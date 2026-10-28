// Runs the render-file scan off the page so the browser stays responsive.
importScripts('zstd.js', 'fseq-scan.js');
self.onmessage = async (e) => {
  const { id, file, heads } = e.data;
  try {
    let last = 0;
    const r = await scanFseq(file, heads, (p) => { const now = Date.now(); if (now - last > 300) { last = now; self.postMessage({ id, progress: p }); } });
    const transfer = r.heads.filter((h) => !h.missing).flatMap((h) => [h.tilt.buffer, h.on.buffer]);
    self.postMessage({ id, result: r }, [...new Set(transfer)]);
  } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
};
