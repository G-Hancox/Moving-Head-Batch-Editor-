// Minimal pure-JS Zstandard decoder (RFC 8878), no dictionaries.
// zstdDecompress(src: Uint8Array, outSizeHint?: number) -> Uint8Array
(function (root) {
'use strict';

function highbit(n) { return 31 - Math.clz32(n); }

// ---------- backward bit reader ----------
function BackReader(src, start, end) {
  // stream is src[start..end)
  this.src = src; this.start = start;
  const last = src[end - 1];
  if (last === 0) throw new Error('zstd: bad bitstream padding');
  this.off = (end - start) * 8 - (8 - highbit(last)); // bits remaining
}
BackReader.prototype.read = function (n) {
  if (n === 0) return 0;
  this.off -= n;
  let off = this.off, v = 0;
  // read n bits at bit position off (LSB-first within little-endian bytes)
  // n <= 32 assumed; process up to 4 bytes
  let got = 0;
  while (got < n) {
    const p = off + got;
    let bit, byteVal;
    if (p < 0) { const take = Math.min(n - got, -p); got += take; continue; } // zeros
    const bi = p >> 3; bit = p & 7;
    byteVal = this.src[this.start + bi];
    const take = Math.min(8 - bit, n - got);
    v += ((byteVal >> bit) & ((1 << take) - 1)) * Math.pow(2, got);
    got += take;
  }
  return v;
};

// ---------- FSE ----------
function readFSETable(src, pos, maxSym, maxAL) {
  // returns {table, pos}
  let bitPos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = bitPos + i;
      v |= ((src[pos + (p >> 3)] >> (p & 7)) & 1) << i;
    }
    bitPos += n; return v;
  };
  const AL = readBits(4) + 5;
  if (AL > maxAL) throw new Error('zstd: FSE accuracy too large');
  let remaining = (1 << AL) + 1, threshold = 1 << AL, nbBits = AL + 1;
  const norm = [];
  let sym = 0;
  while (remaining > 1 && sym <= maxSym) {
    const max = (2 * threshold - 1) - remaining;
    let count;
    const low = readBits(nbBits - 1);
    if (low < max) { count = low; }
    else {
      const hi = readBits(1);
      count = low + (hi << (nbBits - 1));
      if (count >= threshold) count -= max;
    }
    count--;
    remaining -= count < 0 ? -count : count;
    norm[sym++] = count;
    if (count === 0) {
      for (;;) {
        const rep = readBits(2);
        for (let i = 0; i < rep; i++) norm[sym++] = 0;
        if (rep !== 3) break;
      }
    }
    while (remaining < threshold) { nbBits--; threshold >>= 1; }
  }
  if (remaining !== 1) throw new Error('zstd: bad FSE table');
  return { table: buildFSE(norm, AL), pos: pos + ((bitPos + 7) >> 3) };
}

function buildFSE(norm, AL) {
  const size = 1 << AL;
  const sym = new Uint8Array(size), nb = new Uint8Array(size), base = new Uint16Array(size);
  let high = size - 1;
  const next = new Uint16Array(norm.length);
  for (let s = 0; s < norm.length; s++) {
    if (norm[s] === -1) { sym[high--] = s; next[s] = 1; }
    else next[s] = norm[s];
  }
  const step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
  let p = 0;
  for (let s = 0; s < norm.length; s++) {
    for (let i = 0; i < norm[s]; i++) {
      sym[p] = s;
      do { p = (p + step) & mask; } while (p > high);
    }
  }
  for (let u = 0; u < size; u++) {
    const s = sym[u];
    const ns = next[s]++;
    const b = AL - highbit(ns);
    nb[u] = b; base[u] = (ns << b) - size;
  }
  return { AL, sym, nb, base };
}

function rleFSE(s) { return { AL: 0, sym: new Uint8Array([s]), nb: new Uint8Array([0]), base: new Uint16Array([0]) }; }

const LL_DEF = [4,3,2,2,2,2,2,2,2,2,2,2,2,1,1,1,2,2,2,2,2,2,2,2,2,3,2,1,1,1,1,1,-1,-1,-1,-1];
const ML_DEF = [1,4,3,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,-1,-1,-1,-1,-1,-1,-1];
const OF_DEF = [1,1,1,1,1,1,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,-1,-1,-1,-1,-1];
const LL_T = buildFSE(LL_DEF, 6), ML_T = buildFSE(ML_DEF, 6), OF_T = buildFSE(OF_DEF, 5);

const LL_BASE = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,20,22,24,28,32,40,48,64,128,256,512,1024,2048,4096,8192,16384,32768,65536];
const LL_BITS = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,2,2,3,3,4,6,7,8,9,10,11,12,13,14,15,16];
const ML_BASE = [];
const ML_BITS = [];
for (let i = 0; i < 32; i++) { ML_BASE.push(i + 3); ML_BITS.push(0); }
[[35,1],[37,1],[39,1],[41,1],[43,2],[47,2],[51,3],[59,3],[67,4],[83,4],[99,5],[131,7],[259,8],[515,9],[1027,10],[2051,11],[4099,12],[8195,13],[16387,14],[32771,15],[65539,16]]
  .forEach(([b, n]) => { ML_BASE.push(b); ML_BITS.push(n); });

// ---------- Huffman ----------
function buildHuf(weights) {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) if (weights[i]) sum += 1 << (weights[i] - 1);
  const maxBits = highbit(sum) + 1;
  const left = (1 << maxBits) - sum;
  if (left & (left - 1)) throw new Error('zstd: bad huffman weights');
  const lastW = highbit(left) + 1;
  const n = weights.length + 1;
  const bits = new Uint8Array(n);
  for (let i = 0; i < weights.length; i++) bits[i] = weights[i] ? maxBits + 1 - weights[i] : 0;
  bits[weights.length] = maxBits + 1 - lastW;
  const size = 1 << maxBits;
  const syms = new Uint8Array(size), nbits = new Uint8Array(size);
  const rankCount = new Uint32Array(maxBits + 2), rankIdx = new Uint32Array(maxBits + 2);
  for (let i = 0; i < n; i++) rankCount[bits[i]]++;
  rankIdx[maxBits] = 0;
  for (let i = maxBits; i >= 1; i--) {
    rankIdx[i - 1] = rankIdx[i] + rankCount[i] * (1 << (maxBits - i));
    nbits.fill(i, rankIdx[i], rankIdx[i - 1]);
  }
  for (let i = 0; i < n; i++) {
    if (bits[i]) {
      const len = 1 << (maxBits - bits[i]);
      syms.fill(i, rankIdx[bits[i]], rankIdx[bits[i]] + len);
      rankIdx[bits[i]] += len;
    }
  }
  return { maxBits, syms, nbits };
}

function readHufTable(src, pos) {
  const hb = src[pos++];
  let weights;
  if (hb >= 128) {
    const num = hb - 127;
    weights = new Uint8Array(num);
    for (let i = 0; i < num; i++) {
      const b = src[pos + (i >> 1)];
      weights[i] = (i & 1) ? (b & 15) : (b >> 4);
    }
    pos += (num + 1) >> 1;
  } else {
    const end = pos + hb;
    const { table, pos: p2 } = readFSETable(src, pos, 255, 6);
    const br = new BackReader(src, p2, end);
    let s1 = br.read(table.AL), s2 = br.read(table.AL);
    const out = [];
    for (;;) {
      out.push(table.sym[s1]);
      s1 = table.base[s1] + br.read(table.nb[s1]);
      if (br.off < 0) { out.push(table.sym[s2]); break; }
      out.push(table.sym[s2]);
      s2 = table.base[s2] + br.read(table.nb[s2]);
      if (br.off < 0) { out.push(table.sym[s1]); break; }
      if (out.length > 255) throw new Error('zstd: too many huffman weights');
    }
    weights = Uint8Array.from(out);
    pos = end;
  }
  return { huf: buildHuf(weights), pos };
}

function hufDecodeStream(huf, src, start, end, out, oStart, count) {
  const br = new BackReader(src, start, end);
  const mask = (1 << huf.maxBits) - 1;
  let state = br.read(huf.maxBits);
  const syms = huf.syms, nbits = huf.nbits;
  for (let i = 0; i < count; i++) {
    out[oStart + i] = syms[state];
    const nb = nbits[state];
    state = ((state << nb) + br.read(nb)) & mask;
  }
}

// ---------- block decoding ----------
function decompress(src, sizeHint, reuse) {
  let out = (reuse && reuse.length >= (sizeHint || 0) && sizeHint) ? reuse : new Uint8Array(sizeHint || Math.max(1024, src.length * 8));
  let op = 0;
  const ensure = (n, at) => {
    const need = (at === undefined ? op : at) + n;
    if (need <= out.length) return;
    let ns = out.length * 2; while (ns < need) ns *= 2;
    const o2 = new Uint8Array(ns); o2.set(out.subarray(0, at === undefined ? op : at)); out = o2;
  };
  let ip = 0;
  while (ip < src.length) {
    const magic = (src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24)) >>> 0;
    ip += 4;
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) {
      const sz = (src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24)) >>> 0;
      ip += 4 + sz; continue;
    }
    if (magic !== 0xFD2FB528) throw new Error('zstd: bad magic');
    const fhd = src[ip++];
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if (!single) ip++;
    ip += [0, 1, 2, 4][dictFlag];
    const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
    if (fcsBytes) {
      let fcs = 0;
      for (let i = 0; i < Math.min(fcsBytes, 6); i++) fcs += src[ip + i] * Math.pow(2, 8 * i);
      if (fcsBytes === 2) fcs += 256;
      ensure(fcs);
      ip += fcsBytes;
    }
    const st = { huf: null, ll: null, ml: null, of: null, rep: [1, 4, 8] };
    for (;;) {
      const bh = src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16); ip += 3;
      const last = bh & 1, type = (bh >> 1) & 3, size = bh >>> 3;
      if (type === 0) { ensure(size); out.set(src.subarray(ip, ip + size), op); op += size; ip += size; }
      else if (type === 1) { ensure(size); out.fill(src[ip], op, op + size); op += size; ip += 1; }
      else if (type === 2) {
        const r = decodeBlock(src, ip, ip + size, st, () => out, ensure, op);
        out = r.out; op = r.op; ip += size;
      } else throw new Error('zstd: reserved block');
      if (last) break;
    }
    if (checksum) ip += 4;
  }
  return out.subarray(0, op);
}

function decodeBlock(src, ip, end, st, getOut, ensure, op) {
  // ---- literals ----
  const b0 = src[ip];
  const ltype = b0 & 3, sf = (b0 >> 2) & 3;
  let lits, litLen;
  if (ltype === 0 || ltype === 1) {
    let hs;
    if (sf === 0 || sf === 2) { litLen = b0 >> 3; hs = 1; }
    else if (sf === 1) { litLen = (b0 >> 4) + (src[ip + 1] << 4); hs = 2; }
    else { litLen = (b0 >> 4) + (src[ip + 1] << 4) + (src[ip + 2] << 12); hs = 3; }
    ip += hs;
    if (ltype === 0) { lits = src.subarray(ip, ip + litLen); ip += litLen; }
    else { lits = new Uint8Array(litLen).fill(src[ip]); ip += 1; }
  } else {
    let regen, comp, hs, streams = sf === 0 ? 1 : 4;
    if (sf <= 1) {
      const v = b0 | (src[ip + 1] << 8) | (src[ip + 2] << 16);
      regen = (v >> 4) & 0x3FF; comp = (v >> 14) & 0x3FF; hs = 3;
    } else if (sf === 2) {
      const v = (b0 | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24)) >>> 0;
      regen = (v >>> 4) & 0x3FFF; comp = (v >>> 18) & 0x3FFF; hs = 4;
    } else {
      const v = (b0 | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24)) >>> 0;
      regen = (v >>> 4) & 0x3FFFF; comp = ((v >>> 22) | (src[ip + 4] << 10)) & 0x3FFFF; hs = 5;
    }
    ip += hs;
    const cEnd = ip + comp;
    let p = ip;
    if (ltype === 2) { const r = readHufTable(src, p); st.huf = r.huf; p = r.pos; }
    if (!st.huf) throw new Error('zstd: missing huffman table');
    lits = new Uint8Array(regen); litLen = regen;
    if (streams === 1) hufDecodeStream(st.huf, src, p, cEnd, lits, 0, regen);
    else {
      const s1 = src[p] | (src[p + 1] << 8), s2 = src[p + 2] | (src[p + 3] << 8), s3 = src[p + 4] | (src[p + 5] << 8);
      p += 6;
      const seg = (regen + 3) >> 2;
      const a = p, b = a + s1, c = b + s2, d = c + s3;
      hufDecodeStream(st.huf, src, a, b, lits, 0, seg);
      hufDecodeStream(st.huf, src, b, c, lits, seg, seg);
      hufDecodeStream(st.huf, src, c, d, lits, 2 * seg, seg);
      hufDecodeStream(st.huf, src, d, cEnd, lits, 3 * seg, regen - 3 * seg);
    }
    ip = cEnd;
  }
  // ---- sequences ----
  let nSeq = src[ip++];
  if (nSeq >= 128) {
    if (nSeq < 255) nSeq = ((nSeq - 128) << 8) + src[ip++];
    else { nSeq = src[ip] + (src[ip + 1] << 8) + 0x7F00; ip += 2; }
  }
  let lp = 0;
  if (nSeq === 0) {
    ensure(litLen, op); const out = getOut(); out.set(lits, op); op += litLen;
    return { out, op };
  }
  const modes = src[ip++];
  const pick = (mode, def, maxSym, maxAL, prev) => {
    if (mode === 0) return def;
    if (mode === 1) return rleFSE(src[ip++]);
    if (mode === 2) { const r = readFSETable(src, ip, maxSym, maxAL); ip = r.pos; return r.table; }
    if (!prev) throw new Error('zstd: repeat without table');
    return prev;
  };
  st.ll = pick(modes >> 6, LL_T, 35, 9, st.ll);
  st.of = pick((modes >> 4) & 3, OF_T, 31, 8, st.of);
  st.ml = pick((modes >> 2) & 3, ML_T, 52, 9, st.ml);
  const LL = st.ll, OF = st.of, ML = st.ml, rep = st.rep;
  const br = new BackReader(src, ip, end);
  let sLL = br.read(LL.AL), sOF = br.read(OF.AL), sML = br.read(ML.AL);
  for (let i = 0; i < nSeq; i++) {
    const ofCode = OF.sym[sOF], llCode = LL.sym[sLL], mlCode = ML.sym[sML];
    let ofv = Math.pow(2, ofCode) + br.read(ofCode);
    const ml = ML_BASE[mlCode] + br.read(ML_BITS[mlCode]);
    const ll = LL_BASE[llCode] + br.read(LL_BITS[llCode]);
    if (i !== nSeq - 1) {
      sLL = LL.base[sLL] + br.read(LL.nb[sLL]);
      sML = ML.base[sML] + br.read(ML.nb[sML]);
      sOF = OF.base[sOF] + br.read(OF.nb[sOF]);
    }
    let offset;
    if (ofv > 3) { offset = ofv - 3; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset; }
    else {
      if (ll === 0) ofv++;
      if (ofv === 1) offset = rep[0];
      else if (ofv === 2) { offset = rep[1]; rep[1] = rep[0]; rep[0] = offset; }
      else if (ofv === 3) { offset = rep[2]; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset; }
      else { offset = rep[0] - 1; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset; }
    }
    ensure(ll + ml, op);
    const out = getOut();
    if (ll) { out.set(lits.subarray(lp, lp + ll), op); op += ll; lp += ll; }
    let from = op - offset;
    if (from < 0) throw new Error('zstd: offset beyond output');
    if (offset >= ml) { out.copyWithin(op, from, from + ml); op += ml; }
    else if (offset === 1) { out.fill(out[from], op, op + ml); op += ml; }
    else {
      let rem = ml;
      while (rem > 0) {
        const n = Math.min(rem, op - from);
        out.copyWithin(op, from, from + n); op += n; rem -= n;
      }
    }
  }
  const restL = litLen - lp;
  ensure(restL, op); const out = getOut();
  out.set(lits.subarray(lp, litLen), op); op += restL;
  return { out, op };
}

root.zstdDecompress = decompress;
if (typeof module !== 'undefined') module.exports = decompress;
})(typeof self !== 'undefined' ? self : this);
