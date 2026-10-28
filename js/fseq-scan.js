// ---- fseq scanning core (runs in a Worker or on the page) ----
function fseqHeader(buf) {
  const v = new DataView(buf);
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (magic !== 'PSEQ' && magic !== 'FSEQ') throw new Error('Not an xLights render file');
  const off = v.getUint16(4, true), major = v.getUint8(7);
  const chcount = v.getUint32(10, true), frames = v.getUint32(14, true), step = v.getUint8(18) || 50;
  const h = { off, major, chcount, frames, step, comp: 0, blocks: [], ranges: [] };
  if (major >= 2) {
    const b20 = v.getUint8(20);
    h.comp = b20 & 15;
    const nb = v.getUint8(21) | ((b20 >> 4) << 8), ns = v.getUint8(22);
    let p = 32;
    for (let i = 0; i < nb; i++) { h.blocks.push([v.getUint32(p, true), v.getUint32(p + 4, true)]); p += 8; }
    for (let i = 0; i < ns; i++) {
      const s = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
      const c = v.getUint8(p + 3) | (v.getUint8(p + 4) << 8) | (v.getUint8(p + 5) << 16);
      h.ranges.push([s, c]); p += 6;
    }
  }
  if (!h.ranges.length) h.ranges.push([0, chcount]);
  return h;
}

async function inflate(u8) {
  const ds = new DecompressionStream('deflate');
  const ab = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(ab);
}

// heads: [{tilt: absCh0, dim: absCh0 or -1}]
async function scanFseq(file, heads, onProgress) {
  const first = await file.slice(0, 65536).arrayBuffer();
  let h = fseqHeader(first);
  const hdr = h.off > first.byteLength ? await file.slice(0, h.off).arrayBuffer() : first;
  h = fseqHeader(hdr);
  const mapCh = (ch) => {
    if (ch < 0) return -1;
    let acc = 0;
    for (const [s, c] of h.ranges) { if (ch >= s && ch < s + c) return acc + ch - s; acc += c; }
    return -2;
  };
  const H = heads.map((hd) => ({
    t: mapCh(hd.tilt), d: mapCh(hd.dim),
    // frame-by-frame tilt value and whether the beam was on (dimmer above 0)
    tilt: new Uint8Array(h.frames), on: new Uint8Array(h.frames),
  }));
  const cc = h.chcount;
  let frame = 0;
  const consume = (d, nf) => {
    for (const x of H) {
      if (x.t < 0) continue;
      const t0 = x.t, d0 = x.d;
      for (let f = 0; f < nf; f++) {
        const b = f * cc, t = d[b + t0];
        const fr = frame + f; if (fr >= x.tilt.length) break;
        x.tilt[fr] = t;
        x.on[fr] = d0 < 0 || d[b + d0] > 0 ? 1 : 0;
      }
    }
    frame += nf;
  };
  const total = file.size;
  if (h.comp === 0 || !h.blocks.length) {
    const per = Math.max(1, Math.floor((16 << 20) / cc));
    let pos = h.off;
    while (frame < h.frames && pos < total) {
      const nf = Math.min(per, h.frames - frame);
      const d = new Uint8Array(await file.slice(pos, pos + nf * cc).arrayBuffer());
      const got = Math.floor(d.length / cc); if (!got) break;
      pos += got * cc; consume(d, got);
      onProgress && onProgress(pos / total);
    }
  } else {
    let pos = h.off, reuse = null;
    const blocks = h.blocks.filter((b) => b[1] > 0);
    const CHUNK = 32 << 20;
    let i = 0;
    while (i < blocks.length) {
      let j = i, len = 0;
      while (j < blocks.length && (j === i || len + blocks[j][1] <= CHUNK)) { len += blocks[j][1]; j++; }
      const buf = new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
      let p = 0;
      for (let k = i; k < j; k++) {
        const sz = blocks[k][1];
        const src = buf.subarray(p, p + sz); p += sz;
        const nextFr = k + 1 < blocks.length ? blocks[k + 1][0] : h.frames;
        const hint = Math.max(1, nextFr - blocks[k][0]) * cc;
        let d;
        if (h.comp === 1) {
          if (!reuse || reuse.length < hint) reuse = new Uint8Array(hint);
          d = zstdDecompress(src, hint, reuse);
          if (d.buffer !== reuse.buffer) reuse = new Uint8Array(d.buffer);
        } else d = await inflate(src);
        consume(d, Math.floor(d.length / cc));
      }
      pos += len; i = j;
      onProgress && onProgress(pos / total);
    }
  }
  return {
    frames: frame, step: h.step,
    heads: H.map((x) => ({ missing: x.t < 0, tilt: x.tilt.subarray(0, Math.min(frame, x.tilt.length)), on: x.on.subarray(0, Math.min(frame, x.on.length)) })),
  };
}

if (typeof module !== 'undefined') module.exports = { scanFseq, fseqHeader };
