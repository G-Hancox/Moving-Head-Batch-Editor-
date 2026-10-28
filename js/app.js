// Moving Head Batch Editor: page logic.
// Scan: reads rendered .fseq files (read-only) and measures each head's tilt.
// Fix:  adds or raises the Additive lift on the tilt line model (MH Tilt) in
//       .xsq files, only after an explicit confirmation, backing up every file first.
'use strict';

// Your 8 heads, used until a layout file is read. liftIndex = DMX slot on MH Tilt.
const DEFAULT_HEADS = [
  ['YPS Starlight - ADV 1', 82448, 82454, 2, 8], ['YPS-MovingHead-1', 82746, 82736, 12, 2],
  ['YPS Starlight - ADV 2', 82592, 82598, 2, 8], ['YPS-MovingHead-2', 82730, 82720, 12, 2],
  ['YPS-MovingHead-3', 82714, 82704, 12, 2], ['YPS Starlight - ADV 3', 82640, 82646, 2, 8],
  ['YPS-MovingHead-4', 82698, 82688, 12, 2], ['YPS Starlight - ADV 4', 82672, 82678, 2, 8],
].map(([name, tilt, dim, tiltCh, dimCh], i) => ({ name, tilt, dim, tiltCh, dimCh, on: true, own: null, liftIndex: i }));
const TILT_ROW = 'MH Tilt';
const BACKUP_DIR = 'Tilt Lift Backups';
const SKIP_DIRS = /^(Backup|RenderCache|Tilt Lift Backups|\..*)$/i;

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('mhbe:' + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('mhbe:' + k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
};
const fsa = typeof window.showDirectoryPicker === 'function';

let heads = DEFAULT_HEADS;
let headsKey = 'saved setup';
let tiltModel = { name: TILT_ROW, count: 8 };
let groups = { 'MH - ALL': [2, 12] };
let rootHandle = null;   // folder handle (Chrome/Edge), needed for editing
let rootName = 'Show DIR';
let entries = [];        // {rel, dir, name, file, handle}
let folderSel = {};
let results = [];
let scanning = false, stopReq = false;
let fixRows = [], cantRows = [];
let lastEdit = null;     // {stamp, items:[{row, backupHandle}]}

// ---------- settings ----------
function settings() {
  const minT = clamp(parseInt($('minT').value, 10), 0, 255, 0);
  const mx = parseInt($('maxT').value, 10);
  return { minT, maxT: Number.isFinite(mx) ? clamp(mx, 0, 255, 255) : null, litOnly: $('litOnly').checked,
    ignoreMs: clamp(parseInt($('ignoreMs').value, 10), 0, 5000, 0) };
}
function clamp(v, a, b, d) { return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; }
function saveSettings() {
  store.set('settings', {
    minT: $('minT').value, maxT: $('maxT').value, litOnly: $('litOnly').checked, ignoreMs: $('ignoreMs').value,
    sameLift: $('sameLift').checked, margin: $('margin').value, addAll: $('addAll').checked,
    heads: Object.fromEntries(heads.map((h) => [h.name, { on: h.on, own: h.own }])),
  });
}
function loadSettings() {
  const s = store.get('settings'); if (!s) return;
  if (s.minT !== undefined) $('minT').value = s.minT;
  if (s.maxT !== undefined) $('maxT').value = s.maxT;
  if (s.litOnly !== undefined) $('litOnly').checked = s.litOnly;
  if (s.ignoreMs !== undefined) $('ignoreMs').value = s.ignoreMs;
  if (s.sameLift !== undefined) $('sameLift').checked = s.sameLift;
  if (s.margin !== undefined) $('margin').value = s.margin;
  if (s.addAll !== undefined) $('addAll').checked = s.addAll;
  applySavedHeads(s.heads);
}
function applySavedHeads(saved) {
  if (!saved) return;
  for (const h of heads) if (saved[h.name]) { h.on = saved[h.name].on !== false; h.own = saved[h.name].own ?? null; }
}
function headLimit(h, s) { return h.own ?? s.minT; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- heads table ----------
function renderHeads() {
  const tb = $('headRows'); tb.innerHTML = '';
  heads.forEach((h, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" id="hon${i}" ${h.on ? 'checked' : ''} aria-label="Check ${esc(h.name)}"></td>
      <td>${esc(h.name)}</td><td class="num">${h.tiltCh ?? '?'}</td><td class="num">${h.dimCh || '—'}</td>
      <td class="num">${h.liftIndex >= 0 ? 'DMX' + (h.liftIndex + 1) : '<span class="pill warn">not on it</span>'}</td>
      <td class="num"><input type="number" id="hown${i}" min="0" max="255" placeholder="—" value="${h.own ?? ''}" aria-label="Own lowest tilt for ${esc(h.name)}"></td>`;
    tb.appendChild(tr);
    tr.querySelector('#hon' + i).addEventListener('change', (e) => { h.on = e.target.checked; changed(); });
    tr.querySelector('#hown' + i).addEventListener('input', (e) => { const v = parseInt(e.target.value, 10); h.own = Number.isFinite(v) ? clamp(v, 0, 255, 0) : null; changed(); });
  });
  $('headNote').textContent = `${heads.length} moving heads from your ${headsKey}. "Own lowest" overrides the limit for one head. "MH Tilt ch" is the DMX slot in the lift effect that moves that head.`;
}

// ---------- gauge ----------
function renderGauge() {
  const s = settings();
  const lo = (s.minT / 255) * 100, hi = s.maxT === null ? 100 : (s.maxT / 255) * 100;
  const g = $('gauge'); g.style.setProperty('--lo', lo + '%'); g.style.setProperty('--hi', hi + '%');
  $('tickLo').style.left = `calc(${lo}% - 1px)`;
  $('labLo').style.left = lo + '%'; $('labLo').textContent = `too low below ${s.minT}`;
  $('tickHi').hidden = s.maxT === null; if (s.maxT !== null) $('tickHi').style.left = `calc(${hi}% - 1px)`;
}

// ---------- results math ----------
// Where the head can actually be: a moving head can't follow a split-second
// change, so on each frame it is taken to be no lower than the highest tilt it
// was sent over the last `k` frames. k = 1 uses every frame as-is.
const settledCache = new WeakMap();
function settledTilt(hr, k) {
  let byK = settledCache.get(hr);
  if (!byK) { byK = {}; settledCache.set(hr, byK); }
  if (byK[k]) return byK[k];
  const t = hr.tilt, n = t.length, out = new Uint8Array(n);
  if (k <= 1) out.set(t);
  else {
    const dq = new Int32Array(n); let head = 0, tail = 0; // indices, tilt values decreasing
    for (let i = 0; i < n; i++) {
      while (tail > head && t[dq[tail - 1]] <= t[i]) tail--;
      dq[tail++] = i;
      if (dq[head] <= i - k) head++;
      out[i] = t[dq[head]];
    }
  }
  return (byK[k] = out);
}
function headStats(hr, h, s, step) {
  if (hr.missing) return { missing: true };
  const k = Math.max(1, Math.ceil(s.ignoreMs / (step || 50)));
  const st = settledTilt(hr, k), raw = hr.tilt, on = hr.on, n = raw.length;
  const lim = headLimit(h, s);
  let low = -1, high = -1, cnt = 0, below = 0, dip = -1, over = 0;
  for (let i = 0; i < n; i++) {
    if (s.litOnly && !on[i]) continue;
    cnt++;
    const v = st[i];
    if (low < 0 || v < low) low = v;
    if (raw[i] > high) high = raw[i];
    if (v < lim) { below++; if (dip < 0) dip = i; }
    if (s.maxT !== null && raw[i] > s.maxT) over++;
  }
  if (!cnt) return { never: true };
  return { low, high, n: cnt, below, dip, add: Math.max(0, lim - low), over };
}
function seqStats(r, s) {
  const per = [];
  let add = 0, worst = null, dip = -1, high = -1, over = 0, any = false, lowest = 999;
  r.heads.forEach((hr, i) => {
    const h = heads[i]; if (!h || !h.on) return;
    const st = headStats(hr, h, s, r.step); per.push({ h, st });
    if (st.missing || st.never) return;
    any = true;
    if (st.low < lowest) lowest = st.low;
    if (st.add > add) { add = st.add; worst = h.name; }
    if (st.dip >= 0 && (dip < 0 || st.dip < dip)) dip = st.dip;
    high = Math.max(high, st.high); over += st.over;
  });
  let status;
  if (r.error) status = ['bad', 'Could not read'];
  else if (!r.heads.length || r.heads.every((x) => x.missing)) status = ['dim', 'Heads not in file'];
  else if (!any) status = ['dim', s.litOnly ? 'Heads never on' : 'No tilt data'];
  else if (add > 0) status = ['bad', 'Too low'];
  else if (over > 0) status = ['warn', 'Too high'];
  else status = ['ok', 'OK'];
  return { per, add, worst, dip, high, over, any, lowest: any ? lowest : null, status, topAfter: any ? high + add : null };
}
function fmtTime(frame, step) {
  if (frame < 0 || !step) return '—';
  const t = frame * step / 1000, m = Math.floor(t / 60), sec = (t % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

// ---------- results table ----------
const openRows = new Set();
function renderResults() {
  const s = settings();
  const tb = $('resRows'); tb.innerHTML = '';
  const rows = results.map((r) => ({ r, st: seqStats(r, s) }));
  const rank = { bad: 0, warn: 1, dim: 2, ok: 3 };
  rows.sort((a, b) => (rank[a.st.status[0]] - rank[b.st.status[0]]) || (b.st.add - a.st.add) || a.r.name.localeCompare(b.r.name));
  const onlyBad = $('onlyBad').checked;
  let nBad = 0, nStale = 0, maxAdd = 0, nDone = 0, nClip = 0;
  for (const { r, st } of rows) {
    if (r.pending) continue;
    nDone++;
    if (st.status[0] === 'bad' && !r.error) nBad++;
    if (r.stale) nStale++;
    maxAdd = Math.max(maxAdd, st.add);
    if (st.topAfter !== null && st.add > 0 && st.topAfter > 255) nClip++;
  }
  for (const { r, st } of rows) {
    if (onlyBad && (st.status[0] === 'ok' || r.pending)) continue;
    const key = r.rel;
    const tr = document.createElement('tr'); tr.className = 'seq'; tr.tabIndex = 0;
    const pills = [];
    if (r.pending) pills.push(`<span class="pill dim">${r.progress ? Math.round(r.progress * 100) + '%' : 'Waiting'}</span>`);
    else pills.push(`<span class="pill ${st.status[0]}">${st.status[1]}</span>`);
    if (r.edited) pills.push('<span class="pill ex">Edited, needs render</span>');
    else if (r.stale) pills.push('<span class="pill warn" title="The .xsq was saved after the .fseq was rendered">Render is older</span>');
    const clip = st.topAfter !== null && st.add > 0 && st.topAfter > 255;
    tr.innerHTML = `<td class="name"><div>${esc(r.name)}</div><div class="muted small">${esc(r.folder)}</div></td>
      <td>${pills.join(' ')}</td>
      <td class="num">${r.pending ? '' : st.lowest ?? '—'}${st.worst && st.add ? `<div class="muted small">${esc(st.worst)}</div>` : ''}</td>
      <td class="num">${st.add ? `<span class="add">+${st.add}</span>` : (r.pending ? '' : '0')}</td>
      <td class="num">${st.add ? fmtTime(st.dip, r.step) : '—'}</td>
      <td class="num">${st.topAfter === null || r.pending ? '' : (clip ? `<span class="pill warn">${st.topAfter} clips at 255</span>` : st.topAfter)}</td>`;
    const toggle = () => { openRows.has(key) ? openRows.delete(key) : openRows.add(key); renderResults(); };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    tb.appendChild(tr);
    if (openRows.has(key) && !r.pending) {
      const d = document.createElement('tr'); d.className = 'detail';
      const inner = r.error ? `<p class="msg err">${esc(r.error)}</p>` : `<div class="tablebox"><table><thead><tr><th>Head</th><th class="num">Limit</th><th class="num">Lowest</th><th class="num">Highest</th><th class="num">Add</th><th class="num">Time too low</th><th class="num">First dip</th></tr></thead><tbody>${
        st.per.map(({ h, st: x }) => x.missing ? `<tr><td>${esc(h.name)}</td><td colspan="6" class="muted">Not in this render file</td></tr>`
          : x.never ? `<tr><td>${esc(h.name)}</td><td colspan="6" class="muted">Never on in this sequence</td></tr>`
          : `<tr><td>${esc(h.name)}</td><td class="num">${headLimit(h, s)}</td><td class="num">${x.low}</td><td class="num">${x.high}</td><td class="num">${x.add ? `<span class="add">+${x.add}</span>` : 0}</td><td class="num">${(x.below * r.step / 1000).toFixed(1)}s</td><td class="num">${fmtTime(x.dip, r.step)}</td></tr>`).join('')
      }</tbody></table></div>`;
      d.innerHTML = `<td colspan="6">${inner}</td>`;
      tb.appendChild(d);
    }
  }
  if (!results.length) tb.innerHTML = '<tr><td colspan="6" class="muted">Nothing scanned yet. Pick your show folder and scan, and every sequence shows up here, worst first.</td></tr>';
  $('stats').innerHTML = !nDone ? '' :
    `<div class="stat"><b class="mono">${nDone}</b><span>scanned</span></div>
     <div class="stat"><b class="mono" style="color:var(--bad)">${nBad}</b><span>too low</span></div>
     <div class="stat"><b class="mono">${maxAdd ? '+' + maxAdd : '0'}</b><span>biggest lift needed</span></div>
     <div class="stat"><b class="mono" style="color:var(--warn)">${nStale}</b><span>render older than sequence</span></div>
     ${nClip ? `<div class="stat"><b class="mono" style="color:var(--warn)">${nClip}</b><span>would clip at the top</span></div>` : ''}`;
}

// ---------- copy report ----------
function copyText(text, btn, label) {
  const done = () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = label), 1600); };
  const fallback = () => { const ta = $('copyFallback'); ta.hidden = false; ta.value = text; ta.focus(); ta.select(); };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
}
$('copyBtn').addEventListener('click', () => {
  const s = settings();
  const lines = [['Sequence', 'Folder', 'Status', 'Lowest tilt', 'Add', 'First dip', 'Highest after add', 'Render older'].join('\t')];
  for (const r of results) {
    if (r.pending) continue;
    const st = seqStats(r, s);
    lines.push([r.name, r.folder, st.status[1], st.lowest ?? '', st.add, st.add ? fmtTime(st.dip, r.step) : '', st.topAfter ?? '', r.stale ? 'yes' : ''].join('\t'));
  }
  copyText(lines.join('\n'), $('copyBtn'), 'Copy report');
});

// ---------- folder pick ----------
async function walk(dir, path, out) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') {
      if (SKIP_DIRS.test(name)) continue;
      await walk(h, path ? path + '/' + name : name, out);
    } else if (/\.(fseq|xsq)$/i.test(name) || (!path && /^xlights_(rgbeffects|networks)\.xml$/i.test(name))) {
      out.push({ rel: path ? path + '/' + name : name, dir: path || '(top folder)', name, handle: h, file: await h.getFile() });
    }
  }
}
$('pickBtn').addEventListener('click', async () => {
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'xlights-show', mode: 'read' }); }
  catch (e) { return; } // closed the picker
  rootHandle = dir; rootName = dir.name;
  $('pickInfo').textContent = 'Reading folder…';
  const out = [];
  try { await walk(dir, '', out); }
  catch (e) { $('pickInfo').textContent = 'Could not read that folder: ' + e.message; return; }
  await loadFolder(out);
});
$('pick').addEventListener('change', async (e) => {
  rootHandle = null;
  const files = [...e.target.files];
  rootName = files[0]?.webkitRelativePath.split('/')[0] || 'Show DIR';
  const out = [];
  for (const f of files) {
    const parts = f.webkitRelativePath.split('/'); parts.shift();
    const rel = parts.join('/'); const dirParts = parts.slice(0, -1);
    if (dirParts.some((d) => SKIP_DIRS.test(d))) continue;
    if (/\.(fseq|xsq)$/i.test(f.name) || (!dirParts.length && /^xlights_(rgbeffects|networks)\.xml$/i.test(f.name)))
      out.push({ rel, dir: dirParts.join('/') || '(top folder)', name: f.name, handle: null, file: f });
  }
  await loadFolder(out);
});
async function loadFolder(out) {
  entries = out;
  const fseqs = entries.filter((x) => /\.fseq$/i.test(x.name));
  $('pickInfo').textContent = `${rootName}: ${fseqs.length} rendered sequences found.`;
  const rgb = entries.find((x) => x.rel.toLowerCase() === 'xlights_rgbeffects.xml');
  const net = entries.find((x) => x.rel.toLowerCase() === 'xlights_networks.xml');
  const msg = $('layoutMsg'); msg.hidden = false; msg.className = 'msg';
  if (rgb && net) {
    try {
      const L = parseLayout(await rgb.file.text(), await net.file.text(), TILT_ROW);
      if (L.heads.length) {
        heads = L.heads; headsKey = 'layout in this folder'; groups = L.groups;
        tiltModel = L.tiltModel || { name: TILT_ROW, count: 0 };
        applySavedHeads(store.get('settings')?.heads);
        const notOn = heads.filter((h) => h.liftIndex < 0).map((h) => h.name);
        msg.textContent = `Read your layout: ${heads.length} moving heads.` +
          (L.tiltModel ? ` "${TILT_ROW}" covers ${heads.length - notOn.length} of them.` : ` No "${TILT_ROW}" model found, so editing is off.`) +
          (notOn.length && L.tiltModel ? ` Not on it: ${notOn.join(', ')}.` : '') +
          (L.skipped.length ? ` Skipped ${L.skipped.join(', ')} (couldn't work out their channels).` : '');
      } else { msg.className = 'msg err'; msg.textContent = 'No moving heads found in this layout. Using the saved list of your 8 heads instead.'; }
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message + ' Using the saved list of your 8 heads instead.'; }
  } else {
    msg.textContent = 'No layout file at the top of this folder, so the saved list of your 8 heads is used. Pick Show DIR itself to read your layout.';
  }
  results = []; fixRows = []; cantRows = [];
  renderHeads(); buildFolders(fseqs); renderResults(); renderFix();
}
function buildFolders(fseqs) {
  const groupsByDir = {};
  for (const f of fseqs) (groupsByDir[f.dir] ||= []).push(f);
  const newest = Math.max(0, ...fseqs.map((f) => f.file.lastModified));
  const saved = store.get('folders') || {};
  folderSel = {};
  const box = $('folders'); box.innerHTML = '';
  const names = Object.keys(groupsByDir).sort();
  if (!names.length) box.innerHTML = '<span class="muted small">No .fseq files in this folder. Render your sequences in xLights first.</span>';
  names.forEach((d, i) => {
    const g = groupsByDir[d];
    const recent = g.some((f) => newest - f.file.lastModified < 90 * 864e5);
    folderSel[d] = saved[d] ?? recent;
    const gb = g.reduce((a, f) => a + f.file.size, 0) / 1e9;
    const l = document.createElement('label'); l.className = 'check'; l.htmlFor = 'fd' + i;
    l.innerHTML = `<input type="checkbox" id="fd${i}" ${folderSel[d] ? 'checked' : ''}><span>${esc(d)} <span class="muted small mono">${g.length} · ${gb.toFixed(1)} GB</span></span>`;
    l.querySelector('input').addEventListener('change', (e) => { folderSel[d] = e.target.checked; store.set('folders', folderSel); updateScanBtn(); });
    box.appendChild(l);
  });
  updateScanBtn();
}
function selectedSeqs() { return entries.filter((x) => /\.fseq$/i.test(x.name) && folderSel[x.dir]); }
function updateScanBtn() {
  const sel = selectedSeqs();
  $('scanBtn').disabled = scanning || !sel.length;
  $('scanBtn').textContent = sel.length ? `Scan ${sel.length} sequence${sel.length > 1 ? 's' : ''}` : 'Scan sequences';
  if (!scanning) $('scanInfo').textContent = sel.length ? `${(sel.reduce((a, f) => a + f.file.size, 0) / 1e9).toFixed(1)} GB to read` : '';
}
function xsqFor(r) {
  const base = r.rel.replace(/\.fseq$/i, '.xsq').toLowerCase();
  return entries.find((x) => x.rel.toLowerCase() === base) || null;
}

// ---------- scanning ----------
let workerOK = true;
function makeWorker() {
  if (!workerOK) return null;
  try { return new Worker('js/scan-worker.js'); } catch (e) { workerOK = false; return null; }
}
function runInWorker(w, file, hs, onProg) {
  return new Promise((resolve, reject) => {
    const id = Math.random();
    w.onmessage = (e) => { const m = e.data; if (m.id !== id) return; if (m.progress !== undefined) onProg(m.progress); else if (m.error) reject(new Error(m.error)); else resolve(m.result); };
    w.onerror = (e) => { if (e.preventDefault) e.preventDefault(); reject(Object.assign(new Error('worker failed'), { workerBroken: true })); };
    w.postMessage({ id, file, heads: hs });
  });
}
$('scanBtn').addEventListener('click', async () => {
  const sel = selectedSeqs(); if (!sel.length) return;
  scanning = true; stopReq = false; updateScanBtn();
  $('stopBtn').hidden = false; $('bar').hidden = false;
  const hs = heads.map((h) => ({ tilt: h.tilt, dim: h.dim }));
  results = sel.map((f) => {
    const x = xsqFor(f);
    return { name: f.name.replace(/\.fseq$/i, ''), folder: f.dir, rel: f.rel, file: f.file, pending: true, progress: 0, heads: [], step: 0,
      stale: !!x && x.file.lastModified > f.file.lastModified + 60000 };
  });
  renderResults();
  const totalBytes = sel.reduce((a, f) => a + f.file.size, 0) || 1;
  const t0 = Date.now();
  let lastPaint = 0;
  const paint = (force) => {
    const now = Date.now(); if (!force && now - lastPaint < 500) return; lastPaint = now;
    const done = results.reduce((a, r) => a + r.file.size * (r.pending ? r.progress : 1), 0);
    const frac = done / totalBytes;
    $('barFill').style.width = (frac * 100).toFixed(1) + '%';
    const el = (now - t0) / 1000, left = frac > 0.02 ? el / frac - el : null;
    const nDone = results.filter((r) => !r.pending).length;
    $('scanInfo').textContent = `${nDone} of ${results.length} done` + (left !== null ? ` · about ${Math.ceil(left / 60)} min left` : '');
    renderResults();
  };
  const queue = results.slice();
  const nWorkers = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const lane = async () => {
    let w = makeWorker();
    while (queue.length && !stopReq) {
      const r = queue.shift();
      const onProg = (p) => { r.progress = p; paint(); };
      try {
        let res;
        if (w) {
          try { res = await runInWorker(w, r.file, hs, onProg); }
          catch (err) { if (!err.workerBroken) throw err; workerOK = false; w.terminate(); w = null; res = await scanFseq(r.file, hs, onProg); }
        } else res = await scanFseq(r.file, hs, onProg);
        Object.assign(r, res, { pending: false });
      } catch (err) { Object.assign(r, { pending: false, error: err.message || String(err), heads: [] }); }
      paint(true);
    }
    if (w) w.terminate();
  };
  await Promise.all(Array.from({ length: workerOK ? nWorkers : 1 }, lane));
  results = results.filter((r) => !r.pending);
  scanning = false; $('stopBtn').hidden = true;
  updateScanBtn();
  $('scanInfo').textContent = `${results.length} scanned in ${Math.round((Date.now() - t0) / 1000)} s` + (stopReq ? ' (stopped)' : '');
  $('barFill').style.width = '100%';
  renderResults();
  await buildFix();
});
$('stopBtn').addEventListener('click', () => { stopReq = true; $('stopBtn').hidden = true; $('scanInfo').textContent = 'Stopping after the songs in progress…'; });

// ---------- step 4: fix ----------
function tiltTargets() {
  const t = {};
  for (const h of heads) t[h.name] = { channels: [h.tiltCh] };
  for (const [g, chans] of Object.entries(groups)) t[g] = { channels: chans };
  t[tiltModel.name] = { channels: 'all' };
  return t;
}
const fixCache = {}; // rel -> analysis of the .xsq at scan time
async function buildFix() {
  const targets = tiltTargets();
  for (const r of results) {
    if (r.error || fixCache[r.rel]) continue;
    const x = xsqFor(r);
    if (!x) { fixCache[r.rel] = { cant: 'No .xsq file next to this render, so there is nothing to edit.' }; continue; }
    try {
      const text = await x.file.text();
      const plain = XsqLift.analyze(text, tiltModel.name);
      const nodes = XsqLift.analyze(text, tiltModel.name, { allowNodes: true });
      const tiltFx = XsqLift.findTiltEffects(text, targets).found.length;
      fixCache[r.rel] = {
        xsq: x, lastModified: x.file.lastModified, ok: nodes.ok, reason: nodes.reason,
        needsNodes: !plain.ok && nodes.ok, current: nodes.lift ? nodes.lift.values.slice(0, 48) : new Array(48).fill(0),
        hasLift: nodes.state === 'lift', tiltFx,
      };
    } catch (err) { fixCache[r.rel] = { cant: 'Could not read the .xsq: ' + err.message }; }
  }
  renderFix();
}
const userAdds = {}; // rel -> {same: n} or {per: [..]}
const userOn = {};   // rel -> bool
const userAdd = {};  // rel -> additive bool
function computeFix() {
  const s = settings();
  const margin = clamp(parseInt($('margin').value, 10), 0, 100, 0);
  const same = $('sameLift').checked;
  const rows = [], cant = [];
  const count = tiltModel.count || 0;
  for (const r of results) {
    if (r.error) continue;
    const st = seqStats(r, s);
    if (st.add <= 0) continue;
    const c = fixCache[r.rel];
    if (!c) continue;
    if (r.edited) { cant.push({ r, why: 'Edited here already. Batch render it, then scan again before changing it further.' }); continue; }
    if (c.cant) { cant.push({ r, why: c.cant }); continue; }
    if (r.stale) { cant.push({ r, why: 'The sequence was saved after its last render, so the numbers may be out of date. Batch render it, scan again, then fix it.' }); continue; }
    if (!c.ok) { cant.push({ r, why: c.reason }); continue; }
    if (!count) { cant.push({ r, why: `No "${tiltModel.name}" model in your layout.` }); continue; }
    const need = new Array(count).fill(0);
    const notOn = [];
    st.per.forEach(({ h, st: x }) => {
      if (x.missing || x.never || !x.add) return;
      if (h.liftIndex < 0 || h.liftIndex >= count) { notOn.push(h.name); return; }
      need[h.liftIndex] = Math.max(need[h.liftIndex], x.add + margin);
    });
    const maxNeed = Math.max(0, ...need);
    const u = userAdds[r.rel] || {};
    let add;
    if (same) { const v = u.same ?? maxNeed; add = new Array(count).fill(v); }
    else add = need.map((v, i) => (u.per && u.per[i] !== undefined ? u.per[i] : v));
    const next = add.map((v, i) => clamp(c.current[i] + v, 0, 255, 0));
    const clipped = add.some((v, i) => c.current[i] + v > 255);
    const topAfter = st.high + Math.max(0, ...add);
    rows.push({
      r, c, need, add, next, same, notOn, clipped, topAfter,
      on: userOn[r.rel] ?? true,
      additive: c.needsNodes ? true : (userAdd[r.rel] ?? $('addAll').checked),
    });
  }
  return { rows, cant };
}
function renderFix() {
  const can = !!rootHandle;
  const scanned = results.some((r) => !r.pending);
  const { rows, cant } = scanned ? computeFix() : { rows: [], cant: [] };
  fixRows = rows; cantRows = cant;
  $('liftRowName').textContent = tiltModel.name;
  $('fixEmpty').hidden = scanned && can && (rows.length || cant.length) ? true : false;
  if (!can && entries.length) $('fixEmpty').textContent = fsa ? 'Use the "Choose show folder" button above (not the file picker) so this page is allowed to save edits.' : 'Editing needs Chrome or Edge on your PC. This browser can only read the folder.';
  else if (scanned && !rows.length && !cant.length) $('fixEmpty').textContent = 'Nothing to fix. Every scanned sequence stays above your limit.';
  else if (!scanned) $('fixEmpty').textContent = 'Scan your sequences first. Any that are too low show up here.';
  $('fixBody').hidden = !(scanned && can && (rows.length || cant.length));
  const tb = $('fixRows'); tb.innerHTML = '';
  rows.forEach((x, i) => {
    const tr = document.createElement('tr');
    const cur = x.c.hasLift ? fmtVals(x.c.current.slice(0, x.next.length)) : '—';
    const addCell = x.same
      ? `<input type="number" class="lift" id="fa${i}" min="0" max="255" value="${x.add[0]}" aria-label="Add for ${esc(x.r.name)}">`
      : `<div class="heads8">${x.add.map((v, k) => `<label for="fa${i}_${k}" title="${esc(heads.find((h) => h.liftIndex === k)?.name || '')}">DMX${k + 1}<input type="number" class="lift" id="fa${i}_${k}" min="0" max="255" value="${v}"></label>`).join('')}</div>`;
    const notes = [];
    if (x.c.hasLift) notes.push('Raises your existing lift');
    if (x.c.needsNodes) notes.push(`Tilt is on ${esc(tiltModel.name)}'s node rows, so those get switched to Additive`);
    if (x.notOn.length) notes.push(`${esc(x.notOn.join(', '))} not on ${esc(tiltModel.name)}`);
    if (x.clipped || x.topAfter > 255) notes.push('<span class="pill warn">top of the moves clips at 255</span>');
    tr.innerHTML = `<td><input type="checkbox" id="fo${i}" ${x.on ? 'checked' : ''} aria-label="Edit ${esc(x.r.name)}"></td>
      <td class="name"><div>${esc(x.r.name)}</div><div class="muted small">${esc(x.r.folder)}</div></td>
      <td class="num">${cur}</td><td class="num">${addCell}</td><td class="num"><b>${fmtVals(x.next)}</b></td>
      <td><label class="check" for="fd_a${i}"><input type="checkbox" id="fd_a${i}" ${x.additive ? 'checked' : ''} ${x.c.needsNodes ? 'disabled' : ''}><span class="small">${x.c.tiltFx ? x.c.tiltFx + ' effects' : 'none to switch'}</span></label></td>
      <td class="small" style="white-space:normal;min-width:14em">${notes.join('. ') || '—'}</td>`;
    tb.appendChild(tr);
    tr.querySelector('#fo' + i).addEventListener('change', (e) => { userOn[x.r.rel] = e.target.checked; renderFix(); });
    tr.querySelector('#fd_a' + i).addEventListener('change', (e) => { userAdd[x.r.rel] = e.target.checked; renderFix(); });
    if (x.same) tr.querySelector('#fa' + i).addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); userAdds[x.r.rel] = { same: Number.isFinite(v) ? clamp(v, 0, 255, 0) : undefined }; renderFix(); });
    else x.add.forEach((_, k) => tr.querySelector(`#fa${i}_${k}`).addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10); const u = userAdds[x.r.rel] || {}; u.per = u.per || []; u.per[k] = Number.isFinite(v) ? clamp(v, 0, 255, 0) : undefined; userAdds[x.r.rel] = u; renderFix();
    }));
  });
  if (!rows.length) tb.innerHTML = '<tr><td colspan="7" class="muted">No sequences can be fixed automatically. See the list below.</td></tr>';
  $('cantBox').hidden = !cant.length;
  $('cantList').innerHTML = cant.map((x) => `<li><b>${esc(x.r.name)}</b>: ${esc(x.why)}</li>`).join('');
  const picked = rows.filter((x) => x.on);
  $('reviewBtn').disabled = !picked.length || !can;
  $('reviewBtn').textContent = picked.length ? `Review changes for ${picked.length} sequence${picked.length > 1 ? 's' : ''}` : 'Review changes';
  $('fixInfo').textContent = rows.length ? `${picked.length} of ${rows.length} ticked` : '';
  if (!$('confirmBox').hidden) fillConfirm();
}
function fmtVals(v) {
  if (!v.length) return '—';
  return v.every((x) => x === v[0]) ? '+' + v[0] : v.map((x) => '+' + x).join(' ');
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
let pendingStamp = null;
function fillConfirm() {
  const picked = fixRows.filter((x) => x.on);
  const withAdd = picked.filter((x) => x.additive);
  const fx = withAdd.reduce((a, x) => a + x.c.tiltFx, 0);
  $('confirmSummary').innerHTML = `This edits <b>${picked.length} .xsq sequence file${picked.length > 1 ? 's' : ''}</b>` +
    (withAdd.length ? ` and switches <b>${fx} tilt effect${fx === 1 ? '' : 's'}</b> to Additive in ${withAdd.length} of them` : '') +
    `. Your .fseq render files are not changed.<br><span class="small">${picked.map((x) => `${esc(x.r.name)} (${fmtVals(x.next)})`).join(' · ')}</span>`;
  $('backupPath').textContent = `${rootName}\\${BACKUP_DIR}\\${pendingStamp}`;
  $('applyBtn').textContent = `Yes, edit ${picked.length} sequence${picked.length > 1 ? 's' : ''}`;
  $('applyBtn').disabled = !($('ckClosed').checked && $('ckRender').checked) || !picked.length;
}
$('reviewBtn').addEventListener('click', () => {
  pendingStamp = stamp();
  $('ckClosed').checked = false; $('ckRender').checked = false;
  $('confirmBox').hidden = false; $('doneBox').hidden = true;
  fillConfirm();
  $('confirmBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
['ckClosed', 'ckRender'].forEach((id) => $(id).addEventListener('change', fillConfirm));
$('cancelBtn').addEventListener('click', () => { $('confirmBox').hidden = true; });

async function subDir(base, parts) {
  let d = base;
  for (const p of parts) if (p) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}
$('applyBtn').addEventListener('click', async () => {
  const picked = fixRows.filter((x) => x.on);
  $('applyBtn').disabled = true; $('cancelBtn').disabled = true;
  let perm = 'denied';
  try { perm = await rootHandle.requestPermission({ mode: 'readwrite' }); } catch (e) { /* handled below */ }
  if (perm !== 'granted') {
    $('confirmSummary').innerHTML = '<span class="add">The browser was not allowed to save into the folder, so nothing was changed. Click "Yes" again and choose "Save changes" or "Allow" when the browser asks.</span>';
    $('applyBtn').disabled = false; $('cancelBtn').disabled = false; return;
  }
  const targets = tiltTargets();
  const backupRoot = await subDir(rootHandle, [BACKUP_DIR, pendingStamp]);
  const log = [], items = [];
  for (const x of picked) {
    const name = x.r.name;
    try {
      const h = x.c.xsq.handle;
      const file = await h.getFile();
      if (file.lastModified !== x.c.lastModified) { log.push([name, 'skip', 'Changed since the scan (was it saved in xLights?). Scan again first.']); continue; }
      const original = await file.text();
      let t = original, switched = 0;
      if (x.additive) { const res = XsqLift.makeTiltAdditive(t, targets); t = res.text; switched = res.count; }
      const vals = new Array(48).fill(0);
      x.next.forEach((v, i) => { vals[i] = v; });
      for (let i = x.next.length; i < 48; i++) vals[i] = x.c.current[i];
      t = XsqLift.applyLift(t, tiltModel.name, vals, { allowNodes: x.additive });
      // backup first, byte for byte
      const bdir = await subDir(backupRoot, x.c.xsq.dir === '(top folder)' ? [] : x.c.xsq.dir.split('/'));
      const bh = await bdir.getFileHandle(x.c.xsq.name, { create: true });
      const bw = await bh.createWritable(); await bw.write(file); await bw.close();
      if ((await (await bh.getFile()).text()) !== original) throw new Error('Backup check failed, so the sequence was left alone.');
      const w = await h.createWritable(); await w.write(t); await w.close();
      if ((await (await h.getFile()).text()) !== t) throw new Error('Saved file did not read back the same. Restore it from the backup folder.');
      items.push({ x, backupHandle: bh, handle: h });
      x.r.edited = true;
      log.push([name, 'ok', `Lift ${fmtVals(x.next)}` + (switched ? `, ${switched} tilt effects switched to Additive` : '')]);
    } catch (err) { log.push([name, 'err', err.message]); }
  }
  lastEdit = { stamp: pendingStamp, items };
  $('confirmBox').hidden = true; $('applyBtn').disabled = false; $('cancelBtn').disabled = false;
  showDone(log, items);
  renderResults(); renderFix();
});
function showDone(log, items) {
  const ok = log.filter((l) => l[1] === 'ok');
  const names = ok.map((l) => l[0]);
  const box = $('doneBox'); box.hidden = false;
  box.innerHTML = `<h3>${ok.length} sequence${ok.length === 1 ? '' : 's'} edited. Now batch render ${ok.length === 1 ? 'it' : 'them'}.</h3>
    <ol class="steps">
      <li>Open xLights. If it was open, reopen the show folder so it picks up the edited files.</li>
      <li>Go to <b>Tools → Batch Render</b> and tick the sequences listed below.</li>
      <li>Let it render. The show plays the .fseq files, so nothing changes on the lights until this is done.</li>
      <li>Come back here and scan again to check the beams now clear your limit.</li>
    </ol>
    <div class="tablebox"><table><tbody>${log.map((l) => `<tr><td>${esc(l[0])}</td><td><span class="pill ${l[1] === 'ok' ? 'ok' : l[1] === 'skip' ? 'warn' : 'bad'}">${l[1] === 'ok' ? 'Edited' : l[1] === 'skip' ? 'Skipped' : 'Failed'}</span></td><td class="small" style="white-space:normal">${esc(l[2])}</td></tr>`).join('')}</tbody></table></div>
    <p class="small">Backups: <span class="mono">${esc(rootName)}\\${BACKUP_DIR}\\${esc(lastEdit.stamp)}</span></p>
    <div class="row">
      <button id="copyNames">Copy the list of names</button>
      ${items.length ? '<button id="undoBtn">Undo these edits</button>' : ''}
    </div>
    <div class="confirm" id="undoBox" hidden>
      <h3>Put the original sequences back?</h3>
      <p class="small">This copies the ${items.length} backed-up .xsq file${items.length === 1 ? '' : 's'} over the edited ones. Close xLights first.</p>
      <div class="row"><button class="danger" id="undoYes">Yes, undo ${items.length} edit${items.length === 1 ? '' : 's'}</button><button id="undoNo">Keep the edits</button></div>
    </div>`;
  $('copyNames').addEventListener('click', () => copyText(names.join('\n'), $('copyNames'), 'Copy the list of names'));
  if (items.length) {
    $('undoBtn').addEventListener('click', () => { $('undoBox').hidden = false; });
    $('undoNo').addEventListener('click', () => { $('undoBox').hidden = true; });
    $('undoYes').addEventListener('click', undo);
  }
  const b = $('renderBanner');
  if (ok.length) { b.hidden = false; b.textContent = `${ok.length} sequence${ok.length === 1 ? '' : 's'} edited at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Batch render ${ok.length === 1 ? 'it' : 'them'} in xLights before the show.`; }
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function undo() {
  const out = [];
  for (const it of lastEdit.items) {
    try {
      const f = await it.backupHandle.getFile();
      const w = await it.handle.createWritable(); await w.write(f); await w.close();
      it.x.r.edited = false;
      out.push(`${it.x.r.name}: put back`);
    } catch (err) { out.push(`${it.x.r.name}: failed (${err.message}). Copy it back from the backup folder.`); }
  }
  $('undoBox').innerHTML = `<h3>Undo finished</h3><p class="small">${out.map(esc).join('<br>')}</p><p class="small">Scan again before editing these, because their files just changed.</p>`;
  $('renderBanner').hidden = true;
  for (const it of lastEdit.items) delete fixCache[it.x.r.rel];
  lastEdit.items = [];
  renderResults(); renderFix();
}

// ---------- wiring ----------
function changed() { saveSettings(); renderGauge(); renderResults(); renderFix(); }
['minT', 'maxT', 'margin', 'ignoreMs'].forEach((id) => $(id).addEventListener('input', changed));
['litOnly', 'sameLift', 'addAll'].forEach((id) => $(id).addEventListener('change', () => { if (id === 'addAll') for (const k in userAdd) delete userAdd[k]; changed(); }));
$('onlyBad').addEventListener('change', renderResults);

if (fsa) { $('pickBtn').hidden = false; $('pickLabel').hidden = true; } else { $('fsaNote').hidden = false; }
loadSettings();
renderHeads(); renderGauge(); renderResults(); renderFix();
