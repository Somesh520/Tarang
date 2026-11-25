/**
 * Free lyrics via LRCLIB (https://lrclib.net) — no API key, no signup.
 *
 * YouTube titles are messy ("Song - Film | Actor | Singer | 4K"), so we clean
 * the title, then try the exact lookup and fall back to progressively looser
 * searches, picking the candidate whose duration and title match best.
 */

import { TtlCache } from "./cache";
import type { Track } from "./youtube";

export type LyricLine = { t: number; text: string };

export type LyricsSource = "LRCLIB" | "lyrics.ovh";

export type LyricsResult = {
  found: boolean;
  synced: boolean;
  lines: LyricLine[];
  plain: string;
  instrumental: boolean;
  source: LyricsSource;
  matchedTitle?: string;
  matchedArtist?: string;
  matchedDuration?: number;
  durationDelta?: number;
};

const BASE = "https://lrclib.net/api";
const UA = "Tarang/1.0 (https://github.com/tarang-player)";

const cache = new TtlCache<LyricsResult>(500);
const inflight = new Map<string, Promise<LyricsResult>>();

const empty = (): LyricsResult => ({
  found: false,
  synced: false,
  lines: [],
  plain: "",
  instrumental: false,
  source: "LRCLIB",
});

/** Deezer metadata via lyrics.ovh — used to canonicalise messy YouTube titles. */
async function deezerSuggestion(track: Track): Promise<{ title: string; artist: string; duration: number } | null> {
  const title = cleanTitle(track.title) || track.title;
  const hints = artistHints(track.title, track.artist);
  const stripped = title
    .replace(/\b(full song|video song|song|official|lyrical|lyrics|audio|video)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const short = title.split(/\s+[-–—]\s+/)[0].split(/\s+/).slice(0, 4).join(" ");
  const queries = [
    `${title} ${hints[0] || ""}`.trim(),
    title,
    stripped && stripped !== title ? `${stripped} ${hints[0] || ""}`.trim() : "",
    short && short !== title ? short : "",
  ].filter((query, i, all) => query && all.indexOf(query) === i);

  for (const query of queries) {
    try {
      const res = await fetch(`https://api.lyrics.ovh/suggest/${encodeURIComponent(query)}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      const items: any[] = data?.data ?? [];
      if (!items.length) continue;

      const duration = Math.round(Number(track.duration) || 0);
      let winner: any = null;
      let top = -Infinity;
      for (const item of items) {
        const name = String(item.title_short || item.title || "").replace(/\s*\(.*?\)\s*/g, " ").trim();
        if (!name) continue;
        let score = 0;
        if (duration && item.duration) {
          const delta = Math.abs(Number(item.duration) - duration);
          score += delta <= 2 ? 30 : delta <= 6 ? 15 : delta <= 20 ? 0 : -20;
        }
        if (!titleLooksRight(name, cleanTitle(track.title) || track.title)) continue;
        if (normalize(name) === normalize(cleanTitle(track.title) || track.title)) score += 15;
        const artist = String(item.artist?.name || "");
        if (hints.some((hint) => hint && normalize(artist).includes(normalize(hint)))) score += 10;
        if (score > top) {
          top = score;
          winner = { title: name, artist, duration: Number(item.duration) || 0 };
        }
      }
      if (winner && winner.artist) return winner;
    } catch {
      /* try the next query */
    }
  }
  return null;
}

/** Long mixes, jukeboxes and compilations never have a single track's timeline. */
function isCompilation(track: Track): boolean {
  if (Number(track.duration) > 900) return true;
  const title = String(track.title || "").toLowerCase();
  return /\b(mashup|jukebox|compilation|non[- ]?stop|all songs|top \d+|1 hour|30 minutes|mixtape|playlist)\b/.test(title);
}

/** Plain lyrics from lyrics.ovh (Deezer catalogue). */
async function lyricsOvh(artist: string, title: string): Promise<string> {
  try {
    const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const data: any = await res.json();
    const text = String(data?.lyrics || "");
    return text
      .replace(/\r/g, "")
      .replace(/^\s*Paroles de la chanson[^\n]*\n?/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}

/** "Kesariya - Brahmāstra | Ranbir | Pritam | 4K" -> "Kesariya" */
export function cleanTitle(raw: string): string {
  let value = String(raw || "");
  value = value.replace(/[([][^)\]]*[)\]]/g, " ");
  value = value.split("|")[0];
  value = value.replace(
    /\b(official|lyrical|lyrics|video|song|audio|full|hd|4k|8k|remastered|music video|with lyrics|visualizer)\b/gi,
    " ",
  );
  value = value.replace(/[#*_"'“”‘’]/g, " ");
  return value.replace(/\s+/g, " ").replace(/^[-–—\s]+|[-–—\s]+$/g, "").trim();
}

/** Channels are often labels ("Sony Music India"); those never match an artist. */
export function cleanArtist(raw: string): string {
  const value = String(raw || "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\b(vevo|official|records?|studios?|music|india|entertainment|label)\b/gi, " ")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value;
}

/** Singer names usually live in the pipe-separated tail of a YouTube title. */
function artistHints(title: string, artist: string): string[] {
  const parts = String(title || "")
    .split("|")
    .slice(1)
    .map((part) => cleanArtist(part))
    .filter((part) => part && part.length < 40);
  const clean = cleanArtist(artist);
  return [...new Set([clean, ...parts].filter(Boolean))].slice(0, 4);
}

export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of String(lrc || "").split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) continue;
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const fraction = stamp[3] ? Number(`0.${stamp[3]}`) : 0;
      lines.push({ t: Number((minutes * 60 + seconds + fraction).toFixed(2)), text });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

async function request(path: string): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normalize(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reject candidates whose title is clearly a different song. */
function titleLooksRight(got: string, wanted: string): boolean {
  const a = normalize(got);
  const b = normalize(wanted);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const wantedTokens = b.split(" ").filter((token) => token.length > 2);
  if (!wantedTokens.length) return false;
  const gotTokens = new Set(a.split(" ").filter((token) => token.length > 2));
  const hits = wantedTokens.filter((token) => gotTokens.has(token)).length;
  // One shared word only proves a match for one-word titles; otherwise an
  // artist name ("Coldplay") would match every song by that artist.
  if (wantedTokens.length === 1) return hits === 1;
  return hits >= 2 && hits / wantedTokens.length >= 0.4;
}

function score(entry: any, title: string, duration: number): number {
  if (!entry || entry.instrumental) return -100;
  const entryTitle = String(entry.trackName || entry.name || "");
  if (!titleLooksRight(entryTitle, title)) return -100;

  let total = 0;
  if (entry.syncedLyrics) total += 40;
  if (entry.plainLyrics) total += 5;

  const wanted = normalize(title);
  const got = normalize(entryTitle);
  const sameTitle = got === wanted || got.startsWith(`${wanted} `) || wanted.startsWith(`${got} `);

  // Lyrics must come from the same cut, otherwise every timestamp is offset.
  const delta = duration && entry.duration ? Math.abs(entry.duration - duration) : 0;
  // A vague title plus a very different runtime is almost always another song.
  if (!sameTitle && delta > 12) return -100;
  // Even an exact title that far off is usually a different edit or a preview.
  if (delta > 60) return -100;
  if (!duration || !entry.duration) total += 0;
  else if (delta <= 1.5) total += 35;
  else if (delta <= 3) total += 22;
  else if (delta <= 8) total += 8;
  else if (delta <= 20) total -= 10;
  else total -= 30;

  if (wanted && got === wanted) total += 30;
  else if (got && (got.includes(wanted) || wanted.includes(got))) total += 15;

  // Prefer the studio/original recording over dance mixes, live cuts and covers.
  const variant = /\b(remix|dance mix|mix|live|cover|karaoke|acoustic|reprise|remaster(ed)?|sped up|slowed|instrumental)\b/i;
  if (variant.test(entryTitle) && !variant.test(title)) total -= 15;

  return total;
}

function best(results: any[], title: string, duration: number): any | null {
  if (!Array.isArray(results) || !results.length) return null;
  let winner: any = null;
  let top = -Infinity;
  for (const entry of results) {
    const value = score(entry, title, duration);
    if (value > top) {
      top = value;
      winner = entry;
    }
  }
  return top >= 20 ? winner : null;
}

function toResult(entry: any): LyricsResult {
  const synced = typeof entry.syncedLyrics === "string" && entry.syncedLyrics.includes(":");
  const plain = String(entry.plainLyrics || "").trim();
  return {
    found: Boolean(synced || plain),
    synced,
    lines: synced ? parseLrc(entry.syncedLyrics) : [],
    plain,
    instrumental: Boolean(entry.instrumental),
    source: "LRCLIB",
    matchedTitle: entry.trackName || entry.name || undefined,
    matchedArtist: entry.artistName || undefined,
    matchedDuration: Number(entry.duration) || undefined,
    source: "LRCLIB",
  };
}

async function lookup(track: Track): Promise<any | null> {
  const title = cleanTitle(track.title) || track.title;
  const duration = Math.round(Number(track.duration) || 0);
  const hints = artistHints(track.title, track.artist);
  // Keep the whole lookup inside a budget so the panel never spins forever.
  const deadline = Date.now() + 12000;
  const expired = () => Date.now() > deadline;

  // 1. Exact metadata lookup (LRCLIB matches within ~2s of duration).
  for (const artist of hints.slice(0, 2)) {
    if (expired()) return null;
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (duration) params.set("duration", String(duration));
    const exact = await request(`/get?${params}`);
    if (exact && !exact.instrumental && (exact.syncedLyrics || exact.plainLyrics)) return exact;
  }

  // 2. Title full-text first (LRCLIB ranks these well and it always returns
  //    something), then artist-specific searches.
  const attempts: string[] = [`/search?${new URLSearchParams({ q: title })}`];
  for (const artist of hints.slice(0, 2)) {
    attempts.push(`/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`);
  }
  for (const artist of hints.slice(0, 2)) {
    attempts.push(`/search?${new URLSearchParams({ q: `${title} ${artist}`.trim() })}`);
  }

  for (const path of attempts) {
    if (expired()) return null;
    const results = await request(path);
    const winner = best(results ?? [], title, duration);
    if (winner) return winner;
  }
  return null;
}

type Canon = { title: string; artist: string; duration: number };

/** LRCLIB lookup using the clean Deezer title/artist instead of the video title. */
async function lookupCanonical(canon: Canon, duration: number): Promise<any | null> {
  const params = new URLSearchParams({ artist_name: canon.artist, track_name: canon.title });
  if (duration) params.set("duration", String(duration));
  const exact = await request(`/get?${params}`);
  if (exact && !exact.instrumental && (exact.syncedLyrics || exact.plainLyrics)) return exact;

  const results = await request(`/search?${new URLSearchParams({ track_name: canon.title, artist_name: canon.artist })}`);
  const winner = best(results ?? [], canon.title, duration);
  if (winner) return winner;

  const loose = await request(`/search?${new URLSearchParams({ q: `${canon.title} ${canon.artist}`.trim() })}`);
  return best(loose ?? [], canon.title, duration);
}

export async function fetchLyrics(track: Track): Promise<LyricsResult> {
  const key = `${track.id}:${cleanTitle(track.title)}:${Math.round(Number(track.duration) || 0)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const started = Date.now();
    const finish = (result: LyricsResult): LyricsResult => {
      if (result.found && result.matchedDuration && track.duration) {
        result.durationDelta = Math.round(result.matchedDuration - Number(track.duration));
      }
      cache.set(key, result, result.found ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000);
      return result;
    };

    if (isCompilation(track)) return finish(empty());

    const duration = Math.round(Number(track.duration) || 0);
    const title = String(track.title || "");
    // Devanagari/Tamil titles almost never match LRCLIB's Latin rows directly.
    const nonLatin = /[\u0900-\u0DFF]/.test(title);
    let canon = nonLatin ? await deezerSuggestion(track) : null;

    if (canon) {
      const hit = await lookupCanonical(canon, duration);
      if (hit) return finish(toResult(hit));
    }

    // 1. LRCLIB with our own title/artist cleanup (prefers synced lyrics).
    const entry = await lookup(track);
    if (entry) return finish(toResult(entry));

    // 2. Canonicalise the messy YouTube title via Deezer, then retry LRCLIB —
    //    this often surfaces the official synced entry our title never matched.
    if (!canon && Date.now() - started < 8000) canon = await deezerSuggestion(track);
    if (canon) {
      const hit = await lookupCanonical(canon, duration);
      if (hit) return finish(toResult(hit));

      // 3. Plain lyrics from lyrics.ovh (Deezer catalogue).
      const plain = await lyricsOvh(canon.artist, canon.title);
      if (plain) {
        return finish({
          found: true,
          synced: false,
          lines: [],
          plain,
          instrumental: false,
          source: "lyrics.ovh",
          matchedTitle: canon.title,
          matchedArtist: canon.artist,
          matchedDuration: canon.duration || undefined,
        });
      }
    }

    // 4. Last resort: ask lyrics.ovh with the title/artist we already have.
    const ownArtist = artistHints(track.title, track.artist)[0] || track.artist;
    const ownTitle = cleanTitle(track.title) || track.title;
    if (ownArtist && ownTitle && Date.now() - started < 14000) {
      const plain = await lyricsOvh(ownArtist, ownTitle);
      if (plain) {
        return finish({
          found: true,
          synced: false,
          lines: [],
          plain,
          instrumental: false,
          source: "lyrics.ovh",
          matchedTitle: ownTitle,
          matchedArtist: ownArtist,
        });
      }
    }

    return finish(empty());
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}
