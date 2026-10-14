const CACHE = 'mini-live-shell-v28'
const SHELL = ['./', './styles.css', './app.js', './state.mjs', './audio-worklet.js', './manifest.webmanifest', './fonts/source-serif-4.woff2', './fonts/inter.woff2', './fonts/jetbrains-mono.woff2', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || request.url.includes('/relay') || request.url.includes('/api/') || request.url.includes('/health') || request.url.includes('/status') || request.url.includes('/lanes')) {
    event.respondWith(fetch(request, { cache: 'no-store' }))
    return
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(request, copy))
    return response
  })))
})
