const CACHE = 'mini-live-shell-v66'
const SHELL = ['./', './styles.css', './app.js', './state.mjs', './presence-webgl.mjs', './audio-worklet.js', './manifest.webmanifest', './fonts/source-serif-4.woff2', './fonts/inter.woff2', './fonts/jetbrains-mono.woff2', './icons/icon-192.png', './icons/icon-512.png']

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
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-store' }).then((response) => {
      const copy = response.clone()
      caches.open(CACHE).then((cache) => cache.put('./', copy))
      return response
    }).catch(() => caches.match('./')))
    return
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(request, copy))
    return response
  })))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope))
    if (existing) return existing.focus()
    return clients.openWindow(target)
  }))
})
