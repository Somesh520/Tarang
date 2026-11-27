import { TtlCache } from "./cache";

export type Track = {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
  views?: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CLIENT_VERSION = "2.20241126.01.00";

const context = {
  client: {
    clientName: "WEB",
    clientVersion: CLIENT_VERSION,
    hl: "en",
    gl: "IN",
  },
};

/* ------------------------------------------------------------------------- */
/* YouTube Music — the music catalogue, not the video site.                  */
/*                                                                            */
/* Plain youtube.com/search returns whatever a keyword ranks: lyric videos,  */
/* 8K teasers, jukebox playlists, Hustle clips. music.youtube.com returns    */
/* actual songs with a real artist and album, which is what a music player   */
/* should offer. Its radio queue (RDAMVM + videoId) is also what our         */
/* recommendations are built from.                                           */
/* ------------------------------------------------------------------------- */

const YTM_VERSION = "1.20241127.01.00";

const musicContext = {
  client: {
    clientName: "WEB_REMIX",
    clientVersion: YTM_VERSION,
    hl: "en",
    gl: "IN",
  },
};

// Songs only — no albums, playlists, videos or podcasts.
const SONGS_FILTER = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";

async function music(path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://music.youtube.com/youtubei/v1/${path}?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://music.youtube.com",
      "X-Youtube-Client-Name": "67",
      "X-Youtube-Client-Version": YTM_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`music.youtube ${path} responded ${res.status}`);
  return res.json();
}

function parseDuration(raw: string): number {
  if (!raw) return 0;
  const parts = raw.split(":").map((p) => parseInt(p, 10) || 0);
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

function textOf(node: any): string {
  if (!node) return "";
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => r.text ?? "").join("");
  return "";
}

function cleanArtist(raw: string): string {
  return raw
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/\s*VEVO$/i, "")
    .replace(/\s*Official\s*$/i, "")
    .trim();
}

/** "Kesariya (From \"Brahmastra\")" -> "Kesariya" — the film tag is noise. */
function cleanMusicTitle(raw: string): string {
  return String(raw || "")
    .replace(/\s*\(from\s+[^)]*\)\s*$/i, "")
    .replace(/\s*\[from\s+[^\]]*\]\s*$/i, "")
    .trim();
}

const DURATION_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

/** flexColumns[1] is "Artist • Album • 4:29"; duration sometimes lives in fixedColumns. */
function splitMusicSubtitle(runs: any[]): { artist: string; duration: number } {
  const texts = (Array.isArray(runs) ? runs : [])
    .map((run: any) => String(run?.text ?? "").trim())
    .filter((text) => text && text !== "•");

  let duration = 0;
  const rest: string[] = [];
  for (const text of texts) {
    if (!duration && DURATION_RE.test(text)) duration = parseDuration(text);
    else rest.push(text);
  }
  return { artist: cleanArtist(rest[0] || "Unknown artist"), duration };
}

function musicItemToTrack(item: any): Track | null {
  const id = item?.playlistItemData?.videoId;
  if (!id || typeof id !== "string") return null;

  const columns = item?.flexColumns ?? [];
  const title = cleanMusicTitle(textOf(columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text));
  if (!title) return null;

  const subRuns = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
  const { artist, duration: subDuration } = splitMusicSubtitle(subRuns);
  const fixed = textOf(item?.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text);
  const duration = subDuration || (DURATION_RE.test(fixed) ? parseDuration(fixed) : 0);
  if (duration < 45 || duration > 15 * 60) return null;

  const sources = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
  const thumbnail = sources.length
    ? sources[sources.length - 1].url
    : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  return { id, title, artist, duration, thumbnail };
}

/** Radio queue entries (playlistPanelVideoRenderer) carry a cleaner byline. */
function panelItemToTrack(item: any): Track | null {
  const id = item?.videoId;
  if (!id || typeof id !== "string") return null;

  const title = cleanMusicTitle(textOf(item?.title));
  if (!title) return null;

  const artist = cleanArtist(textOf(item?.shortBylineText) || textOf(item?.longBylineText) || "Unknown artist");
  const duration = parseDuration(textOf(item?.lengthText));
  if (duration < 45 || duration > 15 * 60) return null;

  const thumbs = item?.thumbnail?.thumbnails ?? [];
  const thumbnail = thumbs.length
    ? thumbs[thumbs.length - 1].url
    : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  return { id, title, artist, duration, thumbnail };
}

/** Remove near-duplicate results (same song uploaded in several qualities). */
function dedupe(tracks: Track[]): Track[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const out: Track[] = [];

  for (const track of tracks) {
    if (seenIds.has(track.id)) continue;
    const key = `${track.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 60)}|${track.artist.toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenIds.add(track.id);
    seenKeys.add(key);
    out.push(track);
  }
  return out;
}

const searchCache = new TtlCache<Track[]>(400);
const SEARCH_TTL = 6 * 60 * 60 * 1000; // 6 hours
const searchInflight = new Map<string, Promise<Track[]>>();

async function musicSearch(query: string, limit: number): Promise<Track[]> {
  const data = await music("search", {
    context: musicContext,
    query,
    params: SONGS_FILTER,
  });

  const items: any[] = [];
  (function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.musicResponsiveListItemRenderer) items.push(node.musicResponsiveListItemRenderer);
    for (const key in node) {
      if (key === "musicResponsiveListItemRenderer") continue;
      walk(node[key]);
    }
  })(data);

  return dedupe(items.map(musicItemToTrack).filter((t): t is Track => t !== null)).slice(0, limit);
}

/* ------------------------------------------------------------------------- */
/* youtube.com fallback — only used when the music catalogue is unreachable. */
/* ------------------------------------------------------------------------- */

async function innertube(path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/${path}?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.youtube.com",
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": CLIENT_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`innertube ${path} responded ${res.status}`);
  return res.json();
}

function collectVideos(node: any, out: any[]): void {
  if (!node || typeof node !== "object") return;
  if (node.videoRenderer) out.push(node.videoRenderer);
  for (const key in node) {
    if (key === "videoRenderer") continue;
    const value = node[key];
    if (value && typeof value === "object") collectVideos(value, out);
  }
}

function isLiveOrUpcoming(video: any): boolean {
  const badges = video.badges ?? video.thumbnailOverlays ?? [];
  const flat = JSON.stringify(badges);
  return /LIVE|PREMIERE|UPCOMING|SHORTS/i.test(flat);
}

/** Things a music player must never queue: vlogs, playlists, teasers, compilations. */
const NOT_A_SONG =
  /\b(vlog|reaction|unboxing|prank|trailer|teaser|behind the scenes|interview|podcast|jukebox|playlist|mashup|non[- ]?stop|full album|all songs|top \d+|lofi (hip hop )?(mix|radio)|1 hour|hours? of)\b/i;

function toTrack(video: any): Track | null {
  const id = video.videoId;
  if (!id || typeof id !== "string") return null;

  const title = textOf(video.title).trim();
  if (!title) return null;
  if (NOT_A_SONG.test(title)) return null;

  const duration = parseDuration(textOf(video.lengthText));
  if (duration < 45 || duration > 15 * 60) return null;
  if (isLiveOrUpcoming(video)) return null;

  const artist = cleanArtist(
    textOf(video.ownerText) || textOf(video.longBylineText) || textOf(video.shortBylineText) || "Unknown artist",
  );

  const thumbs = video.thumbnail?.thumbnails ?? [];
  const thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  return {
    id,
    title,
    artist,
    duration,
    thumbnail,
    views: textOf(video.viewCountText) || undefined,
  };
}

async function legacySearch(query: string, limit: number): Promise<Track[]> {
  const data = await innertube("search", {
    context,
    query,
    // filter to videos only
    params: "EgIQAQ%3D%3D",
  });

  const videos: any[] = [];
  collectVideos(data, videos);

  return dedupe(videos.map(toTrack).filter((t): t is Track => t !== null)).slice(0, limit);
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

export async function searchTracks(query: string, limit = 24): Promise<Track[]> {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return [];

  const cacheKey = `${normalized}:${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const pending = searchInflight.get(cacheKey);
  if (pending) return pending;

  const task = (async () => {
    let tracks: Track[] = [];
    try {
      tracks = await musicSearch(query, limit);
    } catch (err) {
      console.error("[search] music catalogue failed:", err instanceof Error ? err.message : err);
    }

    if (tracks.length < 3) {
      try {
        const fallback = await legacySearch(query, limit);
        const seen = new Set(tracks.map((track) => track.id));
        tracks = dedupe([...tracks, ...fallback.filter((track) => !seen.has(track.id))]).slice(0, limit);
      } catch (err) {
        console.error("[search] youtube fallback failed:", err instanceof Error ? err.message : err);
      }
    }

    if (tracks.length) searchCache.set(cacheKey, tracks, SEARCH_TTL);
    return tracks;
  })();

  searchInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    searchInflight.delete(cacheKey);
  }
}

const relatedCache = new TtlCache<Track[]>(300);
const RELATED_TTL = 3 * 60 * 60 * 1000;

/** Newer WEB responses use lockupViewModel; older clients still return compactVideoRenderer. */
function lockupToTrack(item: any): Track | null {
  const id = item?.contentId;
  if (!id || typeof id !== "string") return null;

  const md = item.metadata?.lockupMetadataViewModel;
  const title = String(md?.title?.content || "").trim();
  if (!title) return null;
  if (NOT_A_SONG.test(title)) return null;

  const parts = md?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts ?? [];
  const artist = cleanArtist(String(parts[0]?.text?.content || "Unknown artist"));
  const views = parts[1]?.text?.content as string | undefined;

  const badge = item.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]
    ?.thumbnailBadgeViewModel?.text;
  const duration = parseDuration(String(badge || ""));
  if (duration < 45 || duration > 15 * 60) return null;

  const sources = item.contentImage?.thumbnailViewModel?.image?.sources ?? [];
  const thumbnail = sources.length
    ? sources[sources.length - 1].url
    : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  return { id, title, artist, duration, thumbnail, views };
}

/**
 * YouTube answers the `next` graph with 403 when a burst of calls arrives, and
 * sometimes keeps doing it for minutes. Once that happens, stop hammering it:
 * serve recommendations from the catalogue search until the cooldown expires.
 */
const GRAPH_COOLDOWN_MS = 90_000;
let graphCooldownUntil = 0;
const graphCoolingDown = () => Date.now() < graphCooldownUntil;
const coolDownGraph = () => {
  graphCooldownUntil = Date.now() + GRAPH_COOLDOWN_MS;
};

/**
 * YouTube Music radio: the same "up next" queue the music app builds for a
 * seed song. Music-only and artist-coherent, unlike the video watch-next graph.
 */
async function musicRadio(videoId: string, limit: number): Promise<Track[]> {
  if (graphCoolingDown()) return [];

  const body = {
    context: musicContext,
    videoId,
    playlistId: `RDAMVM${videoId}`,
    isAudioOnly: true,
  };

  let data: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = await music("next", body);
      break;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // The first 403 means the burst has already begun: take the cooldown now
      // so the other requests in flight stop piling onto the same rate limit.
      coolDownGraph();
      if (attempt === 1) {
        console.error("[related] music radio unavailable:", detail);
        return [];
      }
      console.error("[related] music radio 403, retrying once:", detail);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (!data) return [];

  const panels: any[] = [];
  (function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.playlistPanelVideoRenderer) panels.push(node.playlistPanelVideoRenderer);
    for (const key in node) {
      if (key === "playlistPanelVideoRenderer") continue;
      walk(node[key]);
    }
  })(data);

  return dedupe(panels.map(panelItemToTrack).filter((t): t is Track => t !== null))
    .filter((track) => track.id !== videoId)
    .slice(0, limit);
}

/** oEmbed gives the real title + channel when the caller has no cached metadata. */
async function oembedSeed(videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return "";
    const meta: any = await res.json();
    return meta?.title ? `${meta.title} ${meta.author_name || ""}`.trim() : "";
  } catch {
    return "";
  }
}

async function legacyRelated(videoId: string, seedQuery?: string): Promise<Track[]> {
  if (graphCoolingDown()) return [];

  let data: any;
  try {
    data = await innertube("next", { context, videoId });
  } catch (err) {
    console.error("[related] innertube next failed:", err instanceof Error ? err.message : err);
    coolDownGraph();
    return [];
  }

  const lockups: any[] = [];
  const compact: any[] = [];

  (function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") lockups.push(node.lockupViewModel);
    if (node.compactVideoRenderer) compact.push(node.compactVideoRenderer);
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === "object") walk(value);
    }
  })(data);

  const tracks = dedupe([
    ...lockups.map(lockupToTrack).filter((t): t is Track => t !== null),
    ...compact.map(toTrack).filter((t): t is Track => t !== null),
  ]).filter((track) => track.id !== videoId);

  if (tracks.length) return tracks;

  // watch-next is blocked on datacenter IPs, so build the seed for the search
  // fallback from oEmbed when the caller has no cached metadata for this id.
  const seed = seedQuery || (await oembedSeed(videoId));
  if (!seed) return [];

  const alt = await searchTracks(seed, 32);
  return dedupe(alt).filter((track) => track.id !== videoId);
}

export async function relatedTracks(videoId: string, limit = 20, seedQuery?: string): Promise<Track[]> {
  const cached = relatedCache.get(videoId);
  if (cached) return cached.slice(0, limit);

  let tracks: Track[] = [];
  try {
    tracks = await musicRadio(videoId, Math.max(limit, 30));
  } catch (err) {
    console.error("[related] music radio failed:", err instanceof Error ? err.message : err);
  }

  if (tracks.length < 5 && !graphCoolingDown()) {
    try {
      const fallback = await legacyRelated(videoId, seedQuery);
      const seen = new Set(tracks.map((track) => track.id));
      tracks = dedupe([...tracks, ...fallback.filter((track) => !seen.has(track.id))]);
    } catch (err) {
      console.error("[related] youtube fallback failed:", err instanceof Error ? err.message : err);
    }
  }

  // Both graph sources can 403 at once; the music catalogue search still answers,
  // so keep the queue alive instead of returning nothing.
  if (tracks.length < 5) {
    const seed = seedQuery || (await oembedSeed(videoId));
    if (seed) {
      try {
        const found = dedupe(await searchTracks(seed, 32)).filter((track) => track.id !== videoId);
        const seen = new Set(tracks.map((track) => track.id));
        tracks = dedupe([...tracks, ...found.filter((track) => !seen.has(track.id))]);
      } catch (err) {
        console.error("[related] catalogue search fallback failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  if (tracks.length) relatedCache.set(videoId, tracks, RELATED_TTL);
  return tracks.slice(0, limit);
}

export const HOME_SHELVES: { key: string; title: string; query: string }[] = [
  { key: "bollywood", title: "Bollywood right now", query: "bollywood hits" },
  { key: "lofi", title: "Late-night lo-fi", query: "lofi study beats" },
  { key: "punjabi", title: "Punjabi heat", query: "punjabi top songs" },
  { key: "indie", title: "Indie India", query: "indian indie" },
  { key: "90s", title: "90s, untouched", query: "90s bollywood classics" },
  { key: "devotional", title: "Devotional", query: "hanuman chalisa" },
];
