import { TtlCache } from "./cache";
import { directEnabled, directResolve } from "./innertube-player";
import type { Track } from "./youtube";

export type Quality = "hifi" | "data" | "aac";

export type Resolved = {
  track: Track;
  url: string;
  itag: string;
  mime: string;
  bitrateKbps: number;
  ext: string;
  expiresAt: number;
  source: "direct" | "ytdlp";
};

const YTDLP = process.env.YT_DLP_PATH || "yt-dlp";

/** Itag ladder. Opus 251 (~160k) first, then m4a 140 (~128k) for Safari. */
const SELECTORS: Record<Quality, string> = {
  hifi: "bestaudio[acodec=opus][abr<=200]/bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio",
  data: "bestaudio[abr<=80]/bestaudio[acodec=opus]/bestaudio",
  aac: "bestaudio[ext=m4a]/bestaudio",
};

const META_TEMPLATE = [
  "META",
  "%(id)s",
  "%(title)s",
  "%(uploader)s",
  "%(duration)s",
  "%(format_id)s",
  "%(abr)s",
  "%(ext)s",
  "%(thumbnails.-1.url)s",
].join("\t");

const urlCache = new TtlCache<Resolved>(600);
const metaCache = new TtlCache<Track>(2000);
const inflight = new Map<string, Promise<Resolved>>();

const MAX_CONCURRENT = 3;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    const next = waiting.shift();
    if (next) next();
  };
}

type RunResult = { stdout: string; stderr: string; code: number };

async function runYtDlp(args: string[], timeoutMs = 30_000): Promise<RunResult> {
  const proc = Bun.spawn([YTDLP, ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr: timedOut ? "resolver timed out" : stderr, code: timedOut ? 124 : code };
  } finally {
    clearTimeout(timer);
  }
}

let available: boolean | null = null;
let version = "";

export async function probeResolver(): Promise<{ available: boolean; version: string }> {
  if (available !== null) return { available, version };
  try {
    const res = await runYtDlp(["--version"], 8_000);
    version = res.stdout.trim().split("\n")[0] || "";
    available = res.code === 0 && Boolean(version);
  } catch {
    available = false;
  }
  return { available, version };
}

function mimeFor(ext: string): string {
  if (ext === "webm") return 'audio/webm; codecs="opus"';
  if (ext === "m4a" || ext === "mp4") return 'audio/mp4; codecs="mp4a.40.2"';
  return "audio/mpeg";
}

function expiryFromUrl(raw: string): number {
  try {
    const expire = Number(new URL(raw).searchParams.get("expire"));
    if (expire && Number.isFinite(expire)) return expire * 1000;
  } catch {
    /* ignore */
  }
  return Date.now() + 45 * 60 * 1000;
}

function classifyError(stderr: string): { code: string; message: string } {
  const text = stderr.toLowerCase();
  if (text.includes("sign in to confirm") || text.includes("not a bot")) {
    return { code: "BOT_CHECK", message: "The source is asking for a signed-in session for this track." };
  }
  if (text.includes("age") && text.includes("restrict")) {
    return { code: "AGE_RESTRICTED", message: "This track is age-restricted at the source." };
  }
  if (text.includes("unavailable") || text.includes("private video") || text.includes("removed")) {
    return { code: "UNAVAILABLE", message: "This track isn't available from the source." };
  }
  if (text.includes("timed out")) {
    return { code: "TIMEOUT", message: "The resolver took too long. Try again." };
  }
  return { code: "RESOLVE_FAILED", message: "Could not resolve an audio stream for this track." };
}

export class ResolveError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

async function doResolveYtDlp(videoId: string, quality: Quality): Promise<Resolved> {
  const selector = SELECTORS[quality] ?? SELECTORS.hifi;
  const { stdout, stderr, code } = await runYtDlp([
    "--no-warnings",
    "--no-progress",
    "--no-playlist",
    "--no-call-home",
    "-f",
    selector,
    "-g",
    "--print",
    META_TEMPLATE,
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  if (code !== 0) {
    const error = classifyError(stderr);
    throw new ResolveError(error.code, error.message);
  }

  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const url = lines.find((line) => /^https?:\/\//.test(line));
  const metaLine = lines.find((line) => line.startsWith("META\t"));

  if (!url) throw new ResolveError("NO_URL", "The resolver returned no playable URL for this track.");

  const fields = metaLine ? metaLine.split("\t") : [];
  const track: Track = {
    id: fields[1] || videoId,
    title: fields[2] || "Unknown title",
    artist: (fields[3] || "Unknown artist").replace(/\s*-\s*Topic$/i, ""),
    duration: Number(fields[4]) || 0,
    thumbnail: fields[8] || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };

  const ext = fields[7] || (url.includes("mime=audio%2Fwebm") ? "webm" : "m4a");
  const bitrateKbps = Math.round(Number(fields[6]) || 0);
  const itag = fields[5] || "";

  const resolved: Resolved = {
    track,
    url,
    itag,
    mime: mimeFor(ext),
    bitrateKbps,
    ext,
    expiresAt: expiryFromUrl(url),
    source: "ytdlp",
  };

  metaCache.set(videoId, track, 24 * 60 * 60 * 1000);
  // Refresh 5 minutes before the signed URL expires.
  urlCache.set(`${videoId}:${quality}`, resolved, Math.max(60_000, resolved.expiresAt - Date.now() - 5 * 60 * 1000));
  return resolved;
}

/**
 * Direct InnerTube first (only when a PoToken provider is configured), then
 * yt-dlp. Whichever path succeeds is cached the same way.
 */
async function doResolve(videoId: string, quality: Quality): Promise<Resolved> {
  if (directEnabled()) {
    const direct = await directResolve(videoId, quality);
    if (direct) {
      const track: Track = {
        id: videoId,
        title: direct.title,
        artist: direct.artist,
        duration: direct.duration,
        thumbnail: direct.thumbnail,
      };
      const resolved: Resolved = {
        track,
        url: direct.url,
        itag: direct.itag,
        mime: direct.mime,
        bitrateKbps: direct.bitrateKbps,
        ext: direct.ext,
        expiresAt: expiryFromUrl(direct.url),
        source: "direct",
      };
      metaCache.set(videoId, track, 24 * 60 * 60 * 1000);
      urlCache.set(
        `${videoId}:${quality}`,
        resolved,
        Math.max(60_000, resolved.expiresAt - Date.now() - 5 * 60 * 1000),
      );
      return resolved;
    }
  }

  return doResolveYtDlp(videoId, quality);
}

export async function resolve(videoId: string, quality: Quality = "hifi"): Promise<Resolved> {
  const key = `${videoId}:${quality}`;
  const cached = urlCache.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const release = await acquire();
    try {
      return await doResolve(videoId, quality);
    } finally {
      release();
    }
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

export function invalidate(videoId: string, quality?: Quality): void {
  if (quality) urlCache.delete(`${videoId}:${quality}`);
  else {
    for (const q of ["hifi", "data", "aac"] as Quality[]) urlCache.delete(`${videoId}:${q}`);
  }
}

export function cachedMeta(videoId: string): Track | undefined {
  return metaCache.get(videoId);
}

export function rememberMeta(track: Track): void {
  if (track?.id) metaCache.set(track.id, track, 24 * 60 * 60 * 1000);
}

export function resolverStatus() {
  return {
    available,
    version,
    mode: directEnabled() ? "direct+yt-dlp" : "yt-dlp",
  };
}
