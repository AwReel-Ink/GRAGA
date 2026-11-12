// GraGa! 1.7.0 — Service worker (version web, publiée sous /GRAGA/ sur GitHub Pages)
// Chemins RELATIFS : ils se résolvent par rapport à l'emplacement de sw.js.
// À chaque nouvelle version de l'appli, changer CACHE_NAME.
const CACHE_NAME = 'graga-v1.7.0';

// Fichiers indispensables au fonctionnement hors ligne
const CORE_FILES = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './sync-maison.js'
];

// Fichiers secondaires : leur absence ne doit pas empêcher l'installation
const OPTIONAL_FILES = [
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(CORE_FILES.map((url) => new Request(url, { cache: 'reload' })));
        await Promise.allSettled(OPTIONAL_FILES.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

// Cache d'abord, puis réseau — uniquement pour les fichiers de l'appli (même origine, GET).
// Les requêtes vers le serveur maison (PocketBase) ne passent PAS par le cache.
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    if (new URL(request.url).origin !== self.location.origin) return;

    event.respondWith((async () => {
        const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
        if (cached) return cached;
        try {
            const response = await fetch(request);
            if (response && response.status === 200 && response.type === 'basic') {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
        } catch (err) {
            if (request.mode === 'navigate') {
                const page = await caches.match('./index.html');
                if (page) return page;
            }
            throw err;
        }
    })());
});
