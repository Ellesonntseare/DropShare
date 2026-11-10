// Receives "Share to DropShare" from Android, parks the shared items in the cache,
// then opens the page, which uploads them with a progress bar.
const CACHE = 'dropshare-share';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'POST' || u.pathname !== '/share') return;

  e.respondWith((async () => {
    try {
      const fd = await e.request.formData();
      const cache = await caches.open(CACHE);
      for (const k of await cache.keys()) await cache.delete(k);

      let n = 0;
      for (const f of fd.getAll('files')) {
        if (!(f instanceof File)) continue;
        await cache.put('/shared/' + n++, new Response(f, {
          headers: { 'X-Name': encodeURIComponent(f.name || 'shared'), 'Content-Type': f.type || 'application/octet-stream' },
        }));
      }

      const str = k => { const v = fd.get(k); return typeof v === 'string' ? v.trim() : ''; };
      const text = str('text'), url = str('url'), title = str('title');
      const parts = [text];
      if (url && !text.includes(url)) parts.push(url);
      let joined = parts.filter(Boolean).join('\n');
      if (!joined && title) joined = title;
      if (joined) {
        await cache.put('/shared/text', new Response(JSON.stringify({ text: joined }), { headers: { 'Content-Type': 'application/json' } }));
      }
    } catch {}
    return Response.redirect('/?shared=1', 303);
  })());
});
