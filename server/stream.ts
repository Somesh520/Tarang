import { invalidate, resolve, type Quality } from "./resolver";

const QUALITIES = new Set<Quality>(["hifi", "data", "aac"]);

export function parseQuality(raw: string | null): Quality {
  const value = (raw || "hifi").toLowerCase() as Quality;
  return QUALITIES.has(value) ? value : "hifi";
}

/**
 * Range-aware proxy in front of the resolved media URL.
 *
 * We never hand the googlevideo URL to the browser: it is IP-bound, expires in
 * hours, and carries no CORS headers. The browser talks to us, we talk to the
 * source, and seek works because Range/206 is forwarded verbatim.
 */
export async function streamAudio(req: Request, videoId: string, quality: Quality): Promise<Response> {
  const range = req.headers.get("range");

  for (let attempt = 0; attempt < 2; attempt++) {
    const resolved = await resolve(videoId, quality);

    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (range) headers.Range = range;

    // No timeout here: it would abort the response body mid-playback.
    const upstream = await fetch(resolved.url, { headers, redirect: "follow" });

    if (upstream.status === 403 || upstream.status === 410) {
      // Signed URL died earlier than advertised — drop it and re-resolve once.
      invalidate(videoId, quality);
      if (attempt === 0) continue;
    }

    if (!upstream.ok && upstream.status !== 206) {
      invalidate(videoId, quality);
      return new Response(
        JSON.stringify({
          error: "UPSTREAM_FAILED",
          message: `The source refused this stream (HTTP ${upstream.status}).`,
        }),
        { status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

    const out = new Headers();
    out.set("Content-Type", upstream.headers.get("content-type") || resolved.mime);
    out.set("Accept-Ranges", "bytes");
    out.set("Cache-Control", "private, max-age=0, no-store");
    out.set("X-Audio-Itag", resolved.itag);
    out.set("X-Audio-Bitrate", String(resolved.bitrateKbps));

    const length = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    if (length) out.set("Content-Length", length);
    if (contentRange) out.set("Content-Range", contentRange);

    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  return new Response(JSON.stringify({ error: "UPSTREAM_FAILED", message: "Stream unavailable." }), {
    status: 502,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function headAudio(videoId: string, quality: Quality): Promise<Response> {
  const resolved = await resolve(videoId, quality);
  return new Response(null, {
    status: 200,
    headers: {
      "Content-Type": resolved.mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Audio-Itag": resolved.itag,
      "X-Audio-Bitrate": String(resolved.bitrateKbps),
    },
  });
}
