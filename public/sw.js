// Service worker: la app abre al instante y sin conexión; recibe las alertas push.
const VERSION = '__VERSION__';
const CACHE = `tiempo-${VERSION}`;
const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/clock.js',
  '/economy.js',
  '/scan.js',
  '/vendor/qrcode.mjs',
  '/fonts/inter-latin-200-normal.woff2',
  '/fonts/inter-latin-300-normal.woff2',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/badge-96.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return; // siempre red
  if (url.pathname.startsWith('/admin')) return; // el panel de admin nunca se cachea

  if (req.mode === 'navigate') {
    // HTML y JS siempre de la MISMA versión: el shell sale de esta caché. Cuando hay deploy,
    // el SW nuevo se instala, toma el control y la app recarga sola ya con todo nuevo.
    e.respondWith(
      caches
        .open(CACHE)
        .then((c) => c.match('/'))
        .then((hit) => hit || fetch(req)),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data?.json() ?? {};
  } catch {}
  const remind = data.kind === 'remind'; // recordatorio de "Mi día": no reemplaza un aviso del reloj
  e.waitUntil(
    self.registration.showNotification(data.title || 'Tiempo', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: remind ? 'recordatorio' : 'tiempo',
      renotify: true,
      vibrate: data.band === 0 ? [300, 120, 300] : [120],
      data: { url: remind ? '/#dia' : '/' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => 'focus' in c);
      if (!open) return self.clients.openWindow(url);
      if (url.endsWith('#dia')) open.postMessage({ open: 'day' }); // la app ya abierta salta a "Mi día"
      return open.focus();
    }),
  );
});
