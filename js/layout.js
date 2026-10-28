// Reads xlights_rgbeffects.xml + xlights_networks.xml (needs DOMParser) to find
// the moving heads, their absolute channels, the tilt "line" model whose strings
// point at each head's tilt channel, and the groups that contain heads.
(function (root) {
'use strict';
function parseLayout(rgbText, netText, tiltModelName) {
  const P = new DOMParser();
  const rgb = P.parseFromString(rgbText, 'application/xml'), net = P.parseFromString(netText, 'application/xml');
  if (rgb.querySelector('parsererror') || net.querySelector('parsererror')) throw new Error('Could not read the layout files.');
  const ctrl = {}; let run = 1;
  for (const c of net.getElementsByTagName('Controller')) {
    let n = 0; for (const nw of c.getElementsByTagName('network')) n += parseInt(nw.getAttribute('MaxChannels') || '0', 10);
    ctrl[c.getAttribute('Name')] = run; run += n;
  }
  const models = {};
  for (const m of rgb.getElementsByTagName('model')) models[m.getAttribute('name')] = m;
  const cache = {};
  const startOf = (name, depth = 0) => {
    if (name in cache) return cache[name];
    const m = models[name]; if (!m || depth > 20) return null;
    return (cache[name] = resolve((m.getAttribute('StartChannel') || '').trim(), depth));
  };
  const resolve = (sc, depth) => {
    let x;
    if ((x = sc.match(/^!(.+):(\d+)$/))) return ctrl[x[1]] !== undefined ? ctrl[x[1]] + +x[2] - 1 : null;
    if ((x = sc.match(/^@(.+):(\d+)$/))) { const b = startOf(x[1], depth + 1); return b === null ? null : b + +x[2] - 1; }
    if ((x = sc.match(/^>(.+):(\d+)$/))) { const b = startOf(x[1], depth + 1), cnt = parseInt(models[x[1]]?.getAttribute('DmxChannelCount') || '', 10); return b === null || !cnt ? null : b + cnt + +x[2] - 1; }
    if (/^\d+$/.test(sc)) return +sc;
    return null;
  };
  const heads = [], skipped = [];
  for (const [name, m] of Object.entries(models)) {
    if (!/MovingHead/i.test(m.getAttribute('DisplayAs') || '')) continue;
    const tm = [...m.children].find((c) => c.tagName === 'TiltMotor');
    const tiltCh = parseInt(tm?.getAttribute('ChannelCoarse') || m.getAttribute('DmxTiltChannel') || '0', 10);
    const dimCh = parseInt(m.getAttribute('MhDimmerChannel') || m.getAttribute('DmxDimmerChannel') || '0', 10);
    const s1 = startOf(name);
    if (s1 === null || !tiltCh) { skipped.push(name); continue; }
    heads.push({ name, tilt: s1 - 1 + tiltCh - 1, dim: dimCh ? s1 - 1 + dimCh - 1 : -1, tiltCh, dimCh, on: true, own: null, liftIndex: -1 });
  }
  // tilt line model: String1..N each point at one head's tilt channel
  let tiltModel = null;
  const tm = models[tiltModelName];
  if (tm) {
    const n = parseInt(tm.getAttribute('NumStrings') || '1', 10);
    const strings = [];
    for (let i = 1; i <= n; i++) {
      const sc = (tm.getAttribute('String' + i) || (i === 1 ? tm.getAttribute('StartChannel') : '') || '').trim();
      const abs = resolve(sc, 0);
      strings.push(abs === null ? null : abs - 1);
    }
    heads.forEach((h) => { h.liftIndex = strings.indexOf(h.tilt); });
    tiltModel = { name: tiltModelName, count: n, strings };
  }
  const groups = {};
  for (const g of rgb.getElementsByTagName('modelGroup')) {
    const members = (g.getAttribute('models') || '').split(',').map((s) => s.trim());
    const hs = heads.filter((h) => members.includes(h.name));
    if (hs.length) groups[g.getAttribute('name')] = [...new Set(hs.map((h) => h.tiltCh))];
  }
  return { heads, skipped, tiltModel, groups };
}
root.parseLayout = parseLayout;
})(typeof globalThis !== 'undefined' ? globalThis : this);
