/* Snakes & Ladders MP service worker — deliberate updates and safe fallbacks. */
const CACHE_NAME = 'snl-mp-v41';
const STATIC_ASSETS = [
  '/', '/index.html', '/manifest.json',
  '/images/board.png', '/images/board1.png', '/images/board2.png',
  '/images/die-1.png', '/images/die-2.png', '/images/die-3.png',
  '/images/die-4.png', '/images/die-5.png', '/images/die-6.png',
  '/images/red.png', '/images/brown.png', '/images/yellow.png',
  '/images/green.png', '/images/blue.png', '/images/purple.png',
  '/images/wood.png', '/images/frame-wood.png',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/sounds/dice-roll.mp3', '/sounds/move.mp3', '/sounds/snake.mp3',
  '/sounds/ladder.mp3', '/sounds/win.mp3', '/sounds/music.mp3',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    Promise.allSettled(STATIC_ASSETS.map((asset) => cache.add(asset)))
  ));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

async function cacheSuccessful(request, response) {
  if (response && response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, navigation) {
  try {
    return await cacheSuccessful(request, await fetch(request));
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (navigation) return caches.match('/index.html');
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  const navigation = event.request.mode === 'navigate';
  // Never intercept/cache API calls (e.g. the LiveKit token endpoint).
  if (url.pathname.startsWith('/api/')) return;

  const dynamicAsset = navigation || url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') || url.pathname.startsWith('/assets/');
  if (dynamicAsset) {
    event.respondWith(networkFirst(event.request, navigation));
    return;
  }

  event.respondWith(caches.match(event.request).then(async (cached) => {
    if (cached) return cached;
    try { return await cacheSuccessful(event.request, await fetch(event.request)); }
    catch (_) { return Response.error(); }
  }));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});