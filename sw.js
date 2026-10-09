// Service worker: makes the app load fast and open without signal.
// Never caches Supabase traffic, so saved/delivered data is always live.
const SHELL_CACHE = "cartdelivery-shell-v5";
const TILE_CACHE = "cartdelivery-tiles-v5";
const MAX_TILES = 600;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function cacheable(res) {
  return res && (res.status === 200 || res.type === "opaque");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;
  if (url.hostname.endsWith("supabase.co")) return;
  if (url.hostname === "api.optimoroute.com") return;

  // Live city queries have a small in-memory cache in the app, never a shell cache.
  if (url.hostname === "maps.austintexas.gov" && /\/query\/?$/.test(url.pathname)) return;
  if (url.hostname === "tigerweb.geo.census.gov" && /\/query\/?$/.test(url.pathname)) return;
  const isCityLimitsTile = url.hostname === "tigerweb.geo.census.gov" &&
    url.pathname === "/arcgis/services/TIGERweb/tigerWMS_Current/MapServer/WMSServer" &&
    url.searchParams.get("request")?.toLowerCase() === "getmap";
  const isTile = url.hostname.endsWith("tile.openstreetmap.org") ||
    ((url.hostname.endsWith("arcgisonline.com") || url.hostname.endsWith("maptiles.arcgis.com") || url.hostname === "maps.austintexas.gov") &&
      /\/tile\/\d+\/\d+\/\d+\/?$/.test(url.pathname)) || isCityLimitsTile;

  if (isTile) {
    // Tiles rarely change: serve cached copy, refresh in background.
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        const fetched = fetch(req)
          .then((res) => {
            if (cacheable(res)) {
              cache.put(req, res.clone()).then(() => trimCache(TILE_CACHE, MAX_TILES));
            }
            return res;
          })
          .catch(() => hit);
        return hit || fetched;
      })
    );
    return;
  }

  // App files and libraries: network first so updates arrive immediately,
  // cached copy only when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: false }).then((r) => r || caches.match(req, { ignoreSearch: true })))
  );
});
