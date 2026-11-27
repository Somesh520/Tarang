import { existsSync } from "node:fs";
import { TtlCache } from "./cache";
import { directEnabled, directOnly, directResolve } from "./innertube-player";
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
const COOKIES = process.env.YT_COOKIES || "";
/** Local convenience: read the browser's own profile instead of exporting a file. */
const COOKIES_FROM_BROWSER = process.env.YT_COOKIES_FROM_BROWSER || "";

/** yt-dlp shells out to a JS runtime to solve YouTube's signature challenges. */
let jsRuntimeArg: string | null = null;
function jsRuntime(): string {
  if (jsRuntimeArg !== null) return jsRuntimeArg;
  jsRuntimeArg = process.env.YT_JS_RUNTIME || "";
  if (!jsRuntimeArg) {
    for (const name of ["deno", "bun", "node"]) {
      const path = Bun.which(name);
      if (path) {
        jsRuntimeArg = `${name}:${path}`;
        break;
      }
    }
  }
  return jsRuntimeArg;
}

function ytdlpBaseArgs(): string[] {
  const args = ["--no-warnings", "--no-progress", "--no-playlist"];
  const runtime = jsRuntime();
  if (runtime) args.push("--js-runtimes", runtime);
  if (COOKIES_FROM_BROWSER) args.push("--cookies-from-browser", COOKIES_FROM_BROWSER);
  else if (COOKIES && existsSync(COOKIES)) args.push("--cookies", COOKIES);
  args.push("--socket-timeout", "15", "--retries", "1");
  return args;
}

/**
 * Extractor attempts, in order: yt-dlp's own client set first, then optionally a
 * shotgun of alternative clients. Override the whole list with YT_PLAYER_CLIENTS
 * (pipe-separated, e.g. "|tv,web_embedded").
 */
const RESOLVE_ATTEMPTS = (process.env.YT_PLAYER_CLIENTS ?? "")
  .split("|")
  .map((entry) => entry.trim());
/**
 * A music player has to answer fast. YouTube intermittently answers with an
 * empty player response and then works on the next request, so a fast failure
 * is retried once — but no attempt is allowed to sit for a minute.
 */
const ATTEMPT_TIMEOUT_MS = Number(process.env.YT_ATTEMPT_TIMEOUT_MS) || 25_000;
const ATTEMPT_BUDGET_MS = Number(process.env.YT_ATTEMPT_BUDGET_MS) || 40_000;
const RESOLVE_BUDGET_MS = Number(process.env.YT_RESOLVE_BUDGET_MS) || 45_000;
const FAST_FAIL_MS = 10_000;

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
/** A track that just failed fails fast for the next minute instead of re-hanging. */
const failureCache = new TtlCache<{ code: string; message: string; detail?: string }>(500);
const FAILURE_TTL = 45_000;
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
  if (directOnly()) {
    available = true;
    version = "direct-only";
    return { available, version };
  }
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
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

/** Turn a successful yt-dlp run into a cached resolution. */
function fromYtDlpOutput(stdout: string, videoId: string, quality: Quality): Resolved | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const url = lines.find((line) => /^https?:\/\//.test(line));
  const metaLine = lines.find((line) => line.startsWith("META\t"));
  if (!url) return null;

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

function stderrSummary(stderr: string): string {
  const lines = stderr.trim().split("\n").filter((line) => /error|warn|confirm|format|runtime/i.test(line));
  const picked = (lines.length ? lines : stderr.trim().split("\n")).slice(-3).join(" | ").trim();
  const runtime = /no supported javascript runtime/i.test(stderr) ? "[no-js-runtime] " : "";
  return (runtime + picked).slice(0, 400);
}

async function doResolveYtDlp(videoId: string, quality: Quality): Promise<Resolved> {
  const selector = SELECTORS[quality] ?? SELECTORS.hifi;
  const started = Date.now();
  let last: { code: string; message: string; detail?: string } | null = null;
  const trail: string[] = [];
  const plan = [...RESOLVE_ATTEMPTS];
  let retried = false;

  while (plan.length) {
    const clients = plan.shift() as string;
    const args = ytdlpBaseArgs();
    if (clients) args.push("--extractor-args", `youtube:player_client=${clients}`);
    args.push("-f", selector, "-g", "--print", META_TEMPLATE, `https://www.youtube.com/watch?v=${videoId}`);

    // Never let an attempt outlive the group budget, whatever the env asks for:
    // a 50s attempt under a 45s budget is just a hung request.
    const elapsed = Date.now() - started;
    const timeout = Math.max(
      5_000,
      Math.min(ATTEMPT_TIMEOUT_MS, ATTEMPT_BUDGET_MS - elapsed, RESOLVE_BUDGET_MS - elapsed),
    );
    const { stdout, stderr, code } = await runYtDlp(args, timeout);
    const detail = stderrSummary(stderr);

    if (code === 0) {
      const resolved = fromYtDlpOutput(stdout, videoId, quality);
      if (resolved) return resolved;
      last = { code: "NO_URL", message: "The resolver returned no playable URL for this track.", detail };
    } else {
      last = { ...classifyError(stderr), detail };
    }

    const took = Math.round(Date.now() - started);
    console.error(`[ytdlp] ${videoId} clients=${clients || "default"} -> ${last.code} in ${took}ms: ${detail}`);
    trail.push(`${clients || "default"}=${last.code}(${took}ms): ${detail || "no stderr"}`);
    // A timeout is not final: the next client set can still answer quickly, and
    // giving up on the first one is how a resolvable track turns into a failure.
    if (last.code === "UNAVAILABLE" || last.code === "AGE_RESTRICTED") break;
    if (Date.now() - started > ATTEMPT_BUDGET_MS) break;

    // An empty player response usually clears on the next request, so retry the
    // same client once — but only when the failure came back quickly.
    if (last.code === "RESOLVE_FAILED" && !retried && Date.now() - started < FAST_FAIL_MS) {
      retried = true;
      plan.unshift(clients);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  // Point at the actual cause instead of a bare "resolve failed": YouTube
  // refusing every client from this network is fixed by a newer yt-dlp or a
  // signed-in session, not by retrying.
  const hint = /failed to extract any player response|sign in to confirm/i.test(trail.join(" "))
    ? " | YouTube refused every client from this network — update yt-dlp (yt-dlp -U) or set YT_COOKIES_FROM_BROWSER=chrome"
    : "";

  throw new ResolveError(
    last?.code || "RESOLVE_FAILED",
    last?.message || "Could not resolve an audio stream for this track.",
    (trail.join(" || ") + hint).slice(0, 900),
  );
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

  if (directOnly()) {
    throw new ResolveError(
      "DIRECT_FAILED",
      "YouTube's direct API did not return a stream for this track.",
      "direct-only mode: the yt-dlp fallback is disabled",
    );
  }

  return doResolveYtDlp(videoId, quality);
}

export async function resolve(videoId: string, quality: Quality = "hifi"): Promise<Resolved> {
  const key = `${videoId}:${quality}`;
  const cached = urlCache.get(key);
  if (cached) return cached;

  const failed = failureCache.get(key);
  if (failed) throw new ResolveError(failed.code, failed.message, failed.detail);

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const release = await acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Nothing may hold the player hostage: cap the whole resolution, not just
      // each attempt.
      const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ResolveError("TIMEOUT", "The resolver took too long. Try again.", `budget ${RESOLVE_BUDGET_MS}ms`)),
          RESOLVE_BUDGET_MS,
        );
      });
      try {
        return await Promise.race([doResolve(videoId, quality), budget]);
      } catch (err) {
        if (err instanceof ResolveError) {
          // A timeout is transient, so it is remembered only briefly.
          const ttl = err.code === "TIMEOUT" ? 15_000 : FAILURE_TTL;
          failureCache.set(key, { code: err.code, message: err.message, detail: err.detail }, ttl);
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
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
    mode: directOnly() ? "direct" : directEnabled() ? "direct+yt-dlp" : "yt-dlp",
    // Surfaced so a blocked network is diagnosable without reading the source.
    signedIn: Boolean(COOKIES_FROM_BROWSER || (COOKIES && existsSync(COOKIES))),
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
    ...(directOnly() ? { directOnly: true } : {}),
  };
}
