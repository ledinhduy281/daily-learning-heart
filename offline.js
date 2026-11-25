const CACHE = "daily-learning-heart-shell-v3";
const root = self.registration.scope;
const shell = new Map([
  "", "index.html", "data/briefings.js", "data/quiz_sets.js", "device_profile.js", "sync_config.js", "cloud_sync.js", "search_ranking.js",
  "clinical_distractors.js", "case_quiz.js", "clinical_mcq.js", "evidence_feed.js", "manifest.json", "icon.svg",
].map(path => {
  const url = new URL(path, root);
  return [url.pathname, url.href];
}));
const home = new URL("index.html", root).href;
shell.set(new URL(root).pathname, home);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...new Set(shell.values())])));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key =>
      key.startsWith("daily-learning-heart-shell-") && key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  const key = shell.get(url.pathname);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !key) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(key, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      const stored = await cache.match(key);
      if (stored) return stored;
      throw error;
    }
  })());
});
