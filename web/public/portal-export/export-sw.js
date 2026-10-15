/* global self */
/**
 * Genome portal export service worker (design §5.4, D8). Same protocol as Storage Browser's download-sw.js:
 * the page transfers a ReadableStream with postMessage({ downloadId, filename, size, stream }, [stream, port]);
 * the worker acknowledges on the port, and when a navigation to /portal-export/<downloadId> arrives it answers
 * with the stream as an attachment. `size` becomes Content-Length so the browser shows a known total.
 *
 * Plain JavaScript served as-is from web/public; keep it free of imports.
 */
(function () {
  'use strict';

  var SCOPE = '/portal-export/';
  var pending = new Map();

  self.addEventListener('install', function () {
    self.skipWaiting();
  });
  self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener('message', function (event) {
    // only pages of this origin can hand over a stream
    if (event.origin !== self.location.origin) return;
    var data = event.data || {};
    if (data.type === 'keepalive') {
      // Firefox terminates an idle worker after 30 s; each ping keeps it alive for 15 s (pings come every 10 s)
      event.waitUntil(
        new Promise(function (resolve) {
          setTimeout(resolve, 15000);
        }),
      );
      return;
    }
    if (data.downloadId && data.stream) {
      pending.set(data.downloadId, {
        stream: data.stream,
        filename: typeof data.filename === 'string' && data.filename ? data.filename : 'download.bin',
        size: typeof data.size === 'number' && data.size >= 0 ? data.size : undefined,
      });
      if (event.ports && event.ports[0]) event.ports[0].postMessage({ ready: true });
    }
  });

  self.addEventListener('fetch', function (event) {
    var url = new URL(event.request.url);
    if (url.pathname.indexOf(SCOPE) !== 0) return;
    var rawId = url.pathname.slice(SCOPE.length);
    if (!rawId) return;
    var entry = pending.get(decodeURIComponent(rawId));
    if (!entry) return;
    pending.delete(decodeURIComponent(rawId));
    var headers = {
      'Content-Type': 'application/octet-stream',
      // RFC 5987 extended notation carries arbitrary UTF-8 file names (S3 keys may contain quotes or Hangul)
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(entry.filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (entry.size !== undefined) headers['Content-Length'] = String(entry.size);
    event.respondWith(new Response(entry.stream, { status: 200, headers: headers }));
  });
})();
