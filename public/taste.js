/**
 * On-device taste model.
 *
 * Same shape as the recommendation systems in YouTube/Spotify, minus the
 * server: we log listening events, build a decayed profile of artists and
 * title terms, then re-rank candidate tracks (YouTube's watch-next graph,
 * artist catalogues) against that profile.
 *
 * Nothing here leaves the browser.
 */

const KEY = "tarang.taste.v2";
const HALF_LIFE_DAYS = 21;

const WEIGHTS = {
  play: 1,
  complete: 2.6,
  skip: -2.2,
  like: 4,
  unlike: -0.8,
  dislike: -6,
  playlist: 3,
  radio: 1.2,
  replay: 2.4,
};

const STOP = new Set(
  `official video audio song full lyrics lyric hd 4k 8k 16k music feat ft remix version live cover new latest status whatsapp mashup jukebox from with and the for you your
   video song lyrical visualizer fullvideo fullsong trailer teaser motion poster making behind scenes promo tseries sony zee tips
   the a an of in on to is it my me we our this that all most best top`
    .split(/\s+/)
    .filter(Boolean),
);

const SCRIPTS = [
  { name: "Hindi", re: /[\u0900-\u097F]/ },
  { name: "Punjabi", re: /[\u0A00-\u0A7F]/ },
  { name: "Tamil", re: /[\u0B80-\u0BFF]/ },
  { name: "Telugu", re: /[\u0C00-\u0C7F]/ },
  { name: "Bengali", re: /[\u0980-\u09FF]/ },
  { name: "Gujarati", re: /[\u0A80-\u0AFF]/ },
  { name: "Kannada", re: /[\u0C80-\u0CFF]/ },
  { name: "Malayalam", re: /[\u0D00-\u0D7F]/ },
  { name: "Arabic", re: /[\u0600-\u06FF]/ },
];

function emptyState() {
  return { events: [], searches: [], dislikes: {}, version: 2 };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || !Array.isArray(raw.events)) return emptyState();
    return { ...emptyState(), ...raw, dislikes: raw.dislikes || {} };
  } catch {
    return emptyState();
  }
}

let db = load();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* storage full / private mode */
  }
}

function decay(ts) {
  const days = Math.max(0, (Date.now() - ts) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

function detectScript(text) {
  for (const script of SCRIPTS) if (script.re.test(text)) return script.name;
  return "Latin";
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u2018\u2019'"`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2 && !STOP.has(token) && !/^\d+$/.test(token));
}

function add(map, key, value) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + value);
}

function snapshotTrack(track) {
  if (!track || !track.id) return null;
  return {
    id: track.id,
    title: track.title || "",
    artist: track.artist || "",
    thumbnail: track.thumbnail || "",
    duration: track.duration || 0,
  };
}

const api = {
  /** Log a listening signal. */
  record(type, track, extra = {}) {
    const snap = snapshotTrack(track);
    if (!snap || !(type in WEIGHTS)) return;

    if (type === "dislike") {
      db.dislikes[snap.id] = Date.now();
    }
    if (type === "unlike") delete db.dislikes[snap.id];

    db.events.push({ ...snap, type, ts: Date.now(), ...extra });

    // Keep the log bounded but recent-weighted.
    if (db.events.length > 800) db.events = db.events.slice(-800);
    persist();
  },

  recordSearch(query) {
    const q = String(query || "").trim();
    if (q.length < 2) return;
    db.searches.push({ q, ts: Date.now() });
    if (db.searches.length > 200) db.searches = db.searches.slice(-200);
    persist();
  },

  recordReplay(track) {
    this.record("replay", track);
  },

  dislike(track) {
    this.record("dislike", track);
  },

  isDisliked(id) {
    return Boolean(db.dislikes[id]);
  },

  /** Aggregate, time-decayed profile. */
  profile() {
    const artists = new Map();
    const terms = new Map();
    const scripts = new Map();
    const recent = new Map();
    let plays = 0;
    let completions = 0;
    let skips = 0;
    let likes = 0;
    let lastPlayed = null;

    for (const event of db.events) {
      const age = decay(event.ts);
      const weight = (WEIGHTS[event.type] || 0) * age;
      if (!weight) continue;

      if (event.type === "play") plays += 1;
      if (event.type === "complete") completions += 1;
      if (event.type === "skip") skips += 1;
      if (event.type === "like") likes += 1;
      if (event.type === "play") lastPlayed = event;

      add(artists, event.artist, weight);
      recent.set(event.id, Math.max(recent.get(event.id) || 0, event.ts));

      for (const token of tokenize(event.title)) add(terms, token, weight * 0.8);
      add(scripts, detectScript(event.title), weight * 0.6);
    }

    // Repeat plays of the same track shouldn't dominate the artist score.
    for (const [name, score] of artists) artists.set(name, score);

    const sortedArtists = [...artists.entries()].sort((a, b) => b[1] - a[1]);
    const sortedTerms = [...terms.entries()].sort((a, b) => b[1] - a[1]);

    return {
      artists,
      terms,
      scripts,
      recent,
      sortedArtists,
      sortedTerms,
      plays,
      completions,
      skips,
      likes,
      lastPlayed,
      disliked: db.dislikes,
      totalEvents: db.events.length,
    };
  },

  topArtists(limit = 5) {
    return this.profile()
      .sortedArtists.slice(0, limit)
      .filter(([, score]) => score > 0)
      .map(([name, score]) => ({ name, score }));
  },

  topTerms(limit = 8) {
    return this.profile()
      .sortedTerms.slice(0, limit)
      .filter(([, score]) => score > 0)
      .map(([term, score]) => ({ term, score }));
  },

  lastPlayed() {
    return this.profile().lastPlayed;
  },

  hasHistory() {
    return db.events.some((event) => event.type === "play" || event.type === "like");
  },

  /**
   * Rank candidate tracks against the profile.
   * score = artist affinity + title-term affinity + language + seed similarity
   *         + discovery bonus - dislike/recent-play penalties.
   */
  rank(candidates, options = {}) {
    const { excludeIds = [], seed = null, limit = 40 } = options;
    const profile = this.profile();
    const excluded = new Set(excludeIds);

    const maxArtist = Math.max(1e-9, profile.sortedArtists[0]?.[1] || 1);
    const maxTerm = Math.max(1e-9, profile.sortedTerms[0]?.[1] || 1);
    const maxScript = Math.max(1e-9, Math.max(0, ...[...profile.scripts.values()]));

    const seedTokens = seed ? new Set(tokenize(seed.title)) : new Set();
    const seedArtist = seed?.artist?.toLowerCase();

    const now = Date.now();
    const scored = [];

    for (const track of candidates) {
      if (!track || !track.id || excluded.has(track.id)) continue;
      if (profile.disliked[track.id]) continue;

      const artistScore = (profile.artists.get(track.artist) || 0) / maxArtist;
      const script = detectScript(track.title);
      const scriptScore = (profile.scripts.get(script) || 0) / maxScript;

      let termHits = 0;
      let termScore = 0;
      const tokens = tokenize(track.title);
      for (const token of tokens) {
        const weight = profile.terms.get(token);
        if (weight) {
          termHits += 1;
          termScore += weight / maxTerm;
        }
      }
      if (tokens.length) termScore /= Math.min(tokens.length, 6);

      let seedScore = 0;
      if (seed) {
        if (seedArtist && track.artist.toLowerCase() === seedArtist) seedScore += 0.6;
        let overlap = 0;
        for (const token of tokens) if (seedTokens.has(token)) overlap += 1;
        if (seedTokens.size) seedScore += Math.min(0.4, overlap / seedTokens.size);
      }

      const seenBefore = profile.recent.has(track.id);
      const discovery = seenBefore ? 0 : 0.18;
      const liked = Boolean(track.liked);

      // Replaying the same track within two hours is worth avoiding in a feed.
      let penalty = 0;
      const lastSeen = profile.recent.get(track.id);
      if (lastSeen && now - lastSeen < 2 * 60 * 60 * 1000) penalty += 0.55;

      const score =
        artistScore * 0.5 +
        termScore * 0.24 +
        scriptScore * 0.08 +
        seedScore * 0.16 +
        discovery +
        (liked ? 0.12 : 0) -
        penalty;

      scored.push({ track, score, artistScore, termHits, scriptScore });
    }

    scored.sort((a, b) => b.score - a.score);

    // Artist diversity: at most two tracks per artist in the top half.
    const perArtist = new Map();
    const result = [];
    for (const row of scored) {
      const key = row.track.artist.toLowerCase();
      const count = perArtist.get(key) || 0;
      if (count >= 2 && result.length < limit) continue;
      perArtist.set(key, count + 1);
      result.push({ ...row.track, _score: Number(row.score.toFixed(4)) });
      if (result.length >= limit) break;
    }
    return result;
  },

  /** Seed artists used to widen the candidate pool. */
  seedsFor(limit = 3) {
    return this.topArtists(limit).map((entry) => entry.name);
  },

  stats() {
    return {
      events: db.events.length,
      searches: db.searches.length,
      dislikes: Object.keys(db.dislikes).length,
    };
  },

  reset() {
    db = emptyState();
    persist();
  },
};

export const taste = api;
export default taste;
