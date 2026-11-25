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

const searchCache = new TtlCache<Track[]>(300);
const SEARCH_TTL = 6 * 60 * 60 * 1000; // 6 hours

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

function toTrack(video: any): Track | null {
  const id = video.videoId;
  if (!id || typeof id !== "string") return null;

  const title = textOf(video.title).trim();
  if (!title) return null;

  const duration = parseDuration(textOf(video.lengthText));
  if (duration < 25 || duration > 60 * 30) return null;
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

export async function searchTracks(query: string, limit = 24): Promise<Track[]> {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return [];

  const cacheKey = `${normalized}:${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const data = await innertube("search", {
    context,
    query,
    // filter to videos only
    params: "EgIQAQ%3D%3D",
  });

  const videos: any[] = [];
  collectVideos(data, videos);

  const tracks = dedupe(videos.map(toTrack).filter((t): t is Track => t !== null)).slice(0, limit);
  searchCache.set(cacheKey, tracks, SEARCH_TTL);
  return tracks;
}

const relatedCache = new TtlCache<Track[]>(200);
const RELATED_TTL = 3 * 60 * 60 * 1000;

/** Newer WEB responses use lockupViewModel; older clients still return compactVideoRenderer. */
function lockupToTrack(item: any): Track | null {
  const id = item?.contentId;
  if (!id || typeof id !== "string") return null;

  const md = item.metadata?.lockupMetadataViewModel;
  const title = String(md?.title?.content || "").trim();
  if (!title) return null;

  const parts = md?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts ?? [];
  const artist = cleanArtist(String(parts[0]?.text?.content || "Unknown artist"));
  const views = parts[1]?.text?.content as string | undefined;

  const badge = item.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]
    ?.thumbnailBadgeViewModel?.text;
  const duration = parseDuration(String(badge || ""));
  if (duration < 25 || duration > 60 * 30) return null;

  const sources = item.contentImage?.thumbnailViewModel?.image?.sources ?? [];
  const thumbnail = sources.length
    ? sources[sources.length - 1].url
    : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  return { id, title, artist, duration, thumbnail, views };
}

/**
 * “Up next” candidates from YouTube's own watch-next graph: the same signal
 * YouTube's autoplay uses, before our local taste model re-ranks it.
 */
export async function relatedTracks(videoId: string, limit = 20, seedQuery?: string): Promise<Track[]> {
  const cached = relatedCache.get(videoId);
  if (cached) return cached.slice(0, limit);

  try {
    const data = await innertube("next", { context, videoId });

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

    if (tracks.length) {
      relatedCache.set(videoId, tracks, RELATED_TTL);
      return tracks.slice(0, limit);
    }
  } catch (err) {
    // Datacenter IPs often get a 403 on watch-next while search still answers,
    // so fall through to the search-based queue instead of failing the request.
    console.error("[related] watch-next failed:", err instanceof Error ? err.message : err);
  }

  if (!seedQuery) return [];

  try {
    const alt = await searchTracks(seedQuery, limit + 8);
    const tracks = dedupe(alt).filter((track) => track.id !== videoId).slice(0, limit);
    relatedCache.set(videoId, tracks, RELATED_TTL);
    return tracks;
  } catch (err) {
    console.error("[related] search fallback failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export const HOME_SHELVES: { key: string; title: string; query: string }[] = [
  { key: "bollywood", title: "Bollywood right now", query: "bollywood hits 2026" },
  { key: "lofi", title: "Late-night lo-fi", query: "lofi hip hop mix" },
  { key: "punjabi", title: "Punjabi heat", query: "punjabi top songs" },
  { key: "indie", title: "Indie India", query: "indian indie music" },
  { key: "90s", title: "90s, untouched", query: "90s bollywood classics" },
  { key: "devotional", title: "Devotional", query: "hanuman chalisa aarti" },
];
