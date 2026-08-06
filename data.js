/* ============================================================
   PROGRESS — data layer
   A tiny mock "backend" so the demo works without a server.
   Everything lives in localStorage on the visitor's own machine.
   ============================================================ */

const DB_KEY = "progress:db:v1";
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const BACKEND_RENDER_URL = "https://progress-351h.onrender.com";
const BACKEND_LOCAL_URL = "http://127.0.0.1:3000";
const ALLOWED_CREATOR_USERNAMES = new Set(["mara", "own", "progresstesting1"]);
// Badges awarded automatically based on username. The server independently
// computes this same table itself (never trusting a client-supplied badges
// field), this copy is only used for the offline-only local-account
// fallback and to repair the local mock DB when the server is unreachable.
const SIGNUP_BADGE_AWARDS = {
  mara: ["dexterity"],
  own: ["dexterity", "dark", "tester", "early_supporter", "dolphin_eat", "trop"],
  progresstesting1: ["dexterity", "817x2", "dark", "tester", "early_supporter", "dolphin_eat", "trop", "jason"],
  "817x2": ["dexterity", "817x2"],
  testuser: ["dexterity", "817x2", "dark", "early_supporter"],
  dark: ["early_supporter", "dark"],
  trop: ["early_supporter", "trop", "dolphin_eat"],
  ohhmytesting: ["dexterity", "817x2", "dark", "tester"]
};
const API_ENABLED = false;
const CHAT_DB_KEY = "progress:chat:v1";
// HTTP API base — uses relative URLs on production so requests go through
// Vercel's global edge CDN (vercel.json rewrites /api/* → Render).
// WebSocket connections (WS_BASE) must still hit Render directly since
// Vercel cannot proxy WebSocket connections. In frontend-only mode, these
// values are not used.
const API_BASE = (() => {
  if (typeof window === "undefined") return BACKEND_RENDER_URL;
  if (window.PROGRESS_API_BASE) return window.PROGRESS_API_BASE;
  if (window.location.protocol === "file:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return BACKEND_LOCAL_URL;
  }
  // On production (Vercel), use relative URLs so the CDN proxy kicks in
  return "";
})();
// WebSocket always connects directly to Render (Vercel can't proxy WS)
const WS_BASE = (() => {
  if (typeof window === "undefined") return BACKEND_RENDER_URL.replace(/^http/, "ws");
  if (window.location.protocol === "file:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return BACKEND_LOCAL_URL.replace(/^http/, "ws");
  }
  return BACKEND_RENDER_URL.replace(/^http/, "ws");
})();

const AUTH_TOKEN_KEY = "progress:authToken";
const SESSION_COOKIE = "progress_session"; // cookie name for cross-context persistence
const SESSION_COOKIE_DAYS = 90;            // stay logged in for 90 days

// ── Cookie helpers ──────────────────────────────────────────────────────────
// Cookies are used as a durable backup alongside localStorage. This matters
// for two real situations users hit:
//
//   1. Safari ITP clears localStorage after 7 days without a visit.
//      Cookies with an explicit Max-Age are NOT subject to the same rule.
//
//   2. iOS "Add to Home Screen" (standalone mode) has its OWN localStorage,
//      completely separate from the Safari browser. Cookies, however, ARE
//      shared between standalone mode and Safari on the same device, so a
//      session started in the browser survives opening from the home screen.
//
// We never send credentials in the cookie to the server - it's purely a
// client-side store that getAuthToken() falls back to when localStorage is
// empty or unavailable.

function setCookie(name, value, days) {
  try {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  } catch (e) {}
}

function _getCookie(name) {
  try {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  } catch (e) { return null; }
}

function deleteCookie(name) {
  try { document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`; } catch (e) {}
}

// ── Auth token ───────────────────────────────────────────────────────────────
// The JWT proving who's actually logged in. Stored in both localStorage (fast,
// first choice) and a long-lived cookie (fallback for Safari ITP + standalone
// mode). apiFetch/apiFetchAuth attach it automatically to every request.

function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || _getCookie(SESSION_COOKIE + "_token") || null;
  } catch (e) {
    return _getCookie(SESSION_COOKIE + "_token") || null;
  }
}

function setAuthToken(token) {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      setCookie(SESSION_COOKIE + "_token", token, SESSION_COOKIE_DAYS);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      deleteCookie(SESSION_COOKIE + "_token");
    }
  } catch (e) {
    if (token) setCookie(SESSION_COOKIE + "_token", token, SESSION_COOKIE_DAYS);
    else deleteCookie(SESSION_COOKIE + "_token");
  }
}

// ── Current-user cookie backup ───────────────────────────────────────────────
// Mirrors db.currentUser in a cookie so that even if localStorage is cleared
// (Safari ITP, standalone/browser mismatch), we can remember who was logged in
// and kick off a silent re-login with the stored password.

function setCurrentUserCookie(username) {
  if (username) setCookie(SESSION_COOKIE + "_user", username, SESSION_COOKIE_DAYS);
  else deleteCookie(SESSION_COOKIE + "_user");
}

function getCurrentUserCookie() {
  return _getCookie(SESSION_COOKIE + "_user");
}

// ── Silent re-login ──────────────────────────────────────────────────────────
// When the server rejects our token (e.g. Render free-tier restarted and
// regenerated its JWT secret, or the token simply expired), we try to get a
// fresh token automatically using the stored password rather than forcing the
// user to type their credentials again.
//
// This is safe: passwords are already persisted locally (the login response
// merges `password` into the user object that goes into localStorage/the DB).
// All we're doing is reusing them for a silent re-auth in the background.

let _silentReloginInProgress = false;

async function silentRelogin() {
  if (_silentReloginInProgress) return false;
  _silentReloginInProgress = true;
  try {
    // Read credentials directly from localStorage so this function works even
    // before the Progress object is fully initialised.
    let username = null;
    let password = null;
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) {
        const db = JSON.parse(raw);
        username = db.currentUser || getCurrentUserCookie();
        if (username && db.users) {
          const u = db.users.find(x => x.username === username);
          password = u && u.password;
        }
      }
    } catch (e) {
      username = getCurrentUserCookie();
    }

    if (!username || !password) return false;

    const result = await apiFetchAuth("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    if (result.ok && result.data && result.data.token) {
      setAuthToken(result.data.token);
      setCurrentUserCookie(username);
      return true;
    }
    return false;
  } finally {
    _silentReloginInProgress = false;
  }
}

async function apiFetch(path, options = {}, _retry = false) {
  if (!API_ENABLED || String(path).startsWith("/api/")) {
    const local = await localApiFetch(path, options);
    if (!local || local.status >= 400) return null;
    return local.data;
  }
  try {
    let url = path;
    if (path.startsWith("/api/")) {
      url = API_BASE + path;
    } else if (!path.startsWith("http://") && !path.startsWith("https://")) {
      url = API_BASE + "/api/" + path.replace(/^\/+/, "");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const token = getAuthToken();
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    clearTimeout(timeout);

    if (res.status === 401 && !_retry) {
      const refreshed = await silentRelogin();
      if (refreshed) return apiFetch(path, options, true);
      return null;
    }

    if (!res.ok) return null;
    if (res.status === 204) return {};
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* Like apiFetch, but preserves the server's response even on non-2xx status
   codes (e.g. 401 invalid credentials, 409 username taken) instead of
   collapsing every kind of failure into `null`. Login/signup need to be able
   to tell "the server said no" apart from "the server was never reached"
   (asleep/offline/slow) so they can show an accurate error instead of a
   misleading one. `status: 0` means the request never got a response. */
async function apiFetchAuth(path, options = {}, timeoutMs = 8000) {
  if (!API_ENABLED || String(path).startsWith("/api/")) {
    const local = await localApiFetch(path, options);
    if (!local) return { ok: false, status: 0, error: null };
    if (local.status >= 400) return { ok: false, status: local.status || 0, error: local.error || null };
    return { ok: true, status: local.status || 200, data: local.data };
  }
  const url = path.startsWith("http://") || path.startsWith("https://") ? path : API_BASE + path;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const token = getAuthToken();
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(url, { ...options, headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) return { ok: false, status: res.status, error: (body && body.error) || null };
    return { ok: true, status: res.status, data: body };
  } catch (e) {
    return { ok: false, status: 0, error: null };
  }
}

async function localApiFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const rawPath = String(path).replace(/^\/?api\/?/, "").replace(/^\//, "");
  const [resource, ...rest] = rawPath.split("/");
  const params = new URLSearchParams((String(path).includes("?") ? String(path).split("?")[1] : ""));
  const db = loadDB();
  const currentUser = db.currentUser ? db.users.find(u => u.username === db.currentUser) : null;
  const body = options.body ? JSON.parse(options.body) : null;

  const makeResponse = (status, data, error = null) => ({ status, data, error });
  const getUserByIdOrUsername = id => db.users.find(u => u.id === id || u.username === id);
  const saveAndReturn = result => { saveDB(db); return makeResponse(200, result); };

  function ensureChat() {
    db.chat = db.chat || { rooms: [{ room: "global", label: "Global", topic: "Everyone", members: [] }], messages: [], invites: [] };
    return db.chat;
  }

  if (resource === "login" && method === "POST") {
    if (!body || !body.username || !body.password) return makeResponse(400, null, "Missing credentials");
    const user = db.users.find(u => u.username.toLowerCase() === String(body.username).toLowerCase());
    if (!user || user.password !== body.password) return makeResponse(401, null, "Invalid credentials");
    db.currentUser = user.username;
    setAuthToken("local-token");
    saveDB(db);
    return makeResponse(200, { token: "local-token", ...user });
  }

  if (resource === "users") {
    if (method === "GET") {
      if (params.has("username")) {
        const match = db.users.filter(u => u.username.toLowerCase() === params.get("username").toLowerCase());
        return makeResponse(200, match);
      }
      return makeResponse(200, db.users);
    }
    if (method === "POST") {
      if (!body || !body.username || !body.name || !body.password) return makeResponse(400, null, "Missing fields");
      const existing = db.users.find(u => u.username.toLowerCase() === body.username.toLowerCase());
      if (existing) return makeResponse(409, null, "That username is already taken.");
      const user = {
        id: "u" + Date.now(),
        username: String(body.username).toLowerCase(),
        name: String(body.name),
        password: String(body.password),
        avatar: null,
        joined: new Date().toISOString().slice(0, 10),
        timezone: body.timezone || DEFAULT_TIMEZONE,
        following: [],
        followers: [],
        bio: "",
        badges: SIGNUP_BADGE_AWARDS[String(body.username).toLowerCase()] || []
      };
      db.users.push(user);
      db.currentUser = user.username;
      setAuthToken("local-token");
      saveDB(db);
      return makeResponse(200, { token: "local-token", ...user });
    }
    if (rest.length >= 1) {
      const id = decodeURIComponent(rest[0]);
      const user = getUserByIdOrUsername(id);
      if (!user) return makeResponse(404, null, "User not found");
      if (method === "GET") return makeResponse(200, user);
      if (rest.length === 2 && rest[1] === "stats" && method === "GET") {
        const postCount = (db.posts || []).filter(p => p.author === user.username).length;
        const commentCount = (db.comments || []).filter(c => c.author === user.username).length;
        return makeResponse(200, { posts: postCount, comments: commentCount, likes: (db.posts || []).filter(p => p.author === user.username).reduce((sum, p) => sum + (p.likes || 0), 0) });
      }
      if (method === "PATCH") {
        if (!currentUser || currentUser.username !== user.username) return makeResponse(403, null, "Forbidden");
        Object.assign(user, body || {});
        saveDB(db);
        return makeResponse(200, user);
      }
      if (method === "DELETE") {
        if (!currentUser || currentUser.username !== user.username) return makeResponse(403, null, "Forbidden");
        db.users = db.users.filter(u => u.username !== user.username);
        db.posts = (db.posts || []).filter(p => p.author !== user.username);
        db.comments = (db.comments || []).filter(c => c.author !== user.username);
        db.notifications = (db.notifications || []).filter(n => n.recipient !== user.username);
        if (db.currentUser === user.username) db.currentUser = null;
        saveDB(db);
        return makeResponse(200, { ok: true });
      }
    }
  }

  if (resource === "me") {
    if (!currentUser) return makeResponse(401, null, "Not authenticated");
    return makeResponse(200, currentUser);
  }

  if (resource === "posts") {
    if (method === "GET") {
      let posts = [...(db.posts || [])];
      if (params.has("author")) {
        const author = params.get("author").toLowerCase();
        posts = posts.filter(p => p.author.toLowerCase() === author);
      }
      if (params.has("limit")) {
        const limit = Number(params.get("limit"));
        if (!Number.isNaN(limit) && limit > 0) posts = posts.slice(0, limit);
      }
      return makeResponse(200, posts.sort((a, b) => new Date(b.date) - new Date(a.date)));
    }
    if (method === "POST") {
      if (!currentUser) return makeResponse(401, null, "Not authenticated");
      const post = {
        id: "p" + Date.now(),
        author: currentUser.username,
        title: body.title || "Untitled entry",
        date: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
        cover: body.cover || null,
        excerpt: body.excerpt || "",
        content: body.content || "",
        likes: 0,
        likedBy: []
      };
      db.posts = [post, ...(db.posts || [])];
      saveDB(db);
      return makeResponse(200, post);
    }
    if (rest.length >= 1) {
      const postId = decodeURIComponent(rest[0]);
      const post = (db.posts || []).find(p => p.id === postId);
      if (!post) return makeResponse(404, null, "Post not found");
      if (method === "GET") return makeResponse(200, post);
      if (method === "DELETE") {
        if (!currentUser || post.author !== currentUser.username) return makeResponse(403, null, "Forbidden");
        db.posts = (db.posts || []).filter(p => p.id !== postId);
        db.comments = (db.comments || []).filter(c => c.postId !== postId);
        saveDB(db);
        return makeResponse(200, { ok: true });
      }
      if (rest.length >= 2 && rest[1] === "comments") {
        if (method === "GET") {
          const comments = (db.comments || []).filter(c => c.postId === postId).sort((a, b) => new Date(a.time) - new Date(b.time));
          return makeResponse(200, comments);
        }
        if (method === "POST") {
          if (!currentUser) return makeResponse(401, null, "Not authenticated");
          const comment = {
            id: "c" + Date.now(),
            postId,
            author: currentUser.username,
            body: body.body || "",
            image: body.image || null,
            time: new Date().toISOString()
          };
          db.comments = [...(db.comments || []), comment];
          if (post.author !== currentUser.username) {
            db.notifications = [{ id: "n" + Date.now(), type: "reply", actor: currentUser.username, postId, postTitle: post.title, body: comment.body, recipient: post.author, time: new Date().toISOString(), seen: false }, ...(db.notifications || [])];
          }
          saveDB(db);
          return makeResponse(200, comment);
        }
      }
      if (rest.length >= 2 && rest[1] === "like" && method === "POST") {
        if (!currentUser) return makeResponse(401, null, "Not authenticated");
        const who = currentUser.username;
        const idx = post.likedBy.indexOf(who);
        if (idx === -1) {
          post.likedBy.push(who);
          post.likes = (post.likes || 0) + 1;
          if (post.author !== who) {
            db.notifications = [{ id: "n" + Date.now(), type: "like", actor: who, postId, postTitle: post.title, recipient: post.author, time: new Date().toISOString(), seen: false }, ...(db.notifications || [])];
          }
        } else {
          post.likedBy.splice(idx, 1);
          post.likes = Math.max(0, (post.likes || 1) - 1);
        }
        saveDB(db);
        return makeResponse(200, post);
      }
    }
  }

  if (resource === "bookmarks") {
    db.bookmarks = db.bookmarks || [];
    if (!currentUser) return makeResponse(401, null, "Not authenticated");
    if (rest.length === 0 && method === "GET") {
      return makeResponse(200, (db.bookmarks || []).map(postId => db.posts.find(p => p.id === postId)).filter(Boolean));
    }
    if (rest.length === 1 && rest[0] === "status" && method === "GET") {
      return makeResponse(200, { bookmarked: false });
    }
    if (rest.length === 1 && method === "POST") {
      const postId = decodeURIComponent(rest[0]);
      const idx = (db.bookmarks || []).indexOf(postId);
      if (idx === -1) {
        db.bookmarks.push(postId);
      } else {
        db.bookmarks.splice(idx, 1);
      }
      saveDB(db);
      return makeResponse(200, { bookmarked: idx === -1 });
    }
    if (rest.length === 2 && rest[1] === "status" && method === "GET") {
      const postId = decodeURIComponent(rest[0]);
      return makeResponse(200, { bookmarked: (db.bookmarks || []).includes(postId) });
    }
  }

  if (resource === "notifications") {
    if (!currentUser) return makeResponse(401, null, "Not authenticated");
    if (method === "GET") {
      const recipient = params.get("recipient");
      const result = (db.notifications || []).filter(n => !recipient || n.recipient === recipient);
      return makeResponse(200, result);
    }
    if (rest.length === 1 && method === "DELETE") {
      const id = decodeURIComponent(rest[0]);
      db.notifications = (db.notifications || []).filter(n => n.id !== id);
      saveDB(db);
      return makeResponse(200, { ok: true });
    }
    if (rest.length === 0 && method === "POST" && String(path).includes("mark-seen")) {
      (db.notifications || []).forEach(n => { if (!n.recipient || n.recipient === currentUser.username) n.seen = true; });
      saveDB(db);
      return makeResponse(200, { ok: true });
    }
  }

  if (resource === "chat") {
    const chat = ensureChat();
    if (rest.length === 1 && rest[0] === "conversations" && method === "GET") {
      const convs = [];
      const dmMessages = chat.messages.filter(m => m.room.startsWith("dm:") && (m.room.includes(currentUser.username + ":") || m.author === currentUser.username));
      const rooms = new Map();
      dmMessages.forEach(msg => {
        const [_, a, b] = msg.room.split(":");
        const peer = a === currentUser.username ? b : b === currentUser.username ? a : null;
        if (!peer) return;
        const key = msg.room;
        const existing = rooms.get(key) || { room: key, with: peer, lastMessage: null, unreadCount: 0 };
        if (!existing.lastMessage || new Date(msg.time) > new Date(existing.lastMessage.time)) existing.lastMessage = msg;
        rooms.set(key, existing);
      });
      return makeResponse(200, Array.from(rooms.values()));
    }
    if (rest.length === 1 && rest[0] === "rooms") {
      if (method === "GET") return makeResponse(200, chat.rooms);
      if (method === "POST") {
        const roomId = body.name || `room-${Date.now()}`;
        const existing = chat.rooms.find(r => r.room === roomId || r.label === body.label);
        if (existing) return makeResponse(409, null, "Room already exists");
        const room = { room: roomId, label: body.label || roomId, topic: body.topic || "", members: [currentUser?.username].filter(Boolean), pinnedMsg: null, inviteCode: null, communityMods: [], owner: currentUser?.username || null };
        chat.rooms.push(room);
        saveDB(db);
        return makeResponse(200, room);
      }
    }
    if (rest.length >= 2) {
      const roomId = decodeURIComponent(rest[0]);
      const room = chat.rooms.find(r => r.room === roomId);
      if (!room) return makeResponse(404, null, "Room not found");
      if (rest[1] === "join" && method === "POST") {
        if (currentUser && !room.members.includes(currentUser.username)) room.members.push(currentUser.username);
        saveDB(db);
        return makeResponse(200, { ok: true });
      }
      if (rest[1] === "leave" && method === "POST") {
        if (currentUser) room.members = room.members.filter(u => u !== currentUser.username);
        saveDB(db);
        return makeResponse(200, { ok: true });
      }
      if (rest[1] === "invite" && method === "POST") {
        const code = `invite-${Math.random().toString(36).slice(2, 8)}`;
        chat.invites.push({ code, room: room.room, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
        saveDB(db);
        return makeResponse(200, { code });
      }
      if (rest[1] === "members" && method === "GET") {
        return makeResponse(200, { members: room.members, communityMods: room.communityMods || [], owner: room.owner || null });
      }
      if (rest[1] === "pin") {
        if (method === "POST") {
          room.pinnedMsg = body.pinnedMsg || null;
          saveDB(db);
          return makeResponse(200, { ok: true });
        }
        if (method === "DELETE") {
          room.pinnedMsg = null;
          saveDB(db);
          return makeResponse(200, { ok: true });
        }
      }
      if (rest[1] === "members" && method === "GET") {
        return makeResponse(200, { members: room.members, communityMods: room.communityMods || [], owner: room.owner || null });
      }
      if (rest[1] === "delete" && method === "DELETE") {
        chat.rooms = chat.rooms.filter(r => r.room !== roomId);
        chat.messages = chat.messages.filter(m => m.room !== roomId);
        saveDB(db);
        return makeResponse(200, { ok: true });
      }
    }
    if (rest.length === 1 && rest[0] === "messages") {
      if (method === "GET") {
        const room = params.get("room") || "global";
        let messages = chat.messages.filter(m => m.room === room);
        if (params.has("before")) {
          const before = new Date(params.get("before"));
          messages = messages.filter(m => new Date(m.time) < before);
        }
        messages = messages.sort((a, b) => new Date(a.time) - new Date(b.time));
        return makeResponse(200, messages.slice(-50));
      }
      if (method === "POST") {
        if (!currentUser) return makeResponse(401, null, "Not authenticated");
        const message = {
          id: "m" + Date.now() + Math.random().toString(36).slice(2, 5),
          room: body.room || "global",
          author: currentUser.username,
          body: body.body || "",
          image: body.image || null,
          type: body.msgType || "message",
          songData: body.songData || null,
          replyTo: body.replyTo || null,
          votes: {},
          reactions: {},
          time: new Date().toISOString()
        };
        chat.messages.push(message);
        saveDB(db);
        return makeResponse(200, message);
      }
    }
    if (rest.length === 2 && rest[0] === "messages") {
      const messageId = decodeURIComponent(rest[1]);
      const message = chat.messages.find(m => m.id === messageId);
      if (!message) return makeResponse(404, null, "Message not found");
      if (rest[2] === "react" && method === "POST") {
        const emoji = body.emoji;
        if (!emoji) return makeResponse(400, null, "Missing emoji");
        message.reactions = message.reactions || {};
        message.reactions[emoji] = message.reactions[emoji] || [];
        const idx = message.reactions[emoji].indexOf(currentUser.username);
        if (idx === -1) message.reactions[emoji].push(currentUser.username);
        else message.reactions[emoji].splice(idx, 1);
        saveDB(db);
        return makeResponse(200, { ok: true, reactions: message.reactions });
      }
      if (rest[2] === "vote" && method === "POST") {
        const opt = String(body.vote);
        message.votes = message.votes || {};
        Object.entries(message.votes).forEach(([key, voters]) => {
          message.votes[key] = voters.filter(u => u !== currentUser.username);
        });
        message.votes[opt] = message.votes[opt] || [];
        message.votes[opt].push(currentUser.username);
        saveDB(db);
        return makeResponse(200, { ok: true, votes: message.votes });
      }
    }
  }

  if (resource === "chat" && rest.length === 1 && rest[0] === "mark-read" && method === "POST") {
    if (!currentUser) return makeResponse(401, null, "Not authenticated");
    // Mark all messages in room as read for this user in local state.
    // This is only used for DM unread indicators.
    return makeResponse(200, { ok: true });
  }

  if (resource === "upload-image" && method === "POST") {
    if (!body || !body.image) return makeResponse(400, null, "Missing image data");
    // In frontend-only mode, keep the image as a data URL so it can be rendered locally.
    return makeResponse(200, { url: body.image });
  }

  if (resource === "storage-upload-url" && method === "POST") {
    if (!body || !body.filename) return makeResponse(400, null, "Missing filename");
    const uploadUrl = `data:application/octet-stream,local-upload-${encodeURIComponent(body.filename)}`;
    const publicUrl = uploadUrl;
    return makeResponse(200, { uploadUrl, publicUrl });
  }

  if (resource === "online-users") {
    const statuses = currentUser ? { [currentUser.username]: "online" } : {};
    return makeResponse(200, { users: currentUser ? [currentUser.username] : [], statuses });
  }

  if (resource === "invite") {
    const code = rest[0];
    const invite = (loadDB().chat?.invites || []).find(i => i.code === code);
    if (!invite) return makeResponse(404, null, "Invite not found");
    if (method === "POST") {
      const room = loadDB().chat.rooms.find(r => r.room === invite.room);
      if (room && currentUser && !room.members.includes(currentUser.username)) room.members.push(currentUser.username);
      saveDB(db);
      return makeResponse(200, { ok: true });
    }
    return makeResponse(200, { room: invite.room, label: loadDB().chat.rooms.find(r => r.room === invite.room)?.label || "" });
  }

  return makeResponse(404, null, "Not implemented");
}

const SEED = {
  currentUser: null, // null = logged out
  users: [
    { id: "u1", username: "mara", name: "Mara Studios", password: "demo1234", avatar: "https://images.unsplash.com/photo-1502685104226-ee32379fefbe?q=80&w=200&auto=format&fit=crop", joined: "2026-02-01", timezone: DEFAULT_TIMEZONE, following: [], followers: [], bio: "", badges: ["dexterity"] }
  ],
  posts: [
    {
      id: "p1",
      author: "mara",
      title: "Velvet drafts after midnight",
      date: "2026-06-28",
      cover: "images/emoticoans/6a05fdfaedb470.93319321.mp4",
      excerpt: "I stopped rushing the words and started letting the page glow first. That one shift made every idea feel more dangerous in the best way.",
      content: "<p>I stopped rushing the words and started letting the page glow first. That one shift made every idea feel more dangerous in the best way.</p><p>I open the draft, dim everything around me, and let the first paragraph arrive slowly. The visual mood does half the work: soft light, warm contrast, and just enough tension to keep me typing.</p><p>The favorite banner shot stays at the top while I edit, like a cue to keep the rhythm slower and more intentional. I trim hard phrases, keep the teasing ones, and let the post breathe before publish.</p><blockquote>When the atmosphere is right, the sentence lands deeper.</blockquote><p>Result: fewer throwaway updates, more entries that actually feel like they belong to this space.</p>",
      likes: 12,
      likedBy: []
    },
    {
      id: "p2",
      author: "mara",
      title: "The vertical frame changed the whole vibe",
      date: "2026-06-14",
      cover: "images/emoticoans/(m=q18T2ZXbeaSaaTbaAaaaa)(mh=zJMuchy9Z1JP4GC7)0.jpg",
      excerpt: "Keeping the vertical image fully visible made the page feel less generic and way more intimate.",
      content: "<p>Keeping the vertical image fully visible made the page feel less generic and way more intimate.</p><p>When it was cropped, the mood got flattened. Once I let the full frame show, the post finally had posture &mdash; taller, softer, and a little more suggestive without saying too much.</p><h2>What I kept</h2><p>I kept the center alignment and gave it room to breathe. No loud overlays, no forced text on top, just a clean frame with enough contrast to hold attention.</p><p>That one adjustment made the entire feed read like a curated set, not a pile of random cards.</p>",
      likes: 27,
      likedBy: []
    },
    {
      id: "p3",
      author: "mara",
      title: "Warm stills, slow loops, and better posts",
      date: "2026-05-30",
      cover: "images/emoticoans/6a0c778ea2d204.73156998.mp4",
      excerpt: "The warm still became my anchor image, and the loop became the pulse. Together they gave the writing a cleaner, sexier rhythm.",
      content: "<p>The warm still became my anchor image, and the loop became the pulse. Together they gave the writing a cleaner, sexier rhythm.</p><p>Now every post starts from a visual pairing: one image that feels plush and one motion clip that keeps subtle momentum. I write to that tempo instead of fighting it.</p><p>The voice got less stiff right away. Shorter lines. Better pauses. More confidence in the final paragraph.</p><blockquote>The look of a page can coach the tone of a sentence.</blockquote><p>I still edit hard. I just do it in a layout that actually matches the feeling I want the post to carry.</p>",
      likes: 8,
      likedBy: []
    }
  ],
  comments: [],
  notifications: [
    { id: "n1", type: "like", actor: "jonah_p", postId: "p2", postTitle: "The vertical frame changed the whole vibe", time: "2026-07-04T09:12:00", seen: false },
    { id: "n2", type: "reply", actor: "wren.codes", postId: "p1", postTitle: "Velvet drafts after midnight", body: "This is exactly the permission I needed to hear today.", time: "2026-07-03T21:40:00", seen: false },
    { id: "n3", type: "like", actor: "delia", postId: "p1", postTitle: "Velvet drafts after midnight", time: "2026-07-02T14:05:00", seen: false },
    { id: "n4", type: "follow", actor: "sam_writes", time: "2026-06-30T08:00:00", seen: true }
  ]
};

function loadDB() {
  let raw = null;
  try { raw = localStorage.getItem(DB_KEY); } catch (e) {}

  if (!raw) {
    // localStorage is empty or unavailable (Safari ITP cleared it, or the user is
    // in a standalone home-screen context with separate storage). Check if we have
    // a cookie that says who was logged in - if so, start from SEED but with that
    // username set as currentUser so the app shows them as "logged in" immediately.
    // silentRelogin() will fire on the first authenticated request and get a fresh
    // JWT, completing the session restore invisibly.
    const cookieUser = getCurrentUserCookie();
    const base = JSON.parse(JSON.stringify(SEED));
    if (cookieUser) base.currentUser = cookieUser;
    base.bookmarks = [];
    base.chat = { rooms: [{ room: "global", label: "Global", topic: "Everyone", members: [] }], messages: [], invites: [] };
    try { localStorage.setItem(DB_KEY, JSON.stringify(base)); } catch (e) {}
    return base;
  }
  try {
    const parsed = JSON.parse(raw);
    // Ensure seed users are always present with correct data
    const seedUsernames = new Set(SEED.users.map(u => u.username));
    const existingMap = new Map((parsed.users || []).map(u => [u.username, u]));
    
    // Add or refresh seed users to ensure they have correct passwords and data
    for (const seedUser of SEED.users) {
      if (!existingMap.has(seedUser.username) || !existingMap.get(seedUser.username).password) {
        // Either user doesn't exist or is corrupted (missing password), so use seed data
        existingMap.set(seedUser.username, { ...seedUser });
      }
    }
    
    parsed.users = Array.from(existingMap.values());
    
    // Normalize old saved DB shapes so missing arrays don't break the app.
    parsed.users = (parsed.users || []).map(u => ({
      ...u,
      timezone: u.timezone || DEFAULT_TIMEZONE,
      joined: u.joined || new Date().toISOString().slice(0, 10),
      following: u.following || [],
      followers: u.followers || [],
      bio: u.bio || ""
    }));
    parsed.posts = parsed.posts || [];
    const seedPostsById = new Map((SEED.posts || []).map(post => [post.id, post]));
    parsed.posts = parsed.posts.map(post => {
      const seeded = seedPostsById.get(post.id);
      if (!seeded) return post;
      return {
        ...post,
        author: seeded.author,
        title: seeded.title,
        cover: seeded.cover,
        excerpt: seeded.excerpt,
        content: seeded.content
      };
    });
    const existingPostIds = new Set(parsed.posts.map(post => post.id));
    for (const seededPost of SEED.posts || []) {
      if (!existingPostIds.has(seededPost.id)) parsed.posts.push({ ...seededPost });
    }
    parsed.notifications = parsed.notifications || [];
    parsed.comments = parsed.comments || [];
    parsed.currentUser = parsed.currentUser || null;
    parsed.users = (parsed.users || []).map(u => ({
      ...u,
      badges: u.badges || [],
      displayBadge: u.displayBadge || null
    }));
    parsed.bookmarks = parsed.bookmarks || [];
    parsed.chat = parsed.chat || JSON.parse(JSON.stringify(SEED.chat));

    if (parsed.currentUser) {
      const currentUser = parsed.users.find(u => u.username === parsed.currentUser);
      if (currentUser && ALLOWED_CREATOR_USERNAMES.has(currentUser.username) && !currentUser.badges.includes("creator")) {
        currentUser.badges.push("creator");
      }
    }

    parsed.users.forEach(u => {
      if (!ALLOWED_CREATOR_USERNAMES.has(u.username)) {
        u.badges = (u.badges || []).filter(b => b !== "creator");
        if (u.displayBadge === "creator") u.displayBadge = null;
      } else if (!u.badges.includes("creator")) {
        u.badges.push("creator");
      }
    });

    const badgeAssignments = SIGNUP_BADGE_AWARDS;
    parsed.users.forEach(u => {
      const awarded = badgeAssignments[u.username] || [];
      const existingBadges = new Set(u.badges || []);
      awarded.forEach(b => existingBadges.add(b));
      const newBadges = Array.from(existingBadges).filter(b => !(u.badges || []).includes(b));
      if (newBadges.length) {
        newBadges.forEach(badgeId => {
          parsed.notifications.unshift({
            id: "n" + Date.now() + Math.floor(Math.random() * 1000),
            type: "badge",
            badgeId,
            recipient: u.username,
            time: new Date().toISOString(),
            seen: false
          });
        });
      }
      u.badges = Array.from(existingBadges);
    });

    return parsed;
  } catch (e) {
    localStorage.setItem(DB_KEY, JSON.stringify(SEED));
    return JSON.parse(JSON.stringify(SEED));
  }
}

function saveDB(db) {
  // Save durable local state, including auth, users, posts, comments, notifications,
  // bookmarks, and chat so the full frontend-only app persists across reloads.
  const minimalDb = {
    currentUser: db.currentUser,
    users: db.users,
    posts: db.posts || [],
    comments: db.comments || [],
    notifications: db.notifications || [],
    bookmarks: db.bookmarks || [],
    chat: db.chat || { rooms: [{ room: "global", label: "Global", topic: "Everyone", members: [] }], messages: [], invites: [] }
  };
  try { localStorage.setItem(DB_KEY, JSON.stringify(minimalDb)); } catch (e) {}
  setCurrentUserCookie(db.currentUser || null);
}

const Progress = {
  db: loadDB(),
  // Optimistic until we know otherwise; loadFromApi() flips this to false if
  // the backend request fails outright (likely a free-tier cold boot).
  apiOnline: true,

  refresh() { this.db = loadDB(); return this.db; },
  persist() {
    saveDB(this.db);
  },

  async loadFromApi() {
    if (!API_ENABLED) return this.db;
    // If a fetch is already in flight, return the same promise
    // instead of firing a second identical batch of requests
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad().finally(() => {
        this._loadPromise = null;
    });
    return this._loadPromise;
},

  async _doLoad() {
    const savedCurrent = this.getCurrentUser();

    // ── Phase 1: load posts first so the feed renders ASAP ──────────────────
    // Posts are the only thing the feed needs to render. Users and notifications
    // can arrive later without blocking the initial paint.
    const posts = await apiFetch("/api/posts");
    this.apiOnline = posts !== null;
    if (posts && posts.length) {
      const apiIds = new Set(posts.map(p => p.id));
      const localOnly = (this.db.posts || []).filter(p => !apiIds.has(p.id));
      this.db.posts = [...localOnly, ...posts].sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date));
    } else if (posts && !posts.length) {
      this.db.posts = [];
    }
    // Fire a DOM event so pages can re-render as soon as posts arrive
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("progress:posts-loaded"));
    }

    // ── Phase 2: load users and notifications in parallel ───────────────────
    const [users, notifications] = await Promise.all([
      apiFetch("/api/users"),
      savedCurrent ? apiFetch(`/api/notifications?recipient=${encodeURIComponent(savedCurrent.username)}`) : Promise.resolve(null)
    ]);

    if (users && users.length) {
      this.db.users = users.map(u => {
        const existing = this.db.users.find(x => x.username === u.username);
        const normalized = {
          ...u,
          timezone: u.timezone || DEFAULT_TIMEZONE,
          following: u.following || [],
          followers: u.followers || [],
          bio: u.bio || "",
          badges: u.badges || []
        };
        if (existing) {
          if (existing.bio && !normalized.bio) normalized.bio = existing.bio;
          if (existing.badges && (!normalized.badges || !normalized.badges.length)) normalized.badges = existing.badges;
          if (existing.badges && normalized.badges && normalized.badges.length) {
            normalized.badges = Array.from(new Set([...(normalized.badges || []), ...existing.badges]));
          }
          if (existing.displayBadge && !normalized.displayBadge) normalized.displayBadge = existing.displayBadge;
          if (existing.email) normalized.email = existing.email;
          if (typeof existing.emailNotifications !== "undefined") normalized.emailNotifications = existing.emailNotifications;
          if (existing.password) normalized.password = existing.password;
        }
        return normalized;
      });
      if (savedCurrent && !this.db.users.some(u => u.username === savedCurrent.username)) {
        this.db.users.push(savedCurrent);
      }
    } else if (savedCurrent && savedCurrent.password) {
      this.syncLocalUserToApi(savedCurrent);
    }
    if (users && users.length && savedCurrent && !users.some(u => u.username === savedCurrent.username) && savedCurrent.password) {
      this.syncLocalUserToApi(savedCurrent);
    }
    if (notifications && notifications.length) this.db.notifications = notifications;

    // Fetch private fields for current user
    if (savedCurrent) {
      try {
        const me = await apiFetch("/api/me");
        if (me && me.id) {
          const meUser = this.db.users.find(u => u.username === me.username);
          if (meUser) {
            if (me.email) meUser.email = me.email;
            if (typeof me.emailNotifications !== "undefined") meUser.emailNotifications = me.emailNotifications;
          }
        }
      } catch (e) {}
    }

    this.persist();
    return this.db;
  },

  async syncLocalUserToApi(user) {
    if (this._syncingUser === user.username) return;
    this._syncingUser = user.username;
    try {
      const payload = await apiFetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user.username, name: user.name, password: user.password, timezone: user.timezone })
      });
      if (payload && !payload.error) {
        const existing = this.db.users.find(u => u.username === user.username);
        if (existing) Object.assign(existing, payload, { password: user.password });
        else this.db.users.push({ ...payload, password: user.password });
        this.persist();
      }
    } finally {
      this._syncingUser = null;
    }
  },

  async loadComments(postId) {
    if (!API_ENABLED) {
      return this.db.comments
        .filter(c => c.postId === postId)
        .sort((a, b) => new Date(a.time) - new Date(b.time));
    }
    const comments = await apiFetch(`/api/posts/${postId}/comments`);
    if (comments) {
      this.db.comments = (this.db.comments || []).filter(c => c.postId !== postId).concat(comments);
      return comments.sort((a, b) => new Date(a.time) - new Date(b.time));
    }
    return this.db.comments
      .filter(c => c.postId === postId)
      .sort((a, b) => new Date(a.time) - new Date(b.time));
  },

  getCurrentUser() {
    if (!this.db.currentUser) return null;
    return this.db.users.find(u => u.username === this.db.currentUser) || null;
  },

  getUser(username) {
    return this.db.users.find(u => u.username === username) || null;
  },

  getTimeZone() {
    const user = this.getCurrentUser();
    return user && user.timezone ? user.timezone : DEFAULT_TIMEZONE;
  },

  isFollowing(username) {
    const user = this.getCurrentUser();
    if (!user) return false;
    return user.following.includes(username);
  },

  createNotification(payload) {
    if (API_ENABLED) return;
    this.db.notifications.unshift({
      id: "n" + Date.now(),
      seen: false,
      time: new Date().toISOString(),
      ...payload
    });
    this.persist();
  },

  getComments(postId) {
    return this.db.comments
      .filter(c => c.postId === postId)
      .sort((a, b) => new Date(a.time) - new Date(b.time));
  },

  async createComment(postId, body, image) {
    const user = this.getCurrentUser();
    if (!user) return null;
    const post = this.getPost(postId);
    if (!post) return null;
    if (API_ENABLED) {
      const payload = await apiFetch(`/api/posts/${postId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: user.username, body, image })
      });
      if (payload && !payload.error) {
        await this.loadComments(postId);
        await this.loadFromApi();
        return payload;
      }
      // fallback to local comment creation when the API is unavailable
    }
    const comment = {
      id: "c" + Date.now(),
      postId,
      author: user.username,
      body,
      image: image || null,
      time: new Date().toISOString()
    };
    this.db.comments.push(comment);
    if (post.author !== user.username) {
      this.createNotification({
        type: "reply",
        actor: user.username,
        postId,
        postTitle: post.title,
        body,
        recipient: post.author
      });
    }
    this.persist();
    return comment;
  },

  async toggleFollow(targetUsername) {
    const user = this.getCurrentUser();
    if (!user || user.username === targetUsername) return null;
    const target = this.getUser(targetUsername);
    if (!target) return null;

    const isFollowing = user.following.includes(targetUsername);
    if (API_ENABLED) {
      const endpoint = `/api/users/${encodeURIComponent(target.id)}/${isFollowing ? "unfollow" : "follow"}`;
      const payload = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ followerId: user.id })
      });
      if (payload) {
        await this.loadFromApi();
        const refreshedUser = this.getCurrentUser();
        const refreshedTarget = this.getUser(targetUsername);
        return refreshedUser && refreshedTarget ? { following: refreshedUser.following, followers: refreshedTarget.followers } : null;
      }
      // fallback to local follow/unfollow when the API is unavailable
    }

    const followingIndex = user.following.indexOf(targetUsername);
    if (followingIndex === -1) {
      user.following.push(targetUsername);
      target.followers = target.followers || [];
      if (!target.followers.includes(user.username)) {
        target.followers.push(user.username);
      }
      this.createNotification({
        type: "follow",
        actor: user.username,
        recipient: targetUsername
      });
    } else {
      user.following.splice(followingIndex, 1);
      const followerIndex = target.followers.indexOf(user.username);
      if (followerIndex !== -1) target.followers.splice(followerIndex, 1);
    }
    this.persist();
    return { following: user.following, followers: target.followers };
  },

  async login(username, password) {
    username = username.trim();
    if (!username || !password) return { ok: false, error: "Enter your username and password." };

    if (API_ENABLED) {
      const loginBody = JSON.stringify({ username, password });
      const headers = { "Content-Type": "application/json" };
      let result = await apiFetchAuth("/api/login", { method: "POST", headers, body: loginBody });
      if (result.status === 0) {
        // First attempt got no response at all (likely a free-tier cold
        // boot) - give it one longer-timeout retry before giving up.
        result = await apiFetchAuth("/api/login", { method: "POST", headers, body: loginBody }, 20000);
      }
      if (result.ok) {
        const { token, ...userData } = result.data;
        const user = { ...userData, password };
        const existing = this.db.users.find(u => u.username === user.username);
        if (existing) Object.assign(existing, user);
        else this.db.users.push(user);
        this.db.currentUser = user.username;
        setAuthToken(token);
        this.persist();
        return { ok: true, user };
      }
      if (result.status === 0) {
        // The server was genuinely unreachable (offline, or no local dev
        // backend running) - fall back to a locally cached account instead
        // of incorrectly telling the user their password is wrong.
        const localUser = this.db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (localUser && localUser.password === password) {
          this.db.currentUser = localUser.username;
          this.persist();
          return { ok: true, user: localUser };
        }
        return { ok: false, error: "Couldn't reach the server. Check your connection and try again in a moment." };
      }
      // The server responded definitively (e.g. 401 invalid credentials) -
      // trust that answer rather than a possibly-stale local cache.
      return { ok: false, error: result.error || "That username and password don't match." };
    }

    const localUser = this.db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!localUser || localUser.password !== password) return { ok: false, error: "That username and password don't match." };
    this.db.currentUser = localUser.username;
    this.persist();
    return { ok: true, user: localUser };
  },

  async signup(username, name, password) {
    username = username.trim().toLowerCase();
    const trimmedName = name.trim();
    if (!username || !trimmedName || !password) return { ok: false, error: "Fill in every field to continue." };
    if (this.db.users.some(u => u.username.toLowerCase() === username)) {
      return { ok: false, error: "That username is already taken." };
    }
    const badges = SIGNUP_BADGE_AWARDS[username] || [];

    if (API_ENABLED) {
      const signupBody = JSON.stringify({ username, name: trimmedName, password, timezone: DEFAULT_TIMEZONE, badges });
      const headers = { "Content-Type": "application/json" };
      let result = await apiFetchAuth("/api/users", { method: "POST", headers, body: signupBody });
      if (result.status === 0) {
        result = await apiFetchAuth("/api/users", { method: "POST", headers, body: signupBody }, 20000);
      }
      if (result.ok) {
        const { token, ...userData } = result.data;
        const user = { ...userData, password };
        const existing = this.db.users.find(u => u.username === user.username);
        if (existing) Object.assign(existing, user);
        else this.db.users.push(user);
        this.db.currentUser = user.username;
        setAuthToken(token);
        this.persist();
        return { ok: true, user };
      }
      if (result.status === 0) {
        // The server was genuinely unreachable (offline, or no local dev
        // backend running) - keep the demo usable with a local-only account
        // instead of silently pretending it exists server-side.
        const user = { id: "u" + Date.now(), username, name: trimmedName, password, avatar: null, joined: new Date().toISOString().slice(0, 10), timezone: DEFAULT_TIMEZONE, following: [], followers: [], bio: "", badges };
        this.db.users.push(user);
        this.db.currentUser = user.username;
        this.persist();
        return { ok: true, user, offline: true };
      }
      // The server responded definitively (e.g. 409 username already taken).
      return { ok: false, error: result.error || "That username is already taken." };
    }

    const user = { id: "u" + Date.now(), username, name: trimmedName, password, avatar: null, joined: new Date().toISOString().slice(0, 10), timezone: DEFAULT_TIMEZONE, following: [], followers: [], bio: "", badges };
    this.db.users.push(user);
    this.db.currentUser = user.username;
    this.persist();
    return { ok: true, user };
  },

  logout() {
    this.db.currentUser = null;
    setAuthToken(null);
    this.persist();
  },

  async updateProfile(fields) {
    const user = this.getCurrentUser();
    if (!user) return null;
    Object.assign(user, fields);
    if (API_ENABLED) {
      const payload = await apiFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields)
      });
      if (!payload) {
        this.persist();
        return user;
      }
      // Apply the server's authoritative response directly — don't call
      // loadFromApi() here. GET /api/users has a 30-second in-memory cache;
      // calling it right after a PATCH would return stale data and silently
      // undo whatever the user just changed (badge, name, bio, etc.).
      const localUser = this.db.users.find(u => u.username === (payload.username || user.username));
      if (localUser) {
        const preserved = { password: localUser.password, email: localUser.email };
        Object.assign(localUser, payload, preserved);
      }
      this.persist();
      return this.getCurrentUser();
    }
    this.persist();
    return user;
  },

  getPosts() {
    return [...this.db.posts].sort((a, b) => new Date(b.date) - new Date(a.date));
  },

  getPost(id) {
    return this.db.posts.find(p => p.id === id) || null;
  },

  async createPost({ title, content, cover, excerpt, category }) {
    const user = this.getCurrentUser();
    if (!user) return null;
    if (API_ENABLED) {
      const body = JSON.stringify({ author: user.username, title, content, cover, excerpt, category: category || null });
      let payload = await apiFetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      if (!payload) {
        // Retry once in case of a transient server/network hiccup before
        // falling back to a local-only post.
        payload = await apiFetch("/api/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body
        });
      }
      if (payload) {
        await this.loadFromApi();
        return payload;
      }
      // Fallback when the API is unavailable or returns an error.
      // This keeps the editor working in static/demo mode.
    }
    const id = "p" + (Date.now());
    const createdAt = new Date().toISOString();
    const post = {
      id,
      author: user.username,
      title: title || "Untitled entry",
      date: createdAt.slice(0, 10),
      createdAt,
      cover: cover || null,
      excerpt: excerpt || "",
      content: content || "",
      likes: 0,
      likedBy: []
    };
    this.db.posts.unshift(post);
    this.persist();
    return post;
  },

  async deletePost(postId) {
    const user = this.getCurrentUser();
    if (!user) return false;
    const post = this.getPost(postId);
    if (!post || post.author !== user.username) return false;
    if (API_ENABLED) {
      const res = await apiFetch(`/api/posts/${postId}`, { method: "DELETE" });
      if (res) {
        await this.loadFromApi();
        return true;
      }
      // fallback to local deletion when the API is unavailable
    }
    const index = this.db.posts.findIndex(p => p.id === postId);
    if (index === -1) return false;
    this.db.posts.splice(index, 1);
    this.db.comments = (this.db.comments || []).filter(c => c.postId !== postId);
    this.db.notifications = (this.db.notifications || []).filter(n => n.postId !== postId);
    this.persist();
    return true;
  },

  async deleteAccount() {
    const user = this.getCurrentUser();
    if (!user) return false;
    if (API_ENABLED) {
      const res = await apiFetch(`/api/users/${user.id}`, { method: "DELETE" });
      if (res !== null) {
        this.db.currentUser = null;
        this.db.users = this.db.users.filter(u => u.username !== user.username);
        this.db.posts = this.db.posts.filter(p => p.author !== user.username);
        this.db.comments = this.db.comments.filter(c => c.author !== user.username);
        this.persist();
        return true;
      }
    }
    // Fallback to local deletion
    this.db.currentUser = null;
    this.db.users = this.db.users.filter(u => u.username !== user.username);
    this.db.posts = this.db.posts.filter(p => p.author !== user.username);
    this.db.comments = this.db.comments.filter(c => c.author !== user.username);
    this.persist();
    return true;
  },

  async toggleLike(postId) {
    const user = this.getCurrentUser();
    const post = this.getPost(postId);
    if (!post || !user) return;
    if (API_ENABLED) {
      const payload = await apiFetch(`/api/posts/${postId}/like`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user.username })
      });
      if (payload && !payload.error) {
        await this.loadFromApi();
        return payload;
      }
      // fallback to local like toggling when the API is unavailable
    }
    const who = user.username;
    const idx = post.likedBy.indexOf(who);
    if (idx === -1) {
      post.likedBy.push(who);
      post.likes += 1;
      if (post.author !== who) {
        this.createNotification({
          type: "like",
          actor: who,
          postId,
          postTitle: post.title,
          recipient: post.author
        });
      }
    } else {
      post.likedBy.splice(idx, 1);
      post.likes = Math.max(0, post.likes - 1);
    }
    this.persist();
    return post;
  },

  getNotifications() {
    const user = this.getCurrentUser();
    if (!user) return [];
    return [...this.db.notifications]
      .filter(n => !n.recipient || n.recipient === user.username)
      .sort((a, b) => new Date(b.time) - new Date(a.time));
  },

  // Injects a single notification pushed live over the WebSocket, without
  // needing a full reload from the server - guards against duplicates in
  // case the same notification somehow arrives twice.
  addNotification(notification) {
    if (!notification || !notification.id) return;
    if (this.db.notifications.some(n => n.id === notification.id)) return;
    this.db.notifications.unshift(notification);
  },

  removeNotification(id) {
    this.db.notifications = this.db.notifications.filter(n => n.id !== id);
    this.persist();
    apiFetch(`/api/notifications/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  },

  unseenCount() {
    const user = this.getCurrentUser();
    if (!user) return 0;
    return this.db.notifications.filter(n =>
      (!n.recipient || n.recipient === user.username) &&
      !n.seen &&
      !(n.type === "message" && n.body && n.body.startsWith("📞::"))
    ).length;
  },

  async markAllSeen() {
    const user = this.getCurrentUser();
    if (!user) return;
    if (API_ENABLED) {
      const payload = await apiFetch("/api/notifications/mark-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: user.username })
      });
      if (payload) {
        await this.loadFromApi();
        return;
      }
      // fallback to local notification state when the API is unavailable
    }
    this.db.notifications.forEach(n => {
      if (!n.recipient || n.recipient === user.username) n.seen = true;
    });
    this.persist();
  },

  timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  },

  formatDate(iso) {
    if (!iso) return "Unknown";
    const date = iso.includes("T") ? new Date(iso) : new Date(iso + "T00:00:00");
    if (isNaN(date.getTime())) return iso;
    return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  },

  formatDateTime(iso) {
    if (!iso) return "";
    const tz = this.getTimeZone();
    const date = iso.includes("T") ? new Date(iso) : new Date(iso + "T00:00:00");
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: tz,
        timeZoneName: "short"
      }).format(date);
    } catch (e) {
      return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) + " • " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
  },

  formatDateShort(iso) {
    const date = iso && iso.includes("T") ? new Date(iso) : new Date(iso + "T00:00:00");
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }).toUpperCase();
  }
};