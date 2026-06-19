const CACHE = 'airdraw-v5';

// Cache all app files including local MediaPipe
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/favicon.ico',
  '/lib/mediapipe/hands/hands.js',
  '/lib/mediapipe/hands/hands_solution_simd_wasm_bin.js',
  '/lib/mediapipe/hands/hands_solution_simd_wasm_bin.wasm',
  '/lib/mediapipe/hands/hands_solution_packed_assets_loader.js',
  '/lib/mediapipe/hands/hand_landmark_lite.tflite',
  '/lib/mediapipe/hands/hands.binarypb',
  '/lib/mediapipe/camera_utils/camera_utils.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
