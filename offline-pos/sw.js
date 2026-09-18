/**
 * ZAT POS Service Worker
 * Caches the entire offline-pos app shell so it works with zero network.
 * API calls (/api/) are always network-only.
 */

const CACHE_NAME = 'zat-pos-v1';

const PRECACHE_URLS = [
    '/offline-pos/',
    '/offline-pos/index.html',
    '/offline-pos/js/app.js',
    '/offline-pos/js/db.js',
    '/offline-pos/js/receipt.js',
    '/offline-pos/js/zatca.js',
    '/offline-pos/vendor/vue.global.js',
    '/offline-pos/vendor/dexie.js',
    '/offline-pos/vendor/tailwind.js',
    '/offline-pos/vendor/qrcode.min.js',
    '/offline-pos/vendor/fa/css/all.min.css',
    '/img/icon-192.png',
    '/img/icon-512.png',
    '/img/favicon.png',
];

// ─── Install: cache app shell ────────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
            .catch(() => self.skipWaiting())
    );
});

// ─── Activate: remove old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method !== 'GET') return;
    if (!url.protocol.startsWith('http')) return;

    // Always hit network for API / sync calls
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sync/')) return;

    // FontAwesome webfonts — cache-first
    if (url.pathname.includes('/vendor/fa/')) {
        event.respondWith(cacheFirst(request));
        return;
    }

    // All offline-pos assets — cache-first
    if (url.pathname.startsWith('/offline-pos/')) {
        event.respondWith(cacheFirst(request));
        return;
    }

    // Shared icons / images — cache-first
    if (url.pathname.startsWith('/img/')) {
        event.respondWith(cacheFirst(request));
        return;
    }
});

// ─── Cache-first strategy ────────────────────────────────────────────────────
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        // Return a minimal offline shell if the main page is requested
        if (request.mode === 'navigate') {
            const shell = await caches.match('/offline-pos/index.html');
            if (shell) return shell;
        }
        return new Response('', { status: 503, statusText: 'Offline' });
    }
}
