// Only cache the public application shell. Never cache API responses or credentials.
const CACHE = "shufang-shell-v2";
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add("/")));
});
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode !== "navigate" && !url.pathname.startsWith("/assets/")) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === "navigate" ? caches.match("/") : Response.error())));
});
