/**
 * Direct InnerTube playback — no yt-dlp, no PoToken sidecar.
 *
 * The WEB / MWEB / TV players answer with SABR-only or "Sign in to confirm
 * you're not a bot" unless the request carries a BotGuard PoToken. The visionOS
 * client (one of the clients yt-dlp itself defaults to) still returns plain
 * adaptive audio URLs when the request reuses the visitor identity from a watch
 * page load, so we bootstrap that identity once per session and reuse it.
 *
 * This module never throws: any failure returns null and the caller falls back
 * to yt-dlp.
 */

import type { Quality } from "./resolver";

/** DIRECT_ONLY forces the direct InnerTube path on and disables the yt-dlp fallback. */
const DIRECT_ONLY = process.env.DIRECT_ONLY === "1";
const DIRECT_OFF = process.env.DIRECT_STREAM === "0" && !DIRECT_ONLY;

const CLIENT_VERSION = "1.02";
const CLIENT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const PAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** First itag in the ladder that the response actually offers. */
const ITAG_LADDER: Record<Quality, number[]> = {
  hifi: [251, 140, 250, 249],
  data: [250, 249, 140, 251],
  aac: [140, 139, 251, 250, 249],
};

export type DirectResult = {
  url: string;
  itag: string;
  bitrateKbps: number;
  ext: string;
  mime: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
};

type Session = { visitorData: string; apiKey: string; cookie: string; expires: number };

const SESSION_TTL = 5 * 60 * 60 * 1000;
let session: Session | null = null;
let inflightSession: Promise<Session | null> | null = null;

export function directEnabled(): boolean {
  return !DIRECT_OFF;
}

export function directOnly(): boolean {
  return DIRECT_ONLY;
}

/** One watch-page load per session gives us the visitor identity + API key. */
async function bootstrap(force = false): Promise<Session | null> {
  if (!force && session && session.expires > Date.now()) return session;
  if (inflightSession) return inflightSession;

  inflightSession = (async () => {
    try {
      const res = await fetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=en", {
        headers: {
          "User-Agent": PAGE_UA,
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: "SOCS=CAI; PREF=hl=en&gl=IN",
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return null;

      const html = await res.text();
      const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || "";
      const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || "";
      if (!visitorData) return null;

      const cookieId = html.match(/VISITOR_INFO1_LIVE=([^;"]+)/)?.[1] || visitorData;
      session = {
        visitorData,
        apiKey,
        cookie: `SOCS=CAI; PREF=hl=en&gl=IN; VISITOR_INFO1_LIVE=${cookieId}`,
        expires: Date.now() + SESSION_TTL,
      };
      return session;
    } catch {
      return null;
    } finally {
      inflightSession = null;
    }
  })();

  return inflightSession;
}

function extFor(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  return "m4a";
}

function pickFormat(formats: any[], quality: Quality): any | null {
  const audio = formats.filter(
    (f) => typeof f?.mimeType === "string" && f.mimeType.startsWith("audio/") && f.url,
  );
  if (!audio.length) return null;

  for (const itag of ITAG_LADDER[quality] ?? ITAG_LADDER.hifi) {
    const match = audio.find((f) => Number(f.itag) === itag);
    if (match) return match;
  }
  return audio.sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];
}

async function askPlayer(videoId: string, token: Session): Promise<any | null> {
  const context = {
    client: {
      clientName: "VISIONOS",
      clientVersion: CLIENT_VERSION,
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      userAgent: CLIENT_UA,
      osName: "visionOS",
      osVersion: "26.5.23O471",
      hl: "en",
      gl: "IN",
      visitorData: token.visitorData,
    },
  };

  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CLIENT_UA,
        "X-Goog-Visitor-Id": token.visitorData,
        ...(token.apiKey ? { "X-Goog-Api-Key": token.apiKey } : {}),
        "X-Youtube-Client-Name": "101",
        "X-Youtube-Client-Version": CLIENT_VERSION,
        Origin: "https://www.youtube.com",
        Referer: `https://www.youtube.com/watch?v=${videoId}`,
        Cookie: token.cookie,
      },
      body: JSON.stringify({
        context,
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
      signal: AbortSignal.timeout(9_000),
    });

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function directResolve(videoId: string, quality: Quality): Promise<DirectResult | null> {
  if (DIRECT_OFF) return null;

  let token = await bootstrap();
  if (!token) return null;

  let data = await askPlayer(videoId, token);
  if (!data || data?.playabilityStatus?.status !== "OK") {
    // The visitor identity may have expired server-side; refresh once.
    const fresh = await bootstrap(true);
    if (fresh) data = await askPlayer(videoId, fresh);
  }

  if (!data || data?.playabilityStatus?.status !== "OK") return null;

  const formats = data?.streamingData?.adaptiveFormats ?? [];
  const format = pickFormat(formats, quality);
  if (!format) return null;

  const details = data.videoDetails ?? {};
  const thumbs = details.thumbnail?.thumbnails ?? [];
  const mime = String(format.mimeType || "audio/webm");

  return {
    url: String(format.url),
    itag: String(format.itag ?? ""),
    bitrateKbps: Math.round(Number(format.bitrate || format.averageBitrate || 0) / 1000),
    ext: extFor(mime),
    mime,
    title: String(details.title || "Unknown title"),
    artist: String(details.author || "Unknown artist").replace(/\s*-\s*Topic$/i, ""),
    duration: Number(details.lengthSeconds) || 0,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}
