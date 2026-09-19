// Makes Phone Farm installable and lets the app shell open with no connection.
// Deliberately NOT a data cache: the phone screen, the fleet and every /api response
// always come live from the hub (they are per-operator and security-sensitive), and
// the shell is fetched network-first so a deploy is never hidden behind a stale copy.

const CACHE = "phone-farm-shell-v1";
const SHELL = [
  "/", "/style.css", "/app.js", "/phoneStage.js", "/liveViewController.js", "/research.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon.svg",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/agent-link" || url.pathname === "/healthz") return; // never cached
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && SHELL.includes(url.pathname)) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    } catch {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === "navigate") return (await caches.match("/")) || Response.error();
      return Response.error();
    }
  })());
});
