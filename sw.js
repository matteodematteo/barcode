// Offline app shell. All paths are resolved against the service worker scope
// so installs work both at the domain root and from a deployed subfolder.
const CACHE_NAME = 'webscanner-v126';
const APP_VERSION = '126';
const APP_SHELL_URL = new URL('index.html', self.registration.scope).toString();
const CACHEABLE_DESTINATIONS = new Set(['script', 'style', 'document', 'image', 'font']);
const ASSETS_TO_CACHE = [
  './', 'index.html', 'manifest.webmanifest?v=126',
  'apple-touch-icon.png?v=126', 'icon-192.png?v=126', 'icon-512.png?v=126',
  'css/interface.bundle.css?v=126',
  'js/app.bundle.js?v=126', 'js/capture.bundle.js?v=126',
  'js/zxing-worker.js?v=126',
  'js/vendor/zxing-wasm/3.1.5/reader.js',
  'js/vendor/zxing-wasm/3.1.5/zxing_reader.wasm'
].map((url) => new URL(url, self.registration.scope).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache each asset independently so one bad/missing URL can't abort
      // the whole precache (cache.addAll rejects — and skips caching
      // everything — the moment a single request fails).
      Promise.allSettled(
        ASSETS_TO_CACHE.map((url) =>
          fetch(url, { cache: 'reload' }).then((response) => {
            if (response && response.ok) {
              return cache.put(url, response);
            }
          }).catch(() => {
            // Ignore individual asset failures; the rest still get cached.
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k.startsWith('webscanner-') && k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(async () => {
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) => client.postMessage({ type: 'APP_VERSION', version: APP_VERSION }));
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_APP_VERSION') {
    event.source?.postMessage({ type: 'APP_VERSION', version: APP_VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  // Let live ERP/proxy requests go straight to the network.
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;
  // Versioned decoder files are immutable. Reuse them without downloading the
  // WASM binary again while the camera is starting on every repeat visit.
  if (ASSETS_TO_CACHE.includes(requestUrl.href) &&
      (requestUrl.pathname.includes('/vendor/zxing-wasm/') || requestUrl.searchParams.has('v'))) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })());
    return;
  }
  // Reopen instantly from the installed shell, refreshing HTML in the
  // background. A slow connection must not hold up an already installed app.
  if (event.request.mode === 'navigate') {
    const cachePromise = caches.open(CACHE_NAME);
    const cachedPromise = cachePromise.then(async (cache) =>
      await cache.match(event.request) || await cache.match(APP_SHELL_URL));
    const networkFetch = fetch(event.request, { cache: 'no-store' }).then(async (response) => {
      if (response?.ok) {
        const cache = await cachePromise;
        await Promise.all([
          cache.put(event.request, response.clone()),
          cache.put(APP_SHELL_URL, response.clone())
        ]).catch(() => {});
      }
      return response;
    }).catch(async () => await cachedPromise || Response.error());
    event.waitUntil(networkFetch.then(() => {}));
    event.respondWith(cachedPromise.then((cached) => cached || networkFetch));
    return;
  }

  const cachePromise = caches.open(CACHE_NAME);
  const cachedPromise = cachePromise.then((cache) => cache.match(event.request));
  const networkFetch = fetch(event.request).then(async (response) => {
    if (response.ok && (CACHEABLE_DESTINATIONS.has(event.request.destination) || ASSETS_TO_CACHE.includes(requestUrl.href))) {
      const cache = await cachePromise;
      await cache.put(event.request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(async () => await cachedPromise || Response.error());
  // Keep background cache writes alive even after returning a cached response.
  event.waitUntil(networkFetch.then(() => {}));
  event.respondWith(cachedPromise.then((cached) => cached || networkFetch));
});
