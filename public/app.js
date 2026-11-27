/* Tarang client — search, YouTube embeds, queue, library, playlists. */

import { taste } from "./taste.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const LS_KEY = "tarang.v1";

/* ------------------------------ persistence ------------------------------ */

const defaults = () => ({
  liked: {},
  playlists: [],
  recents: [],
  lyricOffsets: {},
  volume: 0.9,
  repeat: "off",
  shuffle: false,
  muted: false,
});

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return { ...defaults(), ...raw, liked: raw.liked || {}, playlists: raw.playlists || [], recents: raw.recents || [] };
  } catch {
    return defaults();
  }
}

let store = loadStore();

function saveStore() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* private mode — run in memory */
  }
}

/* ------------------------------ state ------------------------------ */

const state = {
  view: "home",
  query: "",
  results: [],
  lists: new Map(),
  registry: new Map(),
  queue: [],
  index: -1,
  current: null,
  loading: false,
  viewParams: {},
};

const audioListeners = new Map();
let youtubePlayer = null;
let youtubePlayerReady = false;
let youtubePlayerReadyPromise = null;

const audioEvents = new EventTarget();

const audio = {
  yt: null,
  _volume: store.volume,
  _muted: store.muted,
  _playing: false,
  addEventListener(type, callback) {
    audioEvents.addEventListener(type, callback);
  },
  dispatch(type) {
    audioEvents.dispatchEvent(new Event(type));
  },
  attach(player) {
    this.yt = player;
    this.volume = this._volume;
    this.muted = this._muted;
  },
  get currentTime() {
    const value = Number(this.yt?.getCurrentTime?.());
    return Number.isFinite(value) ? value : 0;
  },
  set currentTime(value) {
    if (!Number.isFinite(value) || !this.yt) return;
    this.yt.seekTo(Math.max(0, value), true);
    queueMicrotask(() => this.dispatch("seeked"));
  },
  get duration() {
    const value = Number(this.yt?.getDuration?.());
    return Number.isFinite(value) && value > 0 ? value : NaN;
  },
  get paused() {
    return !this._playing;
  },
  get volume() {
    return this._volume;
  },
  set volume(value) {
    this._volume = Math.min(1, Math.max(0, Number(value) || 0));
    if (this.yt && !this._muted) this.yt.setVolume(Math.round(this._volume * 100));
  },
  get muted() {
    return this._muted;
  },
  set muted(value) {
    this._muted = Boolean(value);
    if (this.yt) this._muted ? this.yt.mute() : this.yt.unMute();
  },
  play() {
    if (!this.yt) return Promise.reject(new Error("YouTube player is not ready."));
    this.yt.playVideo();
    return Promise.resolve();
  },
  pause() {
    this.yt?.pauseVideo();
  },
};

const view = $("#view");
const main = $("#main");

audio.volume = store.muted ? 0 : store.volume;
$("#vol").value = String(Math.round((store.muted ? 0 : store.volume) * 100));

function setYouTubeStatus(message, tone = "") {
  const element = $("#resolverState");
  if (!element) return;
  element.classList.remove("ok", "bad");
  if (tone) element.classList.add(tone);
  const dot = document.createElement("span");
  dot.className = "dot";
  element.replaceChildren(dot, document.createTextNode(message));
}

function loadYouTubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error("YouTube player API did not load."));
    }, 15_000);

    window.onYouTubeIframeAPIReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(window.YT);
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("Couldn't load YouTube's player API."));
    };
    document.head.append(script);
  });
}

const youtubeApiReady = loadYouTubeIframeApi();

/* ------------------------------ helpers ------------------------------ */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4h4v16H7zM14 4h4v16h-4z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-9.2A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7 3.8C19 15.6 12 20 12 20z"/></svg>',
  heartFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20s-7-4.4-7-9.2A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7 3.8C19 15.6 12 20 12 20z"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 6h11M4 12h11M4 18h7"/><path d="M19 10v8"/><circle cx="17" cy="19" r="2"/></svg>',
  nextUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M4 12h9M4 18h5M17 8v8M17 8l3 2-3 2"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 11l5 4 5-4M5 21h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  radio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="2.2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>',
  block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m6 18 12-12"/></svg>',
};

function icon(name) {
  return ICONS[name] || "";
}

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s, transform .3s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

function setRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty("--pct", `${Math.max(0, Math.min(100, pct))}%`);
}

/* ------------------------------ nav / views ------------------------------ */

const navButtons = $$(".nav-item");

function setView(name, params = {}) {
  state.view = name;
  state.viewParams = params;
  navButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === name));
  main.scrollTop = 0;

  if (name === "home") renderHome();
  else if (name === "search") renderSearch();
  else if (name === "library") renderLibrary();
  else if (name === "playlist") renderPlaylist(params.id);
  else if (name === "liked") renderLiked();
}

navButtons.forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));
$("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

main.addEventListener("scroll", () => main.classList.toggle("scrolled", main.scrollTop > 8), { passive: true });

/* ------------------------------ rendering: shared ------------------------------ */

function registerList(key, tracks) {
  const seen = new Set();
  tracks = tracks.filter((track) => track && track.id && !seen.has(track.id) && seen.add(track.id));
  state.lists.set(key, tracks);
  tracks.forEach((track) => track && track.id && state.registry.set(track.id, track));
}

function rowsHTML(tracks, listKey, options = {}) {
  const { showIndex = true, showViews = true } = options;
  return `<div class="track-list" data-list="${esc(listKey)}">
    ${tracks
      .map(
        (track, i) => `
      <div class="trow" data-track-id="${esc(track.id)}" tabindex="0" role="button">
        <span class="idx">
          ${showIndex ? `<span class="idx-num">${i + 1}</span>` : ""}
          <span class="idx-play">${icon("play")}</span>
        </span>
        <img class="thumb" src="${esc(track.thumbnail)}" alt="" loading="lazy" decoding="async" />
        <div class="t-main">
          <div class="t-title">${esc(track.title)}</div>
          <div class="t-artist">${esc(track.artist)}</div>
        </div>
        <div class="t-views">${showViews ? esc(track.views || "") : ""}</div>
        <div class="t-dur">${fmtTime(track.duration)}</div>
        <button class="icon-btn sm t-more" data-menu aria-label="More options">${icon("more")}</button>
      </div>`,
      )
      .join("")}
  </div>`;
}

function cardsHTML(tracks, listKey) {
  return `<div class="shelf" data-list="${esc(listKey)}">
    ${tracks
      .map(
        (track) => `
      <div class="card" data-track-id="${esc(track.id)}" tabindex="0" role="button" aria-label="Play ${esc(track.title)}">
        <div class="cover-wrap">
          <img src="${esc(track.thumbnail)}" alt="" loading="lazy" decoding="async" />
          <span class="play-fab">${icon("play")}</span>
        </div>
        <p class="c-title">${esc(track.title)}</p>
        <p class="c-sub">${esc(track.artist)}</p>
      </div>`,
      )
      .join("")}
  </div>`;
}

function skeletonCards(count = 6) {
  return `<div class="shelf">${Array.from({ length: count })
    .map(
      () => `<div class="card sk-card"><div class="cover-wrap skeleton"></div><div class="sk-line skeleton" style="width:76%"></div><div class="sk-line skeleton" style="width:44%;height:9px"></div></div>`,
    )
    .join("")}</div>`;
}

function skeletonRows(count = 8) {
  return `<div class="track-list">${Array.from({ length: count })
    .map(
      () => `<div class="trow"><span></span><div class="thumb skeleton" style="border:0"></div><div><div class="sk-line skeleton" style="width:46%"></div><div class="sk-line skeleton" style="width:26%;height:9px"></div></div><span></span><span></span><span></span></div>`,
    )
    .join("")}</div>`;
}

function emptyState(title, text) {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}

/* ------------------------------ home ------------------------------ */

const HOME_QUICK = ["Arijit Singh", "Lo-fi", "Punjabi", "A. R. Rahman", "Indie", "90s Bollywood", "Devotional", "English pop"];

function shelfHTML(key, title, subtitle, tracks, query) {
  registerList(key, tracks);
  return `<section class="section">
      <div class="section-head">
        <div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>
        ${query ? `<button class="more" data-quick="${esc(query)}">See all</button>` : ""}
      </div>
      ${cardsHTML(tracks, key)}
    </section>`;
}

async function renderHome() {
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const profile = taste.profile();
  const warm = profile.plays >= 3 || profile.likes >= 1;

  view.innerHTML = `
    <div class="greeting">
      <span class="eyebrow">${warm ? `Tuned to your last ${profile.plays} plays` : "Tarang · YouTube playback"}</span>
      <h1>${greeting}, <span class="serif">listener.</span></h1>
      <p>${
        warm
          ? "Recommendations from YouTube's watch-next graph, re-ranked on this device by what you actually finish, skip and like."
          : "Tracks play in YouTube's embedded player. YouTube controls playback and may show ads. Play five tracks and your feed starts learning."
      }</p>
      <div class="chips">
        ${(warm ? taste.seedsFor(4).map((a) => a) : HOME_QUICK).map((q) => `<button data-quick="${esc(q)}">${esc(q)}</button>`).join("")}
      </div>
    </div>
    <div id="shelves">${Array.from({ length: 3 }).map(() => `<div class="section"><div class="sk-line skeleton" style="width:180px;height:14px"></div>${skeletonCards()}</div>`).join("")}</div>
  `;

  if (warm) await renderPersonalHome(profile);
  else await renderColdHome();
}

async function renderColdHome() {
  try {
    const data = await api("/api/home?limit=3");
    if (state.view !== "home") return;
    if (!data.shelves.length) {
      $("#shelves").innerHTML = emptyState("Nothing came back", "The catalogue didn't return results. Check your connection and reload.");
      return;
    }

    const hint = `<section class="section"><div class="taste-hint">
        <span class="dot"></span>
        <div><b>Recommendations are off until they're earned.</b>
        <p>Play five tracks and this page rebuilds around your artists, languages and finish rate. The model runs in this browser — no account, no upload.</p></div>
      </div></section>`;

    $("#shelves").innerHTML =
      hint +
      data.shelves
        .filter((shelf) => shelf.tracks.length)
        .map((shelf) => shelfHTML(`home-${shelf.key}`, shelf.title, `${shelf.tracks.length} tracks · YouTube player`, shelf.tracks, shelf.query))
        .join("") +
      `<div id="homeMore">${Array.from({ length: 3 }).map(() => `<div class="section"><div class="sk-line skeleton" style="width:180px;height:14px"></div>${skeletonCards()}</div>`).join("")}</div>`;
    markPlaying();

    try {
      const more = await api(`/api/home?offset=${data.shelves.length}&limit=6`);
      if (state.view !== "home") return;
      const shelves = more.shelves.filter((shelf) => shelf.tracks.length);
      $("#homeMore").innerHTML = shelves.length
        ? shelves.map((shelf) => shelfHTML(`home-${shelf.key}`, shelf.title, `${shelf.tracks.length} tracks · YouTube player`, shelf.tracks, shelf.query)).join("")
        : data.shelves.some((shelf) => shelf.tracks.length)
          ? ""
          : emptyState("Nothing came back", "The catalogue didn't return results. Check your connection and reload.");
      markPlaying();
    } catch (error) {
      if (state.view !== "home") return;
      $("#homeMore").innerHTML = emptyState("More shelves didn't load", error.message || "Check your connection and try again.");
    }
  } catch (err) {
    $("#shelves").innerHTML = emptyState("Couldn't load the shelves", err.message);
  }
}

async function renderPersonalHome(profile) {
  const seeds = taste.seedsFor(2);
  const last = taste.lastPlayed();

  const requests = [
    last
      ? api(`/api/related?id=${encodeURIComponent(last.id)}&limit=26`).catch(() => ({ tracks: [] }))
      : Promise.resolve({ tracks: [] }),
    ...seeds.map((name) => api(`/api/search?q=${encodeURIComponent(`${name} songs`)}&limit=14`).catch(() => ({ tracks: [] }))),
    api("/api/home?limit=2").catch(() => ({ shelves: [] })),
  ];

  const results = await Promise.all(requests);
  if (state.view !== "home") return;

  const related = results[0].tracks || [];
  const artistPools = results.slice(1, 1 + seeds.length).map((r) => r.tracks || []);
  const curated = results[1 + seeds.length]?.shelves || [];

  const pool = [...related, ...artistPools.flat()];
  const forYou = taste.rank(pool, { limit: 16 });
  const because = last ? taste.rank(related, { seed: last, excludeIds: [last.id], limit: 14 }) : [];

  let html = "";
  if (forYou.length) {
    html += shelfHTML(
      "for-you",
      "Made for you",
      `${profile.plays} plays · ${profile.completions} finishes · rebuilds every session`,
      forYou,
      null,
    );
  }
  if (because.length && last) {
    html += shelfHTML(
      "because",
      `Because you played “${last.title.length > 44 ? `${last.title.slice(0, 44)}…` : last.title}”`,
      "Same watch-next graph, ranked by your taste",
      because,
      null,
    );
  }

  artistPools.forEach((tracks, i) => {
    if (!tracks.length || !seeds[i]) return;
    const ranked = taste.rank(tracks, { limit: 14 });
    if (ranked.length < 3) return;
    html += shelfHTML(`artist-${i}`, `More from ${seeds[i]}`, "Artist catalogue · taste-ranked", ranked, seeds[i]);
  });

  const seen = new Set([...forYou, ...because].map((t) => t.id));
  curated.slice(0, 2).forEach((shelf) => {
    const fresh = shelf.tracks.filter((t) => !seen.has(t.id));
    if (fresh.length < 4) return;
    html += shelfHTML(`home-${shelf.key}`, shelf.title, "Curated · outside your bubble", fresh, shelf.query);
  });

  $("#shelves").innerHTML = html || emptyState("Nothing to recommend yet", "Play a few more tracks and this page will fill in.");
  markPlaying();
}

/* ------------------------------ search ------------------------------ */

let searchTimer = null;

async function runSearch(query) {
  const q = query.trim();
  if (q.length < 2) return;
  state.query = q;
  taste.recordSearch(q);

  if (state.view !== "search") {
    state.view = "search";
    navButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === "search"));
  }
  main.scrollTop = 0;

  view.innerHTML = `
    <div class="greeting" style="padding-bottom:10px">
      <span class="eyebrow">Search</span>
      <h1 style="font-size:26px">“${esc(q)}”</h1>
      <p>Resolving tracks…</p>
    </div>
    ${skeletonRows(9)}`;

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&limit=28`);
    if (state.query !== q) return;
    state.results = data.tracks;
    renderSearchResults();
  } catch (err) {
    view.innerHTML = `<div class="greeting"><span class="eyebrow">Search</span><h1 style="font-size:26px">“${esc(q)}”</h1></div>` + emptyState("Search failed", err.message);
  }
}

function renderSearchResults() {
  const tracks = state.results;
  if (!tracks.length) {
    view.innerHTML =
      `<div class="greeting"><span class="eyebrow">Search</span><h1 style="font-size:26px">“${esc(state.query)}”</h1></div>` +
      emptyState("No matches", "Try a song title, an artist, or a film name.");
    return;
  }

  registerList("results", tracks);
  view.innerHTML = `
    <div class="greeting" style="padding-bottom:6px">
      <span class="eyebrow">Search</span>
      <h1 style="font-size:26px">“${esc(state.query)}”</h1>
      <p>${tracks.length} results · playback provided by YouTube</p>
    </div>
    <div class="section-head" style="margin-top:24px">
      <h2>Songs</h2>
      <button class="more" data-play-all="results">Play all</button>
    </div>
    ${rowsHTML(tracks, "results")}`;
  markPlaying();
}

function renderSearch() {
  if (state.results.length && state.query) {
    renderSearchResults();
    return;
  }
  view.innerHTML = `<div class="greeting">
      <span class="eyebrow">Search</span>
      <h1>Find <span class="serif">anything.</span></h1>
      <p>Search songs, soundtracks, covers and more. Playback uses YouTube's embedded player.</p>
      <div class="chips">${HOME_QUICK.map((q) => `<button data-quick="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    </div>`;
  setTimeout(() => $("#searchInput").focus(), 30);
}

/* ------------------------------ library ------------------------------ */

function likedTracks() {
  return Object.values(store.liked).filter(Boolean);
}

function renderLibrary() {
  const liked = likedTracks();
  const playlists = store.playlists;
  const recents = store.recents;

  view.innerHTML = `
    <div class="greeting">
      <span class="eyebrow">Your library</span>
      <h1>Kept <span class="serif">on this device.</span></h1>
      <p>No account, no sync calls. Everything here lives in your browser's local storage.</p>
    </div>

    <section class="section">
      <div class="section-head">
        <div><h2>Liked songs</h2><p>${liked.length} ${liked.length === 1 ? "track" : "tracks"}</p></div>
        ${liked.length ? '<button class="more" data-play-all="liked">Play all</button>' : ""}
      </div>
      ${liked.length ? rowsHTML(registerAndReturn("liked", liked), "liked") : emptyState("No liked songs yet", "Tap the heart in the player bar while something is playing.")}
    </section>

    ${(() => {
      const profile = taste.profile();
      const stats = taste.stats();
      const artists = taste.topArtists(6);
      const scripts = [...profile.scripts.entries()]
        .filter(([, score]) => score > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name);
      return `<section class="section">
        <div class="section-head">
          <div><h2>Your taste</h2><p>On-device model · ${stats.events} signals · never uploaded</p></div>
          <button class="more" id="resetTaste">Reset</button>
        </div>
        <div class="taste-card">
          <div class="taste-stats">
            <div><b>${profile.plays}</b><span>plays</span></div>
            <div><b>${profile.completions}</b><span>finishes</span></div>
            <div><b>${profile.skips}</b><span>skips</span></div>
            <div><b>${profile.likes}</b><span>likes</span></div>
          </div>
          <div class="taste-body">
            <div class="taste-block">
              <span class="taste-label">Top artists</span>
              <div class="taste-tags">
                ${artists.map((a) => `<button class="tag" data-quick="${esc(a.name)}">${esc(a.name)}</button>`).join("") || '<span class="taste-empty">Nothing yet — play a few tracks.</span>'}
              </div>
            </div>
            <div class="taste-block">
              <span class="taste-label">Languages in your history</span>
              <div class="taste-tags">
                ${scripts.map((name) => `<span class="tag ghost">${esc(name)}</span>`).join("") || '<span class="taste-empty">—</span>'}
              </div>
            </div>
          </div>
          <label class="switch-row">
            <span><b>Autoplay similar</b><em>Keep the queue going when it runs out</em></span>
            <span class="switch"><input type="checkbox" id="autoplayToggle" ${taste.getAutoplay() ? "checked" : ""} /><i></i></span>
          </label>
        </div>
      </section>`;
    })()}

    <section class="section">
      <div class="section-head">
        <div><h2>Playlists</h2><p>${playlists.length} ${playlists.length === 1 ? "playlist" : "playlists"}</p></div>
        <button class="more" id="inlineNewPlaylist">New playlist</button>
      </div>
      ${
        playlists.length
          ? `<div class="shelf" style="grid-auto-columns:190px">${playlists
              .map(
                (pl) => `<div class="card" data-playlist="${pl.id}" tabindex="0" role="button">
                  <div class="cover-wrap" style="background:linear-gradient(150deg,#232830,#12151a)">
                    <div style="position:absolute;inset:0;display:grid;place-items:center;color:#8b9099">${icon("list")}</div>
                  </div>
                  <p class="c-title">${esc(pl.name)}</p>
                  <p class="c-sub">${pl.tracks.length} ${pl.tracks.length === 1 ? "track" : "tracks"}</p>
                </div>`,
              )
              .join("")}</div>`
          : emptyState("No playlists yet", "Create one here, or from any track's menu.")
      }
    </section>

    <section class="section">
      <div class="section-head"><div><h2>Recently played</h2><p>Last ${Math.min(recents.length, 30)} tracks</p></div></div>
      ${recents.length ? rowsHTML(registerAndReturn("recents", recents), "recents", { showViews: false }) : emptyState("Nothing played yet", "Your listening history will show up here.")}
    </section>
  `;

  markPlaying();
}

function registerAndReturn(key, tracks) {
  registerList(key, tracks);
  return tracks;
}

function renderLiked() {
  navButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === "library"));
  const liked = likedTracks();
  registerList("liked", liked);
  view.innerHTML = `<div class="greeting">
      <span class="eyebrow">Playlist</span>
      <h1>Liked <span class="serif">songs.</span></h1>
      <p>${liked.length} tracks</p>
    </div>
    ${liked.length ? rowsHTML(liked, "liked", { showViews: false }) : emptyState("No liked songs yet", "Tap the heart in the player bar.")}`;
  markPlaying();
}

function renderPlaylist(id) {
  navButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === "library"));
  const playlist = store.playlists.find((pl) => pl.id === id);
  if (!playlist) {
    setView("library");
    return;
  }

  const key = `playlist-${id}`;
  registerList(key, playlist.tracks);

  view.innerHTML = `
    <div class="greeting" style="display:flex;gap:22px;align-items:flex-end;flex-wrap:wrap">
      <div style="width:150px;height:150px;border-radius:16px;background:linear-gradient(150deg,#2a3038,#12151a);border:1px solid var(--line);display:grid;place-items:center;color:#8b9099">${icon("list")}</div>
      <div>
        <span class="eyebrow">Playlist</span>
        <h1 style="margin-top:6px">${esc(playlist.name)}</h1>
        <p>${playlist.tracks.length} ${playlist.tracks.length === 1 ? "track" : "tracks"}</p>
      </div>
    </div>
    <div class="section-head" style="margin-top:26px">
      <button class="more" data-play-all="${esc(key)}">Play all</button>
      <button class="more" data-delete-playlist="${esc(playlist.id)}">Delete playlist</button>
    </div>
    ${playlist.tracks.length ? rowsHTML(playlist.tracks, key, { showViews: false }) : emptyState("Empty playlist", "Use a track's menu and choose “Add to playlist”.")}
  `;
  markPlaying();
}

/* ------------------------------ sidebar playlists ------------------------------ */

function renderSidebarPlaylists() {
  const el = $("#playlistList");
  if (!store.playlists.length) {
    el.innerHTML = `<p class="pl-empty">No playlists yet.<br />Create one from any track's menu.</p>`;
    return;
  }
  el.innerHTML = store.playlists
    .map(
      (pl) => `<button class="pl-item" data-playlist="${pl.id}" title="${esc(pl.name)}">
        <span class="art">${pl.tracks.length ? `<img src="${esc(pl.tracks[0].thumbnail)}" alt="" />` : ""}</span>
        <span>${esc(pl.name)}</span>
      </button>`,
    )
    .join("");
}

/* ------------------------------ playback ------------------------------ */

function findTrack(id) {
  return state.registry.get(id) || state.queue.find((t) => t.id === id) || store.liked[id] || null;
}

function playFromList(list, index, options = {}) {
  if (!list || !list.length) return;
  const i = Math.max(0, Math.min(index, list.length - 1));
  radioMode = false;
  smartSeed += 1; // cancel any pending smart queue
  state.queue = list.slice();
  state.index = i;
  startTrack(state.queue[i]);
  renderQueue();
  if (options.smart) seedSmartQueue(state.queue[i], list, i);
}

/**
 * Discovery surfaces (shelves, search) continue into similar songs, while lists
 * the user built or saved (liked, history, playlists) keep their own order.
 */
function isDiscoveryList(key) {
  return !/^(liked|recents|playlist)/.test(key || "");
}

let smartSeed = 0;

/**
 * After a track is picked from a discovery list, put songs from the same
 * related graph right after it (re-ranked by taste), then keep the rest of the
 * list as the tail. Mirrors how YouTube/Spotify continue a single pick.
 */
async function seedSmartQueue(track, list, index) {
  const seq = ++smartSeed;
  radioMode = true;
  try {
    const data = await api(`/api/related?id=${encodeURIComponent(track.id)}&limit=26`);
    if (seq !== smartSeed) return; // another track took over
    if (state.current?.id !== track.id) return;
    const ranked = taste.rank(data.tracks || [], { excludeIds: [track.id], seed: track, limit: 12 });
    if (!ranked.length) return;
    const rankedIds = new Set(ranked.map((t) => t.id));
    const tail = list.slice(index + 1).filter((t) => t.id !== track.id && !rankedIds.has(t.id));
    state.queue = [state.queue[state.index] || track, ...ranked, ...tail].filter(
      (t, i, all) => all.findIndex((x) => x.id === t.id) === i,
    );
    state.index = 0;
    renderQueue();
  } catch {
    /* keep the plain list order */
  }
}

function addToQueue(track) {
  state.queue.push(track);
  if (state.index < 0) {
    state.index = 0;
    startTrack(state.queue[0]);
  }
  renderQueue();
  toast("Added to queue", "ok");
}

function playNext(track) {
  const insertAt = state.index + 1;
  state.queue.splice(insertAt, 0, track);
  if (state.index < 0) {
    state.index = 0;
    startTrack(state.queue[0]);
  }
  renderQueue();
  toast("Playing next", "ok");
}

let session = null;
let radioMode = false;

function finalizeSession() {
  if (!session) return;
  const played = Number(audio.currentTime || 0);
  const duration = Number(audio.duration || session.track.duration || 0);
  const ratio = duration ? played / duration : 0;
  if (played > 3 && ratio > 0.02 && ratio < 0.2) {
    taste.record("skip", session.track, { ratio: Number(ratio.toFixed(2)) });
  } else if (ratio >= 0.85) {
    taste.record("complete", session.track, { ratio: Number(ratio.toFixed(2)) });
  }
  session = null;
}

function handleYouTubePlayerState(event) {
  switch (event.data) {
    case 0:
      audio._playing = false;
      audio.dispatch("ended");
      break;
    case 1:
      audio._playing = true;
      state.loading = false;
      $("#playBtn").classList.remove("loading");
      $("#youtubeError").hidden = true;
      setYouTubeStatus("YouTube player connected", "ok");
      if (state.current && session?.track.id !== state.current.id) {
        taste.record("play", state.current);
        session = { track: state.current, startedAt: Date.now() };
        rememberRecent(state.current);
        renderNow();
      }
      audio.dispatch("loadedmetadata");
      audio.dispatch("play");
      audio.dispatch("playing");
      break;
    case 2:
      audio._playing = false;
      audio.dispatch("pause");
      break;
    case 3:
      state.loading = true;
      $("#playBtn").classList.add("loading");
      break;
    case 5:
      audio.dispatch("loadedmetadata");
      break;
    default:
      break;
  }
}

function handleYouTubePlayerError(event) {
  const messages = {
    2: "YouTube rejected this video ID.",
    5: "This video can't play in the embedded player.",
    100: "This video is unavailable or private.",
    101: "The video owner doesn't allow playback here.",
    150: "The video owner doesn't allow playback here.",
    153: "YouTube couldn't verify the embed request.",
  };
  audio._playing = false;
  state.loading = false;
  $("#playBtn").classList.remove("loading");
  $("#youtubeError").textContent = messages[event.data] || "YouTube couldn't play this video.";
  $("#youtubeError").hidden = false;
  setYouTubeStatus("YouTube playback unavailable", "bad");
  audio.dispatch("error");
}

async function ensureYouTubePlayer() {
  if (youtubePlayerReady) return;
  if (!youtubePlayerReadyPromise) {
    youtubePlayerReadyPromise = youtubeApiReady
      .then(
        (YT) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              youtubePlayer?.destroy();
              youtubePlayer = null;
              reject(new Error("YouTube player didn't become ready."));
            }, 15_000);

            youtubePlayer = new YT.Player("youtubePlayer", {
              width: 200,
              height: 200,
              playerVars: {
                controls: 1,
                enablejsapi: 1,
                origin: location.origin,
                playsinline: 1,
                rel: 0,
              },
              events: {
                onReady(event) {
                  clearTimeout(timeout);
                  youtubePlayerReady = true;
                  audio.attach(event.target);
                  resolve();
                },
                onStateChange: handleYouTubePlayerState,
                onError: handleYouTubePlayerError,
              },
            });
          }),
      )
      .catch((error) => {
        youtubePlayerReadyPromise = null;
        throw error;
      });
  }
  return youtubePlayerReadyPromise;
}

async function loadYouTubeTrack(track) {
  await ensureYouTubePlayer();
  if (state.current?.id !== track.id) return;
  $("#youtubeTitle").textContent = track.title;
  $("#youtubeArtist").textContent = track.artist;
  $("#youtubeOpenLink").href = `https://www.youtube.com/watch?v=${encodeURIComponent(track.id)}`;
  youtubePlayer.loadVideoById({ videoId: track.id });
}

async function startTrack(track) {
  if (!track) return;
  if (state.current?.id !== track.id) finalizeSession();
  state.current = track;
  state.loading = true;
  audio._playing = false;
  $("#youtubeStage").hidden = false;
  $("#youtubeError").hidden = true;
  setYouTubeStatus("Connecting to YouTube player");
  if (lyricsOpen()) loadLyrics();

  $("#playBtn").classList.add("loading");
  renderNow();
  markPlaying();

  clearTimeout(state.startWatchdog);
  state.startWatchdog = setTimeout(() => {
    if (state.current?.id !== track.id || !audio.paused) return;
    toast("This track isn't loading. Skipping.", "err");
    if (state.queue.length > 1) nextTrack(true);
  }, 40_000);

  try {
    await loadYouTubeTrack(track);
  } catch (error) {
    if (state.current?.id !== track.id) return;
    clearTimeout(state.startWatchdog);
    $("#youtubeError").textContent = error instanceof Error ? error.message : "Couldn't load YouTube's player.";
    $("#youtubeError").hidden = false;
    setYouTubeStatus("YouTube player unavailable", "bad");
    toast(error instanceof Error ? error.message : "Couldn't play this track.", "err");
    $("#playBtn").classList.remove("loading");
    state.loading = false;
    audio._playing = false;
  }
}

function rememberRecent(track) {
  if (!track) return;
  store.recents = [track, ...store.recents.filter((t) => t.id !== track.id)].slice(0, 40);
  saveStore();
}

async function nextTrack(auto = false) {
  if (!state.queue.length) return;

  if (store.repeat === "one" && auto) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }

  if (store.shuffle && state.queue.length > 1) {
    let i = state.index;
    while (i === state.index) i = Math.floor(Math.random() * state.queue.length);
    state.index = i;
    startTrack(state.queue[i]);
    renderQueue();
    return;
  }

  if (state.index + 1 >= state.queue.length) {
    if (store.repeat === "all" && auto) {
      state.index = 0;
      startTrack(state.queue[0]);
      renderQueue();
      return;
    }
    if (auto && (radioMode || taste.getAutoplay())) {
      const extended = await extendQueue();
      if (extended) {
        state.index += 1;
        startTrack(state.queue[state.index]);
        renderQueue();
        return;
      }
    }
    if (!auto) toast("End of queue");
    return;
  }

  state.index += 1;
  startTrack(state.queue[state.index]);
  renderQueue();
}

async function extendQueue() {
  const last = state.queue[state.queue.length - 1];
  if (!last) return false;
  try {
    const data = await api(`/api/related?id=${encodeURIComponent(last.id)}&limit=24`);
    const existing = new Set(state.queue.map((t) => t.id));
    const fresh = taste.rank(data.tracks, { excludeIds: [...existing], seed: last, limit: 12 });
    if (!fresh.length) return false;
    state.queue.push(...fresh);
    renderQueue();
    return true;
  } catch {
    return false;
  }
}

async function startRadio(seed) {
  if (!seed) return;
  closePopover();
  toast(`Radio · ${seed.artist}`, "ok");

  let candidates = [];
  try {
    const data = await api(`/api/related?id=${encodeURIComponent(seed.id)}&limit=26`);
    candidates = data.tracks || [];
  } catch {
    /* seed-only radio */
  }

  const ranked = taste.rank(candidates, { excludeIds: [seed.id], seed, limit: 24 });
  const queue = [seed, ...ranked];
  if (queue.length === 1) {
    candidates = [];
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(seed.artist + " songs")}&limit=14`);
      queue.push(...taste.rank(data.tracks || [], { excludeIds: [seed.id], seed, limit: 12 }));
    } catch {
      /* give up quietly */
    }
  }

  playFromList(queue, 0);
  radioMode = true;
  if (queue.length < 2) toast("No similar tracks found for this one", "err");
}

function prevTrack() {
  if (!state.queue.length) return;
  if (audio.currentTime > 4) {
    audio.currentTime = 0;
    return;
  }
  if (state.index === 0) {
    audio.currentTime = 0;
    return;
  }
  state.index -= 1;
  startTrack(state.queue[state.index]);
  renderQueue();
}

function togglePlay() {
  if (!state.current) {
    if (state.queue.length) startTrack(state.queue[Math.max(0, state.index)]);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function toggleLike(track = state.current) {
  if (!track) return;
  if (store.liked[track.id]) {
    delete store.liked[track.id];
    toast("Removed from liked songs");
  } else {
    store.liked[track.id] = track;
    toast("Added to liked songs", "ok");
  }
  taste.record(store.liked[track.id] ? "like" : "unlike", track);
  saveStore();
  renderNow();
  if (state.view === "library") renderLibrary();
  if (state.view === "liked") renderLiked();
}

/* ------------------------------ player UI ------------------------------ */

function renderNow() {
  const track = state.current;
  const cover = $("#pCover");
  const title = $("#pTitle");
  const artist = $("#pArtist");

  if (!track) {
    $("#youtubeStage").hidden = true;
    cover.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    title.textContent = "Nothing playing";
    artist.textContent = "Pick something to start";
    $("#likeBtn").classList.remove("liked");
    $("#streamBadge").textContent = "—";
    $("#streamBadge").classList.remove("hifi");
    return;
  }

  cover.innerHTML = `<img src="${esc(track.thumbnail)}" alt="" />`;
  title.textContent = track.title;
  artist.textContent = track.artist;
  title.title = track.title;
  $("#youtubeTitle").textContent = track.title;
  $("#youtubeArtist").textContent = track.artist;
  $("#youtubeOpenLink").href = `https://www.youtube.com/watch?v=${encodeURIComponent(track.id)}`;

  const liked = Boolean(store.liked[track.id]);
  $("#likeBtn").classList.toggle("liked", liked);
  $("#likeBtn").innerHTML = liked ? icon("heartFill") : icon("heart");

  $("#streamBadge").textContent = "YouTube";
  $("#streamBadge").classList.remove("hifi");

  updateMediaSession(track);
}

function markPlaying() {
  const id = state.current ? state.current.id : null;
  $$("[data-track-id]").forEach((el) => el.classList.toggle("playing", el.dataset.trackId === id));
}

function updatePlayIcon() {
  $("#playBtn").innerHTML = audio.paused ? icon("play") : icon("pause");
  $("#playBtn").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  const stagePlay = $("#stagePlay");
  if (stagePlay) stagePlay.innerHTML = audio.paused ? icon("play") : icon("pause");
}

function updateProgress() {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.current?.duration || 0;
  const current = audio.currentTime || 0;
  const pct = duration ? (current / duration) * 100 : 0;

  $("#seek").value = String(Math.round(pct * 10));
  setRangeFill($("#seek"));
  $("#tCur").textContent = fmtTime(current);
  $("#tDur").textContent = fmtTime(duration);

  const stageSeek = $("#stageSeek");
  if (stageSeek) {
    stageSeek.value = String(Math.round(pct * 10));
    setRangeFill(stageSeek);
    $("#stageCur").textContent = fmtTime(current);
    $("#stageDur").textContent = fmtTime(duration);
  }

  $("#seekBuffer").style.width = "0";
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator) || !track) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: "Tarang",
      artwork: [{ src: track.thumbnail, sizes: "512x512", type: "image/jpeg" }],
    });
  } catch {
    /* unsupported */
  }
}

/* ------------------------------ audio events ------------------------------ */

audio.addEventListener("loadedmetadata", () => {
  clearTimeout(state.startWatchdog);
  $("#playBtn").classList.remove("loading");
  state.loading = false;
  updateProgress();
});

audio.addEventListener("timeupdate", updateProgress);
audio.addEventListener("progress", updateProgress);
audio.addEventListener("play", updatePlayIcon);
audio.addEventListener("pause", updatePlayIcon);

audio.addEventListener("playing", () => {
  clearTimeout(state.startWatchdog);
  $("#playBtn").classList.remove("loading");
  state.loading = false;
  updatePlayIcon();
});

audio.addEventListener("ended", () => {
  if (session) {
    taste.record("complete", session.track, { ratio: 1 });
    session = null;
  }
  nextTrack(true);
});

audio.addEventListener("error", () => {
  clearTimeout(state.startWatchdog);
  $("#playBtn").classList.remove("loading");
  state.loading = false;
  const track = state.current;
  if (!track) return;

  toast("Couldn't play this track. Skipping.", "err");
  if (state.queue.length > 1) nextTrack(true);
});

/* ------------------------------ controls ------------------------------ */

$("#playBtn").addEventListener("click", togglePlay);
$("#nextBtn").addEventListener("click", () => nextTrack(false));
$("#prevBtn").addEventListener("click", prevTrack);
$("#likeBtn").addEventListener("click", () => toggleLike());

$("#shuffleBtn").addEventListener("click", () => {
  store.shuffle = !store.shuffle;
  saveStore();
  $("#shuffleBtn").classList.toggle("active", store.shuffle);
  toast(store.shuffle ? "Shuffle on" : "Shuffle off");
});

$("#repeatBtn").addEventListener("click", () => {
  store.repeat = store.repeat === "off" ? "all" : store.repeat === "all" ? "one" : "off";
  saveStore();
  $("#repeatBtn").classList.toggle("active", store.repeat !== "off");
  $("#repeatBtn").classList.toggle("one-mode", store.repeat === "one");
  $("#repeatBtn").setAttribute(
    "aria-label",
    store.repeat === "off" ? "Repeat off" : store.repeat === "all" ? "Repeat all" : "Repeat one",
  );
  toast(store.repeat === "off" ? "Repeat off" : store.repeat === "all" ? "Repeat queue" : "Repeat this track");
});

$("#seek").addEventListener("input", (event) => {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  if (!duration) return;
  const pct = Number(event.target.value) / 1000;
  audio.currentTime = pct * duration;
  $("#tCur").textContent = fmtTime(audio.currentTime);
  setRangeFill(event.target);
});

const volInput = $("#vol");
volInput.addEventListener("input", () => {
  const value = Number(volInput.value) / 100;
  store.volume = value;
  store.muted = value === 0;
  audio.volume = value;
  audio.muted = false;
  saveStore();
  setRangeFill(volInput);
  updateVolIcon();
});

$("#volBtn").addEventListener("click", () => {
  store.muted = !store.muted;
  audio.muted = store.muted;
  saveStore();
  updateVolIcon();
  setRangeFill(volInput);
});

function updateVolIcon() {
  const muted = store.muted || audio.volume === 0;
  $("#volBtn").classList.toggle("active", muted);
  $("#volBtn").innerHTML = muted
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6M22 9l-6 6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>';
  $("#volIcon")?.remove();
  volInput.value = String(Math.round((store.muted ? 0 : store.volume) * 100));
}

/* ------------------------------ queue drawer ------------------------------ */

function openQueue(open) {
  $("#queuePanel").classList.toggle("open", open);
  $("#queuePanel").setAttribute("aria-hidden", open ? "false" : "true");
}

$("#queueBtn").addEventListener("click", () => openQueue(!$("#queuePanel").classList.contains("open")));
$("#closeQueue").addEventListener("click", () => openQueue(false));

/* ------------------------------ lyrics ------------------------------ */

const lyricsPanel = $("#lyricsPanel");
const lyricsBody = $("#lyricsBody");
let lyrics = { id: null, lines: [], timings: [], active: -1, wordIndex: -1, synced: false };

/**
 * LRCLIB only gives line timestamps, so word timing has to be estimated.
 *
 * Singing a syllable takes roughly a third of a second; stretching a line's
 * words across the whole gap to the next line is what made the highlight crawl
 * and drift. So we estimate the sung length from syllables and clamp it inside
 * the available gap, then distribute by syllable weight.
 */
function syllableWeight(word) {
  const text = String(word).replace(/[^\p{L}\p{N}]/gu, "");
  if (!text) return 1;
  if (/[a-z]/i.test(text)) {
    const groups = text.toLowerCase().match(/[aeiouy]+/g);
    return Math.max(1, groups ? groups.length : Math.ceil(text.length / 3));
  }
  // Indic scripts: one syllable is usually ~2 characters.
  return Math.max(1, Math.round(text.length / 2.1));
}

function wordTimings(line, nextStart) {
  const words = String(line.text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const weights = words.map(syllableWeight);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const sung = Math.max(0.9, total * 0.34);
  const gap = nextStart && nextStart > line.t ? nextStart - line.t : 0;
  // A line is sung across most of the gap before the next one. Spreading words
  // over a short "sung" estimate lit the last word seconds early, which reads as
  // drift; follow the line's real span and cap it so instrumental gaps stay sane.
  const span = gap > 0 ? Math.max(0.8, Math.min(gap - 0.25, Math.max(sung, gap * 0.8))) : sung;

  let cursor = line.t;
  return words.map((text, i) => {
    const start = cursor;
    cursor += (span * weights[i]) / total;
    return { text, start, end: cursor };
  });
}

function lyricsOpen() {
  return lyricsPanel.classList.contains("open");
}

function lyricsMessage(text) {
  lyricsBody.innerHTML = `<p class="ly-empty">${esc(text)}</p>`;
}

function openLyrics(open) {
  lyricsPanel.classList.toggle("open", open);
  lyricsPanel.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("stage-open", open);
  $("#lyricsBtn").classList.toggle("active", open);
  if (open) {
    openQueue(false);
    loadLyrics();
    startLyricLoop();
    syncStageModes();
  }
}

function renderLyrics(data) {
  const meta = $("#lyricsMeta");
  const track = state.current;

  if (!data.found) {
    meta.textContent = track ? `No lyrics found · ${track.artist}` : "Nothing playing";
    lyricsMessage("LRCLIB (free, community-run) has no match for this track yet.");
    lyricsBody.insertAdjacentHTML("beforeend", `<p class="ly-note">source · LRCLIB</p>`);
    return;
  }

  const synced = Boolean(data.synced && data.lines.length);
  lyrics.synced = synced;
  lyrics.lines = synced ? data.lines : [];
  lyrics.timings = synced ? data.lines.map((line, i) => ({ t: line.t, words: wordTimings(line, data.lines[i + 1]?.t) })) : [];
  lyrics.active = -1;
  lyrics.wordIndex = -1;

  const who = data.matchedArtist || track?.artist || "";
  const drift = Math.abs(Number(data.durationDelta) || 0);
  const differentCut = drift > 3;
  meta.textContent = `${synced ? "Sing along" : "Unsynced"} · ${who}${differentCut ? " · different cut" : ""}`;

  const hint = differentCut
    ? `<p class="ly-hint">These lyrics are timed for a ${Math.round((data.matchedDuration || 0) / 60)}:${String(Math.round((data.matchedDuration || 0) % 60)).padStart(2, "0")} version. Nudge sync with − / + above.</p>`
    : "";

  const source = esc(String(data.source || "LRCLIB"));

  if (synced) {
    lyricsBody.innerHTML = hint +
      data.lines
        .map(
          (line, i) =>
            `<button class="ly-line" data-ly="${i}">${lyrics.timings[i].words
              .map((word) => `<span class="ly-w">${esc(word.text)}</span>`)
              .join(" ")}</button>`,
        )
        .join("") + `<p class="ly-note">source · ${source} · tap a line to jump</p>`;
  } else {
    lyricsBody.innerHTML = hint +
      String(data.plain)
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `<p class="ly-line plain">${esc(line)}</p>`)
        .join("") + `<p class="ly-note">source · ${source} · unsynced</p>`;
  }

  syncLyrics(true);
}

async function loadLyrics() {
  const track = state.current;
  if (!track) {
    $("#lyricsMeta").textContent = "Nothing playing";
    lyricsMessage("Play a track to see its lyrics.");
    return;
  }
  if (lyrics.id === track.id && lyricsBody.querySelector(".ly-line")) {
    syncLyrics(true);
    return;
  }

  lyrics = {
    id: track.id,
    lines: [],
    timings: [],
    active: -1,
    wordIndex: -1,
    synced: false,
    offset: lyricOffsetFor(track.id),
  };
  updateLyricOffsetUI();
  const cover = $("#lyCover");
  if (cover && track.thumbnail) cover.src = track.thumbnail;
  $("#lyTitle").textContent = track.title;
  lyricsPanel.style.setProperty("--art", `url("${track.thumbnail}")`);
  $("#lyricsMeta").textContent = `${track.artist} · searching…`;
  lyricsMessage("Finding lyrics…");

  try {
    const params = new URLSearchParams({
      id: track.id,
      title: track.title,
      artist: track.artist,
      duration: String(track.duration || 0),
    });
    const data = await api(`/api/lyrics?${params}`);
    if (state.current?.id !== track.id) return;
    renderLyrics(data);
  } catch (err) {
    if (state.current?.id !== track.id) return;
    $("#lyricsMeta").textContent = "Lyrics unavailable";
    lyricsMessage(err.message || "Couldn't load lyrics right now.");
  }
}

/** Keep the current line centred without letting smooth scrolling fight the user. */
let lyricScrollPauseUntil = 0;

document.addEventListener("wheel", (event) => {
  if (lyricsBody.contains(event.target)) lyricScrollPauseUntil = Date.now() + 3500;
}, { passive: true });
lyricsBody.addEventListener("touchmove", () => {
  lyricScrollPauseUntil = Date.now() + 3500;
}, { passive: true });

function lyricOffsetFor(id) {
  return Number(store.lyricOffsets?.[id]) || 0;
}

function updateLyricOffsetUI() {
  const el = $("#lyOffset");
  if (!el) return;
  const offset = lyrics.offset || 0;
  el.textContent = `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`;
  el.classList.toggle("on", Math.abs(offset) > 0.01);
  el.title = Math.abs(offset) > 0.01 ? "Tap to reset sync" : "Shift lyrics in time";
}

function setLyricOffset(next) {
  const id = state.current?.id;
  if (!id) return;
  const clamped = Math.max(-30, Math.min(30, Math.round(next * 10) / 10));
  lyrics.offset = clamped;
  store.lyricOffsets = store.lyricOffsets || {};
  if (Math.abs(clamped) < 0.01) delete store.lyricOffsets[id];
  else store.lyricOffsets[id] = clamped;
  saveStore();
  updateLyricOffsetUI();
  syncLyrics(true);
  toast(`Lyrics sync ${clamped > 0 ? "+" : ""}${clamped.toFixed(1)}s`, "ok");
}

function centerLyricLine(node) {
  if (Date.now() < lyricScrollPauseUntil) return;
  const target = node.offsetTop - lyricsBody.clientHeight * 0.42 + node.offsetHeight / 2;
  lyricsBody.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

/** timeupdate only fires ~4x/s; a frame loop keeps the word highlight smooth. */
let lyricFrame = 0;

function lyricTick() {
  if (!lyricsOpen() || audio.paused) {
    lyricFrame = 0;
    return;
  }
  syncLyrics();
  lyricFrame = requestAnimationFrame(lyricTick);
}

function startLyricLoop() {
  if (!lyricFrame) lyricFrame = requestAnimationFrame(lyricTick);
}

audio.addEventListener("play", () => {
  if (lyricsOpen()) startLyricLoop();
});
audio.addEventListener("seeked", () => syncLyrics(true));

function syncLyrics(force = false) {
  if (!lyrics.synced || !lyrics.lines.length || !lyricsOpen()) return;

  const time = audio.currentTime + 0.12 + (lyrics.offset || 0);
  const nodes = lyricsBody.querySelectorAll(".ly-line");
  let index = -1;
  for (let i = 0; i < lyrics.lines.length; i++) {
    if (lyrics.lines[i].t <= time) index = i;
    else break;
  }

  if (index !== lyrics.active || force) {
    lyrics.active = index;
    lyrics.wordIndex = -1;
    nodes.forEach((node, i) => {
      node.classList.toggle("active", i === index);
      node.classList.toggle("past", i < index);
    });
    // Word highlights belong to the active line only.
    lyricsBody.querySelectorAll(".ly-w.on, .ly-w.now").forEach((span) => span.classList.remove("on", "now"));
    if (nodes[index]) centerLyricLine(nodes[index]);
  }

  // Paint the words of the active line one by one.
  const timing = lyrics.timings[index];
  if (!timing || !nodes[index]) return;
  let word = -1;
  for (let i = 0; i < timing.words.length; i++) {
    if (timing.words[i].start <= time) word = i;
    else break;
  }
  if (word === lyrics.wordIndex && !force) return;
  lyrics.wordIndex = word;
  nodes[index].querySelectorAll(".ly-w").forEach((span, i) => {
    span.classList.toggle("on", i < word);
    span.classList.toggle("now", i === word);
  });
}

$("#lyricsBtn").addEventListener("click", () => openLyrics(!lyricsOpen()));
$("#closeLyrics").addEventListener("click", () => openLyrics(false));
$("#lyMinus").addEventListener("click", () => setLyricOffset((lyrics.offset || 0) - 0.5));
$("#lyPlus").addEventListener("click", () => setLyricOffset((lyrics.offset || 0) + 0.5));
$("#lyOffset").addEventListener("click", () => setLyricOffset(0));

const stageSeekEl = $("#stageSeek");
stageSeekEl.addEventListener("input", () => {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.current?.duration || 0;
  if (!duration) return;
  audio.currentTime = (Number(stageSeekEl.value) / 1000) * duration;
  updateProgress();
});
$("#stagePrev").addEventListener("click", () => prevTrack());
$("#stageNext").addEventListener("click", () => nextTrack(false));
$("#stagePlay").addEventListener("click", () => togglePlay());
$("#stageShuffle").addEventListener("click", () => {
  $("#shuffleBtn").click();
  syncStageModes();
});
$("#stageRepeat").addEventListener("click", () => {
  $("#repeatBtn").click();
  syncStageModes();
});

function syncStageModes() {
  $("#stageShuffle").classList.toggle("active", $("#shuffleBtn").classList.contains("active"));
  $("#stageRepeat").classList.toggle("active", $("#repeatBtn").classList.contains("active"));
}

audio.addEventListener("timeupdate", () => syncLyrics());

lyricsBody.addEventListener("click", (event) => {
  const line = event.target.closest("[data-ly]");
  if (!line || !lyrics.synced) return;
  const target = lyrics.lines[Number(line.dataset.ly)];
  if (!target) return;
  audio.currentTime = Math.max(0, target.t);
  if (audio.paused) audio.play().catch(() => {});
});
$("#clearQueue").addEventListener("click", () => {
  if (!state.queue.length) return;
  const current = state.current;
  state.queue = current ? [current] : [];
  state.index = current ? 0 : -1;
  renderQueue();
  toast("Queue cleared");
});

function renderQueue() {
  const body = $("#queueBody");
  const count = state.queue.length;
  $("#queueMeta").textContent = count ? `${count} track${count === 1 ? "" : "s"} · ${Math.max(0, count - state.index - 1)} up next` : "Nothing queued";

  if (!count) {
    body.innerHTML = `<p class="pl-empty" style="padding:16px 10px">Your queue is empty. Play a track or use a track's menu to add one.</p>`;
    return;
  }

  body.innerHTML = state.queue
    .map(
      (track, i) => `<div class="qrow ${i === state.index ? "current" : ""}" data-queue-index="${i}" data-track-id="${esc(track.id)}">
        <span class="q-i">${i === state.index ? "▶" : i + 1}</span>
        <img src="${esc(track.thumbnail)}" alt="" loading="lazy" />
        <div style="min-width:0">
          <div class="q-t">${esc(track.title)}</div>
          <div class="q-a">${esc(track.artist)}</div>
        </div>
        <button class="icon-btn sm q-x" data-queue-remove="${i}" aria-label="Remove">${icon("close")}</button>
      </div>`,
    )
    .join("");

  markPlaying();
}

/* ------------------------------ popover / menu ------------------------------ */

const popover = $("#popover");

function openPopover(rect, html) {
  popover.innerHTML = html;
  popover.classList.add("open");
  popover.setAttribute("aria-hidden", "false");

  const width = 250;
  const left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width));
  const spaceBelow = window.innerHeight - rect.bottom;
  const height = popover.offsetHeight || 200;
  const top = spaceBelow > height + 12 ? rect.bottom + 8 : Math.max(10, rect.top - height - 8);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.minWidth = `${width}px`;
}

function closePopover() {
  popover.classList.remove("open");
  popover.setAttribute("aria-hidden", "true");
}

document.addEventListener("click", (event) => {
  if (!popover.contains(event.target)) closePopover();
  if (!event.target.closest("#sidebar") && !event.target.closest("#menuBtn")) $("#sidebar").classList.remove("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePopover();
    closeModal();
    openQueue(false);
    openLyrics(false);
  }
});
window.addEventListener("resize", closePopover);
main.addEventListener("scroll", closePopover, { passive: true });

function openTrackMenu(track, rect) {
  if (!track) return;
  const liked = Boolean(store.liked[track.id]);
  const playlists = store.playlists
    .map((pl) => `<button class="pop-item" data-add-to="${pl.id}" data-track="${esc(track.id)}">${icon("plus")}${esc(pl.name)}</button>`)
    .join("");

  openPopover(
    rect,
    `<button class="pop-item" data-menu-action="like" data-track="${esc(track.id)}">${liked ? icon("heartFill") : icon("heart")}${liked ? "Remove from liked" : "Add to liked songs"}</button>
     <button class="pop-item" data-menu-action="next" data-track="${esc(track.id)}">${icon("nextUp")}Play next</button>
     <button class="pop-item" data-menu-action="queue" data-track="${esc(track.id)}">${icon("queue")}Add to queue</button>
     <button class="pop-item" data-menu-action="radio" data-track="${esc(track.id)}">${icon("radio")}Start radio</button>
     <div class="pop-sep"></div>
     <div class="pop-label">Add to playlist</div>
     ${playlists || '<div class="pop-item" style="color:#7d828a">No playlists yet</div>'}
     <button class="pop-item" data-menu-action="new-playlist" data-track="${esc(track.id)}">${icon("plus")}New playlist…</button>
     <div class="pop-sep"></div>
     <button class="pop-item" data-menu-action="dislike" data-track="${esc(track.id)}">${icon("block")}Not interested</button>`,
  );
}

popover.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;

  if (btn.dataset.addTo) {
    const playlist = store.playlists.find((pl) => pl.id === btn.dataset.addTo);
    const track = findTrack(btn.dataset.track);
    if (playlist && track) {
      if (!playlist.tracks.some((t) => t.id === track.id)) {
        playlist.tracks.push(track);
        taste.record("playlist", track);
        saveStore();
        renderSidebarPlaylists();
        if (state.view === "playlist") renderPlaylist(playlist.id);
        toast(`Added to ${playlist.name}`, "ok");
      } else {
        toast("Already in that playlist");
      }
    }
    closePopover();
    return;
  }

  const action = btn.dataset.menuAction;
  const track = findTrack(btn.dataset.track);
  if (action === "like") toggleLike(track);
  else if (action === "next") playNext(track);
  else if (action === "queue") addToQueue(track);
  else if (action === "radio") startRadio(track);
  else if (action === "dislike") {
    taste.dislike(track);
    closePopover();
    toast("We'll play less like this", "ok");
    if (state.current && state.current.id === track.id) nextTrack(false);
  } else if (action === "new-playlist") {
    closePopover();
    openNewPlaylistModal(track);
  }
});

/* ------------------------------ modal ------------------------------ */

const modal = $("#modal");
const modalCard = $("#modalCard");

function openModal(html) {
  modalCard.innerHTML = html;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const input = modalCard.querySelector("input");
  if (input) setTimeout(() => input.focus(), 40);
}

function closeModal() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

function openNewPlaylistModal(track = null) {
  openModal(`<h3>New playlist</h3><p>Give it a name. Tracks are added from any song's menu.</p>
    <input id="plName" maxlength="60" placeholder="Late night drive" />
    <div class="modal-actions">
      <button class="btn" data-modal="cancel">Cancel</button>
      <button class="btn primary" data-modal="create">Create</button>
    </div>`);

  const create = () => {
    const name = modalCard.querySelector("#plName").value.trim();
    if (!name) return;
    const playlist = { id: `pl_${Date.now().toString(36)}`, name, tracks: track ? [track] : [] };
    store.playlists.push(playlist);
    saveStore();
    renderSidebarPlaylists();
    closeModal();
    toast(`Playlist “${playlist.name}” created`, "ok");
    if (state.view === "library") renderLibrary();
  };

  modalCard.querySelector('[data-modal="create"]').addEventListener("click", create);
  modalCard.querySelector('[data-modal="cancel"]').addEventListener("click", closeModal);
  modalCard.querySelector("#plName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") create();
  });
}

$("#newPlaylistBtn").addEventListener("click", () => openNewPlaylistModal());

/* ------------------------------ delegation: main view ------------------------------ */

view.addEventListener("click", (event) => {
  const menuBtn = event.target.closest("[data-menu]");
  if (menuBtn) {
    event.stopPropagation();
    const row = menuBtn.closest("[data-track-id]");
    if (row) openTrackMenu(findTrack(row.dataset.trackId), menuBtn.getBoundingClientRect());
    return;
  }

  const quick = event.target.closest("[data-quick]");
  if (quick) {
    $("#searchInput").value = quick.dataset.quick;
    runSearch(quick.dataset.quick);
    return;
  }

  const playAll = event.target.closest("[data-play-all]");
  if (playAll) {
    const listKey = playAll.dataset.playAll;
    const list = state.lists.get(listKey);
    if (list && list.length) {
      if (store.shuffle) {
        const shuffled = [...list].sort(() => Math.random() - 0.5);
        playFromList(shuffled, 0);
      } else {
        playFromList(list, 0);
      }
    }
    return;
  }

  const playlistLink = event.target.closest("[data-playlist]");
  if (playlistLink) {
    setView("playlist", { id: playlistLink.dataset.playlist });
    return;
  }

  const inlineNew = event.target.closest("#inlineNewPlaylist");
  if (inlineNew) {
    openNewPlaylistModal();
    return;
  }

  if (event.target.closest("#resetTaste")) {
    taste.reset();
    toast("Taste profile cleared");
    renderLibrary();
    return;
  }

  const deletePlaylist = event.target.closest("[data-delete-playlist]");
  if (deletePlaylist) {
    const id = deletePlaylist.dataset.deletePlaylist;
    const playlist = store.playlists.find((pl) => pl.id === id);
    if (!playlist) return;
    store.playlists = store.playlists.filter((pl) => pl.id !== id);
    saveStore();
    renderSidebarPlaylists();
    setView("library");
    toast(`Deleted “${playlist.name}”`);
    return;
  }

  const row = event.target.closest("[data-track-id]");
  if (row) {
    const listEl = row.closest("[data-list]");
    const listKey = listEl ? listEl.dataset.list : null;
    const list = listKey ? state.lists.get(listKey) : null;
    const track = findTrack(row.dataset.trackId);
    if (list && track) {
      playFromList(list, list.findIndex((t) => t.id === track.id), { smart: isDiscoveryList(listKey || "") });
    } else if (track) {
      playFromList([track], 0, { smart: true });
    }
  }
});

view.addEventListener("change", (event) => {
  if (event.target && event.target.id === "autoplayToggle") {
    taste.setAutoplay(event.target.checked);
    toast(event.target.checked ? "Autoplay on" : "Autoplay off");
  }
});

view.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("[data-track-id]");
  if (!row) return;
  event.preventDefault();
  row.click();
});

/* ------------------------------ delegation: queue / sidebar ------------------------------ */

$("#queueBody").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-queue-remove]");
  if (remove) {
    event.stopPropagation();
    const index = Number(remove.dataset.queueRemove);
    const wasCurrent = index === state.index;
    state.queue.splice(index, 1);
    if (index < state.index) state.index -= 1;
    if (wasCurrent) {
      state.index = Math.min(state.index, state.queue.length - 1);
      if (state.index >= 0) startTrack(state.queue[state.index]);
      else {
        state.current = null;
        audio.pause();
        renderNow();
        markPlaying();
      }
    }
    renderQueue();
    return;
  }

  const row = event.target.closest("[data-queue-index]");
  if (row) {
    const index = Number(row.dataset.queueIndex);
    state.index = index;
    startTrack(state.queue[index]);
    renderQueue();
  }
});

$("#playlistList").addEventListener("click", (event) => {
  const item = event.target.closest("[data-playlist]");
  if (item) {
    setView("playlist", { id: item.dataset.playlist });
    $("#sidebar").classList.remove("open");
  }
});

/* ------------------------------ search input ------------------------------ */

const searchInput = $("#searchInput");

searchInput.addEventListener("input", () => {
  const value = searchInput.value.trim();
  clearTimeout(searchTimer);
  if (value.length < 2) return;
  searchTimer = setTimeout(() => runSearch(value), 420);
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    clearTimeout(searchTimer);
    runSearch(searchInput.value);
  }
});

/* ------------------------------ keyboard ------------------------------ */

document.addEventListener("keydown", (event) => {
  const typing = /^(input|textarea)$/i.test(event.target.tagName) || event.target.isContentEditable;

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }

  if (typing) return;

  if (event.code === "Space") {
    event.preventDefault();
    togglePlay();
  } else if (event.key === "ArrowRight" && event.shiftKey) {
    nextTrack(false);
  } else if (event.key === "ArrowLeft" && event.shiftKey) {
    prevTrack();
  } else if (event.key === "ArrowRight" && audio.duration) {
    audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
  } else if (event.key === "ArrowLeft" && audio.duration) {
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  } else if (event.key.toLowerCase() === "m") {
    $("#volBtn").click();
  } else if (event.key.toLowerCase() === "l") {
    toggleLike();
  } else if (event.key === "/") {
    event.preventDefault();
    searchInput.focus();
  }
});

/* ------------------------------ media session ------------------------------ */

if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack(false));
    navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null) audio.currentTime = details.seekTime;
    });
  } catch {
    /* unsupported */
  }
}

/* ------------------------------ boot ------------------------------ */

setRangeFill($("#seek"));
setRangeFill(volInput);
updateVolIcon();
updatePlayIcon();
$("#shuffleBtn").classList.toggle("active", store.shuffle);
$("#repeatBtn").classList.toggle("active", store.repeat !== "off");
$("#repeatBtn").classList.toggle("one-mode", store.repeat === "one");
renderSidebarPlaylists();
setView("home");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations
          .filter((registration) =>
            [registration.active, registration.waiting, registration.installing].some((worker) => {
              if (!worker) return false;
              const url = new URL(worker.scriptURL);
              return url.origin === location.origin && url.pathname === "/sw.js";
            }),
          )
          .map((registration) => registration.unregister()),
      );

      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith("tarang-shell-"))
          .map((name) => caches.delete(name)),
      );
    } catch (error) {
      console.error("[pwa] Service worker cleanup failed:", error);
    }
  });
}
renderQueue();

youtubeApiReady
  .then(() => setYouTubeStatus("YouTube player ready", "ok"))
  .catch(() => setYouTubeStatus("YouTube player unavailable", "bad"));

setInterval(() => {
  if (youtubePlayerReady && state.current) audio.dispatch("timeupdate");
}, 500);
