const CACHE_NAME = "tarang-shell-v1";
const APP_SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/taste.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];
const SHELL_PATHS = new Set(APP_SHELL);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("tarang-shell-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      let response;
      try {
        response = await fetch(request);
      } catch {
        return (await caches.match("/")) || Response.error();
      }
      try {
        await (await caches.open(CACHE_NAME)).put("/", response.clone());
      } catch (error) {
        console.error("[pwa] Could not cache app page:", error);
      }
      return response;
    })());
    return;
  }

  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      try {
        await (await caches.open(CACHE_NAME)).put(request, response.clone());
      } catch (error) {
        console.error("[pwa] Could not cache app asset:", error);
      }
    }
    return response;
  })());
});
