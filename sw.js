/* Service Worker «Судоку».
 * Стратегия: stale-while-revalidate для своих GET-запросов — мгновенный старт
 * из кеша (важно офлайн), а свежая версия подтягивается в фоне и будет
 * использована при следующем запуске. */

// Меняйте версию при каждом релизе: старые кеши удаляются в activate
const CACHE_VERSION = 'sudoku-v1.3';

// Пути относительные: так приложение работает и в корне домена,
// и в подпапке (например, GitHub Pages /sudoku-pwa/)
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/main.css',
  './css/themes.css',
  './css/game.css',
  './js/app.js',
  './js/sudoku.js',
  './js/ui.js',
  './js/storage.js',
  './js/audio.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // cache.addAll падает целиком, если хоть один файл недоступен.
      // Файлы появляются поэтапно, поэтому кешируем по одному и терпим 404 —
      // иначе на ранних этапах service worker вообще не установится.
      Promise.allSettled(STATIC_ASSETS.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Кешируем только свои GET-запросы; всё остальное браузер обработает сам
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // ignoreSearch: запуск с ?utm=... или ?source=pwa не должен ломать офлайн
    const cached = await cache.match(req, { ignoreSearch: true });

    const network = fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(req, res.clone());
        }
        return res;
      })
      .catch(() => null);

    if (cached) {
      // Обновление идёт в фоне, но воркер не должен умереть до его завершения
      event.waitUntil(network);
      return cached;
    }

    const res = await network;
    if (res) return res;

    // Офлайн и ресурса нет в кеше: для переходов отдаём оболочку приложения
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return Response.error();
  })());
});
