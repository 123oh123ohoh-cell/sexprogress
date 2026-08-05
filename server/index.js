require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { MongoClient } = require("mongodb");
const { WebSocketServer } = require("ws");

const webpush = require("web-push");

// VAPID keys — generate once with: npx web-push generate-vapid-keys
// Then add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL to Render env vars
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL       = process.env.VAPID_EMAIL       || "mailto:hello@progressing.online";
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function sendPushToUser(username, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const doc = await db.collection("pushSubscriptions").findOne({ username });
    if (!doc || !doc.subscription) return;
    await webpush.sendNotification(doc.subscription, JSON.stringify(payload));
    console.log(`[push] sent to ${username}: ${payload.title}`);
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      // Subscription expired — remove it
      await db.collection("pushSubscriptions").deleteOne({ username }).catch(() => {});
    } else {
      console.warn("[push] failed:", e.message);
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;
const publicPath = path.join(__dirname, "..");
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "progress";

if (!mongoUri) {
  console.error("Missing MONGODB_URI environment variable. Set it in a .env file locally or in your host's environment settings.");
  process.exit(1);
}

const DEFAULT_TIMEZONE = "UTC";
const ALLOWED_CREATOR_USERNAMES = new Set(["mara", "own", "progresstesting1"]);
const DEFAULT_CHAT_ROOM = "global";

const SPOTIFY_LINK_RE = /^(?:https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(?:track|album|playlist|artist|episode|show)\/[a-zA-Z0-9]+(?:\?[^\s]*)?|spotify:(?:track|album|playlist|artist|episode|show):[a-zA-Z0-9]+)$/i;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";

const SUPABASE_URL         = process.env.SUPABASE_URL         || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_BUCKET      = "progress";

// Uploads a base64 data URI (image or video) to Supabase Storage and
// returns the public URL. Uses the Supabase REST API directly via fetch —
// no extra npm package needed.
// Bucket must be created in Supabase dashboard as PUBLIC, named "progress".
async function uploadToSupabase(base64DataUri) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.");
  }
  const matches = base64DataUri.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9+.\-]+);base64,([\s\S]+)$/);
  if (!matches) throw new Error("Invalid data URI format.");
  const mimeType = matches[1];
  const extMap = { jpeg: "jpg", quicktime: "mov", "x-msvideo": "avi", "x-matroska": "mkv", "x-ms-wmv": "wmv" };
  const rawExt = mimeType.split("/")[1].split("+")[0].split(";")[0];
  const ext    = extMap[rawExt] || rawExt;
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
  const buffer   = Buffer.from(matches[2], "base64");
  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${filename}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": mimeType,
      "x-upsert": "false"
    },
    body: buffer
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => "");
    throw new Error(`Supabase upload failed (${uploadRes.status}): ${errText}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${filename}`;
}

// Finds every base64 data URI inside an HTML string (e.g. <img src="data:...">)
// and uploads each one to Supabase, replacing the data URI with the public URL.
async function uploadBase64InHtml(html) {
  if (!html || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return html;
  const regex = /src="(data:[^"]{20,})"/g;
  let match;
  const items = [];
  while ((match = regex.exec(html)) !== null) {
    items.push(match[1]);
  }
  let result = html;
  for (const dataUri of items) {
    try {
      const url = await uploadToSupabase(dataUri);
      result = result.split(dataUri).join(url);
    } catch (e) { /* keep original on failure */ }
  }
  return result;
}
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:3000/api/spotify/callback";
const SPOTIFY_SCOPES = "user-read-currently-playing user-read-private user-read-playback-state user-modify-playback-state";
const spotifyOAuthStates = new Map();
function cleanupSpotifyOAuthStates() {
  const now = Date.now();
  for (const [state, entry] of spotifyOAuthStates) {
    if (entry.expires < now) spotifyOAuthStates.delete(state);
  }
}

const SIGNUP_BADGE_AWARDS = {
  mara:             ["dexterity", "dark", "tester", "early_supporter"],
  own:              ["dexterity", "dark", "tester", "early_supporter", "dolphin_eat", "trop"],
  progresstesting1: ["dexterity", "817x2", "dark", "tester", "early_supporter", "dolphin_eat", "trop", "jason"],
  "817x2":          ["817x2", "dexterity", "dark", "tester", "early_supporter"],
  testuser:         ["817x2", "dexterity", "dark", "tester", "early_supporter"],
  dark:             ["dark", "early_supporter"],
  trop:             ["trop", "early_supporter", "dolphin_eat"],
  ohhmytesting:     ["817x2", "dexterity", "dark", "tester"],
};

const DEFAULT_SEED = {
  users: [
    {
      _id: "u1",
      username: "mara",
      name: "Mara Studios",
      password: hashPassword("demo1234"),
      avatar: "https://images.unsplash.com/photo-1502685104226-ee32379fefbe?q=80&w=200&auto=format&fit=crop",
      joined: "2026-02-01",
      timezone: "UTC",
      following: [],
      followers: [],
      bio: "",
      spotify: "",
      badges: ["dexterity"]
    }
  ],
  posts: [
    {
      _id: "p1",
      author: "mara",
      title: "Slowing down the shipping cadence, on purpose",
      date: "2026-06-28",
      createdAt: "2026-06-28T10:00:00.000Z",
      cover: "https://images.unsplash.com/photo-1499750310107-5fef28a66643?q=80&w=1200&auto=format&fit=crop",
      excerpt: "For a year I measured progress in commits. This month I started measuring it in questions I stopped asking too early.",
      content: "<p>For a year I measured progress in commits. This month I started measuring it in questions I stopped asking too early.</p><p>The habit crept in quietly. Every sprint became a race to close tickets, and every retro became a scoreboard. It worked, in the sense that the graphs went up and to the right. But somewhere in there the work stopped teaching me anything.</p><h2>What changed</h2><p>I started leaving one hour a week with nothing scheduled. Not a break, not admin time &mdash; just space to sit with a problem before reaching for the obvious fix.</p><blockquote>The fastest way to solve the wrong problem is still the wrong problem, just faster.</blockquote><p>Three weeks in, the backlog looks about the same. But two of the last four decisions I made were ones I would have gotten wrong under the old pace.</p>",
      likes: 12,
      likedBy: []
    },
    {
      _id: "p2",
      author: "mara",
      title: "A small kitchen table, rebuilt from a door",
      date: "2026-06-14",
      createdAt: "2026-06-14T10:00:00.000Z",
      cover: "https://images.unsplash.com/photo-1533090161767-e6ffed986c88?q=80&w=1200&auto=format&fit=crop",
      excerpt: "The old door had six coats of paint on it. Underneath was oak nobody had seen since 1974.",
      content: "<p>The old door had six coats of paint on it. Underneath was oak nobody had seen since 1974.</p><p>Stripping it took longer than building the frame. That felt backwards until I remembered most restoration is like that &mdash; the removing is the real work, the assembling is just the reward for finishing it.</p><h2>The joints</h2><p>I used simple lap joints instead of anything fancier. Nobody will ever see them, and that's sort of the point of a kitchen table.</p><p>It wobbled for exactly one afternoon before I found the short leg. Now it's the steadiest thing in the house.</p>",
      likes: 27,
      likedBy: []
    },
    {
      _id: "p3",
      author: "mara",
      title: "Notes from a week of only handwritten drafts",
      date: "2026-05-30",
      createdAt: "2026-05-30T10:00:00.000Z",
      cover: "https://images.unsplash.com/photo-1455390582262-044cdead277a?q=80&w=1200&auto=format&fit=crop",
      excerpt: "No backspace key for seven days. It changed which sentences I was willing to start.",
      content: "<p>No backspace key for seven days. It changed which sentences I was willing to start.</p><p>On a screen, a bad sentence costs nothing &mdash; you delete it and move on. On paper, a bad sentence costs a scratched-out line staring back at you, so you think a little longer before committing to one.</p><p>I'm not going back to longhand permanently. But I'm keeping the pause.</p>",
      likes: 8,
      likedBy: []
    }
  ],
  comments: [],
  notifications: [
    { _id: "n1", type: "like", actor: "jonah_p", postId: "p2", postTitle: "A small kitchen table, rebuilt from a door", time: "2026-07-04T09:12:00.000Z", seen: false, recipient: "mara" },
    { _id: "n2", type: "reply", actor: "wren.codes", postId: "p1", postTitle: "Slowing down the shipping cadence, on purpose", time: "2026-07-03T21:40:00.000Z", body: "This is exactly the permission I needed to hear today.", seen: false, recipient: "mara" },
    { _id: "n3", type: "like", actor: "delia", postId: "p1", postTitle: "Slowing down the shipping cadence, on purpose", time: "2026-07-02T14:05:00.000Z", seen: false, recipient: "mara" },
    { _id: "n4", type: "follow", actor: "sam_writes", time: "2026-06-30T08:00:00.000Z", seen: true, recipient: "mara" }
  ]
};

function generateId(prefix) {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored) return false;
  if (stored.startsWith("scrypt:")) {
    const [, salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const hashBuffer = Buffer.from(hash, "hex");
    const candidateBuffer = crypto.scryptSync(String(password), salt, 64);
    if (hashBuffer.length !== candidateBuffer.length) return false;
    return crypto.timingSafeEqual(hashBuffer, candidateBuffer);
  }
  return stored === password;
}

function isLegacyPassword(stored) {
  return typeof stored === "string" && !stored.startsWith("scrypt:");
}

async function notifyBadgesAwarded(username, badgeIds) {
  if (!badgeIds.length) return;
  for (const badgeId of badgeIds) {
    await createNotification({
      _id: generateId("n"),
      type: "badge",
      badgeId,
      recipient: username,
      time: new Date().toISOString(),
      seen: false
    });
  }
}

async function ensureUsernameBadges(user) {
  const awarded = SIGNUP_BADGE_AWARDS[user.username] || [];
  const currentBadges = Array.isArray(user.badges) ? user.badges : [];
  const missing = awarded.filter(b => !currentBadges.includes(b));
  if (!missing.length) return user;
  await db.collection("users").updateOne({ _id: user._id }, { $addToSet: { badges: { $each: missing } } });
  await notifyBadgesAwarded(user.username, missing);
  user.badges = [...currentBadges, ...missing];
  return user;
}

function toClient(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function normalizeUser(doc) {
  const user = toClient(doc);
  return {
    ...user,
    timezone: user.timezone || DEFAULT_TIMEZONE,
    following: Array.isArray(user.following) ? user.following : [],
    followers: Array.isArray(user.followers) ? user.followers : [],
    badges: Array.isArray(user.badges) ? user.badges : [],
    bio: user.bio || "",
    spotify: user.spotify || "",
    locked: !!user.locked,
    banned: !!user.banned,
    streak: typeof user.streak === "number" ? user.streak : 0,
    lastLoginDate: user.lastLoginDate || null
  };
}

function publicUser(user) {
  const badges = Array.isArray(user.badges) ? user.badges.filter(b => b !== "creator") : [];
  let displayBadge = user.displayBadge || null;
  if (ALLOWED_CREATOR_USERNAMES.has(user.username)) {
    if (!badges.includes("creator")) badges.push("creator");
  }
  // displayBadge is kept as-is — admins can assign any badge including creator
  const spotifyAccount = user.spotifyAccount && user.spotifyAccount.connected
    ? { connected: true, displayName: user.spotifyAccount.spotifyName || null, profileUrl: user.spotifyAccount.spotifyProfileUrl || null }
    : { connected: false, displayName: null, profileUrl: null };
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar,
    joined: user.joined,
    timezone: user.timezone,
    bio: user.bio || "",
    spotify: user.spotify || "",
    spotifyAccount,
    badges,
    displayBadge,
    followers: user.followers || [],
    following: user.following || [],
    locked: !!user.locked,
    banned: !!user.banned,
    streak: typeof user.streak === "number" ? user.streak : 0,
    adminRole: ALLOWED_CREATOR_USERNAMES.has(user.username) ? "owner" : (user.adminRole || null)
  };
}

// Post content is real HTML from the rich-text editor (bold, headings,
// Spotify/YouTube embeds, etc.) rather than escaped plain text, since the
// whole point is to preserve formatting - but nothing stops someone from
// calling POST /api/posts directly with a `content` field containing a
// <script> tag or an iframe pointing anywhere they want, which would then
// run for every single visitor who views that post. This sanitizes on
// both the write path (new posts) and the read path (defense in depth,
// so any already-stored malicious content also gets neutralized without
// needing a data migration).
//
// This is a pragmatic regex-based allowlist, not a full HTML parser like
// the `sanitize-html` npm package would give you - it covers the realistic
// attack surface for what this editor actually produces, but a real
// parser-based library is the more bulletproof choice if this app's
// user-generated content ever needs to withstand serious adversarial
// testing.
const SANITIZE_ALLOWED_TAGS = new Set(["p", "h2", "blockquote", "strong", "b", "em", "i", "u", "ul", "ol", "li", "a", "img", "br", "div", "span", "iframe"]);
const SANITIZE_ALLOWED_IFRAME_HOSTS = [/^https:\/\/open\.spotify\.com\//i, /^https:\/\/www\.youtube-nocookie\.com\//i, /^https:\/\/www\.youtube\.com\//i];

function sanitizePostContent(html) {
  if (!html) return "";
  // Strip entire dangerous elements, including their content.
  let clean = html.replace(/<(script|style|object|embed|link|meta|form|base)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  clean = clean.replace(/<(script|style|object|embed|link|meta|form|base)\b[^>]*\/?>/gi, "");
  // Strip every on*="..." event handler attribute (onerror, onload, onclick, ...).
  clean = clean.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Neutralize javascript:/data: URIs that could otherwise execute code via href/src.
  clean = clean.replace(/(href|src)\s*=\s*"(javascript|data):[^"]*"/gi, '$1="#"');
  clean = clean.replace(/(href|src)\s*=\s*'(javascript|data):[^']*'/gi, "$1='#'");
  // Drop any tag not on the allowlist (keeps its text content, strips the wrapping tag itself).
  clean = clean.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    if (!SANITIZE_ALLOWED_TAGS.has(tag)) return "";
    if (tag === "iframe") {
      const srcMatch = attrs.match(/src\s*=\s*"([^"]*)"/i) || attrs.match(/src\s*=\s*'([^']*)'/i);
      const src = srcMatch ? srcMatch[1] : "";
      if (!SANITIZE_ALLOWED_IFRAME_HOSTS.some(re => re.test(src))) return "";
    }
    return match;
  });
  return clean;
}

function normalizePost(doc) {
  const post = toClient(doc);
  return {
    ...post,
    content: typeof post.content === "string" ? sanitizePostContent(post.content) : post.content,
    likes: typeof post.likes === "number" ? post.likes : 0,
    likedBy: Array.isArray(post.likedBy) ? post.likedBy : []
  };
}

function normalizeChatMessage(doc) {
  return toClient(doc);
}

const chatRooms = new Map();

function chatRoomClients(room) {
  let set = chatRooms.get(room);
  if (!set) {
    set = new Set();
    chatRooms.set(room, set);
  }
  return set;
}

function isUserActiveInRoom(username, room) {
  const clients = chatRooms.get(room);
  if (!clients) return false;
  for (const ws of clients) {
    if (ws.username === username && ws.readyState === 1) return true;
  }
  return false;
}

function broadcastToRoom(room, payload) {
  const json = JSON.stringify(payload);
  for (const client of chatRoomClients(room)) {
    if (client.readyState === client.OPEN) client.send(json);
  }
}

function roomPresence(room) {
  return Array.from(chatRoomClients(room))
    .map(c => c.username)
    .filter(Boolean);
}

function dmRoomId(userA, userB) {
  return "dm:" + [userA, userB].sort().join(":");
}

function dmParticipants(room) {
  if (typeof room !== "string" || !room.startsWith("dm:")) return null;
  const parts = room.slice(3).split(":");
  return parts.length === 2 && parts[0] && parts[1] ? parts : null;
}

function canAccessRoom(room, username) {
  const participants = dmParticipants(room);
  if (!participants) return true;
  return participants.includes(username);
}

// Connection-based presence, same model Discord uses - each individual
// WebSocket connection tracks its own active/idle state (via a plain
// property on the ws object), not just a per-username flag. Someone with
// two tabs open - one focused, one backgrounded - correctly shows as
// "online" as long as ANY of their connections is in the foreground;
// "idle" only once every single one of their open tabs is backgrounded;
// "offline" once they have no connections left at all.
const usernameConnections = new Map(); // username -> Set of ws connections
const postViewers = new Map(); // postId -> Map<ws, { username, avatar, name }>

function broadcastPostViewers(postId) {
  const map = postViewers.get(postId);
  const viewers = map ? [...map.values()] : [];
  const payload = JSON.stringify({ type: "post-viewers", postId, viewers });
  for (const conns of usernameConnections.values()) {
    for (const ws of conns) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}

function addUserConnection(username, ws) {
  if (!username) return;
  let set = usernameConnections.get(username);
  if (!set) { set = new Set(); usernameConnections.set(username, set); }
  set.add(ws);
}
function removeUserConnection(username, ws) {
  if (!username) return;
  const set = usernameConnections.get(username);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) usernameConnections.delete(username);
}
function getUserPresenceStatus(username) {
  const set = usernameConnections.get(username);
  if (!set || set.size === 0) return "offline";
  for (const ws of set) {
    if (ws.isActiveTab !== false) return "online";
  }
  return "idle";
}
function isUserOnline(username) {
  return getUserPresenceStatus(username) !== "offline";
}

// Fires on every connect/disconnect/tab-focus-change anywhere on the
// site (not just within one room) - sent only to clients in the
// "presence" room (the one non-chat pages open), carrying every
// currently-connected username's real status. Fully offline usernames are
// simply omitted, keeping the payload small.
function broadcastGlobalPresenceUpdate() {
  const statuses = {};
  for (const username of usernameConnections.keys()) {
    statuses[username] = getUserPresenceStatus(username);
  }
  // Broadcast to ALL connected clients (every room, not just the dedicated
  // presence room) so the chat page can show live online dots in the DM list.
  const payload = JSON.stringify({ type: "global-presence", statuses });
  for (const conns of usernameConnections.values()) {
    for (const ws of conns) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}

// ── Transactional email via Resend ───────────────────────────────────────────
// Requires RESEND_API_KEY in .env.  Silently skips if the key is absent so the
// rest of the app works without email configured.

/**
 * Wraps email content in the Progress branded template.
 * All content params accept pre-escaped HTML strings.
 */
/**
 * Branded Progress email wrapper.
 * Uses the site's cream/mocha palette and emoticon PNGs from /images/emoticons/.
 * emoticon: full URL to a .png from images/emoticons/ (or null)
 */
function emailWrap({ emoticon = null, headlineHtml = "", bodyHtml = "", ctaText = "", ctaUrl = "", preview = "", site = "https://progressing.online", accentColor = "#8C6E58", buttonColor = "#8C6E58", footerTagline = "until next time" }) {
  const previewSnippet = preview
    ? `<span style="display:none;font-size:0;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preview}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</span>`
    : "";

  const emoticonBlock = emoticon
    ? `<tr>
        <td align="center" style="padding:46px 0 0;">
          <img src="${emoticon}" alt="" width="100" height="100" border="0" style="display:block;margin:0 auto;outline:none;-ms-interpolation-mode:bicubic;">
          <p style="margin:16px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#CDB99A;letter-spacing:0.36em;">✦ &nbsp; ✦ &nbsp; ✦</p>
        </td>
      </tr>`
    : `<tr><td height="46" style="font-size:0;line-height:0;">&nbsp;</td></tr>`;

  const ctaBlock = ctaText && ctaUrl
    ? `<tr>
        <td align="center" style="padding:30px 0 52px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
            <tr>
              <td bgcolor="${buttonColor}" style="border-radius:100px;">
                <a href="${ctaUrl}" style="display:inline-block;padding:14px 44px;font-family:Georgia,'Times New Roman',serif;font-size:13px;font-weight:bold;color:#FAF5EE;text-decoration:none;letter-spacing:0.1em;white-space:nowrap;">${ctaText}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : `<tr><td height="52" style="font-size:0;line-height:0;">&nbsp;</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Progress</title>
</head>
<body style="margin:0;padding:0;background-color:#DEC9AE;-webkit-font-smoothing:antialiased;">
${previewSnippet}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#DEC9AE">
  <tr><td align="center" style="padding:48px 20px 68px;">

    <!-- brand stamp -->
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">
      <tr>
        <td align="center" style="padding-bottom:24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
            <tr>
              <td style="vertical-align:bottom;padding-right:8px;padding-bottom:2px;">
                <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-style:italic;color:#3B2518;letter-spacing:0.01em;">progress.</p>
                <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:10px;color:${accentColor};letter-spacing:0.32em;text-transform:uppercase;opacity:0.75;">a writing community &nbsp;✿</p>
              </td>
              <td style="vertical-align:bottom;padding-bottom:2px;">
                <img src="${site}/images/nearheader.png" alt="" width="62" height="62" border="0" style="display:block;outline:none;-ms-interpolation-mode:bicubic;">
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- card — no border, soft paper feel -->
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" bgcolor="#FAF5EE" style="max-width:480px;width:100%;border-radius:26px;">

      <!-- emoticon / opener -->
      ${emoticonBlock}

      <!-- headline -->
      <tr>
        <td align="center" style="padding:20px 44px 10px;">
          ${headlineHtml}
        </td>
      </tr>

      <!-- botanical divider -->
      <tr>
        <td align="center" style="padding:4px 44px 22px;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#D4BBA0;letter-spacing:0.36em;">✿ &nbsp; &nbsp; ✿ &nbsp; &nbsp; ✿</p>
        </td>
      </tr>

      <!-- body content -->
      <tr>
        <td style="padding:0 44px;">
          ${bodyHtml}
        </td>
      </tr>

      <!-- closing botanical -->
      <tr>
        <td align="center" style="padding:26px 44px 0;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#D4BBA0;letter-spacing:0.36em;">⊹ &nbsp; &nbsp; ⊹ &nbsp; &nbsp; ⊹</p>
        </td>
      </tr>

      <!-- CTA button -->
      ${ctaBlock}

    </table>

    <!-- footer -->
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;margin-top:28px;">
      <tr>
        <td align="center" style="padding:0 20px;">
          <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:12px;font-style:italic;color:#B89A78;line-height:2.1;">
            ${footerTagline} — <a href="${site}" style="color:${accentColor};text-decoration:none;">progress</a> &nbsp;✿
          </p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:11px;color:#C9AE92;line-height:2.1;">
            <a href="${site}/profile.html" style="color:#B89A78;text-decoration:underline;">email preferences</a>
            &nbsp;&middot;&nbsp;
            <a href="${site}" style="color:#B89A78;text-decoration:none;">progressing.online</a>
          </p>
        </td>
      </tr>
    </table>

  </td></tr>
</table>
</body>
</html>`;
}

/** Send a welcome email when a user adds their email address for the first time. */
async function sendWelcomeEmail(user) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !user || !user.email) return;
  const site = "https://progressing.online";
  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const displayName = esc(user.name || user.username || "friend");

  const step = (num, title, desc) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:14px;">
      <tr>
        <td width="34" valign="top" style="padding-top:2px;">
          <table cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="26" height="26" style="background-color:#1C1917;border-radius:50%;font-family:Georgia,'Times New Roman',serif;font-size:11px;font-weight:bold;color:#FAF5EE;line-height:26px;text-align:center;">${num}</td></tr></table>
        </td>
        <td style="padding-left:12px;">
          <p style="margin:0 0 3px;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:bold;color:#1C1917;line-height:1.3;">${title}</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#8C6E58;line-height:1.65;">${desc}</p>
        </td>
      </tr>
    </table>`;

  const feat = (mark, title, desc) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:12px;">
      <tr>
        <td width="22" valign="top" style="font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#8C6E58;padding-top:1px;">${mark}</td>
        <td style="padding-left:10px;">
          <p style="margin:0 0 2px;font-family:Georgia,'Times New Roman',serif;font-size:13px;font-weight:bold;color:#1C1917;">${title}</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:12px;color:#9C8B7C;line-height:1.6;">${desc}</p>
        </td>
      </tr>
    </table>`;

  const bodyHtml = `
    <p style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:16px;color:#4A3728;line-height:1.85;text-align:center;">
      you're officially in the circle, ${displayName}.
    </p>
    <p style="margin:0 0 30px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#9C8B7C;line-height:1.9;text-align:center;">
      a quiet corner of the internet for writing,<br>reading, and showing up every day.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:28px;background-color:#EDD9C4;border-radius:12px;">
      <tr><td style="padding:22px 24px 20px;">
        <p style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">what is progress?</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#4A3728;line-height:1.9;">
          progress is a place to write, share, and build a daily habit. it's not about performance or follower counts — it's about the quiet act of putting words down, day after day. we built it for the writers who show up even when no one's watching.
        </p>
      </td></tr>
    </table>

    <p style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">your first three steps</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:28px;background-color:#EDD9C4;border-radius:12px;">
      <tr><td style="padding:20px 22px 8px;">
        ${step(1, "write something small", "open a blank page. a sentence, a thought, a question — whatever's in your head right now. there are no rules and no audience yet.")}
        ${step(2, "find some writers", "browse recent posts. follow the people whose words make you feel something. a small curated feed beats an infinite scroll, every time.")}
        ${step(3, "build your streak", "come back tomorrow. then the day after. daily writing changes you slowly, then suddenly. trust the ritual.")}
      </td></tr>
    </table>

    <p style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">what you can do here</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:28px;background-color:#EDD9C4;border-radius:12px;">
      <tr><td style="padding:20px 22px 10px;">
        ${feat("✦", "write freely", "publish posts in any format — essays, diary entries, lists, fragments, half-finished thoughts. all of it belongs.")}
        ${feat("♡", "follow writers", "curate your reading list with voices that move you. quality over quantity, always.")}
        ${feat("◎", "keep a streak", "every day you write counts. missing a day resets your streak — which is exactly the point.")}
        ${feat("✉", "stay connected", "gentle email nudges when someone likes your work, replies, or follows you.")}
      </td></tr>
    </table>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:6px;border-top:1px solid #E4D5C4;">
      <tr><td style="padding:24px 0 10px;">
        <p style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">a note from us</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#4A3728;line-height:1.9;font-style:italic;">
          &ldquo;we made progress because we wanted a place where writing felt like making coffee in the morning — ordinary, ritual, entirely yours. not everything you write needs to be good. it just needs to exist. so welcome. pull up a chair.&rdquo;
        </p>
        <p style="margin:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:12px;color:#9C8B7C;">— the progress team</p>
      </td></tr>
    </table>`;

  const html = emailWrap({
    emoticon: `${site}/images/emoticons/hi.png`,
    headlineHtml: `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.25;letter-spacing:-0.01em;">welcome, ${displayName}.</h1>`,
    bodyHtml,
    ctaText: "start writing",
    ctaUrl: `${site}/write.html`,
    preview: `you're in. welcome to progress, ${user.name || user.username}.`,
    site
  });

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Progress <noreply@progressing.online>",
      to: user.email,
      subject: `welcome to progress, ${user.name || user.username} ✦`,
      html
    })
  }).then(r => { if (!r.ok) r.text().then(t => console.error("[welcome] Resend error:", t)); })
    .catch(e => console.error("[welcome] fetch error:", e));
}

async function sendNotificationEmail(user, notification) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !user || !user.email) return;
  const site = "https://progressing.online";
  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const img = name => `${site}/images/emoticons/${name}`;

  const quote = (text) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#EDD9C4;border-radius:8px;border-left:3px solid #B08060;margin-top:16px;margin-bottom:16px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#4A3728;line-height:1.7;font-style:italic;">${text}</p>
      </td></tr>
    </table>`;

  const warmCard = (label, text) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:20px;margin-bottom:8px;background-color:#EDD9C4;border-radius:12px;">
      <tr><td style="padding:20px 22px;">
        <p style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">${label}</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#4A3728;line-height:1.85;">${text}</p>
      </td></tr>
    </table>`;

  let subject, emoticon, headlineHtml, bodyHtml, ctaText, ctaUrl, preview;

  if (notification.type === "like") {
    subject      = `@${notification.actor} liked your post`;
    preview      = "someone appreciated what you wrote.";
    emoticon     = img("romantic.png");
    headlineHtml = `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.3;">someone loved your writing</h1>`;
    bodyHtml = `
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#4A3728;line-height:1.85;text-align:center;">
        <strong style="color:#1C1917;">@${esc(notification.actor)}</strong> liked your post.
      </p>
      ${quote(`&ldquo;${esc(notification.postTitle || "your post")}&rdquo;`)}
      ${warmCard("what this means", "a like on progress isn't a vanity metric — it's a signal from a real person that your words reached them. someone stopped, read what you wrote, and felt something. that's not nothing. that's the whole point.")}
      <p style="margin:20px 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#9C8B7C;line-height:1.8;text-align:center;">
        keep writing. readers are finding you.
      </p>`;
    ctaText = "read it again";
    ctaUrl  = `${site}/post.html?id=${notification.postId}`;

  } else if (notification.type === "reply") {
    subject      = `@${notification.actor} replied to your post`;
    preview      = "someone joined your conversation.";
    emoticon     = img("two.png");
    headlineHtml = `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.3;">a reply came in</h1>`;
    const snippet = notification.body
      ? esc(String(notification.body).replace(/<[^>]+>/g,"").slice(0, 240)) + (notification.body.length > 240 ? "&hellip;" : "")
      : "";
    bodyHtml = `
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#4A3728;line-height:1.85;text-align:center;">
        <strong style="color:#1C1917;">@${esc(notification.actor)}</strong> replied to your post<br>
        <em style="color:#8C6E58;">${esc(notification.postTitle || "your post")}</em>.
      </p>
      ${snippet ? quote(`&ldquo;${snippet}&rdquo;`) : ""}
      ${warmCard("the conversation", "the best writing on progress isn't monologue — it's dialogue. someone read your words carefully enough to respond. that's rare. write back when you're ready, or just let it sit. either way, your post started something.")}
      <p style="margin:20px 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#9C8B7C;line-height:1.8;text-align:center;">
        conversations on progress can go anywhere. join yours.
      </p>`;
    ctaText = "join the conversation";
    ctaUrl  = `${site}/post.html?id=${notification.postId}`;

  } else if (notification.type === "follow") {
    subject      = `@${notification.actor} is now following you`;
    preview      = "your writing is finding its people.";
    emoticon     = img("wonder.png");
    headlineHtml = `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.3;">you have a new follower</h1>`;
    bodyHtml = `
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#4A3728;line-height:1.85;text-align:center;">
        <strong style="color:#1C1917;">@${esc(notification.actor)}</strong> just started following you.<br>
        <span style="color:#9C8B7C;font-size:13px;">they'll see everything you write from here on.</span>
      </p>
      ${warmCard("your writing community", "every follower on progress is a real reader — someone who sought out your profile and chose to stay. your circle grows one person at a time, through the writing itself. that's a beautiful thing.")}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;margin-bottom:6px;background-color:#EDD9C4;border-radius:12px;">
        <tr><td style="padding:18px 22px;">
          <p style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:13px;font-weight:bold;color:#1C1917;">what to do next</p>
          <p style="margin:0 0 5px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#4A3728;line-height:1.7;">✦ &nbsp;check out <a href="${site}/user.html?id=${esc(notification.actor)}" style="color:#8C6E58;text-decoration:underline;">@${esc(notification.actor)}'s profile</a> — you might find a new favorite writer</p>
          <p style="margin:0 0 5px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#4A3728;line-height:1.7;">✦ &nbsp;write something today — they'll see it in their feed</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#4A3728;line-height:1.7;">✦ &nbsp;follow back if their writing resonates with you</p>
        </td></tr>
      </table>`;
    ctaText = "view their profile";
    ctaUrl  = `${site}/user.html?id=${esc(notification.actor)}`;

  } else if (notification.type === "mention") {
    subject      = `@${notification.actor} mentioned you`;
    preview      = "you came up in conversation.";
    emoticon     = img("kiss.png");
    headlineHtml = `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.3;">you were mentioned</h1>`;
    bodyHtml = `
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#4A3728;line-height:1.85;text-align:center;">
        <strong style="color:#1C1917;">@${esc(notification.actor)}</strong> brought you into the conversation<br>
        in <em style="color:#8C6E58;">${esc(notification.postTitle || "a post")}</em>.
      </p>
      ${warmCard("you're part of it", "being mentioned means someone thought of your voice while they were writing. they wanted to bring you in. it's one of the nicest things that can happen on a writing platform. go see what they said.")}
      <p style="margin:20px 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#9C8B7C;line-height:1.8;text-align:center;">
        your words and presence matter here.
      </p>`;
    ctaText = "see the post";
    ctaUrl  = `${site}/post.html?id=${notification.postId}`;

  } else if (notification.type === "streak") {
    const n = notification.streak || 0;
    let milestoneMsg = "every single day counts. this is how it starts.";
    if (n >= 365) milestoneMsg = "one full year of daily writing. that's not a habit — that's an identity. you are a writer.";
    else if (n >= 100) milestoneMsg = "a hundred days. you've crossed the line where this becomes who you are.";
    else if (n >= 60) milestoneMsg = "two months of showing up every day. you've built something real here.";
    else if (n >= 30) milestoneMsg = "thirty days. a full month. the research says habits solidify around here.";
    else if (n >= 14) milestoneMsg = "two weeks straight. you're past the hardest part — the beginning.";
    else if (n >= 7) milestoneMsg = "one full week. you've proven to yourself that you can do this.";

    subject      = `${n}-day streak — keep it going`;
    preview      = "you're on a roll. don't stop now.";
    emoticon     = img("pancake.png");
    headlineHtml = `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.3;">${n} days in a row</h1>`;
    bodyHtml = `
      <p style="margin:0 0 22px;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#4A3728;line-height:1.85;text-align:center;">
        you've written ${n} days in a row.<br>
        <span style="color:#9C8B7C;font-size:13px;">${milestoneMsg}</span>
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;background-color:#3B2518;border-radius:14px;">
        <tr>
          <td align="center" style="padding:28px 20px 24px;">
            <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:68px;font-weight:bold;color:#FAF5EE;line-height:1;">${n}</p>
            <p style="margin:6px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:10px;color:#A9866D;text-transform:uppercase;letter-spacing:0.22em;">day streak</p>
          </td>
        </tr>
      </table>

      ${warmCard("keeping the streak alive", "the secret isn't discipline — it's lowering the bar. on the hard days, write one sentence. write a grocery list in the notes field. write 'today was hard.' that counts. showing up in any form is the whole game.")}

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;margin-bottom:6px;background-color:#EDD9C4;border-radius:12px;">
        <tr><td style="padding:18px 22px;">
          <p style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">tips for the long run</p>
          <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#4A3728;line-height:1.7;">✦ &nbsp;write at the same time each day — morning coffee works well</p>
          <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#4A3728;line-height:1.7;">✦ &nbsp;keep a running draft — even unfinished posts count toward your streak</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#4A3728;line-height:1.7;">✦ &nbsp;when you miss a day, start again quietly — no drama, no guilt</p>
        </td></tr>
      </table>`;
    ctaText = "keep writing";
    ctaUrl  = `${site}/write.html`;

  } else {
    return;
  }

  const html = emailWrap({ emoticon, headlineHtml, bodyHtml, ctaText, ctaUrl, preview, site });
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Progress <noreply@progressing.online>", to: user.email, subject, html })
  }).then(r => { if (!r.ok) r.text().then(t => console.error("[email] Resend error:", t)); })
    .catch(e => console.error("[email] fetch error:", e));
}

// Digest email — called by POST /api/admin/send-digest
async function sendWeeklyDigest() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: 0, skipped: "no RESEND_API_KEY" };
  const site = "https://progressing.online";
  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const writingTips = [
    "write the first draft like no one will ever read it. edit it like everyone will.",
    "the blank page isn't your enemy. your standards are. lower them first.",
    "the best writing comes from asking 'what do I actually think?' and then answering honestly.",
    "read your drafts out loud. your ear catches what your eye misses every time.",
    "constraints are creative tools. try writing about one thing for a whole week.",
    "start in the middle. beginnings are the hardest part — you can add them later.",
    "every writer you admire once wrote something terrible. they kept going anyway.",
  ];
  const weekTip = writingTips[new Date().getDay() % writingTips.length];

  const users = await db.collection("users").find({ email: { $exists: true, $ne: "" } }).toArray();
  let sent = 0;
  for (const user of users) {
    const following = user.following || [];
    if (!following.length) continue;
    const posts = await db.collection("posts")
      .find({ author: { $in: following }, date: { $gte: since.toISOString().slice(0,10) } })
      .sort({ likes: -1 })
      .limit(5)
      .project({ _id: 1, title: 1, author: 1, excerpt: 1, likes: 1 })
      .toArray();
    if (!posts.length) continue;

    const postCards = posts.map((p, i) => {
      const excerpt = p.excerpt ? esc(String(p.excerpt).replace(/<[^>]+>/g,"").slice(0, 140)) : "";
      const isFirst = i === 0;
      return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:10px;background-color:${isFirst ? "#3B2518" : "#EDD9C4"};border-radius:10px;">
        <tr>
          <td style="padding:18px 20px;">
            ${isFirst ? `<p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#A9866D;">top pick this week</p>` : ""}
            <a href="${site}/post.html?id=${p._id}" style="font-family:Georgia,'Times New Roman',serif;font-size:${isFirst ? "16" : "15"}px;font-weight:bold;color:${isFirst ? "#FAF5EE" : "#3B2518"};text-decoration:none;line-height:1.4;display:block;margin-bottom:6px;">${esc(p.title || "Untitled")}</a>
            <p style="margin:0 0 ${excerpt ? "8px" : "0"};font-family:Georgia,'Times New Roman',serif;font-size:11px;color:${isFirst ? "#8C6E58" : "#A9866D"};letter-spacing:0.05em;">by @${esc(p.author)} &nbsp;&#9825; ${p.likes || 0}</p>
            ${excerpt ? `<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:${isFirst ? "#A9866D" : "#4A3728"};line-height:1.7;font-style:italic;">${excerpt}&hellip;</p>` : ""}
          </td>
        </tr>
      </table>`;
    }).join("");

    const displayName = esc(user.name || user.username || "friend");
    const weekLabel = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });

    const bodyHtml = `
      <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#4A3728;line-height:1.85;text-align:center;">
        hi ${displayName} — here's what came out this week<br>from the writers you follow.
      </p>
      <p style="margin:0 0 28px;font-family:Georgia,'Times New Roman',serif;font-size:12px;color:#9C8B7C;line-height:1.9;text-align:center;">
        make yourself something warm and settle in.<br>
        <span style="font-style:italic;">week of ${weekLabel}</span>
      </p>

      <p style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">from your following list</p>
      ${postCards}

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;margin-bottom:10px;background-color:#EDD9C4;border-radius:12px;">
        <tr><td style="padding:20px 22px;">
          <p style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">writing tip of the week</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#4A3728;line-height:1.9;font-style:italic;">&ldquo;${weekTip}&rdquo;</p>
        </td></tr>
      </table>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:10px;margin-bottom:6px;border-top:1px solid #E4D5C4;">
        <tr><td style="padding:22px 0 10px;">
          <p style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#A9866D;">your writing life</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#4A3728;line-height:1.9;">
            the writers above are the ones you chose to follow — which means something about what you're drawn to. that pull is worth paying attention to. what would you write about if you weren't trying to be good at it?
          </p>
          <p style="margin:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#8C6E58;font-style:italic;">
            open a blank page this week. see what comes.
          </p>
        </td></tr>
      </table>`;

    const html = emailWrap({
      emoticon: `${site}/images/emoticons/starbucks.png`,
      headlineHtml: `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.3;">your week in writing</h1>`,
      bodyHtml,
      ctaText: "read more on progress",
      ctaUrl: site,
      preview: `${posts.length} new post${posts.length !== 1 ? "s" : ""} from people you follow this week.`,
      site
    });

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Progress <noreply@progressing.online>", to: user.email, subject: "your weekly digest ✦", html })
    }).then(r => { if (r.ok) sent++; else r.text().then(t => console.error("[digest] Resend error:", t)); })
      .catch(e => console.error("[digest] fetch error:", e));
  }
  return { sent };
}

// Every notification (like, reply, follow, badge, message, mention) should
// go through this instead of inserting directly - it stores the
// notification exactly as before, but also pushes it straight to the
// recipient's own open connections (any page, not just chat), the same
// direct-push pattern already used for instant unread badges. If they
// don't have a connection open right now, this quietly does nothing extra -
// they'll just see it next time they load notifications normally.
async function createNotification(notification) {
  await db.collection("notifications").insertOne(notification);
  const recipientConnections = usernameConnections.get(notification.recipient);
  if (recipientConnections) {
    const payload = JSON.stringify({ type: "notification", notification: toClient(notification) });
    for (const conn of recipientConnections) {
      if (conn.readyState === conn.OPEN) conn.send(payload);
    }
  }
  if (notification.recipient && ["like","reply","follow","mention","streak"].includes(notification.type)) {
    const site = "https://progressing.online";
    // Email notification
    db.collection("users").findOne({ username: notification.recipient })
      .then(doc => sendNotificationEmail(doc, notification)).catch(() => {});
    // Push notification (PWA)
    const pushPayload = {
      title: notification.type === "like"    ? `@${notification.actor} liked your post`
           : notification.type === "reply"   ? `@${notification.actor} replied to your post`
           : notification.type === "follow"  ? `@${notification.actor} is now following you`
           : notification.type === "mention" ? `@${notification.actor} mentioned you`
           : notification.type === "streak"  ? `🔥 ${notification.streak}-day streak!`
           : "New notification",
      body: (notification.body || notification.postTitle || "").slice(0, 100),
      url:  notification.postId ? `${site}/post.html?id=${notification.postId}` : site,
      tag:  notification.type
    };
    sendPushToUser(notification.recipient, pushPayload).catch(() => {});
  }
}

// ── In-memory response cache ──────────────────────────────────────────────────
// Avoids hitting MongoDB on every request for data that rarely changes.
// Keyed by string, value is { data, expires }. Single-server so no staleness
// across replicas, and the TTLs are short enough that stale data is fine.
const _memCache = new Map();
function cacheGet(key) {
  const e = _memCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { _memCache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttlMs = 30000) {
  _memCache.set(key, { data, expires: Date.now() + ttlMs });
}
function cacheInvalidate(...keys) {
  keys.forEach(k => _memCache.delete(k));
}

let db;

// ── Audit log helper ──────────────────────────────────────────────────────────
async function auditLog(actor, action, target, details = {}) {
  try {
    await db.collection("auditLog").insertOne({
      _id: generateId("al"),
      actor, action, target, details,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.warn("[audit] write failed:", e.message);
  }
}

// ── Admin role helpers ────────────────────────────────────────────────────────
// Role hierarchy: owner > admin > moderator > analyst
const ROLE_WEIGHTS = { owner: 5, moderator: 4, analyst: 3, email_writer: 2, tester: 1 };

async function getAdminRole(username) {
  if (ALLOWED_CREATOR_USERNAMES.has(username.toLowerCase())) return "owner";
  const user = await db.collection("users").findOne(
    { username: username.toLowerCase() },
    { projection: { adminRole: 1 } }
  );
  return user?.adminRole || null;
}

// Middleware factory — pass the minimum role weight required.
// e.g. requireRole("moderator") allows owner + moderator
// requireRole("email_writer") allows all four roles
function requireRole(minRole) {
  const minWeight = ROLE_WEIGHTS[minRole] || 99;
  return async (req, res, next) => {
    try {
      const role = await getAdminRole(req.user.username);
      const weight = ROLE_WEIGHTS[role] || 0;
      if (weight < minWeight) {
        return res.status(403).json({ error: "Insufficient permissions." });
      }
      req.adminRole = role;
      next();
    } catch (e) { next(e); }
  };
}

async function connect() {
  const client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db(dbName);
  console.log(`Connected to MongoDB database "${dbName}"`);
  await seedIfNeeded();
  await seedDefaultEvent();
}

async function seedIfNeeded() {
  const users = db.collection("users");
  const posts = db.collection("posts");
  const comments = db.collection("comments");
  const notifications = db.collection("notifications");
  const messages = db.collection("messages");

  try {
    await users.createIndex({ username: 1 }, { unique: true });
    await posts.createIndex({ author: 1, createdAt: -1 });
    await comments.createIndex({ postId: 1, time: 1 });
    await notifications.createIndex({ recipient: 1, time: -1 });
    await messages.createIndex({ room: 1, time: 1 });
  } catch (e) {
    if (!e.message.includes("already exists")) {
      console.warn("Index creation warning:", e.message);
    }
  }

  const mara = await users.findOne({ username: "mara" });
  if (!mara) {
    await users.insertOne(DEFAULT_SEED.users[0]);
  } else {
    const repair = {};
    if (!mara.password) repair.password = hashPassword("demo1234");
    if (!Array.isArray(mara.badges) || !mara.badges.length) repair.badges = ["dexterity"];
    if (Object.keys(repair).length) {
      await users.updateOne({ username: "mara" }, { $set: repair });
    }
  }

  for (const awardedUsername of Object.keys(SIGNUP_BADGE_AWARDS)) {
    const existingUser = await users.findOne({ username: awardedUsername });
    if (existingUser) await ensureUsernameBadges(existingUser);
  }

  for (const seedPost of DEFAULT_SEED.posts) {
    const exists = await posts.findOne({ _id: seedPost._id });
    if (!exists) await posts.insertOne(seedPost);
  }

  if ((await comments.estimatedDocumentCount()) === 0 && DEFAULT_SEED.comments.length) {
    await comments.insertMany(DEFAULT_SEED.comments);
  }

  if ((await notifications.estimatedDocumentCount()) === 0) {
    await notifications.insertMany(DEFAULT_SEED.notifications);
  }
}

// Simple in-memory rate limiter - a sliding window of request timestamps
// per IP, kept per-route via a dedicated Map for each limiter instance.
// This is intentionally not distributed (no Redis) since the app runs as
// Minimal JWT sign/verify using Node's built-in crypto (HMAC-SHA256) -
// this is a well-defined, simple enough format that a small dependency-free
// implementation is entirely reasonable here, same spirit as the rest of
// this app's approach to avoiding unnecessary dependencies.
//
// IMPORTANT: set a real JWT_SECRET environment variable in production. If
// it's not set, this falls back to a random value generated at boot, which
// means every existing token becomes invalid (forcing everyone to log back
// in) on every server restart/redeploy.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn("[jwt] JWT_SECRET is not set - using a random secret for this run. Sessions will not survive a restart. Set JWT_SECRET in your environment for persistent logins.");
}
const JWT_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60; // 30 days

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString();
}
function signJWT(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + JWT_EXPIRES_IN_SECONDS };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(fullPayload));
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(`${headerB64}.${payloadB64}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${headerB64}.${payloadB64}.${signature}`;
}
function verifyJWT(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signature] = parts;
  const expectedSignature = crypto.createHmac("sha256", JWT_SECRET).update(`${headerB64}.${payloadB64}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  } catch (e) {
    return null;
  }
  try {
    const payload = JSON.parse(base64urlDecode(payloadB64));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Requires a valid token and populates req.user = { username, id }. Use on
// any route where the acting identity must be verified rather than trusted
// from the request body.
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const payload = verifyJWT(token);
  if (!payload || !payload.username) {
    return res.status(401).json({ error: "Please log in again." });
  }
  req.user = payload;
  next();
}

// Same as requireAuth, but never rejects the request - just populates
// req.user if a valid token happens to be present. Useful for routes that
// behave the same for everyone but want to know who's asking (none of the
// current routes need this yet, kept here for future use).
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const payload = verifyJWT(token);
  req.user = payload || null;
  next();
}

// Simple in-memory rate limiter - a sliding window of request timestamps
// per IP, kept per-route via a dedicated Map for each limiter instance.
// This is intentionally not distributed (no Redis) since the app runs as
// a single Render instance - fine at this scale, and avoids adding a new
// dependency just for this.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> array of timestamps within the window

  // Periodic sweep so IPs that stop making requests don't sit in memory
  // forever - runs far less often than the window itself, just tidying up.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of hits) {
      const fresh = timestamps.filter(t => now - t < windowMs);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  }, Math.max(windowMs, 60000)).unref();

  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const timestamps = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (timestamps.length >= max) {
      return res.status(429).json({ error: message || "Too many requests. Please slow down and try again shortly." });
    }
    timestamps.push(now);
    hits.set(ip, timestamps);
    next();
  };
}

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Please wait a few minutes and try again."
});
const signupRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  message: "Too many accounts created from this connection recently. Please try again later."
});
const generalApiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  message: "Too many requests. Please slow down."
});
const uploadRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: "Too many image uploads recently. Please wait a bit and try again."
});
const linkPreviewRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: "Too many link previews requested recently. Please slow down."
});

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

async function isUsernameBanned(username) {
  if (!username) return false;
  const doc = await db.collection("users").findOne({ username: username.toLowerCase() });
  return !!(doc && doc.banned);
}

async function notifyMentionedUsers({ text, author, skipUsernames = [], context = {} }) {
  if (!text) return;
  const mentioned = Array.from(new Set((text.match(/@([a-zA-Z0-9_.]+)/g) || [])
    .map(m => m.slice(1).toLowerCase())))
    .filter(u => u !== author.toLowerCase() && !skipUsernames.includes(u));
  if (!mentioned.length) return;
  try {
    const mentionedUsers = await db.collection("users").find({ username: { $in: mentioned } }).toArray();
    for (const u of mentionedUsers) {
      await createNotification({
        _id: generateId("n"),
        type: "mention",
        actor: author,
        recipient: u.username,
        body: text,
        time: new Date().toISOString(),
        seen: false,
        ...context
      });
    }
  } catch (e) {
    console.error("Mention notification failed:", e);
  }
}

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
// Only these origins can call the API at all - a malicious site can no
// longer make requests to this backend on a visitor's behalf just by
// including a <script> that calls fetch(). Local dev origins are included
// so testing against a local server still works.
const ALLOWED_ORIGINS = new Set([
  "https://progressing.online",
  "https://progressing.vercel.app",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:3000",
  "http://localhost:3000"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Security headers as plain res.setHeader() calls rather than the helmet
// package - this is deliberate: these are universal HTTP concepts, not
// anything Express-specific, so this same logic ports cleanly to a
// different backend framework (or even a different language) later,
// whereas helmet() itself is tied to Express's middleware pattern.
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "frame-src https://open.spotify.com https://www.youtube-nocookie.com https://www.youtube.com",
  "connect-src 'self' https://progress-351h.onrender.com wss://progress-351h.onrender.com"
].join("; ");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff"); // stop browsers guessing a file's type differently than the server says
  res.setHeader("X-Frame-Options", "DENY"); // stop this site being embedded in an iframe on someone else's page (clickjacking)
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); // don't leak full URLs to third-party sites via the Referer header
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); // force HTTPS for a year once a browser's seen it once
  res.setHeader("Content-Security-Policy", CSP_HEADER); // configured for this app's actual needs (Spotify/YouTube embeds, Google Fonts, the API's own origin) rather than the strictest possible defaults, which would break real features
  res.removeHeader("X-Powered-By"); // don't advertise "this is Express" to anyone probing the server
  next();
});

// ── Share card routes ────────────────────────────────────────────────────────
// /og/:id        — server-rendered HTML with real OG meta (for link crawlers)
// /api/posts/:id/og.svg — SVG share image returned as image/svg+xml

app.get("/api/posts/:id/og.svg", asyncHandler(async (req, res) => {
  const post = await db.collection("posts").findOne({ _id: req.params.id }, { projection: { title: 1, author: 1, excerpt: 1, date: 1 } });
  if (!post) return res.status(404).send("Not found");
  const title = (post.title || "Untitled").slice(0, 80);
  const author = `@${post.author || ""}`;
  const excerpt = (post.excerpt || "").replace(/<[^>]+>/g, "").slice(0, 100);
  // Wrap title text into ~38-char lines
  const words = title.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > 38 && line) { lines.push(line); line = w; }
    else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  const titleSVG = lines.map((l, i) => `<text x="48" y="${100 + i * 52}" font-size="40" font-weight="600" fill="#1C1917" font-family="Georgia,serif">${l.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</text>`).join("");
  const titleHeight = 100 + lines.length * 52;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FAF5EE"/>
  <rect x="0" y="0" width="8" height="630" fill="#1C1917"/>
  <text x="48" y="60" font-size="18" fill="#8C6E58" font-family="monospace" letter-spacing="3">PROGRESS</text>
  ${titleSVG}
  <text x="48" y="${titleHeight + 28}" font-size="20" fill="#9C8B7C" font-family="Georgia,serif">${excerpt.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</text>
  <text x="48" y="590" font-size="18" fill="#4A3728" font-family="monospace">${author} · progressing.online</text>
</svg>`;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(svg);
}));

app.get("/og/:id", asyncHandler(async (req, res) => {
  const post = await db.collection("posts").findOne({ _id: req.params.id }, { projection: { title: 1, author: 1, excerpt: 1, date: 1, cover: 1 } });
  if (!post) return res.redirect("/404.html");
  const SITE = "https://progressing.online";
  const title = (post.title || "Progress").replace(/"/g, "&quot;");
  const description = (post.excerpt || "").replace(/<[^>]+>/g, "").replace(/"/g, "&quot;").slice(0, 200);
  const isVideoCover = src => /\.(mp4|webm|mov|mkv|avi|wmv|ogv)(?:[?#].*)?$/i.test(src || "");
  const ogImage = post.cover && !isVideoCover(post.cover) ? post.cover : `${SITE}/api/posts/${post._id}/og.svg`;
  const postUrl = `${SITE}/post.html?id=${post._id}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>${title} — Progress</title>
<meta property="og:site_name" content="Progress">
<meta property="og:type" content="article">
<meta property="og:url" content="${postUrl}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ogImage}">
<meta http-equiv="refresh" content="0;url=${postUrl}">
<link rel="canonical" href="${postUrl}">
</head><body><a href="${postUrl}">Read on Progress &rarr;</a></body></html>`);
}));

app.use(express.static(publicPath));
app.use("/api", generalApiRateLimit);

// ── Maintenance-mode gate ─────────────────────────────────────────────────────
// When _maintenanceMode is on, block all API traffic except:
//   • authentication (login/signup/forgot)
//   • admin routes (so the admin can turn it back off)
//   • the maintenance status check itself
app.use("/api", (req, res, next) => {
  if (!_maintenanceMode) return next();
  const exempt = ["/login", "/signup", "/forgot", "/reset-password"];
  const isExempt = exempt.includes(req.path) ||
                   req.path.startsWith("/admin/") ||
                   req.path === "/admin/maintenance";
  if (isExempt) return next();
  res.status(503).json({ error: "maintenance", message: "Progress is under maintenance. We'll be back shortly." });
});

app.get("/api/users", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  const filter = {};
  if (req.query.username) {
    filter.username = { $regex: `^${escapeRegex(req.query.username)}$`, $options: "i" };
  }
  const cacheKey = req.query.username ? `users:${req.query.username}` : "users:all";
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  const docs = await db.collection("users").find(filter, { projection: { password: 0 } }).toArray();
  const result = docs.map(normalizeUser).map(publicUser);
  cacheSet(cacheKey, result, 30000); // 30 seconds
  res.json(result);
}));

app.get("/api/users/:id", asyncHandler(async (req, res) => {
  const doc = await db.collection("users").findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: "User not found" });
  res.json(publicUser(normalizeUser(doc)));
}));

app.get("/api/users/:id/stats", asyncHandler(async (req, res) => {
  // Accept either a MongoDB _id or a username
  const users = db.collection("users");
  const posts = db.collection("posts");
  let userDoc = await users.findOne({ _id: req.params.id });
  if (!userDoc) userDoc = await users.findOne({ username: req.params.id });
  if (!userDoc) return res.status(404).json({ error: "User not found" });

  const username = userDoc.username;
  const userPosts = await posts
    .find({ author: username })
    .project({ _id: 1, title: 1, date: 1, likes: 1, content: 1 })
    .toArray();

  // Total words (strip HTML tags, count tokens)
  const totalWords = userPosts.reduce((sum, p) => {
    const text = (p.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return sum + (text ? text.split(" ").filter(w => w.length > 0).length : 0);
  }, 0);

  // Total likes received
  const totalLikes = userPosts.reduce((sum, p) => sum + (p.likes || 0), 0);

  // Posts per month — last 6 months
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return { label: d.toLocaleString("en-US", { month: "short" }), year: d.getFullYear(), month: d.getMonth(), count: 0 };
  });
  for (const p of userPosts) {
    if (!p.date) continue;
    const d = new Date(p.date);
    const m = months.find(m => m.year === d.getFullYear() && m.month === d.getMonth());
    if (m) m.count++;
  }

  // Longest streak (computed from unique post dates)
  const dateSorted = [...new Set(userPosts.map(p => p.date ? p.date.slice(0, 10) : null).filter(Boolean))].sort();
  let longestStreak = dateSorted.length > 0 ? 1 : 0, currentRun = 1;
  for (let i = 1; i < dateSorted.length; i++) {
    const diff = (new Date(dateSorted[i]) - new Date(dateSorted[i - 1])) / 86400000;
    currentRun = diff === 1 ? currentRun + 1 : 1;
    if (currentRun > longestStreak) longestStreak = currentRun;
  }

  // Top post
  const top = [...userPosts].sort((a, b) => (b.likes || 0) - (a.likes || 0))[0] || null;

  // Daily post counts for the last 365 days (heatmap)
  const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const postsByDay = {};
  for (const p of userPosts) {
    if (!p.date) continue;
    const d = p.date.slice(0, 10);
    if (d >= yearAgo) postsByDay[d] = (postsByDay[d] || 0) + 1;
  }

  res.json({
    totalPosts: userPosts.length,
    totalWords,
    totalLikes,
    followers: (userDoc.followers || []).length,
    following: (userDoc.following || []).length,
    longestStreak,
    postsPerMonth: months.map(({ label, count }) => ({ label, count })),
    topPost: top ? { id: top._id, title: top.title, likes: top.likes || 0 } : null,
    postsByDay
  });
}));

app.post("/api/users", signupRateLimit, asyncHandler(async (req, res) => {
  const { username, name, password, timezone } = req.body;
  if (!username || !name || !password) return res.status(400).json({ error: "username, name, and password are required" });
  const normalizedUsername = username.trim().toLowerCase();
  if (!normalizedUsername) return res.status(400).json({ error: "username, name, and password are required" });
  const existing = await db.collection("users").findOne({ username: { $regex: `^${escapeRegex(normalizedUsername)}$`, $options: "i" } });
  if (existing) return res.status(409).json({ error: "Username already taken" });
  const user = {
    _id: generateId("u"),
    username: normalizedUsername,
    name,
    password: hashPassword(password),
    avatar: null,
    joined: new Date().toISOString().slice(0, 10),
    timezone: timezone || DEFAULT_TIMEZONE,
    following: [],
    followers: [],
    bio: "",
    spotify: "",
    badges: SIGNUP_BADGE_AWARDS[normalizedUsername] || []
  };
  await db.collection("users").insertOne(user);
  await notifyBadgesAwarded(normalizedUsername, user.badges);
  const adminRole = ALLOWED_CREATOR_USERNAMES.has(user.username) ? "owner" : (user.adminRole || null);
  const token = signJWT({ username: user.username, id: user._id, adminRole });
  res.status(201).json({ ...publicUser(normalizeUser(user)), token });
}));

app.patch("/api/users/:id", requireAuth, asyncHandler(async (req, res) => {
  const users = db.collection("users");
  const doc = await users.findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: "User not found" });
  if (req.user.id !== doc._id) return res.status(403).json({ error: "You can only edit your own profile." });
  const { name, timezone, avatar, bio, displayBadge, spotify, email, emailNotifications } = req.body;
  const update = {};
  if (typeof name === "string") update.name = name;
  if (typeof timezone === "string") update.timezone = timezone;
  if (typeof avatar !== "undefined") update.avatar = avatar;
  if (typeof bio === "string") update.bio = bio;
  if (typeof email !== "undefined") {
    if (email === null || email === "") {
      update.email = null;
    } else {
      const trimmedEmail = String(email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)) {
        return res.status(400).json({ error: "That doesn't look like a valid email address." });
      }
      update.email = trimmedEmail;
    }
  }
  if (typeof emailNotifications === "boolean") update.emailNotifications = emailNotifications;
  if (typeof spotify === "string") {
    const trimmedSpotify = spotify.trim();
    if (trimmedSpotify && (trimmedSpotify.length > 300 || !SPOTIFY_LINK_RE.test(trimmedSpotify))) {
      return res.status(400).json({ error: "That doesn't look like a valid Spotify link." });
    }
    update.spotify = trimmedSpotify;
  }
  if (typeof displayBadge !== "undefined") {
    if (displayBadge === null) {
      update.displayBadge = null;
    } else {
      // Merge SIGNUP_BADGE_AWARDS so badges awarded after signup are recognised
      const awardedBadges = SIGNUP_BADGE_AWARDS[doc.username] || [];
      const ownedBadges = [...new Set([...(Array.isArray(doc.badges) ? doc.badges : []), ...awardedBadges])];
      if (ALLOWED_CREATOR_USERNAMES.has(doc.username) && !ownedBadges.includes("creator")) {
        ownedBadges.push("creator");
      }
      if (displayBadge === "dexterity" || !ownedBadges.includes(displayBadge)) {
        return res.status(400).json({ error: "You don't own that badge" });
      }
      // Write badge into user doc permanently if not already there
      if (!Array.isArray(doc.badges) || !doc.badges.includes(displayBadge)) {
        update.badges = ownedBadges;
      }
      update.displayBadge = displayBadge;
    }
  }
  if (Object.keys(update).length) {
    await users.updateOne({ _id: req.params.id }, { $set: update });
    // Bust the GET /api/users cache so the next load sees the fresh values.
    cacheInvalidate("users:all", `users:${doc.username}`);
  }
  const updated = await users.findOne({ _id: req.params.id });
  // Fire a welcome email the first time a user adds their email address
  if (update.email && !doc.email) {
    sendWelcomeEmail(updated).catch(e => console.error("[welcome email trigger]", e));
  }
  res.json(publicUser(normalizeUser(updated)));
}));

app.delete("/api/users/:id", requireAuth, asyncHandler(async (req, res) => {
  const users = db.collection("users");
  const posts = db.collection("posts");
  const comments = db.collection("comments");
  const notifications = db.collection("notifications");

  const user = await users.findOne({ _id: req.params.id });
  if (user && req.user.id !== user._id) return res.status(403).json({ error: "You can only delete your own account." });
  if (!user) return res.status(404).json({ error: "User not found" });

  const username = user.username;

  await posts.deleteMany({ author: username });
  await comments.deleteMany({ author: username });

  await posts.updateMany(
    { likedBy: username },
    { 
      $pull: { likedBy: username },
      $inc: { likes: -1 }
    }
  );

  await notifications.deleteMany({ $or: [{ actor: username }, { recipient: username }] });

  await users.updateMany(
    { following: username },
    { $pull: { following: username } }
  );

  await users.updateMany(
    { followers: username },
    { $pull: { followers: username } }
  );

  await users.deleteOne({ _id: req.params.id });

  res.status(204).end();
}));

app.post("/api/users/:id/follow", requireAuth, asyncHandler(async (req, res) => {
  const users = db.collection("users");
  const target = await users.findOne({ _id: req.params.id });
  const { action } = req.body;
  const followerId = req.user.id;
  if (!target) return res.status(404).json({ error: "User not found" });
  const follower = await users.findOne({ _id: followerId });
  if (!follower) return res.status(404).json({ error: "Follower user not found" });
  if (target._id === follower._id) return res.status(400).json({ error: "Cannot follow yourself" });
  if (follower.banned) return res.status(403).json({ error: "This account has been banned." });

  const isUnfollow = action === "unfollow";
  const followerFollowing = Array.isArray(follower.following) ? follower.following : [];
  const targetFollowers = Array.isArray(target.followers) ? target.followers : [];

  if (!isUnfollow) {
    if (!followerFollowing.includes(target.username)) followerFollowing.push(target.username);
    if (!targetFollowers.includes(follower.username)) targetFollowers.push(follower.username);
    await createNotification({
      _id: generateId("n"),
      type: "follow",
      actor: follower.username,
      recipient: target.username,
      time: new Date().toISOString(),
      seen: false
    });
  } else {
    const fi = followerFollowing.indexOf(target.username);
    if (fi !== -1) followerFollowing.splice(fi, 1);
    const ti = targetFollowers.indexOf(follower.username);
    if (ti !== -1) targetFollowers.splice(ti, 1);
  }

  await users.updateOne({ _id: follower._id }, { $set: { following: followerFollowing } });
  await users.updateOne({ _id: target._id }, { $set: { followers: targetFollowers } });

  res.json({ follower: follower.username, target: target.username, following: followerFollowing, followers: targetFollowers });
}));

app.post("/api/users/:id/unfollow", requireAuth, asyncHandler(async (req, res) => {
  const users = db.collection("users");
  const target = await users.findOne({ _id: req.params.id });
  const followerId = req.user.id;
  if (!target) return res.status(404).json({ error: "User not found" });
  const follower = await users.findOne({ _id: followerId });
  if (!follower) return res.status(404).json({ error: "Follower user not found" });
  if (target._id === follower._id) return res.status(400).json({ error: "Cannot unfollow yourself" });

  const followerFollowing = Array.isArray(follower.following) ? follower.following : [];
  const targetFollowers = Array.isArray(target.followers) ? target.followers : [];
  const fi = followerFollowing.indexOf(target.username);
  if (fi !== -1) followerFollowing.splice(fi, 1);
  const ti = targetFollowers.indexOf(follower.username);
  if (ti !== -1) targetFollowers.splice(ti, 1);

  await users.updateOne({ _id: follower._id }, { $set: { following: followerFollowing } });
  await users.updateOne({ _id: target._id }, { $set: { followers: targetFollowers } });

  res.json({ follower: follower.username, target: target.username });
}));

app.post("/api/users/:id/lock", requireAuth, asyncHandler(async (req, res) => {
  const { locked } = req.body || {};
  if (!ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase())) {
    return res.status(403).json({ error: "Only admins can lock or unlock accounts." });
  }
  const users = db.collection("users");
  const target = await users.findOne({ _id: req.params.id });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.username === req.user.username.toLowerCase()) {
    return res.status(400).json({ error: "You can't lock your own account." });
  }
  await users.updateOne({ _id: req.params.id }, { $set: { locked: !!locked } });
  const updated = await users.findOne({ _id: req.params.id });
  auditLog(req.user.username, locked ? "lock_user" : "unlock_user", target.username);
  res.json(publicUser(normalizeUser(updated)));
}));

app.post("/api/users/:id/ban", requireAuth, asyncHandler(async (req, res) => {
  if (!ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase())) {
    return res.status(403).json({ error: "Only admins can ban accounts." });
  }
  const users = db.collection("users");
  const target = await users.findOne({ _id: req.params.id });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.username === req.user.username.toLowerCase()) {
    return res.status(400).json({ error: "You can't ban your own account." });
  }
  await users.updateOne({ _id: req.params.id }, { $set: { banned: true } });
  const updated = await users.findOne({ _id: req.params.id });
  auditLog(req.user.username, "ban_user", target.username);
  res.json(publicUser(normalizeUser(updated)));
}));

app.post("/api/users/:id/unban", requireAuth, asyncHandler(async (req, res) => {
  if (!ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase())) {
    return res.status(403).json({ error: "Only admins can unban accounts." });
  }
  const users = db.collection("users");
  const target = await users.findOne({ _id: req.params.id });
  if (!target) return res.status(404).json({ error: "User not found" });
  await users.updateOne({ _id: req.params.id }, { $set: { banned: false } });
  const updated = await users.findOne({ _id: req.params.id });
  auditLog(req.user.username, "unban_user", target.username);
  res.json(publicUser(normalizeUser(updated)));
}));

app.get("/api/spotify/status", (req, res) => {
  res.json({ configured: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) });
});

// Client-credentials token cache for search (no user auth needed)
let _spotifyClientToken = null;
let _spotifyClientTokenExpires = 0;
async function getSpotifyClientToken() {
  if (_spotifyClientToken && _spotifyClientTokenExpires > Date.now() + 10000) return _spotifyClientToken;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
      },
      body: new URLSearchParams({ grant_type: "client_credentials" })
    });
    if (!res.ok) return null;
    const data = await res.json();
    _spotifyClientToken = data.access_token;
    _spotifyClientTokenExpires = Date.now() + (data.expires_in * 1000);
    return _spotifyClientToken;
  } catch { return null; }
}

app.get("/api/spotify/search", asyncHandler(async (req, res) => {
  const q = (req.query.q || "").trim().slice(0, 100);
  const limit = Math.min(parseInt(req.query.limit) || 5, 10);
  if (!q) return res.json({ tracks: [] });
  const token = await getSpotifyClientToken();
  if (!token) return res.status(503).json({ error: "Spotify not configured" });
  const searchRes = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=${limit}`,
    { headers: { "Authorization": `Bearer ${token}` } }
  );
  if (!searchRes.ok) return res.json({ tracks: [] });
  const data = await searchRes.json();
  const tracks = (data.tracks?.items || []).map(t => ({
    id:         t.id,
    name:       t.name,
    artists:    t.artists.map(a => a.name).join(", "),
    albumArt:   t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
    previewUrl: t.preview_url || null,
    spotifyUrl: t.external_urls?.spotify || null,
    duration:   t.duration_ms || 0
  }));
  res.json({ tracks });
}));

app.get("/api/spotify/login", asyncHandler(async (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(503).send("Spotify integration isn't configured on this server yet.");
  }
  const userId = req.query.userId;
  if (!userId) return res.status(400).send("Missing userId");
  const user = await db.collection("users").findOne({ _id: userId });
  if (!user) return res.status(404).send("User not found");

  cleanupSpotifyOAuthStates();
  const state = crypto.randomBytes(24).toString("hex");
  spotifyOAuthStates.set(state, { userId, expires: Date.now() + 10 * 60 * 1000 });

  const authorizeUrl = new URL("https://accounts.spotify.com/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  authorizeUrl.searchParams.set("scope", SPOTIFY_SCOPES);
  authorizeUrl.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI);
  authorizeUrl.searchParams.set("state", state);
  res.redirect(authorizeUrl.toString());
}));

app.get("/api/spotify/callback", asyncHandler(async (req, res) => {
  const SITE = "https://progressing.online";
  const redirectError = () => res.redirect(`${SITE}/profile.html?tab=settings&spotify=error`);
  const { code, state, error } = req.query;
  if (error || !code || !state || !spotifyOAuthStates.has(state)) return redirectError();

  const pending = spotifyOAuthStates.get(state);
  spotifyOAuthStates.delete(state);
  if (pending.expires < Date.now()) return redirectError();

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SPOTIFY_REDIRECT_URI })
    });
    if (!tokenRes.ok) return redirectError();
    const tokens = await tokenRes.json();

    let profile = null;
    try {
      const profileRes = await fetch("https://api.spotify.com/v1/me", {
        headers: { "Authorization": `Bearer ${tokens.access_token}` }
      });
      if (profileRes.ok) profile = await profileRes.json();
    } catch (e) {
      profile = null;
    }

    await db.collection("users").updateOne({ _id: pending.userId }, { $set: {
      spotifyAccount: {
        connected: true,
        spotifyId: profile ? profile.id : null,
        spotifyName: profile ? profile.display_name : null,
        spotifyProfileUrl: profile && profile.external_urls ? profile.external_urls.spotify : null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpires: Date.now() + (tokens.expires_in * 1000)
      }
    }});

    res.redirect(`${SITE}/profile.html?tab=settings&spotify=connected`);
  } catch (e) {
    console.error("Spotify OAuth callback failed:", e);
    redirectError();
  }
}));

async function getValidSpotifyAccessToken(userDoc) {
  const acct = userDoc.spotifyAccount;
  if (!acct || !acct.refreshToken) return null;
  if (acct.accessToken && acct.accessTokenExpires && acct.accessTokenExpires > Date.now() + 5000) {
    return acct.accessToken;
  }
  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: acct.refreshToken })
    });
    if (!tokenRes.ok) return null;
    const tokens = await tokenRes.json();
    const update = {
      "spotifyAccount.accessToken": tokens.access_token,
      "spotifyAccount.accessTokenExpires": Date.now() + (tokens.expires_in * 1000)
    };
    if (tokens.refresh_token) update["spotifyAccount.refreshToken"] = tokens.refresh_token;
    await db.collection("users").updateOne({ _id: userDoc._id }, { $set: update });
    return tokens.access_token;
  } catch (e) {
    return null;
  }
}

app.get("/api/users/:id/spotify/now-playing", asyncHandler(async (req, res) => {
  const userDoc = await db.collection("users").findOne({ _id: req.params.id });
  if (!userDoc) return res.status(404).json({ error: "User not found" });
  if (!userDoc.spotifyAccount || !userDoc.spotifyAccount.connected) {
    return res.json({ connected: false, playing: null });
  }
  const accessToken = await getValidSpotifyAccessToken(userDoc);
  if (!accessToken) return res.json({ connected: true, playing: null });

  try {
    const npRes = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (npRes.status !== 200) return res.json({ connected: true, playing: null });
    const data = await npRes.json().catch(() => null);
    if (!data || !data.item) return res.json({ connected: true, playing: null });
    const images = (data.item.album && data.item.album.images) || [];
    return res.json({
      connected: true,
      playing: {
        isPlaying: !!data.is_playing,
        trackName: data.item.name,
        artistNames: (data.item.artists || []).map(a => a.name).join(", "),
        albumArt: (images[1] && images[1].url) || (images[0] && images[0].url) || null,
        trackUrl: (data.item.external_urls && data.item.external_urls.spotify) || null,
        progressMs: typeof data.progress_ms === "number" ? data.progress_ms : null,
        durationMs: (data.item && typeof data.item.duration_ms === "number") ? data.item.duration_ms : null,
        fetchedAt: Date.now()
      }
    });
  } catch (e) {
    return res.json({ connected: true, playing: null });
  }
}));

app.post("/api/users/:id/spotify/disconnect", requireAuth, asyncHandler(async (req, res) => {
  const users = db.collection("users");
  const doc = await users.findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: "User not found" });
  if (req.user.id !== doc._id) return res.status(403).json({ error: "You can only manage your own Spotify connection." });
  await users.updateOne({ _id: req.params.id }, { $unset: { spotifyAccount: "" } });
  const updated = await users.findOne({ _id: req.params.id });
  res.json(publicUser(normalizeUser(updated)));
}));

function publicListenSession(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    hostUsername: doc.hostUsername,
    hostUserId: doc.hostUserId,
    active: doc.active !== false,
    trackUri: doc.trackUri || null,
    trackName: doc.trackName || null,
    artistNames: doc.artistNames || null,
    albumArt: doc.albumArt || null,
    trackUrl: doc.trackUrl || null,
    durationMs: typeof doc.durationMs === "number" ? doc.durationMs : null,
    progressMs: typeof doc.progressMs === "number" ? doc.progressMs : null,
    isPlaying: !!doc.isPlaying,
    updatedAt: doc.updatedAt || null,
    participants: (doc.participants || []).map(p => p.username),
    createdAt: doc.createdAt
  };
}

async function refreshListenSessionFromHost(sessionDoc) {
  const hostDoc = await db.collection("users").findOne({ username: sessionDoc.hostUsername });
  if (!hostDoc || !hostDoc.spotifyAccount || !hostDoc.spotifyAccount.connected) return sessionDoc;
  const accessToken = await getValidSpotifyAccessToken(hostDoc);
  if (!accessToken) return sessionDoc;
  try {
    const npRes = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    let update;
    if (npRes.status === 200) {
      const data = await npRes.json().catch(() => null);
      if (data && data.item) {
        const images = (data.item.album && data.item.album.images) || [];
        update = {
          trackUri: data.item.uri,
          trackName: data.item.name,
          artistNames: (data.item.artists || []).map(a => a.name).join(", "),
          albumArt: (images[1] && images[1].url) || (images[0] && images[0].url) || null,
          trackUrl: (data.item.external_urls && data.item.external_urls.spotify) || null,
          durationMs: data.item.duration_ms,
          progressMs: data.progress_ms,
          isPlaying: !!data.is_playing,
          updatedAt: Date.now()
        };
      }
    }
    if (!update) update = { isPlaying: false, updatedAt: Date.now() };
    await db.collection("listenSessions").updateOne({ _id: sessionDoc._id }, { $set: update });
    return { ...sessionDoc, ...update };
  } catch (e) {
    return sessionDoc;
  }
}

app.post("/api/listen/sessions", requireAuth, asyncHandler(async (req, res) => {
  const hostId = req.user.id;
  const hostDoc = await db.collection("users").findOne({ _id: hostId });
  if (!hostDoc) return res.status(404).json({ error: "User not found" });
  if (hostDoc.banned) return res.status(403).json({ error: "This account has been banned." });
  if (!hostDoc.spotifyAccount || !hostDoc.spotifyAccount.connected) {
    return res.status(400).json({ error: "Connect Spotify before starting a listening session." });
  }
  await db.collection("listenSessions").updateMany(
    { hostUsername: hostDoc.username, active: true },
    { $set: { active: false } }
  );
  const session = {
    _id: crypto.randomUUID(),
    hostUsername: hostDoc.username,
    hostUserId: hostDoc._id,
    active: true,
    participants: [{ username: hostDoc.username, userId: hostDoc._id, joinedAt: Date.now() }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isPlaying: false
  };
  await db.collection("listenSessions").insertOne(session);
  const refreshed = await refreshListenSessionFromHost(session);
  res.json(publicListenSession(refreshed));
}));

app.get("/api/listen/sessions", asyncHandler(async (req, res) => {
  const docs = await db.collection("listenSessions").find({ active: true }).toArray();
  res.json(docs.map(publicListenSession));
}));

app.get("/api/listen/sessions/:id", asyncHandler(async (req, res) => {
  const doc = await db.collection("listenSessions").findOne({ _id: req.params.id, active: true });
  if (!doc) return res.status(404).json({ error: "Session not found or ended" });
  const refreshed = await refreshListenSessionFromHost(doc);
  res.json(publicListenSession(refreshed));
}));

app.post("/api/listen/sessions/:id/join", requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const userDoc = await db.collection("users").findOne({ _id: userId });
  if (!userDoc) return res.status(404).json({ error: "User not found" });
  const doc = await db.collection("listenSessions").findOne({ _id: req.params.id, active: true });
  if (!doc) return res.status(404).json({ error: "Session not found or ended" });
  const already = (doc.participants || []).some(p => p.username === userDoc.username);
  if (!already) {
    await db.collection("listenSessions").updateOne(
      { _id: doc._id },
      { $push: { participants: { username: userDoc.username, userId: userDoc._id, joinedAt: Date.now() } } }
    );
  }
  const updated = await db.collection("listenSessions").findOne({ _id: doc._id });
  const refreshed = await refreshListenSessionFromHost(updated);
  res.json(publicListenSession(refreshed));
}));

app.post("/api/listen/sessions/:id/leave", requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  await db.collection("listenSessions").updateOne(
    { _id: req.params.id },
    { $pull: { participants: { userId } } }
  );
  res.json({ left: true });
}));

app.post("/api/listen/sessions/:id/end", requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const doc = await db.collection("listenSessions").findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: "Session not found" });
  if (doc.hostUserId !== userId) return res.status(403).json({ error: "Only the host can end this session." });
  await db.collection("listenSessions").updateOne({ _id: req.params.id }, { $set: { active: false } });
  res.json({ ended: true });
}));

app.post("/api/listen/sessions/:id/sync-me", requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const userDoc = await db.collection("users").findOne({ _id: userId });
  if (!userDoc || !userDoc.spotifyAccount || !userDoc.spotifyAccount.connected) {
    return res.status(400).json({ synced: false, reason: "Connect Spotify first." });
  }
  const doc = await db.collection("listenSessions").findOne({ _id: req.params.id, active: true });
  if (!doc) return res.status(404).json({ synced: false, reason: "Session not found or ended" });
  const refreshed = await refreshListenSessionFromHost(doc);
  if (!refreshed.trackUri || !refreshed.isPlaying) {
    return res.json({ synced: false, reason: "The host isn't playing anything right now." });
  }
  const accessToken = await getValidSpotifyAccessToken(userDoc);
  if (!accessToken) {
    return res.json({ synced: false, reason: "Couldn't refresh your Spotify session. Try reconnecting Spotify." });
  }
  const roundTripBufferMs = 1200;
  const targetPosition = Math.max(0, refreshed.progressMs + (Date.now() - refreshed.updatedAt) + roundTripBufferMs);
  try {
    const playRes = await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [refreshed.trackUri], position_ms: targetPosition })
    });
    if (playRes.status === 204) return res.json({ synced: true });
    if (playRes.status === 404) return res.json({ synced: false, reason: "Open Spotify on a device first, then try again." });
    if (playRes.status === 403) return res.json({ synced: false, reason: "Syncing playback needs Spotify Premium." });
    return res.json({ synced: false, reason: "Spotify couldn't sync playback right now." });
  } catch (e) {
    return res.json({ synced: false, reason: "Spotify couldn't sync playback right now." });
  }
}));

// Fetches a URL server-side and pulls out OpenGraph metadata for a link
// preview card - has to happen server-side since the browser can't fetch
// arbitrary cross-origin pages itself (CORS). Deliberately dependency-free
// (plain regex over the raw HTML) rather than pulling in an HTML parser
// just for this. A short timeout keeps a slow/unresponsive external site
// from hanging the request.
app.get("/api/link-preview", linkPreviewRateLimit, asyncHandler(async (req, res) => {
  const url = (req.query.url || "").toString();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "A valid http(s) URL is required." });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const pageRes = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ProgressLinkPreview/1.0)" }
    });
    const html = await pageRes.text();

    const metaValue = (attr, key) => {
      const re1 = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']*)["']`, "i");
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${key}["']`, "i");
      const match = html.match(re1) || html.match(re2);
      return match ? match[1] : null;
    };

    const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = metaValue("property", "og:title") || (titleTagMatch ? titleTagMatch[1].trim() : null);
    const description = metaValue("property", "og:description") || metaValue("name", "description");
    const image = metaValue("property", "og:image");
    let siteName = metaValue("property", "og:site_name");
    if (!siteName) {
      try { siteName = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { siteName = null; }
    }

    if (!title && !description && !image) return res.json({ preview: null });
    res.json({ preview: { title, description, image, siteName, url } });
  } catch (e) {
    res.json({ preview: null });
  } finally {
    clearTimeout(timeout);
  }
}));

app.post("/api/upload-image", uploadRateLimit, asyncHandler(async (req, res) => {
  const { image } = req.body || {};
  if (!image || typeof image !== "string" || !image.startsWith("data:")) {
    return res.status(400).json({ error: "A base64 data URI is required." });
  }
  try {
    const url = await uploadToSupabase(image);
    res.json({ url });
  } catch (e) {
    console.error("Upload failed:", e);
    res.status(502).json({ error: "Could not upload file. Try again." });
  }
}));

// Dedicated video upload endpoint — accepts base64 data URI in `video` or `image` field.
app.post("/api/upload-video", uploadRateLimit, asyncHandler(async (req, res) => {
  const data = (req.body || {}).video || (req.body || {}).image;
  if (!data || typeof data !== "string" || !data.startsWith("data:")) {
    return res.status(400).json({ error: "A base64 video data URI is required." });
  }
  try {
    const url = await uploadToSupabase(data);
    res.json({ url });
  } catch (e) {
    console.error("Video upload failed:", e);
    res.status(502).json({ error: "Could not upload video. Try again." });
  }
}));

app.get("/api/vapid-public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: "Push not configured" });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push-subscribe", requireAuth, asyncHandler(async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription) return res.status(400).json({ error: "subscription required" });
  await db.collection("pushSubscriptions").updateOne(
    { username: req.user.username },
    { $set: { username: req.user.username, subscription, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
}));

app.delete("/api/push-subscribe", requireAuth, asyncHandler(async (req, res) => {
  await db.collection("pushSubscriptions").deleteOne({ username: req.user.username });
  res.json({ ok: true });
}));

app.get("/api/posts", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=60");
  const filter = {};
  if (req.query.author) {
    filter.author = { $regex: `^${escapeRegex(req.query.author)}$`, $options: "i" };
  }
  const cacheKey = req.query.author ? `posts:author:${req.query.author}` : "posts:all";
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  const docs = await db.collection("posts").find(filter, { projection: { content: 0, likedBy: 0 } }).toArray();
  const posts = docs.map(doc => {
    const p = normalizePost(doc);
    if (p.cover && p.cover.startsWith("data:")) p.cover = null;
    return p;
  }).sort((a, b) => new Date(b.createdAt || b.date).getTime() - new Date(a.createdAt || a.date).getTime());
  cacheSet(cacheKey, posts, 20000); // 20 seconds
  res.json(posts);
}));

app.get("/api/posts/:id", asyncHandler(async (req, res) => {
  const doc = await db.collection("posts").findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: "Post not found" });
  res.json(normalizePost(doc));
}));

app.post("/api/posts", requireAuth, asyncHandler(async (req, res) => {
  const { title, cover, excerpt } = req.body;
  const author = req.user.username;
  const content = sanitizePostContent(req.body.content);
  if (!title || !content) return res.status(400).json({ error: "title and content are required" });
  if (await isUsernameBanned(author)) return res.status(403).json({ error: "This account has been banned." });

  // Upload base64 cover + embedded images to Supabase so they're stored as URLs
  let coverUrl = cover || null;
  if (coverUrl && coverUrl.startsWith("data:")) {
    try { coverUrl = await uploadToSupabase(coverUrl); } catch (e) { /* keep base64 on failure */ }
  }
  const processedContent = await uploadBase64InHtml(content);

  const createdAt = new Date().toISOString();
  const post = {
    _id: generateId("p"),
    author,
    title,
    date: createdAt.slice(0, 10),
    createdAt,
    cover: coverUrl,
    excerpt: excerpt || content.replace(/<[^>]+>/g, "").slice(0, 140),
    content: processedContent,
    likes: 0,
    likedBy: []
  };
  await db.collection("posts").insertOne(post);
  cacheInvalidate("posts:all", `posts:author:${author}`, "explore:anon", `explore:${author}`);
  await notifyMentionedUsers({
    text: content.replace(/<[^>]+>/g, " "),
    author,
    context: { postId: post._id, postTitle: post.title, via: "post" }
  });
  res.status(201).json(toClient(post));
}));

// Admin-only: update post fields (category, title, etc.)
app.patch("/api/posts/:id", requireAuth, asyncHandler(async (req, res) => {
  const post = await db.collection("posts").findOne({ _id: req.params.id });
  if (!post) return res.status(404).json({ error: "Post not found" });
  const isAdmin = ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase());
  const isAuthor = post.author === req.user.username;
  if (!isAdmin && !isAuthor) return res.status(403).json({ error: "Not allowed." });
  const allowed = ["category", "title", "excerpt", "cover", "content"];
  const update = {};
  for (const key of allowed) {
    if (key in req.body) update[key] = req.body[key] === "" ? null : req.body[key];
  }
  if (!Object.keys(update).length) return res.status(400).json({ error: "Nothing to update." });
  // Upload any base64 images to Supabase
  if (update.cover && update.cover.startsWith("data:")) {
    try { update.cover = await uploadToSupabase(update.cover); } catch (e) {}
  }
  if (update.content) {
    update.content = await uploadBase64InHtml(update.content);
  }
  await db.collection("posts").updateOne({ _id: req.params.id }, { $set: update });
  cacheInvalidate("posts:all", `posts:author:${post.author}`, "explore:anon");
  const updated = await db.collection("posts").findOne({ _id: req.params.id });
  res.json(normalizePost(updated));
}));

app.delete("/api/posts/:id", requireAuth, asyncHandler(async (req, res) => {
  const post = await db.collection("posts").findOne({ _id: req.params.id });
  if (!post) return res.status(404).json({ error: "Post not found" });
  const isAdmin = ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase());
  if (post.author !== req.user.username && !isAdmin) return res.status(403).json({ error: "You can only delete your own entries." });
  await db.collection("posts").deleteOne({ _id: req.params.id });
  await db.collection("comments").deleteMany({ postId: req.params.id });
  await db.collection("notifications").deleteMany({ postId: req.params.id });
  cacheInvalidate("posts:all", `posts:author:${post.author}`, "explore:anon");
  if (isAdmin && post.author !== req.user.username) {
    auditLog(req.user.username, "delete_post", post.author, { postId: post._id, title: post.title });
  }
  res.status(204).end();
}));

app.get("/api/posts/:id/comments", asyncHandler(async (req, res) => {
  const docs = await db.collection("comments").find({ postId: req.params.id }).toArray();
  const comments = docs.map(toClient).sort((a, b) => new Date(a.time) - new Date(b.time));
  res.json(comments);
}));

app.post("/api/posts/:id/comments", requireAuth, asyncHandler(async (req, res) => {
  const post = await db.collection("posts").findOne({ _id: req.params.id });
  const { body, image } = req.body;
  const author = req.user.username;
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (!body && !image) return res.status(400).json({ error: "body or image are required" });
  if (await isUsernameBanned(author)) return res.status(403).json({ error: "This account has been banned." });
  const comment = {
    _id: generateId("c"),
    postId: post._id,
    author,
    body: body || "",
    image: image || null,
    time: new Date().toISOString()
  };
  await db.collection("comments").insertOne(comment);
  if (post.author !== author) {
    await createNotification({
      _id: generateId("n"),
      type: "reply",
      actor: author,
      recipient: post.author,
      postId: post._id,
      postTitle: post.title,
      body: body || "",
      time: new Date().toISOString(),
      seen: false
    });
  }
  await notifyMentionedUsers({
    text: body || "",
    author,
    skipUsernames: [post.author.toLowerCase()],
    context: { postId: post._id, postTitle: post.title, via: "comment" }
  });
  res.status(201).json(toClient(comment));
}));

app.delete("/api/posts/:id/comments/:commentId", requireAuth, asyncHandler(async (req, res) => {
  const comment = await db.collection("comments").findOne({ _id: req.params.commentId, postId: req.params.id });
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  const post = await db.collection("posts").findOne({ _id: req.params.id });
  const isCommentAuthor = comment.author === req.user.username;
  const isPostAuthor = post && post.author === req.user.username;
  if (!isCommentAuthor && !isPostAuthor) {
    return res.status(403).json({ error: "You can only delete your own replies." });
  }
  await db.collection("comments").deleteOne({ _id: req.params.commentId, postId: req.params.id });
  res.status(204).end();
}));

app.post("/api/posts/:id/like", requireAuth, asyncHandler(async (req, res) => {
  const posts = db.collection("posts");
  const post = await posts.findOne({ _id: req.params.id });
  const username = req.user.username;
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (await isUsernameBanned(username)) return res.status(403).json({ error: "This account has been banned." });
  const likedBy = Array.isArray(post.likedBy) ? post.likedBy : [];
  let likes = typeof post.likes === "number" ? post.likes : 0;
  const idx = likedBy.indexOf(username);
  if (idx === -1) {
    likedBy.push(username);
    likes += 1;
    if (post.author !== username) {
      await createNotification({
        _id: generateId("n"),
        type: "like",
        actor: username,
        recipient: post.author,
        postId: post._id,
        postTitle: post.title,
        time: new Date().toISOString(),
        seen: false
      });
    }
  } else {
    likedBy.splice(idx, 1);
    likes = Math.max(0, likes - 1);
  }
  await posts.updateOne({ _id: post._id }, { $set: { likedBy, likes } });
  const updated = await posts.findOne({ _id: post._id });
  res.json(normalizePost(updated));
}));

app.get("/api/notifications", asyncHandler(async (req, res) => {
  const recipient = req.query.recipient;
  if (!recipient) return res.status(400).json({ error: "recipient is required" });
  const docs = await db.collection("notifications").find({ recipient }).toArray();
  const notifications = docs.map(toClient).sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json(notifications);
}));

app.post("/api/notifications/mark-seen", asyncHandler(async (req, res) => {
  const recipient = req.body.recipient;
  if (!recipient) return res.status(400).json({ error: "recipient is required" });
  await db.collection("notifications").updateMany({ recipient }, { $set: { seen: true } });
  res.json({ ok: true });
}));

app.delete("/api/notifications/:id", requireAuth, asyncHandler(async (req, res) => {
  await db.collection("notifications").deleteOne({ _id: req.params.id, recipient: req.user.username });
  res.json({ ok: true });
}));

async function createChatMessage({ room, author, body, image, replyTo, msgType, songData, gameData }) {
  const targetRoom = (room || DEFAULT_CHAT_ROOM).toString().slice(0, 200);
  const trimmed = (body || "").toString().trim();
  const safeImage = (typeof image === "string" && image.startsWith("https://")) ? image : null;
  const hasSongData = msgType === "song" && songData && typeof songData === "object";
  const hasGameData = msgType === "game" && gameData && typeof gameData === "object";

  // ── Poll detection: /poll [Nh|Nm] Question; Option A; Option B ──────────
  if (trimmed.startsWith("/poll ")) {
    let rest = trimmed.slice(6).trim();
    // Optional duration prefix: 2h, 30m, 1d, etc.
    let closesAt = null;
    const durMatch = rest.match(/^(\d+)(h|m|d)\s+/i);
    if (durMatch) {
      const n = parseInt(durMatch[1], 10);
      const unit = durMatch[2].toLowerCase();
      const ms = unit === "m" ? n * 60000 : unit === "h" ? n * 3600000 : n * 86400000;
      closesAt = new Date(Date.now() + ms).toISOString();
      rest = rest.slice(durMatch[0].length);
    }
    const parts = rest.split(";").map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      const [question, ...opts] = parts;
      const pollMsg = {
        _id: generateId("m"),
        room: targetRoom,
        author,
        body: "",
        type: "poll",
        pollData: { question: question.slice(0, 200), options: opts.slice(0, 4).map(o => o.slice(0, 100)) },
        votes: {},
        closesAt,
        time: new Date().toISOString(),
      };
      await db.collection("messages").insertOne(pollMsg);
      const clientPollMsg = normalizeChatMessage(pollMsg);
      broadcastToRoom(targetRoom, { type: "message", message: clientPollMsg });
      return clientPollMsg;
    }
  }

  if (!author || (!trimmed && !safeImage && !hasSongData && !hasGameData)) return null;
  if (!canAccessRoom(targetRoom, author)) return null;
  if (await isUsernameBanned(author)) return null;
  const safeReplyTo = replyTo && typeof replyTo === "object" ? {
    id:     String(replyTo.id     || "").slice(0, 50),
    author: String(replyTo.author || "").slice(0, 50),
    body:   String(replyTo.body   || "").slice(0, 300)
  } : null;
  const safeSongData = hasSongData ? {
    id:         String(songData.id     || "").slice(0, 50),
    name:       String(songData.name   || "").slice(0, 200),
    artists:    String(songData.artists|| "").slice(0, 200),
    albumArt:   typeof songData.albumArt === "string" && songData.albumArt.startsWith("https://") ? songData.albumArt : null,
    previewUrl: typeof songData.previewUrl === "string" && songData.previewUrl.startsWith("https://") ? songData.previewUrl : null,
    spotifyUrl: typeof songData.spotifyUrl === "string" && songData.spotifyUrl.startsWith("https://") ? songData.spotifyUrl : null,
  } : null;
  const safeGameData = hasGameData ? {
    gameType: String(gameData.gameType || "").slice(0, 20),
    prompt:   String(gameData.prompt   || "").slice(0, 300),
    optionA:  gameData.optionA ? String(gameData.optionA).slice(0, 200) : undefined,
    optionB:  gameData.optionB ? String(gameData.optionB).slice(0, 200) : undefined,
  } : null;
  const message = {
    _id: generateId("m"),
    room: targetRoom,
    author,
    body: trimmed.slice(0, 2000),
    image: safeImage,
    replyTo: safeReplyTo,
    type: safeSongData ? "song" : safeGameData ? "game" : undefined,
    songData: safeSongData,
    gameData: safeGameData,
    time: new Date().toISOString()
  };
  await db.collection("messages").insertOne(message);
  const clientMessage = normalizeChatMessage(message);
  broadcastToRoom(targetRoom, { type: "message", message: clientMessage });

  try {
    const participants = dmParticipants(targetRoom);
    if (participants) {
      const recipient = participants.find(p => p !== author);
      if (recipient) {
        // Skip notification + unread badge if recipient is actively viewing this DM
        const recipientInRoom = isUserActiveInRoom(recipient, targetRoom);
        if (!recipientInRoom) {
          await createNotification({
            _id: generateId("n"),
            type: "message",
            actor: author,
            recipient,
            room: targetRoom,
            body: message.body,
            time: new Date().toISOString(),
            seen: false
          });
          // Push unread badge to recipient's sidebar (other tabs / other rooms)
          const recipientConnections = usernameConnections.get(recipient);
          if (recipientConnections) {
            const payload = JSON.stringify({ type: "dm-notify", room: targetRoom, from: author });
            for (const conn of recipientConnections) {
              if (conn.readyState === conn.OPEN) conn.send(payload);
            }
          }
        }
      }
    } else {
      await notifyMentionedUsers({ text: message.body, author, context: { room: targetRoom } });
    }
  } catch (e) {
    console.error("Chat notification failed:", e);
  }

  return clientMessage;
}

// ── Chat: community rooms ────────────────────────────────────────────────────
// GET  — list all community rooms (non-DM)
app.get("/api/chat/rooms", requireAuth, asyncHandler(async (req, res) => {
  const username = req.user.username;
  const rooms = await db.collection("chatRoomDefs")
    .find({})
    .sort({ createdAt: 1 })
    .limit(200)
    .toArray();
  res.json(rooms.map(r => ({
    room:          r.room,
    label:         r.label,
    topic:         r.topic || "",
    image:         r.image || null,
    icon:          r.icon  || null,
    color:         r.color || null,
    isPrivate:     r.isPrivate || false,
    createdBy:     r.createdBy || null,
    createdAt:     r.createdAt || null,
    memberCount:   (r.members || []).length,
    joined:        (r.members || []).includes(username),
    pinnedMsg:     r.pinnedMsg || null,
    inviteCode:    r.inviteCode || null,
    communityMods: r.communityMods || [],
  })));
}));

// POST — join a community room
app.post("/api/chat/rooms/:room/join", requireAuth, asyncHandler(async (req, res) => {
  const { room } = req.params;
  const username = req.user.username;
  const result = await db.collection("chatRoomDefs").updateOne(
    { room },
    { $addToSet: { members: username } }
  );
  if (!result.matchedCount) return res.status(404).json({ error: "Room not found." });
  res.json({ ok: true });
}));

// POST — leave a community room
app.post("/api/chat/rooms/:room/leave", requireAuth, asyncHandler(async (req, res) => {
  const { room } = req.params;
  const username = req.user.username;
  await db.collection("chatRoomDefs").updateOne(
    { room },
    { $pull: { members: username } }
  );
  res.json({ ok: true });
}));

// GET — members of a room (includes communityMods and owner)
app.get("/api/chat/rooms/:room/members", requireAuth, asyncHandler(async (req, res) => {
  const { room } = req.params;
  const doc = await db.collection("chatRoomDefs").findOne({ room });
  if (!doc) return res.status(404).json({ error: "Room not found." });
  res.json({
    members:       doc.members || [],
    memberCount:   (doc.members || []).length,
    communityMods: doc.communityMods || [],
    owner:         doc.createdBy || null,
  });
}));

// POST — create a new community room
app.post("/api/chat/rooms", requireAuth, asyncHandler(async (req, res) => {
  const { name, label, topic } = req.body || {};
  if (!name || !label) return res.status(400).json({ error: "Name and label are required." });

  // Sanitise room ID: lowercase, alphanumeric + hyphens only
  const roomId = name.toString().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 60);
  if (!roomId) return res.status(400).json({ error: "Invalid room name." });

  // Don't allow duplicating "global" or "dm:…" patterns
  if (roomId === "global" || roomId.startsWith("dm-")) return res.status(400).json({ error: "That name is reserved." });

  const existing = await db.collection("chatRoomDefs").findOne({ room: roomId });
  if (existing) return res.status(409).json({ error: "A room with that ID already exists." });

  const doc = {
    room:      roomId,
    label:     label.toString().slice(0, 80),
    topic:     (topic || "").toString().slice(0, 200),
    image:     null,
    createdBy: req.user.username,
    createdAt: new Date().toISOString(),
  };
  await db.collection("chatRoomDefs").insertOne(doc);
  res.json({ room: doc.room, label: doc.label, topic: doc.topic, createdAt: doc.createdAt });
}));

// PATCH — edit a community room (moderator, or the room's creator)
app.patch("/api/chat/rooms/:room", requireAuth, asyncHandler(async (req, res) => {
  const roomId = req.params.room;
  const doc = await db.collection("chatRoomDefs").findOne({ room: roomId });
  if (!doc) return res.status(404).json({ error: "Room not found." });
  // Use DB role as fallback for tokens issued before adminRole was included in JWT
  const role = req.user.adminRole || await getAdminRole(req.user.username);
  const isMod = ROLE_WEIGHTS[role] >= ROLE_WEIGHTS["moderator"];
  const isCreator = doc.createdBy === req.user.username;
  if (!isMod && !isCreator) return res.status(403).json({ error: "Not allowed." });
  const { image, icon, topic, label, color, isPrivate } = req.body || {};
  const update = {};
  // image / icon accept null (clear), https URL, or base64 data URL
  const isValidImg = v => v === null || (typeof v === "string" && (v.startsWith("http") || v.startsWith("data:image/")));
  if (isValidImg(image)) update.image = image === null ? null : image.trim();
  if (isValidImg(icon))  update.icon  = icon  === null ? null : icon.trim();
  if (typeof topic === "string")  update.topic     = topic.trim().slice(0, 200);
  if (typeof label === "string" && label.trim()) update.label = label.trim().slice(0, 50);
  if (typeof color === "string")  update.color     = color.slice(0, 30);
  if (typeof isPrivate === "boolean") update.isPrivate = isPrivate;
  if (!Object.keys(update).length) return res.status(400).json({ error: "Nothing to update." });
  await db.collection("chatRoomDefs").updateOne({ room: roomId }, { $set: update });
  res.json({ ok: true, ...update });
}));

// DELETE — remove a community room (moderator, or the room's creator)
app.delete("/api/chat/rooms/:room", requireAuth, asyncHandler(async (req, res) => {
  const roomId = req.params.room;
  const doc = await db.collection("chatRoomDefs").findOne({ room: roomId });
  if (!doc) return res.status(404).json({ error: "Room not found." });
  // Use DB role as fallback for tokens issued before adminRole was included in JWT
  const role = req.user.adminRole || await getAdminRole(req.user.username);
  const isMod = ROLE_WEIGHTS[role] >= ROLE_WEIGHTS["moderator"];
  const isCreator = doc.createdBy === req.user.username;
  if (!isMod && !isCreator) return res.status(403).json({ error: "Not allowed." });
  await db.collection("chatRoomDefs").deleteOne({ room: roomId });
  // Also remove all messages in the room
  await db.collection("messages").deleteMany({ room: roomId }).catch(() => {});
  res.json({ ok: true });
}));

// ── Community helpers ────────────────────────────────────────────────────────

function canManageRoom(doc, username, reqUser) {
  const role = reqUser?.adminRole;
  const isMod = ROLE_WEIGHTS[role] >= ROLE_WEIGHTS["moderator"];
  const isCreator = doc.createdBy === username;
  const isCommunityMod = Array.isArray(doc.communityMods) && doc.communityMods.includes(username);
  return isMod || isCreator || isCommunityMod;
}

// ── Pinned messages ──────────────────────────────────────────────────────────

// PUT — pin a message in a community room (owner/mod only)
app.put("/api/chat/rooms/:room/pin", requireAuth, asyncHandler(async (req, res) => {
  const roomId = req.params.room;
  const doc = await db.collection("chatRoomDefs").findOne({ room: roomId });
  if (!doc) return res.status(404).json({ error: "Room not found." });
  if (!canManageRoom(doc, req.user.username, req.user)) return res.status(403).json({ error: "Not allowed." });
  const { messageId } = req.body;
  if (!messageId) return res.status(400).json({ error: "messageId required." });
  const msg = await db.collection("messages").findOne({ _id: messageId });
  if (!msg) return res.status(404).json({ error: "Message not found." });
  const pinnedMsg = { id: msg._id, author: msg.author, body: (msg.body || "").slice(0, 200), time: msg.time };
  await db.collection("chatRoomDefs").updateOne({ room: roomId }, { $set: { pinnedMsg } });
  broadcastToRoom(roomId, { type: "pin", pinnedMsg });
  res.json({ ok: true, pinnedMsg });
}));

// DELETE — unpin message
app.delete("/api/chat/rooms/:room/pin", requireAuth, asyncHandler(async (req, res) => {
  const roomId = req.params.room;
  const doc = await db.collection("chatRoomDefs").findOne({ room: roomId });
  if (!doc) return res.status(404).json({ error: "Room not found." });
  if (!canManageRoom(doc, req.user.username, req.user)) return res.status(403).json({ error: "Not allowed." });
  await db.collection("chatRoomDefs").updateOne({ room: roomId }, { $unset: { pinnedMsg: "" } });
  broadcastToRoom(roomId, { type: "pin", pinnedMsg: null });
  res.json({ ok: true });
}));

// ── Invite links ─────────────────────────────────────────────────────────────

function generateInviteCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// POST — generate or retrieve invite link for a room (owner/mod only)
app.post("/api/chat/rooms/:room/invite", requireAuth, asyncHandler(async (req, res) => {
  const roomId = req.params.room;
  const doc = await db.collection("chatRoomDefs").findOne({ room: roomId });
  if (!doc) return res.status(404).json({ error: "Room not found." });
  if (!canManageRoom(doc, req.user.username, req.user)) return res.status(403).json({ error: "Not allowed." });
  let code = doc.inviteCode;
  if (!code) {
    code = generateInviteCode();
    await db.collection("chatRoomDefs").updateOne({ room: roomId }, { $set: { inviteCode: code } });
  }
  res.json({ ok: true, code });
}));

// GET — preview a room by invite code (public)
app.get("/api/invite/:code", asyncHandler(async (req, res) => {
  const code = req.params.code;
  const doc = await db.collection("chatRoomDefs").findOne({ inviteCode: code });
  if (!doc) return res.status(404).json({ error: "Invalid invite link." });
  res.json({
    room:        doc.room,
    label:       doc.label,
    icon:        doc.icon  || null,
    color:       doc.color || null,
    memberCount: (doc.members || []).length,
  });
}));

// POST — accept an invite and join the room
app.post("/api/invite/:code/accept", requireAuth, asyncHandler(async (req, res) => {
  const code = req.params.code;
  const doc = await db.collection("chatRoomDefs").findOne({ inviteCode: code });
  if (!doc) return res.status(404).json({ error: "Invalid invite link." });
  const username = req.user.username;
  const alreadyMember = (doc.members || []).includes(username);
  await db.collection("chatRoomDefs").updateOne({ inviteCode: code }, { $addToSet: { members: username } });
  // Broadcast a welcome system message to the room
  if (!alreadyMember) {
    const joinMsg = {
      _id: generateId("m"),
      room: doc.room,
      author: "system",
      body: `👋 @${username} joined the community!`,
      type: "join",
      time: new Date().toISOString(),
    };
    await db.collection("messages").insertOne(joinMsg);
    broadcastToRoom(doc.room, { type: "message", message: normalizeChatMessage(joinMsg) });
  }
  res.json({ ok: true, room: doc.room, label: doc.label });
}));

// ── Community moderators ─────────────────────────────────────────────────────

// PUT — promote a member to community mod (creator or global mod only)
app.put("/api/chat/rooms/:room/mods/:username", requireAuth, asyncHandler(async (req, res) => {
  const roomId = req.params.room;
  const targetUser = req.params.username;
  const doc = await db.collection("chatRoomDefs").findOne({ room: roomId });
  if (!doc) return res.status(404).json({ error: "Room not found." });
  const isMod = ROLE_WEIGHTS[req.user.adminRole] >= ROLE_WEIGHTS["moderator"];
  const isCreator = doc.createdBy === req.user.username;
  if (!isMod && !isCreator) return res.status(403).json({ error: "Not allowed." });
  await db.collection("chatRoomDefs").updateOne({ room: roomId }, { $addToSet: { communityMods: targetUser } });
  broadcastToRoom(roomId, { type: "room-update", room: roomId });
  res.json({ ok: true });
}));

// DELETE — demote a community mod
app.delete("/api/chat/rooms/:room/mods/:username", requireAuth, asyncHandler(async (req, res) => {
  const roomId = req.params.room;
  const targetUser = req.params.username;
  const doc = await db.collection("chatRoomDefs").findOne({ room: roomId });
  if (!doc) return res.status(404).json({ error: "Room not found." });
  const isMod = ROLE_WEIGHTS[req.user.adminRole] >= ROLE_WEIGHTS["moderator"];
  const isCreator = doc.createdBy === req.user.username;
  if (!isMod && !isCreator) return res.status(403).json({ error: "Not allowed." });
  await db.collection("chatRoomDefs").updateOne({ room: roomId }, { $pull: { communityMods: targetUser } });
  broadcastToRoom(roomId, { type: "room-update", room: roomId });
  res.json({ ok: true });
}));

// ── Emoji reactions ──────────────────────────────────────────────────────────

const ALLOWED_REACTIONS = ["❤️", "😂", "😮", "😢", "😡", "👍"];

// POST — toggle an emoji reaction on a message
app.post("/api/chat/messages/:id/react", requireAuth, asyncHandler(async (req, res) => {
  const msgId = req.params.id;
  const { emoji } = req.body;
  if (!ALLOWED_REACTIONS.includes(emoji)) return res.status(400).json({ error: "Invalid emoji." });
  const username = req.user.username;
  const msg = await db.collection("messages").findOne({ _id: msgId });
  if (!msg) return res.status(404).json({ error: "Message not found." });
  const reactions = msg.reactions ? { ...msg.reactions } : {};
  const existingUsers = reactions[emoji] || [];
  if (existingUsers.includes(username)) {
    const updated = existingUsers.filter(u => u !== username);
    if (updated.length === 0) delete reactions[emoji];
    else reactions[emoji] = updated;
  } else {
    reactions[emoji] = [...existingUsers, username];
    if (msg.author !== username) {
      await createNotification({
        _id: generateId("n"),
        type: "reaction",
        actor: username,
        recipient: msg.author,
        room: msg.room,
        messageId: msgId,
        body: `${emoji} on: "${(msg.body || "").slice(0, 60)}"`,
        time: new Date().toISOString(),
        seen: false
      });
    }
  }
  await db.collection("messages").updateOne({ _id: msgId }, { $set: { reactions } });
  broadcastToRoom(msg.room, { type: "reaction", messageId: msgId, reactions });
  res.json({ ok: true, reactions });
}));

// ── Polls ────────────────────────────────────────────────────────────────────

// POST — vote on a poll message
app.post("/api/chat/messages/:id/vote", requireAuth, asyncHandler(async (req, res) => {
  const msgId = req.params.id;
  const { optionIndex } = req.body;
  const username = req.user.username;
  const msg = await db.collection("messages").findOne({ _id: msgId });
  if (!msg || msg.type !== "poll") return res.status(404).json({ error: "Poll not found." });
  if (msg.closesAt && new Date(msg.closesAt) < new Date()) return res.status(400).json({ error: "Poll has closed." });
  const opts = (msg.pollData && msg.pollData.options) || [];
  if (typeof optionIndex !== "number" || optionIndex < 0 || optionIndex >= opts.length) {
    return res.status(400).json({ error: "Invalid option." });
  }
  const votes = msg.votes ? { ...msg.votes } : {};
  // Remove any prior vote by this user
  for (const k of Object.keys(votes)) {
    votes[k] = votes[k].filter(u => u !== username);
    if (votes[k].length === 0) delete votes[k];
  }
  votes[optionIndex] = [...(votes[optionIndex] || []), username];
  await db.collection("messages").updateOne({ _id: msgId }, { $set: { votes } });
  broadcastToRoom(msg.room, { type: "vote", messageId: msgId, votes });
  res.json({ ok: true, votes });
}));

// ── Limited-time Events ───────────────────────────────────────────────────────

// Seed a default event if the collection is empty (runs once at startup)
async function seedDefaultEvent() {
  try {
    const count = await db.collection("events").countDocuments();
    if (count > 0) return;
    await db.collection("events").insertOne({
      id:          "candy-cascade-aug2026",
      title:       "Sweet Cascade",
      emoji:       "🍬",
      description: "The candies are falling and it's up to you to clear the board. Match sweets, rack up combos, and climb the leaderboard before time runs out.",
      teaser:      "Match sweets, rack up combos, and fight for the top spot.",
      game:        "candy",
      startDate:   new Date("2026-08-01T00:00:00Z"),
      endDate:     new Date("2026-08-31T23:59:59Z"),
      active:      true,
      gradient:    "linear-gradient(135deg, #ff6b9d 0%, #ffd93d 50%, #ff6b35 100%)",
      prizeNote:   "Top 3 players earn an exclusive limited badge 🏆",
      createdAt:   new Date(),
    });
    console.log("[events] Seeded default event: candy-cascade-aug2026");
  } catch (e) {
    console.warn("[events] Seed error:", e.message);
  }
}

// GET — current active event (public)
app.get("/api/events/current", asyncHandler(async (req, res) => {
  const now = new Date();
  const event = await db.collection("events").findOne({
    active: true,
    startDate: { $lte: now },
    endDate:   { $gte: now },
  }, { sort: { startDate: -1 } });
  if (!event) return res.json(null);
  const { _id, ...safe } = event;
  res.json(safe);
}));

// GET — leaderboard for an event (top 10 + community stats, public)
app.get("/api/events/:id/leaderboard", asyncHandler(async (req, res) => {
  const eventId = req.params.id;

  // Optional auth — detect viewer for personal rank
  let viewerUsername = null;
  try {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      const payload = require("jsonwebtoken").verify(auth.slice(7), JWT_SECRET);
      viewerUsername = payload.username;
    }
  } catch (e) {}

  // All-time best scores per user (ranked)
  const allRanked = await db.collection("eventScores").aggregate([
    { $match: { eventId } },
    { $group: { _id: "$username", score: { $max: "$score" }, submittedAt: { $first: "$submittedAt" } } },
    { $sort:  { score: -1 } },
  ]).toArray();

  const totalPlayers = allRanked.length;
  const totalSubmissions = await db.collection("eventScores").countDocuments({ eventId });

  // Viewer's personal rank
  let userRank = null, userBest = null;
  if (viewerUsername) {
    const idx = allRanked.findIndex(r => r._id === viewerUsername);
    if (idx >= 0) { userRank = idx + 1; userBest = allRanked[idx].score; }
  }

  const top10 = allRanked.slice(0, 10);
  const usernames = top10.map(r => r._id);
  const users = usernames.length
    ? await db.collection("users").find({ username: { $in: usernames } }, { projection: { username: 1, name: 1, avatar: 1 } }).toArray()
    : [];
  const userMap = Object.fromEntries(users.map(u => [u.username, u]));

  const leaderboard = top10.map((r, i) => ({
    rank:        i + 1,
    username:    r._id,
    name:        userMap[r._id]?.name || r._id,
    avatar:      userMap[r._id]?.avatar || null,
    score:       r.score,
    submittedAt: r.submittedAt,
  }));

  res.json({ leaderboard, totalPlayers, totalSubmissions, userRank, userBest });
}));

// POST — submit a score (auth required)
app.post("/api/events/:id/score", requireAuth, asyncHandler(async (req, res) => {
  const eventId = req.params.id;
  const score   = parseInt(req.body?.score, 10);
  if (!Number.isFinite(score) || score < 0 || score > 999999) {
    return res.status(400).json({ error: "Invalid score." });
  }
  const event = await db.collection("events").findOne({ id: eventId, active: true });
  if (!event) return res.status(404).json({ error: "Event not found or inactive." });
  const now = new Date();
  if (now < event.startDate || now > event.endDate) {
    return res.status(400).json({ error: "Event is not currently active." });
  }
  await db.collection("eventScores").insertOne({
    eventId,
    username:    req.user.username,
    score,
    submittedAt: now,
  });
  // Return the user's personal best
  const best = await db.collection("eventScores").aggregate([
    { $match: { eventId, username: req.user.username } },
    { $group: { _id: null, best: { $max: "$score" } } },
  ]).toArray();
  res.json({ ok: true, best: best[0]?.best ?? score });
}));

// GET — personal score history (last 5 runs, auth required)
app.get("/api/events/:id/my-history", requireAuth, asyncHandler(async (req, res) => {
  const eventId  = req.params.id;
  const username = req.user.username;
  const runs = await db.collection("eventScores")
    .find({ eventId, username })
    .sort({ submittedAt: -1 })
    .limit(5)
    .toArray();
  res.json(runs.map(r => ({ score: r.score, submittedAt: r.submittedAt })));
}));

// (admin) POST — create or update an event
app.post("/api/events", requireAuth, requireRole("owner"), asyncHandler(async (req, res) => {
  const { id, title, emoji, description, teaser, game, startDate, endDate, gradient, prizeNote } = req.body || {};
  if (!id || !title) return res.status(400).json({ error: "id and title required." });
  await db.collection("events").updateOne(
    { id },
    { $set: { id, title, emoji: emoji || "🎮", description, teaser, game: game || "candy",
               startDate: new Date(startDate), endDate: new Date(endDate),
               gradient, prizeNote, active: true, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
}));

app.get("/api/chat/messages", requireAuth, asyncHandler(async (req, res) => {
  const room = (req.query.room || DEFAULT_CHAT_ROOM).toString().slice(0, 200);
  const viewer = req.user.username;
  if (dmParticipants(room) && !canAccessRoom(room, viewer)) {
    return res.status(403).json({ error: "Not a participant in this conversation" });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const docs = await db.collection("messages")
    .find({ room })
    .sort({ time: -1 })
    .limit(limit)
    .toArray();
  res.json(docs.map(normalizeChatMessage).reverse());
}));

app.get("/api/chat/conversations", requireAuth, asyncHandler(async (req, res) => {
  const username = req.user.username;
  const rooms = await db.collection("messages").distinct("room", { room: { $regex: "^dm:" } });
  const mine = rooms.filter(room => canAccessRoom(room, username));
  const conversations = await Promise.all(mine.map(async room => {
    const participants = dmParticipants(room);
    const withUsername = participants.find(p => p !== username) || participants[0];
    const lastDocs = await db.collection("messages").find({ room }).sort({ time: -1 }).limit(1).toArray();
    const readDoc = await db.collection("chatReadState").findOne({ _id: `${username}:${room}` });
    const lastReadAt = readDoc ? readDoc.lastReadAt : null;
    const unreadCount = await db.collection("messages").countDocuments({
      room,
      author: { $ne: username },
      ...(lastReadAt ? { time: { $gt: lastReadAt } } : {})
    });
    return {
      room,
      with: withUsername,
      lastMessage: lastDocs[0] ? normalizeChatMessage(lastDocs[0]) : null,
      unreadCount
    };
  }));
  conversations.sort((a, b) => {
    const at = a.lastMessage ? new Date(a.lastMessage.time).getTime() : 0;
    const bt = b.lastMessage ? new Date(b.lastMessage.time).getTime() : 0;
    return bt - at;
  });
  res.json(conversations);
}));

// Called when someone actually opens/views a conversation - records "now"
// as their last-read point for that room, so unread counts on future
// /api/chat/conversations calls only count messages after this moment.
app.post("/api/chat/mark-read", requireAuth, asyncHandler(async (req, res) => {
  const { room } = req.body || {};
  const username = req.user.username;
  if (!room) return res.status(400).json({ error: "room is required" });
  await db.collection("chatReadState").updateOne(
    { _id: `${username}:${room}` },
    { $set: { username, room, lastReadAt: new Date().toISOString() } },
    { upsert: true }
  );
  res.status(204).end();
}));

app.post("/api/chat/messages", requireAuth, asyncHandler(async (req, res) => {
  const message = await createChatMessage({ ...req.body, author: req.user.username });
  if (!message) return res.status(400).json({ error: "body or image are required" });
  res.status(201).json(message);
}));

const STREAK_MILESTONES = new Set([3, 7, 14, 30, 50, 100]);

async function computeAndSaveStreak(user) {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const lastDate = user.lastLoginDate || null;
  if (lastDate === today) return user; // already logged in today, no change

  let streak = typeof user.streak === "number" ? user.streak : 0;
  if (lastDate) {
    const diffMs = new Date(today + "T00:00:00Z") - new Date(lastDate + "T00:00:00Z");
    const diffDays = Math.round(diffMs / 86400000);
    // Consecutive day: increment. Gap: reset to 0 (not 1)
    streak = diffDays === 1 ? streak + 1 : 0;
  } else {
    // First login ever: start at 0
    streak = 0;
  }

  await db.collection("users").updateOne(
    { _id: user._id },
    { $set: { streak, lastLoginDate: today } }
  );

  if (STREAK_MILESTONES.has(streak)) {
    await createNotification({
      _id: generateId("n"),
      type: "streak",
      recipient: user.username,
      streak,
      time: new Date().toISOString(),
      seen: false
    });
  }

  return { ...user, streak, lastLoginDate: today };
}

app.post("/api/account/password", requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both current and new password are required." });
  if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters." });
  const users = db.collection("users");
  const user = await users.findOne({ _id: req.user.id });
  if (!user) return res.status(404).json({ error: "User not found." });
  if (!verifyPassword(currentPassword, user.password)) return res.status(401).json({ error: "Current password is incorrect." });
  const hashed = hashPassword(newPassword);
  await users.updateOne({ _id: user._id }, { $set: { password: hashed } });
  res.json({ ok: true });
}));

app.post("/api/login", loginRateLimit, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password are required" });
  let user = await db.collection("users").findOne({ username: { $regex: `^${escapeRegex(username)}$`, $options: "i" } });
  if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: "Invalid credentials" });
  if (isLegacyPassword(user.password)) {
    user.password = hashPassword(password);
    await db.collection("users").updateOne({ _id: user._id }, { $set: { password: user.password } });
  }
  await ensureUsernameBadges(user);
  user = await computeAndSaveStreak(user);
  const adminRole = ALLOWED_CREATOR_USERNAMES.has(user.username) ? "owner" : (user.adminRole || null);
  const token = signJWT({ username: user.username, id: user._id, adminRole });
  res.json({ ...publicUser(normalizeUser(user)), token });
}));

app.get("/api/admin/writing-stats", requireAuth, asyncHandler(async (req, res) => {
  if (!ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase())) {
    return res.status(403).json({ error: "Only admins can view this." });
  }
  const posts = await db.collection("posts").find({}, { projection: { content: 0 } }).toArray();

  // Per-author rollup
  const byAuthor = {};
  for (const p of posts) {
    if (!byAuthor[p.author]) byAuthor[p.author] = { posts: 0, likes: 0, words: 0, comments: 0 };
    byAuthor[p.author].posts += 1;
    byAuthor[p.author].likes += typeof p.likes === "number" ? p.likes : 0;
    byAuthor[p.author].words += ((p.excerpt || "") + " " + (p.title || "")).split(/\s+/).filter(Boolean).length;
  }

  // Attach comment counts
  const commentCounts = await db.collection("comments").aggregate([
    { $group: { _id: "$author", count: { $sum: 1 } } }
  ]).toArray();
  for (const c of commentCounts) {
    if (byAuthor[c._id]) byAuthor[c._id].comments = c.count;
  }

  // Monthly post counts (last 12 months)
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);
  const monthly = {};
  for (const p of posts) {
    const d = new Date(p.createdAt || p.date);
    if (d < twelveMonthsAgo) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthly[key] = (monthly[key] || 0) + 1;
  }

  const authors = Object.entries(byAuthor)
    .map(([username, s]) => ({ username, ...s }))
    .sort((a, b) => b.posts - a.posts);

  res.json({ authors, monthly });
}));

app.post("/api/admin/send-digest", requireAuth, asyncHandler(async (req, res) => {
  if (!ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase())) {
    return res.status(403).json({ error: "Only admins can trigger the digest." });
  }
  const result = await sendWeeklyDigest();
  res.json(result);
}));

// ── Admin: custom email blast ─────────────────────────────────────────────────
app.post("/api/admin/send-email", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  const { subject, body, bodyHtml: prebuiltBodyHtml, targetUsername, emoticon, ctaText, ctaUrl, accentColor, buttonColor, footerTagline } = req.body || {};
  if (!subject || (!body && !prebuiltBodyHtml)) return res.status(400).json({ error: "Subject and body are required." });
  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(503).json({ error: "Email not configured — RESEND_API_KEY missing." });
  const site = "https://progressing.online";
  const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const hexRe = /^#[0-9A-Fa-f]{3,6}$/;
  const safeAccent = hexRe.test(accentColor||"") ? accentColor : undefined;
  const safeButton = hexRe.test(buttonColor||"") ? buttonColor : undefined;
  const safeTagline = typeof footerTagline === "string" ? footerTagline.slice(0, 80) : undefined;
  const ALLOWED_EMOTICONS = new Set(["hi","penguin","starbucks","bee","turtle_lazy","hamster","cow","shark","sharkcat","lion","banana","bored","windy","romantic","wonder","asleep_couch","mwa","kiss","computer","computersupport","dark","construction","dexterity"]);
  const emoticonName = typeof emoticon === "string" ? emoticon.replace(/[^a-z0-9_]/gi,"").toLowerCase() : "penguin";
  const emoticonUrl = (emoticon === "" || emoticon === "none") ? null : (ALLOWED_EMOTICONS.has(emoticonName) ? `${site}/images/emoticons/${emoticonName}.png` : `${site}/images/emoticons/penguin.png`);

  const makeHtml = (text) => emailWrap({
    emoticon: emoticonUrl,
    headlineHtml: `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.35;">${esc(subject)}</h1>`,
    // If builder sent pre-built HTML, use it directly (buttons are already embedded as blocks)
    bodyHtml: prebuiltBodyHtml || `<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#4A3728;line-height:1.85;white-space:pre-wrap;">${esc(text)}</p>`,
    ctaText: prebuiltBodyHtml ? "" : (ctaText || "visit progress"),
    ctaUrl: prebuiltBodyHtml ? "" : (ctaUrl || site),
    preview: (text||"").slice(0, 100).replace(/\n/g," "),
    site,
    ...(safeAccent  && { accentColor: safeAccent }),
    ...(safeButton  && { buttonColor: safeButton }),
    ...(safeTagline && { footerTagline: safeTagline }),
  });

  if (targetUsername) {
    const userDoc = await db.collection("users").findOne({ username: targetUsername.toLowerCase() });
    if (!userDoc || !userDoc.email) return res.status(404).json({ error: "User not found or has no email address." });
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Progress <noreply@progressing.online>", to: userDoc.email, subject, html: makeHtml(body) })
    });
    if (!r.ok) { const t = await r.text(); return res.status(502).json({ error: "Resend error", detail: t }); }
    auditLog(req.user.username, "email_sent", targetUsername, { subject });
    return res.json({ sent: 1, to: userDoc.email });
  } else {
    // Send to all users with email + notifications enabled
    const users = await db.collection("users").find({
      email: { $exists: true, $ne: "" },
      emailNotifications: { $ne: false }
    }).toArray();
    let sent = 0, failed = 0;
    for (const u of users) {
      if (!u.email) continue;
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Progress <noreply@progressing.online>", to: u.email, subject, html: makeHtml(body) })
      }).catch(() => null);
      if (r && r.ok) sent++; else failed++;
    }
    auditLog(req.user.username, "email_blast", "all", { subject, sent, failed });
    return res.json({ sent, failed });
  }
}));

// ── Admin: preview email HTML (no send) ───────────────────────────────────────
app.post("/api/admin/preview-email", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  const { subject, body, bodyHtml: prebuiltBodyHtml, emoticon, ctaText, ctaUrl, accentColor, buttonColor, footerTagline } = req.body || {};
  if (!subject && !body && !prebuiltBodyHtml) return res.status(400).json({ error: "Nothing to preview." });
  const site = "https://progressing.online";
  const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const hexRe = /^#[0-9A-Fa-f]{3,6}$/;
  const safeAccent = hexRe.test(accentColor||"") ? accentColor : undefined;
  const safeButton = hexRe.test(buttonColor||"") ? buttonColor : undefined;
  const safeTagline = typeof footerTagline === "string" ? footerTagline.slice(0,80) : undefined;
  const ALLOWED_EMOTICONS = new Set(["hi","penguin","starbucks","bee","turtle_lazy","hamster","cow","shark","sharkcat","lion","banana","bored","windy","romantic","wonder","asleep_couch","mwa","kiss","computer","computersupport","dark","construction","dexterity"]);
  const emoticonName = typeof emoticon === "string" ? emoticon.replace(/[^a-z0-9_]/gi,"").toLowerCase() : "penguin";
  const emoticonUrl = (emoticon === "" || emoticon === "none") ? null : (ALLOWED_EMOTICONS.has(emoticonName) ? `${site}/images/emoticons/${emoticonName}.png` : `${site}/images/emoticons/penguin.png`);
  const html = emailWrap({
    emoticon: emoticonUrl,
    headlineHtml: `<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;font-style:italic;color:#3B2518;line-height:1.35;">${esc(subject)}</h1>`,
    bodyHtml: prebuiltBodyHtml || `<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#4A3728;line-height:1.85;white-space:pre-wrap;">${esc(body||"")}</p>`,
    ctaText: prebuiltBodyHtml ? "" : (ctaText || ""),
    ctaUrl: prebuiltBodyHtml ? "" : (ctaUrl || ""),
    preview: "",
    site,
    ...(safeAccent  && { accentColor: safeAccent }),
    ...(safeButton  && { buttonColor: safeButton }),
    ...(safeTagline && { footerTagline: safeTagline }),
  });
  res.json({ html });
}));

// ── Email Projects (collaborative builder) ────────────────────────────────────
const EMAIL_PRESENCE_TTL = 45_000;

function livePresence(project) {
  const cutoff = Date.now() - EMAIL_PRESENCE_TTL;
  return (project.presence || []).filter(p => new Date(p.lastSeen).getTime() > cutoff);
}

app.get("/api/admin/email-projects", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  const projects = await db.collection("emailProjects").find({}).sort({ updatedAt: -1 }).limit(60).toArray();
  res.json(projects.map(p => ({ ...p, presence: livePresence(p) })));
}));

app.post("/api/admin/email-projects", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  const project = {
    _id: crypto.randomBytes(8).toString("hex"),
    name: String(name || "Untitled email").slice(0, 100),
    subject: "",
    blocks: [],
    emoticon: "penguin",
    accentColor: "#8C6E58",
    footerTagline: "until next time",
    createdBy: req.user.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: req.user.username,
    version: 1,
    presence: [],
  };
  await db.collection("emailProjects").insertOne(project);
  res.json(project);
}));

app.get("/api/admin/email-projects/:id", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  const p = await db.collection("emailProjects").findOne({ _id: req.params.id });
  if (!p) return res.status(404).json({ error: "Project not found" });
  res.json({ ...p, presence: livePresence(p) });
}));

app.put("/api/admin/email-projects/:id", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  const p = await db.collection("emailProjects").findOne({ _id: req.params.id });
  if (!p) return res.status(404).json({ error: "Project not found" });
  const { name, subject, blocks, emoticon, accentColor, footerTagline, clientVersion } = req.body || {};
  // Optimistic concurrency — client sends its version; if server is ahead, signal conflict
  if (clientVersion && p.version > clientVersion) {
    return res.status(409).json({ conflict: true, serverVersion: p.version, project: { ...p, presence: livePresence(p) } });
  }
  const update = {
    ...(name       !== undefined && { name: String(name).slice(0,100) }),
    ...(subject    !== undefined && { subject }),
    ...(blocks     !== undefined && { blocks }),
    ...(emoticon   !== undefined && { emoticon }),
    ...(accentColor !== undefined && { accentColor }),
    ...(footerTagline !== undefined && { footerTagline }),
    updatedAt: new Date().toISOString(),
    updatedBy: req.user.username,
    version: (p.version || 1) + 1,
  };
  await db.collection("emailProjects").updateOne({ _id: req.params.id }, { $set: update });
  res.json({ ok: true, version: update.version });
}));

app.delete("/api/admin/email-projects/:id", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  await db.collection("emailProjects").deleteOne({ _id: req.params.id });
  auditLog(req.user.username, "email_project_deleted", req.params.id, {});
  res.json({ ok: true });
}));

// Heartbeat — keeps user's presence alive; also returns latest project data for sync
app.post("/api/admin/email-projects/:id/presence", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  const p = await db.collection("emailProjects").findOne({ _id: req.params.id });
  if (!p) return res.status(404).json({ error: "Project not found" });
  const { color, selId } = req.body || {};
  const safeColor = /^#[0-9A-Fa-f]{3,6}$/.test(color||"") ? color : "#8C6E58";
  // selId: which block the user is currently editing (short string like "b3", or null)
  const safeSelId = (typeof selId === "string" && /^b\d+$/.test(selId)) ? selId : null;
  const entry = { username: req.user.username, name: req.user.name || req.user.username, color: safeColor, selId: safeSelId, lastSeen: new Date().toISOString() };
  // Remove stale entry for this user then push fresh one
  await db.collection("emailProjects").updateOne({ _id: req.params.id }, { $pull: { presence: { username: req.user.username } } });
  await db.collection("emailProjects").updateOne({ _id: req.params.id }, { $push: { presence: entry } });
  // Also prune stale presence entries (> 2× TTL)
  const cutoff = new Date(Date.now() - EMAIL_PRESENCE_TTL * 2).toISOString();
  await db.collection("emailProjects").updateOne({ _id: req.params.id }, { $pull: { presence: { lastSeen: { $lt: cutoff } } } });
  const fresh = await db.collection("emailProjects").findOne({ _id: req.params.id });
  res.json({ ok: true, project: { ...fresh, presence: livePresence(fresh) } });
}));

app.get("/api/admin/stats", requireAuth, asyncHandler(async (req, res) => {
  if (!ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase())) {
    return res.status(403).json({ error: "Only admins can view this." });
  }
  const users = db.collection("users");
  const posts = db.collection("posts");
  const comments = db.collection("comments");
  const messages = db.collection("messages");

  const [userCount, postCount, commentCount, messageCount, bannedCount, lockedCount, recentUsers, recentPosts] = await Promise.all([
    users.estimatedDocumentCount(),
    posts.estimatedDocumentCount(),
    comments.estimatedDocumentCount(),
    messages.estimatedDocumentCount(),
    users.countDocuments({ banned: true }),
    users.countDocuments({ locked: true }),
    users.find({}, { projection: { password: 0 } }).sort({ joined: -1 }).limit(10).toArray(),
    // Excludes `content` here too, same reasoning as the public list endpoint -
    // a dashboard summary doesn't need full post bodies, just enough to
    // identify each one.
    posts.find({}, { projection: { content: 0 } }).sort({ createdAt: -1 }).limit(10).toArray()
  ]);

  res.json({
    counts: {
      users: userCount,
      posts: postCount,
      comments: commentCount,
      messages: messageCount,
      banned: bannedCount,
      locked: lockedCount
    },
    recentUsers: recentUsers.map(u => publicUser(normalizeUser(u))),
    recentPosts: recentPosts.map(normalizePost)
  });
}));

// ── Bookmarks ───────────────────────────────────────────────────────────────
app.get("/api/bookmarks", requireAuth, asyncHandler(async (req, res) => {
  const username = req.user.username;
  const docs = await db.collection("bookmarks").find({ username }).toArray();
  const postIds = docs.map(d => d.postId);
  if (!postIds.length) return res.json([]);
  const posts = await db.collection("posts").find({ _id: { $in: postIds } }, { projection: { content: 0 } }).toArray();
  res.json(posts.map(normalizePost));
}));

app.post("/api/bookmarks/:postId", requireAuth, asyncHandler(async (req, res) => {
  const username = req.user.username;
  const { postId } = req.params;
  const post = await db.collection("posts").findOne({ _id: postId });
  if (!post) return res.status(404).json({ error: "Post not found" });
  const existing = await db.collection("bookmarks").findOne({ username, postId });
  if (existing) {
    await db.collection("bookmarks").deleteOne({ username, postId });
    return res.json({ bookmarked: false });
  }
  await db.collection("bookmarks").insertOne({ username, postId, createdAt: new Date().toISOString() });
  res.json({ bookmarked: true });
}));

app.get("/api/bookmarks/:postId/status", requireAuth, asyncHandler(async (req, res) => {
  const username = req.user.username;
  const existing = await db.collection("bookmarks").findOne({ username, postId: req.params.postId });
  res.json({ bookmarked: !!existing });
}));

app.get("/api/explore", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  const viewerUsername = req.query.viewer || null;
  const cacheKey = `explore:${viewerUsername || "anon"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Trending: most liked posts in the last 30 days
  const trendingDocs = await db.collection("posts")
    .find({ createdAt: { $gte: thirtyDaysAgo } }, { projection: { content: 0 } })
    .sort({ likes: -1 })
    .limit(20)
    .toArray();

  // Suggested users: most followers, excluding the viewer and anyone they follow
  let excludeUsernames = viewerUsername ? [viewerUsername] : [];
  if (viewerUsername) {
    const viewer = await db.collection("users").findOne({ username: viewerUsername });
    if (viewer && Array.isArray(viewer.following)) {
      excludeUsernames = excludeUsernames.concat(viewer.following);
    }
  }
  const suggestedDocs = await db.collection("users")
    .find({ username: { $nin: excludeUsernames }, banned: { $ne: true } })
    .sort({ "followers.0": -1 })
    .limit(10)
    .toArray();

  // Sort suggested by follower count
  suggestedDocs.sort((a, b) => (b.followers?.length || 0) - (a.followers?.length || 0));

  const result = {
    trending: trendingDocs.map(normalizePost),
    suggested: suggestedDocs.map(d => publicUser(normalizeUser(d)))
  };
  cacheSet(cacheKey, result, 60000); // 60 seconds
  res.json(result);
}));

app.get("/api/online-users", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const statuses = {};
  for (const username of usernameConnections.keys()) {
    statuses[username] = getUserPresenceStatus(username);
  }
  res.json({ statuses });
});

// ── Page view tracking (lightweight, unauthenticated) ─────────────────────────
app.post("/api/track/pageview", asyncHandler(async (req, res) => {
  const { page } = req.body || {};
  if (!page || typeof page !== "string") return res.json({ ok: true });
  const safePage = page.replace(/[^a-zA-Z0-9\-_.]/g, "").slice(0, 60);
  const username = req.user?.username || null; // populated by requireAuth if present
  await db.collection("pageviews").insertOne({
    page: safePage,
    username,
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
  });
  res.json({ ok: true });
}));

app.get("/api/current-user", (req, res) => {
  res.status(200).json({});
});

app.get("/api/me", requireAuth, asyncHandler(async (req, res) => {
  const user = await db.collection("users").findOne({ username: req.user.username }, { projection: { password: 0 } });
  if (!user) return res.status(404).json({ error: "User not found" });
  const pub = publicUser(normalizeUser(user));
  res.json({ ...pub, email: user.email || null, emailNotifications: typeof user.emailNotifications !== "undefined" ? user.emailNotifications : true });
}));

// ── Migration: move base64 images from MongoDB → Supabase ────────────────────
app.post("/api/admin/migrate-posts-to-supabase", requireAuth, asyncHandler(async (req, res) => {
  if (!ALLOWED_CREATOR_USERNAMES.has(req.user.username.toLowerCase())) {
    return res.status(403).json({ error: "Admin only." });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: "Supabase not configured." });
  }

  const posts = await db.collection("posts").find({}).toArray();
  let migrated = 0, skipped = 0, errors = 0;

  for (const post of posts) {
    const update = {};

    // Cover image
    if (post.cover && post.cover.startsWith("data:")) {
      try {
        update.cover = await uploadToSupabase(post.cover);
      } catch (e) {
        console.error(`migrate cover failed for ${post._id}:`, e.message);
        errors++;
      }
    }

    // Embedded images in content
    if (post.content && post.content.includes("data:")) {
      try {
        const cleaned = await uploadBase64InHtml(post.content);
        if (cleaned !== post.content) update.content = cleaned;
      } catch (e) {
        console.error(`migrate content failed for ${post._id}:`, e.message);
        errors++;
      }
    }

    if (Object.keys(update).length) {
      await db.collection("posts").updateOne({ _id: post._id }, { $set: update });
      migrated++;
    } else {
      skipped++;
    }
  }

  res.json({ total: posts.length, migrated, skipped, errors });
}));

// ── Admin: analytics ─────────────────────────────────────────────────────────
app.get("/api/admin/analytics", requireAuth, requireRole("analyst"), asyncHandler(async (req, res) => {
  const now = new Date();

  // --- Date range params ---
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 90);
  const snapDate = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : now.toISOString().slice(0, 10);

  const dayN   = new Date(now - days * 24*60*60*1000).toISOString();
  const day1   = new Date(now - 1  * 24*60*60*1000).toISOString();
  const day7   = new Date(now - 7  * 24*60*60*1000).toISOString();
  const day30  = new Date(now - 30 * 24*60*60*1000).toISOString();

  // Snapshot window: the selected date, midnight-to-midnight
  const snapStart = snapDate + "T00:00:00.000";
  const snapEnd   = snapDate + "T23:59:59.999";

  // --- Aggregate counters ---
  const [activeToday, activeWeek, activeMonth, newSignupsWeek, newSignupsMonth,
         postsToday, commentsToday, messagesToday, signupsToday] = await Promise.all([
    db.collection("users").countDocuments({ lastLoginDate: { $gte: day1 } }),
    db.collection("users").countDocuments({ lastLoginDate: { $gte: day7 } }),
    db.collection("users").countDocuments({ lastLoginDate: { $gte: day30 } }),
    db.collection("users").countDocuments({ joined: { $gte: day7 } }),
    db.collection("users").countDocuments({ joined: { $gte: day30 } }),
    db.collection("posts").countDocuments({ createdAt: { $gte: snapStart, $lte: snapEnd } }),
    db.collection("comments").countDocuments({ createdAt: { $gte: snapStart, $lte: snapEnd } }),
    db.collection("messages").countDocuments({ createdAt: { $gte: snapStart, $lte: snapEnd } }).catch(() => 0),
    db.collection("users").countDocuments({ joined: { $gte: snapStart, $lte: snapEnd } }),
  ]);

  // Active users on snapshot date
  const activeOnDate = await db.collection("users")
    .countDocuments({ lastLoginDate: { $gte: snapStart, $lte: snapEnd } });

  // --- Daily charts (for the requested day window) ---
  const [postsInRange, usersInRange, activeUsersInRange] = await Promise.all([
    db.collection("posts")
      .find({ createdAt: { $gte: dayN } }, { projection: { createdAt: 1 } }).toArray(),
    db.collection("users")
      .find({ joined: { $gte: dayN } }, { projection: { joined: 1 } }).toArray(),
    db.collection("users")
      .find({ lastLoginDate: { $gte: dayN } }, { projection: { lastLoginDate: 1 } }).toArray(),
  ]);

  const postsByDay = {}, signupsByDay = {}, activeByDay = {};
  for (const p of postsInRange) {
    const d = (p.createdAt || "").slice(0, 10);
    if (d) postsByDay[d] = (postsByDay[d] || 0) + 1;
  }
  for (const u of usersInRange) {
    const d = (u.joined || "").slice(0, 10);
    if (d) signupsByDay[d] = (signupsByDay[d] || 0) + 1;
  }
  for (const u of activeUsersInRange) {
    const d = (u.lastLoginDate || "").slice(0, 10);
    if (d) activeByDay[d] = (activeByDay[d] || 0) + 1;
  }

  // --- Top posts (in date range) ---
  const topPosts = await db.collection("posts")
    .find({ createdAt: { $gte: dayN } }, { projection: { content: 0, likedBy: 0 } })
    .sort({ likes: -1 })
    .limit(10)
    .toArray();

  // --- Top authors (all time, with engagement breakdown) ---
  const topAuthors = await db.collection("posts").aggregate([
    { $group: { _id: "$author", posts: { $sum: 1 }, likes: { $sum: "$likes" } } },
    { $sort: { posts: -1 } },
    { $limit: 15 }
  ]).toArray();

  // Enrich top authors with comment counts
  const authorNames = topAuthors.map(a => a._id);
  const commentCounts = await db.collection("comments").aggregate([
    { $match: { author: { $in: authorNames } } },
    { $group: { _id: "$author", comments: { $sum: 1 } } }
  ]).toArray();
  const commentMap = Object.fromEntries(commentCounts.map(c => [c._id, c.comments]));
  topAuthors.forEach(a => { a.comments = commentMap[a._id] || 0; });

  // --- Currently online ---
  const onlineUsernames = [...usernameConnections.keys()];
  const onlineUserDocs = onlineUsernames.length > 0
    ? await db.collection("users")
        .find({ username: { $in: onlineUsernames } }, { projection: { username: 1, name: 1, avatar: 1 } })
        .toArray()
    : [];
  const onlineUsers = onlineUserDocs.map(u => ({
    username: u.username,
    name: u.name || u.username,
    avatar: u.avatar || null,
  }));

  // --- Activity by hour (last 7d — posts + comments) ---
  const last7d = new Date(now - 7*24*60*60*1000).toISOString();
  const [recentPosts7, recentComments7] = await Promise.all([
    db.collection("posts").find({ createdAt: { $gte: last7d } }, { projection: { createdAt: 1 } }).toArray(),
    db.collection("comments").find({ createdAt: { $gte: last7d } }, { projection: { createdAt: 1 } }).toArray(),
  ]);
  const activeByHour = Array(24).fill(0);
  [...recentPosts7, ...recentComments7].forEach(item => {
    if (item.createdAt) activeByHour[new Date(item.createdAt).getHours()]++;
  });

  // --- Top pages ---
  let topPages = [];
  try {
    topPages = await db.collection("pageviews").aggregate([
      { $match: { timestamp: { $gte: dayN } } },
      { $group: { _id: "$page", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 }
    ]).toArray();
  } catch(e) {}

  // --- Page views by day ---
  let pageviewsByDay = {};
  try {
    const pvDocs = await db.collection("pageviews")
      .find({ timestamp: { $gte: dayN } }, { projection: { date: 1 } })
      .toArray();
    for (const p of pvDocs) {
      if (p.date) pageviewsByDay[p.date] = (pageviewsByDay[p.date] || 0) + 1;
    }
  } catch(e) {}

  res.json({
    snapDate, days,
    activeToday, activeWeek, activeMonth,
    newSignupsWeek, newSignupsMonth,
    // Snapshot for selected date
    postsToday, commentsToday, messagesToday, signupsToday,
    activeOnDate,
    // Charts
    postsByDay, signupsByDay, activeByDay, pageviewsByDay,
    // Live
    onlineNow: onlineUsers.length,
    onlineUsers,
    // Sections (lazy rendered)
    activeByHour,
    topPages,
    topPosts: topPosts.map(normalizePost),
    topAuthors,
  });
}));

// ── Admin: user list ──────────────────────────────────────────────────────────
app.get("/api/admin/users-list", requireAuth, requireRole("moderator"), asyncHandler(async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(50, parseInt(req.query.limit) || 25);
  const q     = (req.query.q || "").toLowerCase().trim();

  const filter = q
    ? { $or: [{ username: { $regex: q, $options: "i" } }, { name: { $regex: q, $options: "i" } }] }
    : {};

  const [total, docs] = await Promise.all([
    db.collection("users").countDocuments(filter),
    db.collection("users")
      .find(filter, { projection: { password: 0 } })
      .sort({ joined: -1 })
      .skip(page * limit)
      .limit(limit)
      .toArray()
  ]);

  res.json({ total, page, limit, users: docs.map(u => ({
    ...publicUser(normalizeUser(u)),
    email: u.email || null,
    adminRole: u.adminRole || null,
    emailNotifications: u.emailNotifications !== false, // default true
  })) });
}));

// ── Admin: subscribers list ───────────────────────────────────────────────────
// Users who actually receive emails (have email + notifications on)
app.get("/api/admin/subscribers", requireAuth, requireRole("email_writer"), asyncHandler(async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const q     = (req.query.q || "").toLowerCase().trim();

  const baseFilter = {
    email: { $exists: true, $ne: "" },
    emailNotifications: { $ne: false },
  };
  const filter = q
    ? { ...baseFilter, $or: [{ username: { $regex: q, $options: "i" } }, { name: { $regex: q, $options: "i" } }, { email: { $regex: q, $options: "i" } }] }
    : baseFilter;

  const [total, docs] = await Promise.all([
    db.collection("users").countDocuments(filter),
    db.collection("users")
      .find(filter, { projection: { password: 0 } })
      .sort({ joined: -1 })
      .skip(page * limit)
      .limit(limit)
      .toArray()
  ]);

  res.json({ total, page, limit, users: docs.map(u => ({
    ...publicUser(normalizeUser(u)),
    email: u.email || null,
    joined: u.joined || null,
    emailNotifications: u.emailNotifications !== false,
  })) });
}));

// ── Chat: submit report ───────────────────────────────────────────────────────
app.post("/api/chat/reports", requireAuth, asyncHandler(async (req, res) => {
  const { messageId, room, author, body, reason } = req.body || {};
  if (!messageId || !reason) return res.status(400).json({ error: "Missing fields." });
  const VALID_REASONS = ["spam","harassment","hate","misinformation","inappropriate","other"];
  if (!VALID_REASONS.includes(reason)) return res.status(400).json({ error: "Invalid reason." });

  // Store using field names that admin.html expects
  await db.collection("chatReports").insertOne({
    messageId:     String(messageId).slice(0, 100),
    room:          String(room || "").slice(0, 100),
    messageAuthor: String(author || "").slice(0, 60),
    messageBody:   String(body || "").slice(0, 500),
    reason,
    reporter:      req.user.username,
    reportedAt:    new Date().toISOString(),
    status:        "pending",
  });
  res.json({ ok: true });
}));

// ── Admin: view chat reports ──────────────────────────────────────────────────
app.get("/api/admin/chat-reports", requireAuth, requireRole("moderator"), asyncHandler(async (req, res) => {
  const docs = await db.collection("chatReports")
    .find({ status: "pending" })
    .sort({ reportedAt: -1 })
    .limit(100)
    .toArray();
  // Return id as string for the frontend
  res.json(docs.map(r => ({ ...r, id: String(r._id) })));
}));

// ── Admin: resolve / ignore a report ─────────────────────────────────────────
app.patch("/api/admin/chat-reports/:id", requireAuth, requireRole("moderator"), asyncHandler(async (req, res) => {
  const { action } = req.body || {};
  if (!["resolve","ignore"].includes(action)) return res.status(400).json({ error: "Invalid action." });
  const { ObjectId } = require("mongodb");
  let oid;
  try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Invalid id." }); }
  const status = action === "resolve" ? "resolved" : "ignored";
  await db.collection("chatReports").updateOne(
    { _id: oid },
    { $set: { status, resolvedBy: req.user.username, resolvedAt: new Date().toISOString() } }
  );
  res.json({ ok: true });
}));

// ── Admin: assign role ────────────────────────────────────────────────────────
app.patch("/api/admin/users/:username/role", requireAuth, requireRole("owner"), asyncHandler(async (req, res) => {
  const { role } = req.body || {};
  const validRoles = ["moderator", "tester", "analyst", "email_writer", null];
  if (!validRoles.includes(role ?? null)) return res.status(400).json({ error: "Invalid role." });

  const target = await db.collection("users").findOne({ username: req.params.username.toLowerCase() });
  if (!target) return res.status(404).json({ error: "User not found." });
  if (ALLOWED_CREATOR_USERNAMES.has(target.username)) {
    return res.status(400).json({ error: "Cannot change role of a platform owner." });
  }

  await db.collection("users").updateOne(
    { username: target.username },
    role ? { $set: { adminRole: role } } : { $unset: { adminRole: "" } }
  );
  auditLog(req.user.username, role ? "set_role" : "remove_role", target.username, { role });
  res.json({ username: target.username, adminRole: role || null });
}));

// ── Admin: assign badge ───────────────────────────────────────────────────────
app.patch("/api/admin/users/:username/badge", requireAuth, requireRole("moderator"), asyncHandler(async (req, res) => {
  const { badge } = req.body || {};  // badge = string or null to remove
  const VALID_BADGES = ["creator", "verified", "mod", "og", "supporter", "writer", null];
  if (!VALID_BADGES.includes(badge ?? null)) return res.status(400).json({ error: "Invalid badge." });

  const target = await db.collection("users").findOne({ username: req.params.username.toLowerCase() });
  if (!target) return res.status(404).json({ error: "User not found." });

  await db.collection("users").updateOne(
    { username: target.username },
    badge ? { $set: { displayBadge: badge } } : { $unset: { displayBadge: "" } }
  );
  cacheInvalidate("users:all", `users:${target.username}`);
  auditLog(req.user.username, badge ? "set_badge" : "remove_badge", target.username, { badge });
  res.json({ username: target.username, displayBadge: badge || null });
}));

// ── Admin: audit log ──────────────────────────────────────────────────────────
app.get("/api/admin/audit-log", requireAuth, requireRole("moderator"), asyncHandler(async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const actor = req.query.actor || null;
  const filter = actor ? { actor } : {};

  const [total, docs] = await Promise.all([
    db.collection("auditLog").countDocuments(filter),
    db.collection("auditLog")
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(page * limit)
      .limit(limit)
      .toArray()
  ]);
  res.json({ total, page, limit, entries: docs });
}));

// ── Admin: announcement ───────────────────────────────────────────────────────
app.post("/api/admin/announcement", requireAuth, requireRole("moderator"), asyncHandler(async (req, res) => {
  const { title, body, targetUsername } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: "title and body are required." });

  const now = new Date().toISOString();

  if (targetUsername) {
    const target = await db.collection("users").findOne({ username: targetUsername.toLowerCase() });
    if (!target) return res.status(404).json({ error: "User not found." });
    await createNotification({
      _id: generateId("n"),
      type: "announcement",
      actor: req.user.username,
      recipient: target.username,
      title: title.slice(0, 200),
      body: body.slice(0, 1000),
      time: now,
      seen: false
    });
    auditLog(req.user.username, "announcement_single", target.username, { title });
    return res.json({ sent: 1 });
  }

  // Send to all users — bulk insert + push to any connected ones
  const users = await db.collection("users").find({ banned: { $ne: true } }, { projection: { username: 1 } }).toArray();
  if (users.length === 0) return res.json({ sent: 0 });

  const docs = users.map(u => ({
    _id: generateId("n"),
    type: "announcement",
    actor: req.user.username,
    recipient: u.username,
    title: title.slice(0, 200),
    body: body.slice(0, 1000),
    time: now,
    seen: false
  }));
  for (let i = 0; i < docs.length; i += 500) {
    await db.collection("notifications").insertMany(docs.slice(i, i + 500));
  }
  // Real-time push to any currently connected users
  for (const doc of docs) {
    const conns = usernameConnections.get(doc.recipient);
    if (conns) {
      const payload = JSON.stringify({ type: "notification", notification: toClient(doc) });
      for (const conn of conns) {
        if (conn.readyState === conn.OPEN) conn.send(payload);
      }
    }
  }
  auditLog(req.user.username, "announcement_all", "all", { title, count: docs.length });
  res.json({ sent: docs.length });
}));

// ── Admin: maintenance mode ───────────────────────────────────────────────────
let _maintenanceMode = false;

app.get("/api/admin/maintenance", requireAuth, requireRole("analyst"), (req, res) => {
  res.json({ maintenance: _maintenanceMode });
});

app.post("/api/admin/maintenance", requireAuth, requireRole("owner"), asyncHandler(async (req, res) => {
  const { maintenance } = req.body || {};
  _maintenanceMode = !!maintenance;
  auditLog(req.user.username, _maintenanceMode ? "maintenance_on" : "maintenance_off", "platform");
  // Push state change to every open WebSocket so clients react in real-time
  broadcastToRoom("presence", { type: "maintenance", on: _maintenanceMode });
  res.json({ maintenance: _maintenanceMode });
}));

// ── Admin: delete orphan notifications (no valid recipient) ──────────────────
app.post("/api/admin/cleanup-orphan-notifications", requireAuth, requireRole("owner"), asyncHandler(async (req, res) => {
  const result = await db.collection("notifications").deleteMany({
    $or: [{ recipient: { $exists: false } }, { recipient: null }, { recipient: "" }]
  });
  res.json({ deleted: result.deletedCount });
}));

// ── Admin: my role ────────────────────────────────────────────────────────────
app.get("/api/admin/my-role", requireAuth, asyncHandler(async (req, res) => {
  const role = await getAdminRole(req.user.username);
  res.json({ role });
}));

// ── Admin: all-time totals ────────────────────────────────────────────────────
app.get("/api/admin/alltime", requireAuth, requireRole("analyst"), asyncHandler(async (req, res) => {
  const [
    totalUsers, totalPosts, totalComments, totalPageViews,
    firstUser, firstPost,
    likesAgg, commentsAgg,
  ] = await Promise.all([
    db.collection("users").countDocuments({}),
    db.collection("posts").countDocuments({}),
    db.collection("comments").countDocuments({}),
    db.collection("pageviews").countDocuments({}).catch(() => 0),
    db.collection("users").findOne({}, { sort: { joined: 1 }, projection: { joined: 1 } }),
    db.collection("posts").findOne({}, { sort: { createdAt: 1 }, projection: { createdAt: 1 } }),
    db.collection("posts").aggregate([{ $group: { _id: null, total: { $sum: "$likes" } } }]).toArray(),
    db.collection("posts").aggregate([{ $group: { _id: null, total: { $sum: "$commentCount" } } }]).toArray(),
  ]);

  const totalLikes    = likesAgg[0]?.total    || 0;
  const avgLikesPost  = totalPosts ? (totalLikes / totalPosts).toFixed(1) : 0;
  const avgCommPost   = totalPosts ? (totalComments / totalPosts).toFixed(1) : 0;
  const platformStartDate = firstUser?.joined || firstPost?.createdAt || null;
  const platformAgeDays   = platformStartDate
    ? Math.floor((Date.now() - new Date(platformStartDate)) / 86400000)
    : null;
  const postsPerDay = platformAgeDays ? (totalPosts / platformAgeDays).toFixed(1) : 0;

  // Top day ever (most posts)
  const topDayAgg = await db.collection("posts").aggregate([
    { $group: { _id: { $substr: ["$createdAt", 0, 10] }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 }
  ]).toArray();
  const topDay = topDayAgg[0] ? { date: topDayAgg[0]._id, count: topDayAgg[0].count } : null;

  // Most popular category
  const catAgg = await db.collection("posts").aggregate([
    { $match: { category: { $exists: true, $nin: [null, ""] } } },
    { $group: { _id: "$category", count: { $sum: 1 } } },
    { $sort: { count: -1 } }, { $limit: 5 }
  ]).toArray();

  // Messages total
  const totalMessages = await db.collection("messages").countDocuments({}).catch(() => 0);

  res.json({
    totalUsers, totalPosts, totalComments, totalLikes,
    totalMessages, totalPageViews,
    avgLikesPost, avgCommPost, postsPerDay,
    platformAgeDays, platformStartDate,
    topDay, categories: catAgg,
  });
}));

// ── Admin: analysis insights ──────────────────────────────────────────────────
app.get("/api/admin/analysis", requireAuth, requireRole("analyst"), asyncHandler(async (req, res) => {
  const now  = new Date();
  const d30  = new Date(now - 30 * 86400000).toISOString();
  const d60  = new Date(now - 60 * 86400000).toISOString();
  const d7   = new Date(now - 7  * 86400000).toISOString();
  const d14  = new Date(now - 14 * 86400000).toISOString();

  const [
    // Current window counts
    posts30, posts60to30, signups30, signups60to30,
    active30, active60to30, comments30, comments60to30,
    posts7, posts14to7,
    // Retention
    activeUsers30Docs, newUsers30to60,
    // Category breakdown (current 30d)
    catBreakdown30,
    // Hour of day breakdown (all time)
    hourBreakdown,
    // Day of week breakdown (all time)
    dowBreakdown,
    // Users who have posted (engagement)
    usersPosted30,
    // New users this week
    signups7,
  ] = await Promise.all([
    db.collection("posts").countDocuments({ createdAt: { $gte: d30 } }),
    db.collection("posts").countDocuments({ createdAt: { $gte: d60, $lt: d30 } }),
    db.collection("users").countDocuments({ joined: { $gte: d30 } }),
    db.collection("users").countDocuments({ joined: { $gte: d60, $lt: d30 } }),
    db.collection("users").countDocuments({ lastLoginDate: { $gte: d30 } }),
    db.collection("users").countDocuments({ lastLoginDate: { $gte: d60, $lt: d30 } }),
    db.collection("comments").countDocuments({ createdAt: { $gte: d30 } }),
    db.collection("comments").countDocuments({ createdAt: { $gte: d60, $lt: d30 } }),
    db.collection("posts").countDocuments({ createdAt: { $gte: d7 } }),
    db.collection("posts").countDocuments({ createdAt: { $gte: d14, $lt: d7 } }),
    db.collection("users").find({ lastLoginDate: { $gte: d30 } }, { projection: { username: 1, joined: 1 } }).toArray(),
    db.collection("users").find({ joined: { $gte: d60, $lt: d30 } }, { projection: { username: 1 } }).toArray(),
    db.collection("posts").aggregate([
      { $match: { createdAt: { $gte: d30 }, category: { $exists: true, $nin: [null, ""] } } },
      { $group: { _id: "$category", count: { $sum: 1 }, likes: { $sum: "$likes" } } },
      { $sort: { count: -1 } }
    ]).toArray(),
    db.collection("posts").aggregate([
      { $match: { createdAt: { $exists: true, $ne: null } } },
      { $group: { _id: { $hour: { $toDate: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray(),
    db.collection("posts").aggregate([
      { $match: { createdAt: { $exists: true, $ne: null } } },
      { $group: { _id: { $dayOfWeek: { $toDate: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray(),
    db.collection("posts").distinct("author", { createdAt: { $gte: d30 } }),
    db.collection("users").countDocuments({ joined: { $gte: d7 } }),
  ]);

  // Growth rates (% change vs prior period)
  const growth = {
    posts:    posts60to30   > 0 ? Math.round((posts30   - posts60to30)   / posts60to30   * 100) : null,
    signups:  signups60to30 > 0 ? Math.round((signups30 - signups60to30) / signups60to30 * 100) : null,
    active:   active60to30  > 0 ? Math.round((active30  - active60to30)  / active60to30  * 100) : null,
    comments: comments60to30> 0 ? Math.round((comments30- comments60to30)/ comments60to30* 100) : null,
    postsWeek:posts14to7    > 0 ? Math.round((posts7    - posts14to7)    / posts14to7    * 100) : null,
  };

  // Retention: of users who signed up 30-60d ago, how many are still active?
  const activeUsernames30 = new Set(activeUsers30Docs.map(u => u.username));
  const retainedCount     = newUsers30to60.filter(u => activeUsernames30.has(u.username)).length;
  const retentionRate     = newUsers30to60.length > 0
    ? Math.round(retainedCount / newUsers30to60.length * 100) : null;

  // Creator rate: % of active-30d users who posted
  const totalActive30 = active30 || 1;
  const creatorRate   = Math.round(usersPosted30.length / totalActive30 * 100);

  // Avg posts per active user
  const avgPostsPerActiveUser = (posts30 / Math.max(active30, 1)).toFixed(2);

  // Hour breakdown array (24 slots)
  const byHour = Array(24).fill(0);
  hourBreakdown.forEach(h => { if (h._id >= 0 && h._id < 24) byHour[h._id] = h.count; });

  // Day-of-week array (1=Sun..7=Sat)
  const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDow = Array(7).fill(0);
  dowBreakdown.forEach(d => { if (d._id >= 1 && d._id <= 7) byDow[d._id - 1] = d.count; });

  // Cohort: signups per month for last 12m and how many are still active
  const cohorts = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStart = d.toISOString().slice(0, 7) + "-01T00:00:00.000";
    const nextD = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const monthEnd = nextD.toISOString().slice(0, 10) + "T00:00:00.000";
    const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    const [joined, active] = await Promise.all([
      db.collection("users").countDocuments({ joined: { $gte: monthStart, $lt: monthEnd } }),
      db.collection("users").countDocuments({ joined: { $gte: monthStart, $lt: monthEnd }, lastLoginDate: { $gte: d30 } }),
    ]);
    cohorts.push({ label, joined, active, retention: joined > 0 ? Math.round(active / joined * 100) : 0 });
  }

  res.json({
    // Counts
    posts30, signups30, active30, comments30, posts7, signups7,
    // Growth
    growth,
    // Engagement
    retentionRate, creatorRate, avgPostsPerActiveUser,
    retainedCount, retentionBase: newUsers30to60.length,
    // Breakdown
    catBreakdown30, byHour, byDow,
    // Cohorts
    cohorts,
  });
}));

// ── Admin: data browser ───────────────────────────────────────────────────────
app.get("/api/admin/data/posts", requireAuth, requireRole("analyst"), asyncHandler(async (req, res) => {
  const page   = Math.max(0, parseInt(req.query.page) || 0);
  const limit  = Math.min(50, parseInt(req.query.limit) || 25);
  const q      = (req.query.q || "").trim();
  const sort   = req.query.sort || "date";
  const filter = q
    ? { $or: [{ title: { $regex: q, $options: "i" } }, { author: { $regex: q, $options: "i" } }] }
    : {};
  const sortMap = { date: { createdAt: -1 }, likes: { likes: -1 }, comments: { commentCount: -1 } };
  const [total, docs] = await Promise.all([
    db.collection("posts").countDocuments(filter),
    db.collection("posts")
      .find(filter, { projection: { content: 0, likedBy: 0, body: 0 } })
      .sort(sortMap[sort] || { createdAt: -1 })
      .skip(page * limit).limit(limit).toArray()
  ]);
  res.json({ total, page, limit, posts: docs.map(normalizePost) });
}));

app.get("/api/admin/data/users", requireAuth, requireRole("analyst"), asyncHandler(async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(50, parseInt(req.query.limit) || 25);
  const q     = (req.query.q || "").trim();
  const sort  = req.query.sort || "joined";
  const filter = q
    ? { $or: [{ username: { $regex: q, $options: "i" } }, { name: { $regex: q, $options: "i" } }, { email: { $regex: q, $options: "i" } }] }
    : {};
  const sortMap = { joined: { joined: -1 }, active: { lastLoginDate: -1 }, posts: { postCount: -1 } };
  const [total, docs] = await Promise.all([
    db.collection("users").countDocuments(filter),
    db.collection("users")
      .find(filter, { projection: { password: 0 } })
      .sort(sortMap[sort] || { joined: -1 })
      .skip(page * limit).limit(limit).toArray()
  ]);
  res.json({ total, page, limit, users: docs.map(u => ({
    username: u.username, name: u.name || u.username,
    email: u.email || null, joined: u.joined || null,
    lastActive: u.lastLoginDate || null, postCount: u.postCount || 0,
    bio: u.bio ? u.bio.slice(0, 80) : null,
    adminRole: u.adminRole || null, isBanned: u.banned || false,
  })) });
}));

app.get("/api/admin/data/comments", requireAuth, requireRole("analyst"), asyncHandler(async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(50, parseInt(req.query.limit) || 25);
  const q     = (req.query.q || "").trim();
  const filter = q
    ? { $or: [{ author: { $regex: q, $options: "i" } }, { body: { $regex: q, $options: "i" } }] }
    : {};
  const [total, docs] = await Promise.all([
    db.collection("comments").countDocuments(filter),
    db.collection("comments")
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(page * limit).limit(limit).toArray()
  ]);
  res.json({ total, page, limit, comments: docs.map(c => ({
    id: c._id?.toString(), author: c.author, body: (c.body || "").slice(0, 200),
    postId: c.postId, createdAt: c.createdAt,
  })) });
}));

app.get("/api/admin/data/pageviews", requireAuth, requireRole("analyst"), asyncHandler(async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(50, parseInt(req.query.limit) || 50);
  const q     = (req.query.q || "").trim();
  const filter = q ? { page: { $regex: q, $options: "i" } } : {};
  const [total, docs] = await Promise.all([
    db.collection("pageviews").countDocuments(filter).catch(() => 0),
    db.collection("pageviews")
      .find(filter).sort({ timestamp: -1 })
      .skip(page * limit).limit(limit).toArray().catch(() => [])
  ]);
  res.json({ total, page, limit, pageviews: docs.map(p => ({
    page: p.page, username: p.username, timestamp: p.timestamp, date: p.date,
  })) });
}));

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

connect()
  .then(() => {
    const server = http.createServer(app);

    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (ws, req, { room, username }) => {
      ws.room = room;
      ws.username = username;
      // Assume active/foreground on connect - corrected within moments by
      // the client's initial activity message if the tab actually started
      // out backgrounded.
      ws.isActiveTab = true;
      chatRoomClients(room).add(ws);
      addUserConnection(username, ws);
      broadcastToRoom(room, { type: "presence", room, users: roomPresence(room) });
      broadcastGlobalPresenceUpdate();

      ws.on("message", raw => {
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch (e) {
          return;
        }
        if (data.type === "send") {
          createChatMessage({ room: ws.room, author: ws.username, body: data.body, image: data.image, replyTo: data.replyTo, msgType: data.msgType, songData: data.songData, gameData: data.gameData }).catch(err => {
            console.error("Chat message failed:", err);
          });
        } else if (data.type === "typing") {
          broadcastToRoom(ws.room, { type: "typing", room: ws.room, username: ws.username });
        } else if (data.type === "viewing-post") {
          const { postId, avatar, name } = data;
          if (postId && typeof postId === "string") {
            // Remove from previous post if switching
            if (ws._viewingPost && ws._viewingPost !== postId) {
              const prev = postViewers.get(ws._viewingPost);
              if (prev) { prev.delete(ws); if (prev.size === 0) postViewers.delete(ws._viewingPost); broadcastPostViewers(ws._viewingPost); }
            }
            ws._viewingPost = postId;
            if (!postViewers.has(postId)) postViewers.set(postId, new Map());
            postViewers.get(postId).set(ws, { username: ws.username, avatar: avatar || null, name: name || ws.username });
            broadcastPostViewers(postId);
          }
        } else if (data.type === "left-post") {
          if (ws._viewingPost) {
            const prev = postViewers.get(ws._viewingPost);
            if (prev) { prev.delete(ws); if (prev.size === 0) postViewers.delete(ws._viewingPost); broadcastPostViewers(ws._viewingPost); }
            ws._viewingPost = null;
          }
        } else if (data.type === "activity") {
          // The client sends this whenever document.hidden changes on
          // THIS specific tab - active=true means focused, false means
          // backgrounded. Only touches this one connection's own state,
          // not the whole username, so a second focused tab elsewhere
          // still correctly keeps someone "online".
          ws.isActiveTab = !!data.active;
          broadcastGlobalPresenceUpdate();
        } else {
          // Relay any other message type (e.g. WebRTC call signaling:
          // call-offer, call-answer, call-ice, call-reject, call-end)
          // to all participants in the same room. Not stored, not logged,
          // just forwarded — lets voice calls work without server changes.
          broadcastToRoom(ws.room, { ...data, from: ws.username });
        }
      });

      ws.on("close", () => {
        chatRoomClients(room).delete(ws);
        removeUserConnection(username, ws);
        broadcastToRoom(room, { type: "presence", room, users: roomPresence(room) });
        broadcastGlobalPresenceUpdate();
        // Clean up post viewer tracking
        if (ws._viewingPost) {
          const prev = postViewers.get(ws._viewingPost);
          if (prev) { prev.delete(ws); if (prev.size === 0) postViewers.delete(ws._viewingPost); broadcastPostViewers(ws._viewingPost); }
        }
      });
    });

    server.on("upgrade", (req, socket, head) => {
      let url;
      try {
        url = new URL(req.url, "http://localhost");
      } catch (e) {
        socket.destroy();
        return;
      }
      if (url.pathname !== "/ws/chat") {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("token") || "";
      const payload = verifyJWT(token);
      const username = payload && payload.username ? payload.username : null;
      const room = (url.searchParams.get("room") || DEFAULT_CHAT_ROOM).trim().slice(0, 200) || DEFAULT_CHAT_ROOM;
      if (!username || !canAccessRoom(room, username)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit("connection", ws, req, { room, username });
      });
    });

    server.listen(port, () => {
      console.log(`Server running on port ${port}`);

      const selfUrl = process.env.RENDER_EXTERNAL_URL;
      if (selfUrl) {
        setInterval(async () => {
          try {
            await fetch(`${selfUrl}/api/posts`);
            console.log("[keep-alive] ping ok");
          } catch (e) { /* silent */ }
        }, 14 * 60 * 1000);
      }
    });
  })
  .catch(err => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });