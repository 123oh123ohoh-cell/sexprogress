/* ============================================================
   PROGRESS — shared app shell (nav, dropdowns, auth modals)
   Included on every page. Expects <div id="nav-root"></div>
   and <div id="modal-root"></div> somewhere in the document.
   ============================================================ */

const ICONS = {
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.1 2 4.5 5.6 4c2-.3 3.9.7 6.4 3.4C14.5 4.7 16.4 3.7 18.4 4c3.6.5 5.2 4.1 3.6 7.7C19.5 16.4 12 21 12 21z"/></svg>`,
  reply: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12l5-5v3c7 0 10 3 11 8-3-3-6-4-11-4v3z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`
};

// Updates the browser tab title to show "(N) PageTitle" when there are
// unseen notifications, so users see the count even when the tab is in the
// background. Passing 0 (or nothing) restores the original title.
function updateTitleBadge(count) {
  const base = document.title.replace(/^\(\d+\)\s*/, "");
  document.title = count > 0 ? `(${count}) ${base}` : base;
}

const BADGES = {
  reader: { label: "Avid Reader", description: "Enjoys reading entries and exploring the community.", icon: "📚" },
  supporter: { label: "Community Supporter", description: "Leaves thoughtful feedback and encourages others.", icon: "🤝" },
  early_supporter: { label: "Early Supporter", description: "Joined early and playtested during the initial development phase!", image: "images/emoticons/asleep_couch.png" },
  dexterity: { label: "Dexterity", description: "Awarded for playing during the Valorant ban on July 4th.", image: "images/emoticons/dexterity.png" },
  "817x2": { label: "817x2", description: "Awarded for 817x2, OurSpawn easter egg!", image: "images/emoticons/817x2.png" },
  trop: { label: "Trop", description: "Awarded for being a dedicated, early member!", image: "images/emoticons/trop.png" },
  jason: { label: "Jason", description: "Awarded for being here.. <em>or is he here?</em>", image: "images/emoticons/jason.png" },
  dolphin_eat: { label: "Ate By Dolphin", description: "Awarded for being eaten by a dolphin.", image: "images/emoticons/dolphin_eat.png" },
  creator: { label: "Creator", description: "Awarded for creator contributions.", image: "images/creator.png" },
  dark: { label: "Dark", description: "Awarded for being a early supporter, one and only!", image: "images/emoticons/dark.png" },
  tester: { label: "Early Tester", description: "Helped test and shape Progress before it launched.", image: "images/emoticons/banana_hello.png" },
  verified: { label: "Verified", description: "Verified account.", icon: "✅" },
  mod: { label: "Moderator", description: "Keeps the community safe and on-track.", icon: "🛡️" },
  og: { label: "OG", description: "One of the very first people on Progress.", icon: "⭐" },
  writer: { label: "Writer", description: "Recognized for exceptional writing on Progress.", icon: "🖋️" },
};

const BROWSE_ALLOWED_USERNAMES = new Set(["mara", "own", "progresstesting1"]);

function canBrowseUsers(user) {
  if (!user) return false;
  if (BROWSE_ALLOWED_USERNAMES.has(user.username)) return true;
  return ["owner", "moderator"].includes(user.adminRole);
}

function canAccessEmails(user) {
  if (!user) return false;
  if (BROWSE_ALLOWED_USERNAMES.has(user.username)) return true;
  return ["owner", "moderator", "analyst", "email_writer"].includes(user.adminRole);
}


function renderBadgeChip(id, activeId) {
  const badge = BADGES[id];
  if (!badge) return "";
  const isActive = !!activeId && id === activeId;
  const activeClass = isActive ? " is-displayed" : "";
  const activeAttr = isActive ? ` data-active="true"` : "";
  if (badge.image) {
    const extraClass = id === "creator" ? " creator-badge" : "";
    return `<img class="profile-badge profile-badge-image${extraClass}${activeClass}" src="${badge.image}" alt="${badge.label}" title="${badge.label}" data-badge-id="${id}"${activeAttr} tabindex="0" />`;
  }
  return `<span class="profile-badge${activeClass}" data-badge-id="${id}"${activeAttr} tabindex="0" aria-label="${badge.label}">${badge.icon}</span>`;
}

function renderDisplayBadge(user) {
  if (!user || !user.displayBadge) return "";
  const badge = BADGES[user.displayBadge];
  if (!badge) return "";
  const extraClass = user.displayBadge === "creator" ? " creator-badge" : "";
  if (badge.image) {
    return `<img class="display-badge-image${extraClass}" src="${badge.image}" alt="${badge.label}" title="${badge.label}" data-badge-id="${user.displayBadge}" tabindex="0">`;
  }
  return `<span class="display-badge-text" data-badge-id="${user.displayBadge}" tabindex="0">${badge.icon}</span>`;
}

function renderBadges(user) {
  if (!user || !user.badges || !user.badges.length) return "";
  return user.badges.map(id => renderBadgeChip(id)).join(" ");
}

function renderBadgeDetails(user) {
  if (!user || !user.badges || !user.badges.length) return "";
  return `<div class="profile-badges-inventory">${user.badges.map(id => renderBadgeChip(id, user.displayBadge)).join(" ")}</div>`;
}

function attachBadgeTooltip(root) {
  if (!root) return;
  let tooltip = document.getElementById("badge-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "badge-tooltip";
    tooltip.className = "emoji-tooltip hidden";
    document.body.appendChild(tooltip);
  }
  root.querySelectorAll(".profile-badge, .display-badge-image, .display-badge-text").forEach(el => {
    const id = el.dataset.badgeId;
    const badge = BADGES[id];
    if (!badge) return;
    const show = () => {
      const icon = badge.image ? `<img src="${badge.image}" alt="${badge.label}" class="tooltip-badge-image">` : badge.icon;
      const note = id === "dexterity" ? `<div style="margin-top:8px; font-size:11px; color:var(--muted);">This badge can't be displayed on display name.</div>` : "";
      tooltip.innerHTML = `<div class="emoji-tooltip-label">${icon} ${badge.label}</div><div style="font-size:12px; color:var(--ink); line-height:1.4;">${badge.description}</div>${note}`;
      tooltip.classList.remove("hidden");
      const rect = el.getBoundingClientRect();
      const left = Math.min(window.innerWidth - tooltip.offsetWidth - 12, Math.max(12, rect.left + rect.width / 2 - tooltip.offsetWidth / 2));
      const top = rect.top - tooltip.offsetHeight - 10;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top < 12 ? rect.bottom + 10 : top}px`;
    };
    el.addEventListener("mouseenter", show);
    el.addEventListener("focus", show);
    el.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
    el.addEventListener("blur", () => tooltip.classList.add("hidden"));
  });
}

const EMOTICON_NAMES = [
  "asleep_couch", "backpack", "banana", "banana_hello", "bee", "bored",
  "charles", "computer", "computer2", "computersupport", "construction",
  "cow", "dead", "dexterity", "dolphinhead", "fishhead", "hamster", "hi", "jason",
  "kiss", "lion", "mwa", "pancake", "penguin", "poodle", "raincoat", "raindeer",
  "romantic", "shark", "shark2", "sharkcat", "squish", "squuish",
  "starbucks", "turtle_lazy", "two", "windy", "wonder"
];
const EMOTICON_NAME_SET = new Set(EMOTICON_NAMES);

function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
}

function avatarHTML(user, size) {
  if (user && user.avatar) return `<img src="${user.avatar}" alt="Avatar">`;
  if (!user) return `<img src="images/default.jpg" alt="Avatar">`;
  const label = initials(user.name);
  return `<span class="initials" style="font-size:${size ? size * 0.4 + 'px' : ''}">${label}</span>`;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const SPOTIFY_EMBED_TYPES = new Set(["track", "album", "playlist", "artist", "episode", "show"]);
const SPOTIFY_EMBED_HEIGHTS = { track: 152, episode: 232, show: 232, album: 352, playlist: 352, artist: 352 };

function parseSpotifyLink(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  let match = trimmed.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)(?:\?\S*)?$/i);
  if (!match) match = trimmed.match(/^spotify:(track|album|playlist|artist|episode|show):([a-zA-Z0-9]+)$/i);
  if (!match) return null;
  const type = match[1].toLowerCase();
  if (!SPOTIFY_EMBED_TYPES.has(type)) return null;
  return { type, id: match[2] };
}

function spotifyEmbedUrl(raw) {
  const parsed = parseSpotifyLink(raw);
  if (!parsed) return null;
  return `https://open.spotify.com/embed/${parsed.type}/${parsed.id}?utm_source=generator`;
}

function renderSpotifyEmbed(user) {
  const parsed = parseSpotifyLink(user && user.spotify);
  if (!parsed) return "";
  const height = SPOTIFY_EMBED_HEIGHTS[parsed.type] || 352;
  const src = `https://open.spotify.com/embed/${parsed.type}/${parsed.id}?utm_source=generator`;
  return `<div class="spotify-embed"><iframe src="${src}" width="100%" height="${height}" frameborder="0" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="Spotify embed"></iframe></div>`;
}

async function fetchSpotifyNowPlaying(userId) {
  if (!userId) return null;
  return apiFetch(`/api/users/${userId}/spotify/now-playing`);
}

function formatNowPlayingClock(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const SPOTIFY_GLYPH = `<svg class="now-playing-spotify-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.32 9.719-.66 13.439 1.621.361.181.54.78.302 1.2zm.12-3.36c-3.899-2.34-10.32-2.58-14.037-1.38-.6.181-1.2-.18-1.381-.72-.18-.6.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.72 1.621.539.3.719 1.02.42 1.56-.301.42-1.021.6-1.442.3z"/></svg>`;

function renderNowPlayingWidget(data) {
  if (!data || !data.playing) return "";
  const p = data.playing;
  const safeHref = p.trackUrl && p.trackUrl.startsWith("https://open.spotify.com/") ? p.trackUrl : "#";
  const safeArt = p.albumArt && /^https:\/\//i.test(p.albumArt) ? p.albumArt : null;
  const stateClass = p.isPlaying ? "is-playing" : "is-paused";
  const hasProgress = typeof p.progressMs === "number" && typeof p.durationMs === "number" && p.durationMs > 0;
  const duration = hasProgress ? p.durationMs : 0;
  const progress = hasProgress ? Math.min(p.progressMs, duration) : 0;
  const pct = hasProgress ? Math.min(100, (progress / duration) * 100) : 0;
  const dataAttrs = hasProgress
    ? `data-duration-ms="${duration}" data-progress-ms="${progress}" data-fetched-at="${p.fetchedAt || Date.now()}" data-is-playing="${p.isPlaying ? "1" : "0"}"`
    : "";
  return `
    <a class="now-playing-widget ${stateClass}" href="${safeHref}" target="_blank" rel="noopener noreferrer" ${dataAttrs}>
      <div class="now-playing-header">${SPOTIFY_GLYPH}<span>${p.isPlaying ? "Listening to Spotify" : "Paused on Spotify"}</span></div>
      <div class="now-playing-body">
        ${safeArt ? `<img src="${safeArt}" alt="">` : `<div class="now-playing-art-fallback">♪</div>`}
        <div class="now-playing-info">
          <span class="now-playing-track">${escapeHTML(p.trackName || "")}</span>
          <span class="now-playing-artist">${escapeHTML(p.artistNames || "")}</span>
          ${hasProgress ? `
          <div class="now-playing-progress">
            <div class="now-playing-progress-fill" style="width:${pct.toFixed(2)}%"></div>
          </div>
          <div class="now-playing-times">
            <span class="now-playing-elapsed">${formatNowPlayingClock(progress)}</span>
            <span class="now-playing-duration">${formatNowPlayingClock(duration)}</span>
          </div>` : ""}
        </div>
      </div>
    </a>`;
}

function tickProgressEl(el) {
  const duration = Number(el.dataset.durationMs);
  const baseProgress = Number(el.dataset.progressMs);
  const fetchedAt = Number(el.dataset.fetchedAt);
  const isPlaying = el.dataset.isPlaying === "1";
  if (!duration) return;
  const elapsed = isPlaying ? baseProgress + (Date.now() - fetchedAt) : baseProgress;
  const clamped = Math.max(0, Math.min(duration, elapsed));
  const pct = Math.min(100, (clamped / duration) * 100);
  const fill = el.querySelector(".now-playing-progress-fill, .dm-listen-progress-fill");
  const elapsedLabel = el.querySelector(".now-playing-elapsed");
  if (fill) fill.style.width = pct.toFixed(2) + "%";
  if (elapsedLabel) elapsedLabel.textContent = formatNowPlayingClock(clamped);
}

function tickNowPlayingWidgets() {
  document.querySelectorAll(".now-playing-widget[data-duration-ms], .dm-listen-banner[data-duration-ms]").forEach(tickProgressEl);
}
setInterval(tickNowPlayingWidgets, 1000);

async function fetchListenSessions() {
  return (await apiFetch("/api/listen/sessions")) || [];
}

async function fetchListenSession(id) {
  return apiFetch(`/api/listen/sessions/${encodeURIComponent(id)}`);
}

async function createListenSession() {
  const user = Progress.getCurrentUser();
  if (!user) return null;
  return apiFetch("/api/listen/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostId: user.id })
  });
}

async function joinListenSession(id) {
  const user = Progress.getCurrentUser();
  if (!user) return null;
  return apiFetch(`/api/listen/sessions/${encodeURIComponent(id)}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id })
  });
}

async function leaveListenSession(id) {
  const user = Progress.getCurrentUser();
  if (!user) return null;
  return apiFetch(`/api/listen/sessions/${encodeURIComponent(id)}/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id })
  });
}

async function endListenSession(id) {
  const user = Progress.getCurrentUser();
  if (!user) return null;
  return apiFetch(`/api/listen/sessions/${encodeURIComponent(id)}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id })
  });
}

async function syncMeToListenSession(id) {
  const user = Progress.getCurrentUser();
  if (!user) return { synced: false, reason: "Log in first." };
  const result = await apiFetch(`/api/listen/sessions/${encodeURIComponent(id)}/sync-me`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id })
  });
  return result || { synced: false, reason: "Couldn't reach the server." };
}

function renderListenSessionCard(session, opts) {
  opts = opts || {};
  const hasProgress = typeof session.progressMs === "number" && typeof session.durationMs === "number" && session.durationMs > 0;
  const pct = hasProgress ? Math.min(100, (session.progressMs / session.durationMs) * 100) : 0;
  // Always stamp server-updated-at and track-uri so the first in-place-update poll
  // doesn't see them as absent and wrongly reset the progress-ticker baseline.
  const baseDataAttrs = `data-server-updated-at="${session.updatedAt || ""}" data-track-uri="${escapeHTML(session.trackUri || "")}"`;
  const dataAttrs = hasProgress
    ? `${baseDataAttrs} data-duration-ms="${session.durationMs}" data-progress-ms="${session.progressMs}" data-fetched-at="${Date.now()}" data-is-playing="${session.isPlaying ? "1" : "0"}"`
    : baseDataAttrs;
  const viewer = Progress.getCurrentUser();
  const isHost = viewer && viewer.username === session.hostUsername;
  const isJoined = viewer && session.participants.includes(viewer.username);
  return `
    <div class="listen-session-card now-playing-widget ${session.isPlaying ? "is-playing" : "is-paused"}" data-session-id="${session.id}" ${dataAttrs}>
      <div class="now-playing-header">${SPOTIFY_GLYPH}<span>@${escapeHTML(session.hostUsername)}'s listening session</span></div>
      <div class="now-playing-body">
        ${session.albumArt ? `<img src="${session.albumArt}" alt="">` : `<div class="now-playing-art-fallback">${SPOTIFY_GLYPH}</div>`}
        <div class="now-playing-info">
          <span class="now-playing-track">${escapeHTML(session.trackName || "Nothing playing yet")}</span>
          <span class="now-playing-artist">${escapeHTML(session.artistNames || "")}</span>
          ${hasProgress ? `
          <div class="now-playing-progress"><div class="now-playing-progress-fill" style="width:${pct.toFixed(2)}%"></div></div>
          <div class="now-playing-times">
            <span class="now-playing-elapsed">${formatNowPlayingClock(session.progressMs)}</span>
            <span class="now-playing-duration">${formatNowPlayingClock(session.durationMs)}</span>
          </div>` : ""}
        </div>
      </div>
      <div class="listen-session-actions">
        <span class="listen-session-count">${session.participants.length} listening</span>
        ${isHost
          ? `<button type="button" class="btn danger listen-end-btn" data-session-id="${session.id}">End session</button>`
          : isJoined
            ? `<button type="button" class="btn listen-sync-btn" data-session-id="${session.id}">Sync my Spotify</button>
               <button type="button" class="btn secondary listen-leave-btn" data-session-id="${session.id}">Leave</button>`
            : `<button type="button" class="btn primary listen-join-btn" data-session-id="${session.id}">Join &amp; sync</button>`}
      </div>
    </div>`;
}

document.addEventListener("click", async (e) => {
  const joinBtn = e.target.closest(".listen-join-btn");
  const leaveBtn = e.target.closest(".listen-leave-btn");
  const endBtn = e.target.closest(".listen-end-btn");
  const syncBtn = e.target.closest(".listen-sync-btn");
  if (!joinBtn && !leaveBtn && !endBtn && !syncBtn) return;

  if (!Progress.getCurrentUser()) { showModal("login"); return; }

  if (joinBtn) {
    joinBtn.disabled = true;
    const result = await joinListenSession(joinBtn.dataset.sessionId);
    if (result) {
      showToast("Joined. Syncing your Spotify…");
      const sync = await syncMeToListenSession(joinBtn.dataset.sessionId);
      showToast(sync.synced ? "Synced!" : (sync.reason || "Couldn't sync."));
      document.dispatchEvent(new CustomEvent("listen-session-updated"));
    } else {
      joinBtn.disabled = false;
      showToast("Couldn't join that session.");
    }
  } else if (leaveBtn) {
    leaveBtn.disabled = true;
    await leaveListenSession(leaveBtn.dataset.sessionId);
    document.dispatchEvent(new CustomEvent("listen-session-updated"));
  } else if (endBtn) {
    endBtn.disabled = true;
    await endListenSession(endBtn.dataset.sessionId);
    document.dispatchEvent(new CustomEvent("listen-session-updated"));
  } else if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.textContent = "Syncing…";
    const sync = await syncMeToListenSession(syncBtn.dataset.sessionId);
    showToast(sync.synced ? "Synced!" : (sync.reason || "Couldn't sync."));
    syncBtn.disabled = false;
    syncBtn.textContent = "Sync my Spotify";
  }
});

const YOUTUBE_URL_PATTERNS = [
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^\s#]*&)?v=([a-zA-Z0-9_-]{11})(?:[&#][^\s]*)?$/i,
  /^https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?#][^\s]*)?$/i,
  /^https?:\/\/(?:www\.|m\.)?youtube(?:-nocookie)?\.com\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})(?:[?#][^\s]*)?$/i
];

function parseYouTubeLink(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  let id = null;
  for (const re of YOUTUBE_URL_PATTERNS) {
    const match = trimmed.match(re);
    if (match) { id = match[1]; break; }
  }
  if (!id) return null;
  return { id, start: parseYouTubeStart(trimmed) };
}

function parseYouTubeStart(raw) {
  const match = raw.match(/[?&#](?:t|start)=([0-9hms]+)/i);
  if (!match) return 0;
  const value = match[1];
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  let seconds = 0;
  (value.match(/\d+[hms]/gi) || []).forEach(part => {
    const n = parseInt(part, 10);
    const unit = part.slice(-1).toLowerCase();
    if (unit === "h") seconds += n * 3600;
    else if (unit === "m") seconds += n * 60;
    else seconds += n;
  });
  return seconds;
}

function renderYouTubeEmbed(raw) {
  const parsed = parseYouTubeLink(raw);
  if (!parsed) return "";
  const src = `https://www.youtube-nocookie.com/embed/${parsed.id}${parsed.start ? `?start=${parsed.start}` : ""}`;
  return `<div class="yt-embed" contenteditable="false"><iframe src="${src}" width="100%" height="315" title="YouTube video player" frameborder="0" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`;
}

function getEmoticonNames() {
  return [...EMOTICON_NAMES];
}

function shouldSkipEmoticonNode(node) {
  let current = node.parentNode;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = current.tagName;
    if (tag === "CODE" || tag === "PRE" || tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

function renderEmoticonsInHTML(html, cssClass = "inline-emoticon") {
  if (!html) return "";

  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let current;

  while ((current = walker.nextNode())) {
    if (!shouldSkipEmoticonNode(current)) textNodes.push(current);
  }

  const tokenRE = /:([a-z0-9_]+):/gi;

  textNodes.forEach(node => {
    const raw = node.nodeValue || "";
    tokenRE.lastIndex = 0;
    if (!tokenRE.test(raw)) return;

    tokenRE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    while ((match = tokenRE.exec(raw))) {
      const full = match[0];
      const name = (match[1] || "").toLowerCase();
      if (!EMOTICON_NAME_SET.has(name)) continue;

      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(raw.slice(lastIndex, match.index)));
      }

      const img = document.createElement("img");
      img.className = cssClass;
      img.src = `images/emoticons/${name}.png`;
      img.alt = name;
      frag.appendChild(img);

      lastIndex = match.index + full.length;
    }

    if (!lastIndex) return;
    if (lastIndex < raw.length) {
      frag.appendChild(document.createTextNode(raw.slice(lastIndex)));
    }
    node.replaceWith(frag);
  });

  return template.innerHTML;
}

function renderEmoticonsText(text, cssClass = "inline-emoticon") {
  return renderEmoticonsInHTML(escapeHTML(text || ""), cssClass);
}

function isVideoAsset(src) {
  if (!src || typeof src !== "string") return false;
  const clean = src.split(/[?#]/)[0];
  return /\.(mp4|webm|mov|mkv|avi|wmv|ogv)$/i.test(clean);
}

function renderCoverMedia(src, options = {}) {
  if (!src) return "";
  const {
    className = "cover-media",
    alt = "",
    videoControls = false,
    videoAutoplay = false,
    videoMuted = true,
    videoLoop = true,
    videoPlaysInline = true,
    loading = "lazy"
  } = options;

  const safeSrc = escapeHTML(encodeURI(src));
  const safeAlt = escapeHTML(alt || "");

  if (isVideoAsset(src)) {
    const attrs = [
      `class="${className}"`,
      `src="${safeSrc}"`,
      videoControls ? "controls" : "",
      videoAutoplay ? "autoplay" : "",
      videoMuted ? "muted" : "",
      videoLoop ? "loop" : "",
      videoPlaysInline ? "playsinline" : "",
      "preload=\"metadata\""
    ].filter(Boolean).join(" ");
    return `<video ${attrs}></video>`;
  }

  return `<img class="${className}" src="${safeSrc}" alt="${safeAlt}" loading="${loading}">`;
}

function renderMentionsInHTML(html, cssClass = "mention-link") {
  if (!html) return "";

  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let current;

  while ((current = walker.nextNode())) {
    if (!shouldSkipEmoticonNode(current)) textNodes.push(current);
  }

  const tokenRE = /@([a-zA-Z0-9_.]+)/g;

  textNodes.forEach(node => {
    const raw = node.nodeValue || "";
    tokenRE.lastIndex = 0;
    if (!tokenRE.test(raw)) return;

    tokenRE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    let touched = false;

    while ((match = tokenRE.exec(raw))) {
      const full = match[0];
      const username = (match[1] || "").toLowerCase();
      const mentionedUser = Progress.getUser(username);
      if (!mentionedUser) continue;

      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(raw.slice(lastIndex, match.index)));
      }

      const link = document.createElement("a");
      link.className = cssClass;
      link.href = `user.html?id=${mentionedUser.id}`;
      link.textContent = full;
      frag.appendChild(link);

      lastIndex = match.index + full.length;
      touched = true;
    }

    if (!touched) return;
    if (lastIndex < raw.length) {
      frag.appendChild(document.createTextNode(raw.slice(lastIndex)));
    }
    node.replaceWith(frag);
  });

  return template.innerHTML;
}

function bootingUpHTML(opts) {
  const { title = "Waking up the server\u2026 \u{1F634}", padding = "80px 20px" } = opts || {};
  return `
    <div class="feed-empty" style="padding:${padding}; text-align:center;">
      <div class="error-illustration" style="max-width:280px;">
        <img src="images/404page.png" alt="Sleepy server illustration">
      </div>
      <h3>${title}</h3>
      <p>We run on free servers that snooze when nobody's around, so they need a minute or two to stretch and boot back up. Sorry for the wait &mdash; hang tight and try refreshing shortly!</p>
    </div>`;
}

function renderNav(activePage) {
  const root = document.getElementById("nav-root");
  if (!root) return;
  const user = Progress.getCurrentUser();
  const unseen = Progress.unseenCount();

  root.innerHTML = `
    <nav class="nav">
      <a href="index.html" class="nav-title">
        <span class="nav-logo-text">Sex</span>
        <img class="nav-logo-image" src="images/nearheader.png" alt="" loading="lazy">
      </a>
      <span class="nav-glow-chip" aria-hidden="true">夜 mode</span>
      <div class="nav-right">
        <a href="chat.html" class="nav-new nav-chat-link">chat</a>
        ${user ? `<a href="write.html" class="nav-new">+ new entry</a>` : ""}
        <div class="bell-wrap">
          <button class="bell-btn" id="bellBtn" aria-label="Notifications">
            ${ICONS.bell}
            <span class="bell-badge ${unseen ? "" : "hidden"}" id="bellBadge">${unseen}</span>
          </button>
          <div class="dropdown notif" id="notifDropdown"></div>
        </div>
        <div class="avatar-wrap">
          <button class="avatar-btn" id="avatarBtn" aria-label="Account">
            ${avatarHTML(user)}
          </button>
          <div class="dropdown" id="accountDropdown"></div>
        </div>
      </div>
    </nav>
    <nav class='mobile-bottom-nav'>
      <a href='index.html' class='mbn-item ${activePage === "feed" ? "active" : ""}'>
        <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/><polyline points='9 22 9 12 15 12 15 22'/></svg>
        <span>Home</span>
      </a>
      <a href='explore.html' class='mbn-item ${activePage === "explore" ? "active" : ""}'>
        <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='8'/><line x1='21' y1='21' x2='16.65' y2='16.65'/></svg>
        <span>Explore</span>
      </a>
      <a href='write.html' class='mbn-item ${activePage === "write" ? "active" : ""}'>
        <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 20h9'/><path d='M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'/></svg>
        <span>Write</span>
      </a>
      <a href='chat.html' class='mbn-item ${activePage === "chat" ? "active" : ""}'>
        <span class='mbn-chat-icon'>
          <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/></svg>
          <span class='mbn-chat-badge' id='mbnChatBadge'></span>
        </span>
        <span>Chat</span>
      </a>
      <a href='profile.html' class='mbn-item ${activePage === "profile" || activePage === "settings" ? "active" : ""}'>
        <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/><circle cx='12' cy='7' r='4'/></svg>
        <span>Me</span>
      </a>
    </nav>
  `;

  renderNotifDropdown();
  renderAccountDropdown(user, activePage);
  wireDropdowns();
  // Chat page clears the badge; every other page just shows whatever's stored
  if (activePage === "chat") setDmUnread(0);
  else updateChatNavBadge();
}

function renderNotifDropdown() {
  const el = document.getElementById("notifDropdown");
  if (!el) return;
  const notifs = Progress.getNotifications();

  // Filter out WebRTC call signaling messages (never meaningful as notifications)
  const visibleNotifs = notifs.filter(n => {
    if (n.type === "message" && n.body && n.body.startsWith("📞::")) return false;
    return true;
  });

  const rows = visibleNotifs.length
    ? visibleNotifs.map(n => {
        const actorUser = Progress.getUser(n.actor);
        const actorHref = actorUser ? `user.html?id=${actorUser.id}` : `user.html?username=${encodeURIComponent(n.actor)}`;
        const actorText = `<strong><span class="username-link" data-href="${actorHref}">@${escapeHTML(n.actor)}</span></strong>`;
        const postHref = n.postId ? `post.html?id=${n.postId}` : "";
        const chatHref = n.type === "message"
          ? `chat.html?with=${encodeURIComponent(n.actor)}`
          : n.type === "mention"
            ? "chat.html"
            : "";
        const targetHref = postHref || chatHref;
        let text;

        if (n.type === "like") {
          text = `${actorText} liked your post "${renderEmoticonsText(n.postTitle, "notif-emoticon")}"`;
        } else if (n.type === "reply") {
          text = `${actorText} replied: "${renderEmoticonsText(n.body, "notif-emoticon")}"`;
        } else if (n.type === "follow") {
          text = `${actorText} started following you`;
        } else if (n.type === "badge") {
          const badge = BADGES[n.badgeId];
          const badgeName = badge ? badge.label : n.badgeId;
          text = `You've been awarded with '${escapeHTML(badgeName)}'!`;
        } else if (n.type === "streak") {
          text = `🔥 You've logged in ${n.streak} days in a row. Keep it going!`;
        } else if (n.type === "message") {
          text = `${actorText} has messaged you: "${renderEmoticonsText(n.body, "notif-emoticon")}"`;
        } else if (n.type === "mention") {
          text = n.via === "comment"
            ? `${actorText} mentioned you in a comment on "${renderEmoticonsText(n.postTitle || "", "notif-emoticon")}": "${renderEmoticonsText(n.body, "notif-emoticon")}"`
            : n.via === "post"
              ? `${actorText} mentioned you in a post: "${renderEmoticonsText(n.postTitle || "", "notif-emoticon")}"`
              : `${actorText} mentioned you in chat: "${renderEmoticonsText(n.body, "notif-emoticon")}"`;
        } else if (n.type === "announcement") {
          text = `📢 <strong>${escapeHTML(n.title || "Announcement")}</strong>${n.body ? `<br><span style="font-weight:400;">${escapeHTML(n.body)}</span>` : ""}`;
        } else {
          text = `${actorText} did something`;
        }

        return `
          <div class="notif-item" data-notif-id="${n.id}" data-post-href="${targetHref}">
            <span class="dot-unread ${n.seen ? "seen" : ""}"></span>
            <div style="flex:1; min-width:0;">
              <p>${text}</p>
              <time>${Progress.timeAgo(n.time)}</time>
            </div>
            <button class="notif-dismiss" data-notif-id="${n.id}" title="Dismiss" aria-label="Dismiss notification">×</button>
          </div>`;
      }).join("")
    : `<div class="notif-empty">Nothing yet. Publish something and come back.</div>`;


  el.innerHTML = `<div class="dropdown-header">Notifications</div>${rows}`;

  el.querySelectorAll('.username-link').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const href = link.dataset.href;
      if (href) location.href = href;
    });
  });

  el.querySelectorAll('.notif-dismiss').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.notifId;
      Progress.removeNotification(id);
      renderNotifDropdown();
      const unseen = Progress.unseenCount();
      const badge = document.getElementById("bellBadge");
      if (badge) badge.classList.toggle("hidden", unseen === 0);
      updateTitleBadge(unseen);
    });
  });

  el.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => {
      const href = item.dataset.postHref;
      if (href) location.href = href;
    });
  });
}

function renderAccountDropdown(user, activePage) {
  const el = document.getElementById("accountDropdown");
  if (!el) return;

  if (!user) {
    el.innerHTML = `
      <button class="dropdown-item" id="openLogin">Log in</button>
      <button class="dropdown-item" id="openSignup">Create account</button>
    `;
    return;
  }

  el.innerHTML = `
    <div class="dropdown-header">${user.name} &middot; @${user.username}</div>
    ${canBrowseUsers(user) ? `<a class="dropdown-item" href="admin.html">Admin dashboard</a><a class="dropdown-item" href="users.html">Browse users</a>` : ""}
    <a class="dropdown-item" href="profile.html?tab=profile">Profile</a>
    <a class="dropdown-item" href="profile.html?tab=settings">Settings</a>
    <button class="dropdown-item danger" id="logoutBtn">Log out</button>
  `;
}

function closeAllDropdowns(except) {
  document.querySelectorAll(".dropdown.open").forEach(d => {
    if (d !== except) d.classList.remove("open");
  });
}

function wireDropdowns() {
  const bellBtn = document.getElementById("bellBtn");
  const avatarBtn = document.getElementById("avatarBtn");
  const notifDD = document.getElementById("notifDropdown");
  const accountDD = document.getElementById("accountDropdown");

  bellBtn && bellBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !notifDD.classList.contains("open");
    closeAllDropdowns();
    if (willOpen) {
      notifDD.classList.add("open");
      Progress.markAllSeen();
      renderNotifDropdown();
      const badge = document.getElementById("bellBadge");
      if (badge) badge.classList.add("hidden");
      updateTitleBadge(0);
    }
  });

  avatarBtn && avatarBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !accountDD.classList.contains("open");
    closeAllDropdowns();
    if (willOpen) accountDD.classList.add("open");
  });

  document.addEventListener("click", (e) => {
    if (!notifDD.contains(e.target) && e.target !== bellBtn && !accountDD.contains(e.target) && e.target !== avatarBtn) {
      closeAllDropdowns();
    }
  });
  notifDD && notifDD.addEventListener("click", (e) => e.stopPropagation());
  accountDD && accountDD.addEventListener("click", (e) => e.stopPropagation());

  const openLogin = document.getElementById("openLogin");
  const openSignup = document.getElementById("openSignup");
  const logoutBtn = document.getElementById("logoutBtn");

  openLogin && openLogin.addEventListener("click", () => showModal("login"));
  openSignup && openSignup.addEventListener("click", () => showModal("signup"));
  logoutBtn && logoutBtn.addEventListener("click", () => {
    Progress.logout();
    showToast("Signed out. See you soon.");
    setTimeout(() => location.reload(), 500);
  });
}

/* ============================================================
   AUTH MODALS
   ============================================================ */

function mountModals() {
  const root = document.getElementById("modal-root");
  if (!root) return;

  root.innerHTML = `
    <div class="modal-overlay" id="modalOverlay" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true">
        <button class="modal-close" id="modalClose">&times;</button>

        <div id="loginPane">
          <h2>Welcome back</h2>
          <p class="sub">Log in to write, like, and follow along.</p>
          <div class="modal-error" id="loginError"></div>
          <div class="field">
            <label for="loginUsername">Username</label>
            <input id="loginUsername" type="text" autocomplete="username" placeholder="mara" autocapitalize="none" spellcheck="false">
          </div>
          <div class="field">
            <label for="loginPassword">Password</label>
            <input id="loginPassword" type="password" autocomplete="current-password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" autocapitalize="none" spellcheck="false">
          </div>
          <button class="modal-submit" id="loginSubmit">Log in</button>
          <p class="modal-switch">New here? <button id="toSignup">Create an account</button></p>
          <p class="modal-switch" style="margin-top:6px; font-size:11.5px;">Try the demo: <strong>mara</strong> / <strong>demo1234</strong></p>
        </div>

        <div id="signupPane" style="display:none;">
          <h2>Start your journal</h2>
          <p class="sub">It takes a minute. Everyone's welcome.</p>
          <div class="modal-error" id="signupError"></div>
          <div class="field">
            <label for="signupName">Display name</label>
            <input id="signupName" type="text" placeholder="Mara Studios" autocapitalize="words" spellcheck="false">
          </div>
          <div class="field">
            <label for="signupUsername">Username</label>
            <input id="signupUsername" type="text" placeholder="mara" autocapitalize="none" spellcheck="false">
          </div>
          <div class="field">
            <label for="signupPassword">Password</label>
            <input id="signupPassword" type="password" autocomplete="new-password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" autocapitalize="none" spellcheck="false">
          </div>
          <button class="modal-submit" id="signupSubmit">Create account</button>
          <p class="modal-switch">Already have one? <button id="toLogin">Log in</button></p>
        </div>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `;

  const overlay = document.getElementById("modalOverlay");
  document.getElementById("modalClose").addEventListener("click", hideModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) hideModal(); });

  document.getElementById("toSignup").addEventListener("click", () => showModal("signup"));
  document.getElementById("toLogin").addEventListener("click", () => showModal("login"));

  const loginSubmit = document.getElementById("loginSubmit");
  const signupSubmit = document.getElementById("signupSubmit");
  function setModalButtonState(button, enabled, label) {
    if (!button) return;
    button.disabled = !enabled;
    if (label) button.textContent = label;
  }

  function withWakingLabel(button, label) {
    const timer = setTimeout(() => {
      if (button.disabled) button.textContent = label;
    }, 4000);
    return () => clearTimeout(timer);
  }

  document.getElementById("loginSubmit").addEventListener("click", async () => {
    const username = document.getElementById("loginUsername").value;
    const password = document.getElementById("loginPassword").value;
    const errEl = document.getElementById("loginError");
    errEl.classList.remove("show");
    errEl.textContent = "";
    setModalButtonState(loginSubmit, false, "Logging in...");
    const stopWaking = withWakingLabel(loginSubmit, "Waking up server\u2026");
    const res = await Progress.login(username, password);
    stopWaking();
    setModalButtonState(loginSubmit, true, "Log in");
    if (!res.ok) {
      errEl.textContent = res.error;
      errEl.classList.add("show");
      return;
    }
    hideModal();
    showToast(`Welcome back, ${res.user.name.split(" ")[0]}.`);
    setTimeout(() => location.reload(), 500);
  });

  document.getElementById("signupSubmit").addEventListener("click", async () => {
    const name = document.getElementById("signupName").value;
    const username = document.getElementById("signupUsername").value;
    const password = document.getElementById("signupPassword").value;
    const errEl = document.getElementById("signupError");
    errEl.classList.remove("show");
    errEl.textContent = "";
    setModalButtonState(signupSubmit, false, "Creating...");
    const stopWaking = withWakingLabel(signupSubmit, "Waking up server\u2026");
    const res = await Progress.signup(username, name, password);
    stopWaking();
    setModalButtonState(signupSubmit, true, "Create account");
    if (!res.ok) {
      errEl.textContent = res.error;
      errEl.classList.add("show");
      return;
    }
    hideModal();
    showToast(res.offline
      ? "Account created locally. It'll finish syncing once the server's reachable."
      : `Account created. Welcome, ${res.user.name.split(" ")[0]}.`);
    setTimeout(() => location.reload(), 500);
  });

  ["loginUsername","loginPassword","signupName","signupUsername","signupPassword"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const isLogin = id.startsWith("login");
        document.getElementById(isLogin ? "loginSubmit" : "signupSubmit").click();
      }
    });
  });
}

function showModal(which) {
  document.getElementById("loginError").classList.remove("show");
  document.getElementById("signupError").classList.remove("show");
  document.getElementById("loginPane").style.display = which === "login" ? "block" : "none";
  document.getElementById("signupPane").style.display = which === "signup" ? "block" : "none";
  const overlay = document.getElementById("modalOverlay");
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function hideModal() {
  const overlay = document.getElementById("modalOverlay");
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

const THEME_STORAGE_KEY = "progressTheme";

// Dark mode lives entirely in localStorage rather than the user's account -
// it applies instantly on every page load (including for logged-out
// visitors) with zero server round-trip, and the tiny inline snippet in
// each page's <head> reads this same key before first paint, so there's
// no flash of the wrong theme while the page loads.
function getStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch (e) {}
  // No explicit choice saved yet - respect the system/browser preference
  // rather than always defaulting to light for someone whose OS is set
  // to dark mode.
  try {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  } catch (e) {}
  return "light";
}
function applyTheme(theme) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
}
function setTheme(theme) {
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (e) {}
  applyTheme(theme);
}

/* ============================================================
   MEXICAN CANDY MODE — a wild, joyful accent theme
   Applied as a body class so it stacks on top of dark/light.
   ============================================================ */
const CANDY_MODE_KEY = "progressCandyMode";

function getCandyMode() {
  try { return localStorage.getItem(CANDY_MODE_KEY) === "1"; } catch (e) { return false; }
}
function setCandyMode(on) {
  try { localStorage.setItem(CANDY_MODE_KEY, on ? "1" : ""); } catch (e) {}
  document.body.classList.toggle("candy-mode", on);
}
function applyCandy() {
  document.body.classList.toggle("candy-mode", getCandyMode());
}

function setDeviceMode() {
  // Treat as mobile if: UA says so, OR the viewport is narrow enough that
  // the desktop layout wouldn't fit (iPad in portrait, small browser window).
  const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || "");
  const narrowViewport = window.innerWidth <= 768;
  document.body.classList.toggle("mobile", uaMobile || narrowViewport);
}

function attachNavScrollWatcher() {
  const nav = document.querySelector(".nav");
  if (!nav) return;

  // On mobile/tablet the bottom nav handles navigation — never hide the top
  // nav on scroll there, it would leave users with no visible controls.
  if (document.body.classList.contains("mobile")) return;

  let lastScroll = window.scrollY || window.pageYOffset || 0;
  let ticking = false;

  const updateNav = () => {
    const current = window.scrollY || window.pageYOffset || 0;
    const scrolledDown = current > lastScroll + 6 && current > 20;
    const scrolledUp = current < lastScroll - 6 || current <= 20;

    if (scrolledDown) nav.classList.add("hidden");
    if (scrolledUp) nav.classList.remove("hidden");

    lastScroll = current;
    ticking = false;
  };

  const onScroll = () => {
    if (!ticking) {
      window.requestAnimationFrame(updateNav);
      ticking = true;
    }
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  updateNav();
}

function applyLockedOverlayIfNeeded() {
  const user = Progress.getCurrentUser();
  if (!user || !user.locked) return;
  document.body.classList.add("account-locked");
  const main = document.querySelector("main");
  if (main && !main.querySelector(".locked-screen")) {
    main.innerHTML = `
      <div class="locked-screen">
        <div class="error-illustration">
          <img src="images/404page.png" alt="Account locked illustration">
        </div>
        <h1>Your account has been locked</h1>
        <p>If you think this is a mistake, you can <a href="https://forms.gle/4p5gh4ocT3K6WQuU6" target="_blank" rel="noopener noreferrer">appeal here</a>.</p>
      </div>
    `;
  }
}

let bannedMainObserver = null;

function lockMainToBannedScreen() {
  const main = document.querySelector("main");
  if (!main) return;
  const bannedHTML = `
    <div class="locked-screen banned-screen">
      <div class="error-illustration">
        <img src="images/404page.png" alt="Account banned illustration">
      </div>
      <h1>This account has been banned</h1>
      <p>Your account has been suspended for violating our community guidelines. If you believe this was a mistake, you're welcome to submit an appeal and we'll take a look.</p>
      <a class="btn primary banned-appeal-btn" href="https://forms.gle/FBDevngpyBNgWVAQ7" target="_blank" rel="noopener noreferrer">Submit an appeal</a>
    </div>
  `;
  const enforce = () => {
    if (!main.querySelector(".banned-screen")) main.innerHTML = bannedHTML;
  };
  enforce();
  if (bannedMainObserver) bannedMainObserver.disconnect();
  bannedMainObserver = new MutationObserver(enforce);
  bannedMainObserver.observe(main, { childList: true });
}

async function applyBannedOverlayIfNeeded() {
  const user = Progress.getCurrentUser();
  if (!user) return false;
  let banned = !!user.banned;
  const fresh = await apiFetch(`/api/users/${user.id}`);
  if (fresh) banned = !!fresh.banned;
  if (!banned) return false;
  document.body.classList.add("account-banned");
  lockMainToBannedScreen();
  return true;
}

// Discord-style presence: a single persistent WebSocket connection, opened
// once per page and held open the whole time someone's on the site. Being
// "online" is defined purely by that connection existing - no periodic
// pings, no polling on the write side, nothing repeated at all. The
// connection joins a dedicated "presence" room that never carries actual
// chat traffic, so it stays idle except for the connect/disconnect signal
// itself. Skipped on chat.html, which already opens its own connection for
// real chat - no need for a second, redundant one there.
let presenceSocket = null;
const NOTIF_OPTIN_KEY = "progressNotifOptIn";

function getNotificationOptIn() {
  try { return localStorage.getItem(NOTIF_OPTIN_KEY) === "true"; } catch (e) { return false; }
}
function setNotificationOptIn(value) {
  try { localStorage.setItem(NOTIF_OPTIN_KEY, value ? "true" : "false"); } catch (e) {}
}
// Must be called from a real user gesture (a click) - browsers refuse to
// show the permission prompt otherwise.
async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") { setNotificationOptIn(true); return true; }
  if (Notification.permission === "denied") { setNotificationOptIn(false); return false; }
  const result = await Notification.requestPermission();
  const granted = result === "granted";
  setNotificationOptIn(granted);
  return granted;
}

function describeNotificationForOS(n) {
  if (n.type === "like") return { title: "New like", body: `@${n.actor} liked your post "${n.postTitle || ""}"` };
  if (n.type === "reply") return { title: "New reply", body: `@${n.actor}: ${n.body || ""}` };
  if (n.type === "follow") return { title: "New follower", body: `@${n.actor} started following you` };
  if (n.type === "message") return { title: `@${n.actor}`, body: n.body || "sent you a message" };
  if (n.type === "mention") return { title: "You were mentioned", body: `@${n.actor}: ${n.body || ""}` };
  if (n.type === "badge") return { title: "New badge!", body: "You've been awarded a new badge." };
  if (n.type === "streak") return { title: `🔥 ${n.streak}-day streak!`, body: `You've logged in ${n.streak} days in a row. Keep it going!` };
  return { title: "New notification", body: "You have a new notification on Progress." };
}

function notificationHref(n) {
  if (n.postId) return `post.html?id=${n.postId}`;
  if (n.type === "message") return `chat.html?with=${encodeURIComponent(n.actor)}`;
  if (n.type === "mention") return "chat.html";
  return null;
}

// ── Chat nav badge (mobile bottom nav) ──────────────────────────────────────
const DM_UNREAD_KEY = "progress:dmUnread";
function getDmUnread() { try { return Math.max(0, parseInt(localStorage.getItem(DM_UNREAD_KEY) || "0", 10) || 0); } catch (e) { return 0; } }
function setDmUnread(n) { try { localStorage.setItem(DM_UNREAD_KEY, String(Math.max(0, n))); } catch (e) {} updateChatNavBadge(); }
function updateChatNavBadge() {
  const badge = document.getElementById("mbnChatBadge");
  if (!badge) return;
  // Also count unseen message/mention notifications from in-memory DB as a
  // floor — this seeds the badge on first load when localStorage is empty.
  const fromNotifs = ((Progress.db && Progress.db.notifications) || [])
    .filter(n => !n.seen && (n.type === "message" || n.type === "mention")).length;
  const n = Math.max(getDmUnread(), fromNotifs);
  badge.textContent = n > 9 ? "9+" : n > 0 ? String(n) : "";
  badge.style.display = n > 0 ? "flex" : "none";
}

// ── Notification preference filter ──────────────────────────────────────────
function _notifPref(key, def = true) {
  try { const p = JSON.parse(localStorage.getItem("notifPrefs") || "{}"); return key in p ? p[key] : def; } catch { return def; }
}
function notifAllowed(notification) {
  const t = notification.type || "";
  if (t === "like")     return _notifPref("notif-likes");
  if (t === "comment")  return _notifPref("notif-comments");
  if (t === "follow")   return _notifPref("notif-follows");
  if (t === "reaction") return _notifPref("notif-reactions");
  if (t === "event")    return _notifPref("notif-events");
  if (t === "mention")  return _notifPref("notif-mentions");
  if (t === "message" && notification.room && !notification.room.startsWith("dm:")) {
    const level = _notifPref("community-level", "mentions") || "mentions";
    return level === "all";
  }
  return true;
}

// Called whenever a "notification" WS message arrives, regardless of
// whether it came in on the shared presence socket or chat.html's own
// dedicated socket - both funnel through here so the behavior is
// identical no matter which page someone's on.
function handleIncomingNotification(notification) {
  if (!notifAllowed(notification)) return;
  Progress.addNotification(notification);
  const badge = document.getElementById("bellBadge");
  const unseen = Progress.unseenCount();
  if (badge) {
    badge.textContent = unseen;
    badge.classList.toggle("hidden", !unseen);
  }
  updateTitleBadge(unseen);
  // Bump the chat nav badge for incoming DMs
  if (notification.type === "message" || notification.type === "mention") {
    setDmUnread(getDmUnread() + 1);
  }
  const notifDD = document.getElementById("notifDropdown");
  if (notifDD && notifDD.classList.contains("open")) {
    renderNotifDropdown();
  }

  // Play a subtle sound whenever a notification arrives, regardless of
  // focus state - muted by default so it only fires if the browser allows
  // autoplay (i.e. the user has interacted with the page at some point).
  try {
    const sfx = new Audio("sounds/notification.mp3");
    sfx.volume = 0.45;
    sfx.play().catch(() => {}); // silently ignore autoplay blocks
  } catch (e) {}

  // Fire an OS notification whenever the browser window isn't focused -
  // this covers tabbing away to another app, minimising, locking the screen,
  // or switching to a different Chrome window. We use !document.hasFocus()
  // rather than document.hidden so it also catches the case where the tab is
  // visible but another window is in front of it.
  // We only require the browser permission itself here - the in-app opt-in
  // toggle (progressNotifOptIn) is for the Settings UI to let users turn it
  // back off, but we don't gate the fire on it because a user who explicitly
  // granted browser permission clearly wants notifications.
  if (!document.hasFocus() && "Notification" in window && Notification.permission === "granted") {
    const { title, body } = describeNotificationForOS(notification);
    // Icon must be an absolute URL or browsers silently drop it.
    const icon = new URL("images/nearheader.png", location.href).href;
    try {
      const osNotif = new Notification(title, { body, icon });
      osNotif.onclick = () => {
        window.focus();
        const href = notificationHref(notification);
        if (href) location.href = href;
      };
    } catch (e) {
      console.warn("[Progress] OS notification failed:", e);
    }
  }
}

function openPresenceSocket(activePage) {
  if (!API_ENABLED || activePage === "chat") return;
  const user = Progress.getCurrentUser();
  const token = getAuthToken();
  if (!user || !token) return;
  try {
    // Must point at the actual backend (API_BASE, e.g. Render), not
    // location.host - the current page's own origin (Vercel) doesn't run
    // a WebSocket server at all, which is exactly why this was failing
    // with NS_ERROR_WEBSOCKET... every request.
    presenceSocket = new WebSocket(`${WS_BASE}/ws/chat?token=${encodeURIComponent(token)}&room=presence`);

    // Tells the server whether THIS specific tab is currently focused, so
    // someone can show as "Idle" rather than fully "Online" while every
    // tab they have open is backgrounded (Discord calls this state Idle).
    // Sent once right after connecting (correcting the server's default
    // "active" assumption if the tab actually started out hidden) and
    // again on every subsequent visibility change.
    const sendActivity = () => {
      if (presenceSocket.readyState === WebSocket.OPEN) {
        presenceSocket.send(JSON.stringify({ type: "activity", active: !document.hidden }));
      }
    };
    presenceSocket.addEventListener("open", sendActivity);
    document.addEventListener("visibilitychange", sendActivity);

    // The server already broadcasts a "presence" message to everyone in
    // this room the instant anyone connects/disconnects/changes tab focus -
    // re-dispatch that as a plain DOM event so any page (e.g. user.html)
    // can react to it immediately, instead of relying purely on a polling
    // interval.
    presenceSocket.addEventListener("message", (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      if (data.type === "global-presence") {
        document.dispatchEvent(new CustomEvent("presence-update", { detail: data.statuses || {} }));
      } else if (data.type === "notification") {
        handleIncomingNotification(data.notification);
      } else if (data.type === "post-viewers") {
        document.dispatchEvent(new CustomEvent("post-viewers", { detail: data }));
      } else if (data.type === "maintenance") {
        if (data.on) {
          // Show a persistent banner; non-admins will get 503s on next API calls
          let banner = document.getElementById("maintenance-banner");
          if (!banner) {
            banner = document.createElement("div");
            banner.id = "maintenance-banner";
            banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#1c1917;color:#faf5ee;text-align:center;padding:12px 16px;font-size:14px;font-family:var(--font-mono);letter-spacing:.03em;";
            banner.innerHTML = "🚧 Progress is going into maintenance mode. The site will be unavailable briefly.";
            document.body.prepend(banner);
          }
        } else {
          const banner = document.getElementById("maintenance-banner");
          if (banner) banner.remove();
          // Reload so users get the live site again
          setTimeout(() => location.reload(), 800);
        }
      }
    });
    window.addEventListener("beforeunload", () => {
      try { presenceSocket.close(); } catch (e) {}
    });
  } catch (e) {
    // If this fails for any reason, the page still works fine - presence
    // just won't reflect while this connection is unavailable.
  }
}

// Announce that this user is actively reading a specific post.
// Called by post.html on load. The server broadcasts this to all
// presence connections so the home feed can show live reader avatars.
window.announceViewingPost = function(postId) {
  if (!presenceSocket || presenceSocket.readyState !== WebSocket.OPEN) return;
  const user = Progress.getCurrentUser();
  presenceSocket.send(JSON.stringify({
    type: "viewing-post",
    postId,
    avatar: user?.avatar || null,
    name: user?.name || user?.username || null
  }));
};

window.announceLeftPost = function() {
  if (!presenceSocket || presenceSocket.readyState !== WebSocket.OPEN) return;
  presenceSocket.send(JSON.stringify({ type: "left-post" }));
};

/* ============================================================
   PWA — Progressive Web App setup
   Registers the service worker (offline cache + fast loads)
   and injects the manifest + theme-color meta tag so the
   browser's "Add to Home Screen" prompt works on every page.
   ============================================================ */
function initPWA() {
  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // Inject manifest link dynamically so every page gets it without
  // having to edit every HTML file
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = document.createElement("link");
    link.rel  = "manifest";
    link.href = "/manifest.json";
    document.head.appendChild(link);
  }

  // theme-color meta tag — controls the browser chrome colour on mobile.
  // Matches the site theme and updates when the user switches dark/light.
  function syncThemeColor() {
    const isDark   = document.documentElement.getAttribute("data-theme") === "dark";
    const isCandy  = document.body.classList.contains("candy-mode");
    let color = isDark ? "#1c1917" : "#faf8f5";
    if (isCandy) color = "#ff1a8c";
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = color;
  }
  syncThemeColor();

  // Apple-specific meta tags for standalone mode
  if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
    [
      ["apple-mobile-web-app-capable",            "yes"],
      ["apple-mobile-web-app-status-bar-style",   "default"],
      ["apple-mobile-web-app-title",              "Progress"],
      ["mobile-web-app-capable",                  "yes"]
    ].forEach(([name, content]) => {
      const m = document.createElement("meta");
      m.name = name; m.content = content;
      document.head.appendChild(m);
    });
    const icon = document.createElement("link");
    icon.rel = "apple-touch-icon";
    icon.href = "/images/nearheader.png";
    document.head.appendChild(icon);
  }

  // Keep theme-color in sync if user changes theme mid-session
  new MutationObserver(syncThemeColor).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ["data-theme"] }
  );
  new MutationObserver(syncThemeColor).observe(
    document.body,
    { attributes: true, attributeFilter: ["class"] }
  );

  // Splash screen only when running as installed PWA
  if (_isInStandaloneMode()) _showSplash();

  // Fade-in animation on every page load
  document.body.classList.add("pwa-page-enter");
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("pwa-page-enter-active")));

  // Install banner
  if (_isIOS() || _isSafari()) {
    if (_shouldShowInstallPrompt()) setTimeout(_showInstallBanner, 4000);
  }

  // Push notifications
  // On iOS: ONLY subscribe from the installed PWA (standalone mode).
  // A Safari subscription is completely separate and won't deliver
  // notifications to the installed app — they must be the same context.
  if ("serviceWorker" in navigator && "PushManager" in window) {
    navigator.serviceWorker.ready.then(reg => {
      if (_isInStandaloneMode()) {
        // Running as installed PWA — subscribe here
        _subscribeToPush(reg);
      } else if (!_isIOS() && Notification.permission === "granted") {
        // Non-iOS browser with permission — subscribe
        _subscribeToPush(reg);
      }
      // iOS + not standalone = do nothing (wrong context)
    }).catch(() => {});
  }
}

/* ── PWA helpers ─────────────────────────────────────────────────────────── */

function _isInStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function _isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function _isSafari() {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}
function _shouldShowInstallPrompt() {
  if (_isInStandaloneMode()) return false;
  try {
    const d = localStorage.getItem("progress:pwaPromptDismissed");
    if (d && Date.now() - parseInt(d) < 7 * 24 * 60 * 60 * 1000) return false;
  } catch(e) {}
  return true;
}

let _installPromptEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _installPromptEvent = e;
  _showInstallBanner();
});
window.addEventListener("appinstalled", () => {
  _hideInstallBanner();
  _installPromptEvent = null;
  // Ask for push notification permission immediately after install
  if ("serviceWorker" in navigator && "PushManager" in window) {
    setTimeout(() => {
      navigator.serviceWorker.ready.then(_subscribeToPush).catch(() => {});
    }, 1500); // small delay so the install animation finishes first
  }
});

function _showSplash() {
  if (document.getElementById("pwaSplash")) return;
  const el = document.createElement("div");
  el.id = "pwaSplash";
  // Apply dark theme class immediately so the background matches before CSS loads
  el.className = "pwa-splash" + (document.documentElement.getAttribute("data-theme") === "dark" ? " pwa-splash-dark" : "");
  el.innerHTML =
    '<div class="pwa-splash-inner">' +
      '<img src="/images/nearheader.png" class="pwa-splash-logo" alt="">' +
      '<div class="pwa-splash-word">Sex</div>' +
    '</div>';
  document.body.appendChild(el);
  const hide = () => { el.classList.add("pwa-splash-hide"); setTimeout(() => el.remove(), 400); };
  if (document.readyState === "complete") setTimeout(hide, 700);
  else window.addEventListener("load", () => setTimeout(hide, 500));
}

function _showInstallBanner() {
  if (_isInStandaloneMode()) return;
  if (document.getElementById("pwaBanner")) return;

  const canInstall = !!_installPromptEvent;
  const ios = _isIOS();
  if (!canInstall && !ios && !_isSafari()) return;

  const shareIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin:0 3px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
  const closeBtn = '<button class="pwa-banner-close" id="pwaBannerClose" aria-label="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';

  const banner = document.createElement("div");
  banner.id = "pwaBanner";
  banner.className = "pwa-banner";

  if (canInstall) {
    banner.innerHTML = '<div class="pwa-banner-inner"><img class="pwa-banner-icon" src="/images/nearheader.png" alt=""><div class="pwa-banner-text"><strong>Install Progress</strong><span>Faster, no browser bar, works offline</span></div><button class="pwa-banner-install" id="pwaBannerInstall">Install</button>' + closeBtn + '</div>';
  } else if (ios) {
    banner.innerHTML = '<div class="pwa-banner-inner"><img class="pwa-banner-icon" src="/images/nearheader.png" alt=""><div class="pwa-banner-text"><strong>Add to Home Screen</strong><span>Tap ' + shareIcon + ' then <em>Add to Home Screen</em></span></div><a class="pwa-banner-install" href="/install.html">How?</a>' + closeBtn + '</div>';
  } else {
    banner.innerHTML = '<div class="pwa-banner-inner"><img class="pwa-banner-icon" src="/images/nearheader.png" alt=""><div class="pwa-banner-text"><strong>Install Progress</strong><span>Open on iPhone: tap ' + shareIcon + ' then <em>Add to Home Screen</em></span></div><a class="pwa-banner-install" href="/install.html">How to install</a>' + closeBtn + '</div>';
  }

  const navRoot = document.getElementById("nav-root");
  if (navRoot) navRoot.insertAdjacentElement("afterend", banner);
  else document.body.prepend(banner);
  requestAnimationFrame(() => banner.classList.add("visible"));

  document.getElementById("pwaBannerClose")?.addEventListener("click", () => {
    _hideInstallBanner();
    try { localStorage.setItem("progress:pwaPromptDismissed", Date.now()); } catch(e) {}
  });
  document.getElementById("pwaBannerInstall")?.addEventListener("click", async () => {
    if (!_installPromptEvent) return;
    _installPromptEvent.prompt();
    const { outcome } = await _installPromptEvent.userChoice;
    if (outcome === "accepted") _hideInstallBanner();
    _installPromptEvent = null;
  });
}

function _hideInstallBanner() {
  const b = document.getElementById("pwaBanner");
  if (!b) return;
  b.classList.remove("visible");
  setTimeout(() => b.remove(), 300);
}

function _urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function _subscribeToPush(reg) {
  try {
    if (!reg) reg = await navigator.serviceWorker.ready;

    // Get current VAPID key from server first
    const keyData = await apiFetch("/api/vapid-public-key");
    if (!keyData || !keyData.publicKey) return;

    // Check existing subscription — if VAPID key changed, unsubscribe and re-subscribe
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      const storedKey = localStorage.getItem("progress:vapidKey");
      if (storedKey === keyData.publicKey) return; // all good, already subscribed
      // Key changed — unsubscribe old
      await existing.unsubscribe().catch(() => {});
    }

    // Request permission
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") return;

    // Subscribe with new key
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(keyData.publicKey)
    });

    // Save subscription to server
    const res = await apiFetch("/api/push-subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub })
    });

    if (res && res.ok) {
      // Remember which VAPID key we subscribed with
      try { localStorage.setItem("progress:vapidKey", keyData.publicKey); } catch(e) {}
    }
  } catch(e) {
    console.warn("[push] subscribe failed:", e.message);
  }
}

function initShell(activePage) {
  applyTheme(getStoredTheme());
  applyCandy();
  setDeviceMode();
  window.addEventListener("resize", setDeviceMode);
  initPWA();
  renderNav(activePage);
  mountModals();
  attachNavScrollWatcher();
  openPresenceSocket(activePage);
  // Track page view (fire-and-forget, no auth required)
  if (API_ENABLED && activePage && typeof API_BASE !== "undefined") {
    fetch(`${API_BASE}/api/track/pageview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: activePage }),
    }).catch(() => {});
  }
  (async () => {
    const banned = await applyBannedOverlayIfNeeded();
    if (!banned) applyLockedOverlayIfNeeded();
  })();
  return Progress.loadFromApi()
    .catch(() => {})
    .then(async () => {
      const banned = await applyBannedOverlayIfNeeded();
      if (!banned) applyLockedOverlayIfNeeded();
      const badge = document.getElementById("bellBadge");
      const unseen = Progress.unseenCount();
      if (badge) {
        badge.textContent = unseen;
        badge.classList.toggle("hidden", !unseen);
      }
      updateTitleBadge(unseen);
      // Seed the chat nav badge from unseen message/mention notifications now
      // that Progress.db is populated.
      updateChatNavBadge();
      const notifDD = document.getElementById("notifDropdown");
      if (notifDD && notifDD.classList.contains("open")) {
        renderNotifDropdown();
      }
    });
}
/* ============================================================
   MENTION AUTOCOMPLETE
   Shared utility - attach to any <input> or <textarea>.
   Shows a floating dropdown of matching @usernames as the user
   types, with keyboard navigation. Works in chat and the write
   editor's title field.
   ============================================================ */

function createMentionAutocomplete(input, opts = {}) {
  // The dropdown is appended to opts.container (defaults to the input's
  // parent). That element needs position:relative - callers set it if needed.
  const container = opts.container || input.parentElement;
  if (container) container.style.position = "relative";

  let dropdownEl = null;
  let activeIdx = -1;
  let currentMention = null; // { start, text }

  function getMatchingUsers(query) {
    const q = (query || "").toLowerCase();
    return (Progress.db.users || [])
      .filter(u => u.username && (
        u.username.toLowerCase().startsWith(q) ||
        (u.name || "").toLowerCase().includes(q)
      ))
      .slice(0, 6);
  }

  function renderDropdown(matches, mention) {
    currentMention = mention;
    activeIdx = -1;
    if (!dropdownEl) {
      dropdownEl = document.createElement("div");
      dropdownEl.className = "mention-dropdown";
      container.appendChild(dropdownEl);
    }
    dropdownEl.innerHTML = matches.map((u, i) => `
      <button type="button" class="mention-dd-item" data-username="${escapeHTML(u.username)}">
        ${u.avatar
          ? `<img class="mention-dd-avatar" src="${u.avatar}" alt="">`
          : `<div class="mention-dd-avatar mention-dd-initials">${initials(u.name)}</div>`}
        <span class="mention-dd-name">${escapeHTML(u.name || u.username)}</span>
        <span class="mention-dd-user">@${escapeHTML(u.username)}</span>
      </button>
    `).join("");
    dropdownEl.querySelectorAll(".mention-dd-item").forEach(btn => {
      btn.addEventListener("mousedown", e => { e.preventDefault(); selectUser(btn.dataset.username); });
    });
    dropdownEl.style.display = "block";
  }

  function hideDropdown() {
    currentMention = null;
    activeIdx = -1;
    if (dropdownEl) dropdownEl.style.display = "none";
  }

  function setActive(idx) {
    const items = dropdownEl ? dropdownEl.querySelectorAll(".mention-dd-item") : [];
    items.forEach(el => el.classList.remove("active"));
    activeIdx = Math.max(-1, Math.min(idx, items.length - 1));
    if (activeIdx >= 0) {
      items[activeIdx].classList.add("active");
      items[activeIdx].scrollIntoView({ block: "nearest" });
    }
  }

  function selectUser(username) {
    if (!currentMention) return;
    const val = input.value;
    const before = val.slice(0, currentMention.start);
    const after = val.slice(currentMention.start + currentMention.text.length + 1);
    const inserted = before + "@" + username + " " + after;
    input.value = inserted;
    const cursor = before.length + username.length + 2;
    input.selectionStart = input.selectionEnd = cursor;
    input.focus();
    hideDropdown();
    opts.onInsert && opts.onInsert();
  }

  function findMentionAtCursor() {
    const val = input.value;
    const pos = input.selectionStart;
    let i = pos - 1;
    while (i >= 0) {
      const ch = val[i];
      if (ch === "@") {
        const text = val.slice(i + 1, pos);
        if (/^[a-zA-Z0-9_.]*$/.test(text)) return { start: i, text };
        break;
      }
      if (ch === " " || ch === "\n") break;
      i--;
    }
    return null;
  }

  function update() {
    const mention = findMentionAtCursor();
    if (mention && mention.text.length >= 1) {
      const matches = getMatchingUsers(mention.text);
      if (matches.length) { renderDropdown(matches, mention); return; }
    } else if (mention && mention.text.length === 0) {
      const matches = getMatchingUsers("");
      if (matches.length) { renderDropdown(matches, mention); return; }
    }
    hideDropdown();
  }

  input.addEventListener("input", update);
  input.addEventListener("keyup", e => {
    if (["ArrowLeft","ArrowRight","Home","End"].includes(e.key)) update();
  });

  input.addEventListener("keydown", e => {
    if (!dropdownEl || dropdownEl.style.display === "none") return;
    const items = dropdownEl.querySelectorAll(".mention-dd-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1); }
    else if ((e.key === "Enter" || e.key === "Tab") && activeIdx >= 0) {
      e.preventDefault();
      selectUser(items[activeIdx].dataset.username);
    } else if (e.key === "Escape") { e.preventDefault(); hideDropdown(); }
  });

  input.addEventListener("blur", () => setTimeout(hideDropdown, 180));
  return { hide: hideDropdown };
}

/* ============================================================
   PULL-TO-REFRESH
   Touch-only. Call initPullToRefresh(onRefreshFn) on any page
   that wants the pull-down-to-reload gesture. Shows a random
   emoticon while the user pulls, spins it while refreshing.
   ============================================================ */

function initPullToRefresh(onRefresh) {
  if (!("ontouchstart" in window)) return;
  const THRESHOLD = 72;
  let startY = 0;
  let lastY = 0;
  let pulling = false;
  let indicator = null;
  let emoteName = null;
  let triggered = false;

  document.addEventListener("touchstart", e => {
    if (window.scrollY > 2) return;
    startY = e.touches[0].clientY;
    lastY = startY;
    pulling = true;
    triggered = false;
    emoteName = EMOTICON_NAMES[Math.floor(Math.random() * EMOTICON_NAMES.length)];
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!pulling) return;
    lastY = e.touches[0].clientY;
    const dy = Math.max(0, lastY - startY);
    if (dy < 8) return;
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "ptr-indicator";
      indicator.innerHTML = `<img class="ptr-emote" src="images/emoticons/${emoteName}.png" alt=""><span class="ptr-label">Pull to refresh</span>`;
      document.body.appendChild(indicator);
    }
    const pct = Math.min(dy / THRESHOLD, 1);
    const travel = Math.min(dy * 0.42, 72);
    indicator.style.transform = `translateX(-50%) translateY(${travel}px)`;
    indicator.style.opacity = String(Math.min(pct * 1.6, 1));
    indicator.querySelector(".ptr-label").textContent = pct >= 1 ? "Release to refresh ✓" : "Pull to refresh";
    if (pct >= 1) indicator.querySelector(".ptr-emote").classList.add("ptr-ready");
    else indicator.querySelector(".ptr-emote").classList.remove("ptr-ready");
  }, { passive: true });

  document.addEventListener("touchend", async () => {
    if (!pulling) return;
    pulling = false;
    const dy = Math.max(0, lastY - startY);
    if (!indicator) return;
    if (dy >= THRESHOLD && !triggered) {
      triggered = true;
      indicator.querySelector(".ptr-label").textContent = "Refreshing…";
      indicator.querySelector(".ptr-emote").classList.add("ptr-spinning");
      try { await onRefresh(); } catch (e) {}
    }
    indicator.style.transition = "opacity .25s ease, transform .25s ease";
    indicator.style.opacity = "0";
    indicator.style.transform = "translateX(-50%) translateY(-40px)";
    const el = indicator;
    setTimeout(() => el.remove(), 280);
    indicator = null;
  }, { passive: true });
}

/* ============================================================
   CATEGORY TABS — post feed filtering
   Stored in localStorage so the preference persists.
   ============================================================ */
const CATEGORY_FEATURE_KEY = "progressCategoryTabs";
const CATEGORY_ACTIVE_KEY  = "progressActiveCategory";

function getCategoryTabsEnabled() {
  try { return localStorage.getItem(CATEGORY_FEATURE_KEY) === "true"; } catch (e) { return false; }
}
function setCategoryTabsEnabled(v) {
  try { localStorage.setItem(CATEGORY_FEATURE_KEY, v ? "true" : "false"); } catch (e) {}
}
function getActiveCategory() {
  try { return localStorage.getItem(CATEGORY_ACTIVE_KEY) || "all"; } catch (e) { return "all"; }
}
function setActiveCategory(v) {
  try { localStorage.setItem(CATEGORY_ACTIVE_KEY, v); } catch (e) {}
}