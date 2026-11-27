import { existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { HOME_SHELVES, relatedTracks, searchTracks, type Track } from "./youtube";
import {
  cachedMeta,
  probeResolver,
  rememberMeta,
  resolve,
  resolverStatus,
  ResolveError,
  type Quality,
} from "./resolver";
import { fetchLyrics } from "./lyrics";
import { headAudio, parseQuality, streamAudio } from "./stream";

const ROOT = import.meta.dir + "/..";
const PUBLIC_DIR = join(ROOT, "public");
const LAUNCH_FILE = join(ROOT, "launch", "index.html");
const PORT = Number(process.env.PORT || 8787);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(code: string, message: string, status = 400): Response {
  return json({ error: code, message }, status);
}

function fileResponse(path: string, cacheSeconds = 0): Response {
  const file = Bun.file(path);
  const headers: Record<string, string> = {
    "Content-Type": MIME[extname(path)] || "application/octet-stream",
  };
  headers["Cache-Control"] = cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-cache";
  return new Response(file, { headers });
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        const status = resolverStatus();
        return json({
          ok: status.available !== false,
          resolver: status,
          pid: process.pid,
          uptime: Math.round(process.uptime()),
        });
      }

      if (path === "/api/home") {
        const offset = Number(url.searchParams.get("offset") || 0);
        const requestedLimit = Number(url.searchParams.get("limit") || HOME_SHELVES.length);
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(requestedLimit) || requestedLimit < 1) {
          return fail("BAD_PAGINATION", "Invalid home shelf range.");
        }
        const shelvesToLoad = HOME_SHELVES.slice(offset, offset + Math.min(requestedLimit, HOME_SHELVES.length));
        const shelves = await Promise.all(
          shelvesToLoad.map(async (shelf) => {
            try {
              const tracks = await searchTracks(shelf.query, 14);
              tracks.forEach((track) => rememberMeta(track));
              return { ...shelf, tracks };
            } catch (err) {
              return { ...shelf, tracks: [] as Track[] };
            }
          }),
        );
        return json({ shelves: shelves.filter((s) => s.tracks.length > 0) });
      }

      if (path === "/api/related") {
        const id = url.searchParams.get("id") || "";
        if (!VIDEO_ID.test(id)) return fail("BAD_ID", "Invalid track id.");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 30);
        const seed = cachedMeta(id);
        const tracks = await relatedTracks(id, limit, seed ? `${seed.title} ${seed.artist}` : undefined);
        tracks.forEach((track) => rememberMeta(track));
        return json({ id, count: tracks.length, tracks });
      }

      if (path === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return fail("BAD_QUERY", "Search needs at least 2 characters.");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 24, 1), 40);
        const tracks = await searchTracks(q, limit);
        tracks.forEach((track) => rememberMeta(track));
        return json({ query: q, count: tracks.length, tracks });
      }

      if (path === "/api/track") {
        const id = url.searchParams.get("id") || "";
        if (!VIDEO_ID.test(id)) return fail("BAD_ID", "Invalid track id.");
        const quality = parseQuality(url.searchParams.get("quality"));

        const known = cachedMeta(id);
        if (known) {
          // Resolve in parallel with the player starting; cached URLs return instantly.
          const resolved = await resolve(id, quality).catch(() => null);
          return json({
            track: known,
            cached: true,
            quality: resolved
              ? {
                  itag: resolved.itag,
                  bitrateKbps: resolved.bitrateKbps,
                  ext: resolved.ext,
                  source: resolved.source,
                }
              : null,
          });
        }

        const resolved = await resolve(id, quality);
        return json({
          track: resolved.track,
          quality: {
            itag: resolved.itag,
            bitrateKbps: resolved.bitrateKbps,
            ext: resolved.ext,
            source: resolved.source,
          },
        });
      }

      if (path === "/api/lyrics") {
        const id = url.searchParams.get("id") || "";
        if (!VIDEO_ID.test(id)) return fail("BAD_ID", "Invalid track id.");

        const title = url.searchParams.get("title")?.trim() || "";
        const artist = url.searchParams.get("artist")?.trim() || "";
        const requestedDuration = Number(url.searchParams.get("duration"));
        let track: Track | null =
          title && artist && title.length <= 300 && artist.length <= 200
            ? {
                id,
                title,
                artist,
                duration:
                  Number.isFinite(requestedDuration) && requestedDuration > 0
                    ? requestedDuration
                    : 0,
                thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              }
            : cachedMeta(id) ?? null;
        if (!track) {
          const resolved = await resolve(id, "data").catch(() => null);
          track = resolved?.track ?? null;
        }
        if (!track) return json({ found: false, synced: false, lines: [], plain: "", source: "LRCLIB" });
        return json(await fetchLyrics(track));
      }

      if (path === "/api/stream") {
        const id = url.searchParams.get("id") || "";
        if (!VIDEO_ID.test(id)) return fail("BAD_ID", "Invalid track id.");
        const quality = parseQuality(url.searchParams.get("quality"));
        if (req.method === "HEAD") return headAudio(id, quality);
        return await streamAudio(req, id, quality);
      }

      if (path === "/launch") {
        if (!existsSync(LAUNCH_FILE)) return new Response("Not found", { status: 404 });
        return fileResponse(LAUNCH_FILE);
      }

      if (path.startsWith("/api/")) return fail("NOT_FOUND", "Unknown endpoint.", 404);

      // static files, confined to public/
      const relative = normalize(decodeURIComponent(path === "/" ? "/index.html" : path)).replace(/^(\.\.[/\\])+/, "");
      const target = join(PUBLIC_DIR, relative);
      if (!target.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
      if (existsSync(target) && Bun.file(target).size > 0) {
        return fileResponse(target, path.startsWith("/vendor") ? 86400 : 0);
      }

      return fileResponse(join(PUBLIC_DIR, "index.html"));
    } catch (err) {
      if (err instanceof ResolveError) {
        console.error("[api]", path, err.code, err.detail || err.message);
        return json(
          { error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) },
          err.code === "UNAVAILABLE" ? 404 : 502,
        );
      }
      console.error("[api]", path, err);
      return fail("INTERNAL", err instanceof Error ? err.message : "Unexpected error.", 500);
    }
  },
});

await probeResolver();
const status = resolverStatus();
console.log(`Tarang running at http://localhost:${server.port}`);
if (status.mode === "direct") {
  console.log("Resolver: direct InnerTube only (DIRECT_ONLY=1, yt-dlp disabled)");
} else if (status.available) {
  console.log(`Resolver: ${status.mode} (yt-dlp ${status.version})`);
  console.log("Direct InnerTube (visionOS) enabled; yt-dlp is the fallback.");
} else {
  console.log("Resolver: yt-dlp NOT FOUND — install it (brew install yt-dlp) or set YT_DLP_PATH");
}
