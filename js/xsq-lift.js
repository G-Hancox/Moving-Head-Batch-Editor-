// Reads and edits xLights .xsq sequence files to add a whole-song tilt lift:
// one DMX effect, blended Additive, on <tilt model> > Strand 1 (strand index 0).
// This is the same thing done by hand in xLights. Works on the raw text so the
// rest of the file is left byte-for-byte untouched.
(function (root) {
'use strict';

const LIFT_PALETTE = 'C_BUTTON_Palette1=#ffffff,C_BUTTON_Palette2=#8000ff,C_BUTTON_Palette3=#00ff00,C_BUTTON_Palette4=#0000ff,C_BUTTON_Palette5=#ffff00,C_BUTTON_Palette6=#000000,C_BUTTON_Palette7=#00ffff,C_BUTTON_Palette8=#ff00ff,C_CHECKBOXBRIGHTNESSLEVEL=0,C_CHECKBOX_Chroma=0,C_CHECKBOX_MusicSparkles=0,C_CHECKBOX_Palette1=1,C_CHECKBOX_Palette2=0,C_CHECKBOX_Palette3=0,C_CHECKBOX_Palette4=0,C_CHECKBOX_Palette5=0,C_CHECKBOX_Palette6=0,C_CHECKBOX_Palette7=0,C_CHECKBOX_Palette8=0,C_SLIDER_SparkleFrequency=0';

function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// DMX effect settings in xLights' own format (keys sorted as xLights writes them).
function liftSettings(values) {
  const kv = {};
  for (let i = 1; i <= 48; i++) { kv['E_CHECKBOX_INVDMX' + i] = '0'; kv['E_SLIDER_DMX' + i] = String(values[i - 1] | 0); }
  kv['E_NOTEBOOK_DMX'] = 'Channels 1-16';
  kv['T_CHECKBOX_Canvas'] = '0';
  kv['T_CHECKBOX_LayerMorph'] = '0';
  kv['T_CHOICE_LayerMethod'] = 'Additive';
  kv['T_SLIDER_EffectLayerMix'] = '0';
  return Object.keys(kv).sort().map((k) => k + '=' + kv[k]).join(',');
}

function section(text, tag) {
  const open = text.indexOf('<' + tag + '>');
  if (open >= 0) { const close = text.indexOf('</' + tag + '>', open); return { open, start: open + tag.length + 2, close, empty: false }; }
  const m = new RegExp('<' + tag + '\\s*/>').exec(text);
  if (m) return { open: m.index, start: m.index, close: m.index, empty: true, emptyLen: m[0].length };
  return null;
}
function countEntries(body, tag) {
  const re = new RegExp('<' + tag + '(?:\\s*/>|>[\\s\\S]*?</' + tag + '>)', 'g');
  return (body.match(re) || []).length;
}
function entryAt(body, tag, idx) {
  const re = new RegExp('<' + tag + '(?:\\s*/>|>([\\s\\S]*?)</' + tag + '>)', 'g');
  let m, i = 0;
  while ((m = re.exec(body))) { if (i++ === idx) return m[1] || ''; }
  return null;
}
function parseSettings(s) {
  const o = {};
  // values can hold commas only inside value curves (| separated), so split on ,KEY=
  for (const part of s.split(/,(?=[A-Z]_[A-Za-z0-9_]+=)/)) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i)] = part.slice(i + 1); }
  return o;
}
function attr(tag, name) { const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag); return m ? m[1] : null; }

// Finds the tilt model's block inside <ElementEffects>.
function findElement(text, modelName) {
  const ee = text.indexOf('<ElementEffects>');
  if (ee < 0) return null;
  const eeEnd = text.indexOf('</ElementEffects>', ee);
  const nameAttr = 'name="' + xmlEsc(modelName) + '"';
  const re = /<Element\b[^>]*>/g; re.lastIndex = ee;
  let m;
  while ((m = re.exec(text)) && m.index < eeEnd) {
    if (m[0].indexOf(nameAttr) < 0 || m[0].indexOf('type="model"') < 0) continue;
    if (m[0].endsWith('/>')) return { start: m.index, openEnd: m.index + m[0].length, end: m.index + m[0].length, selfClosing: true, tag: m[0] };
    const end = text.indexOf('</Element>', m.index);
    return { start: m.index, openEnd: m.index + m[0].length, end, selfClosing: false, tag: m[0] };
  }
  return null;
}

function analyze(text, modelName, opts) {
  opts = opts || {};
  const r = { ok: false };
  const dur = /<sequenceDuration>\s*([\d.]+)\s*<\/sequenceDuration>/.exec(text);
  const tim = /<sequenceTiming>\s*(\d+)\s*ms\s*<\/sequenceTiming>/.exec(text);
  if (!dur) { r.reason = 'Could not find the song length in this sequence.'; return r; }
  r.durationMs = Math.round(parseFloat(dur[1]) * 1000);
  r.stepMs = tim ? parseInt(tim[1], 10) : 50;
  const el = findElement(text, modelName);
  if (!el) { r.state = 'noModel'; r.reason = `This sequence has no "${modelName}" row. Add it in xLights once, then run again.`; return r; }
  r.element = el;
  const body = el.selfClosing ? '' : text.slice(el.openEnd, el.end);
  const sm = /<Strand index="0"\s*(\/>|>)/.exec(body);
  if (!sm || sm[1] === '/>') { r.ok = true; r.state = 'empty'; return r; }
  const sStart = el.openEnd + sm.index + sm[0].length;
  const sEnd = text.indexOf('</Strand>', sStart);
  const sBody = text.slice(sStart, sEnd);
  const firstNode = sBody.search(/<Node\b/);
  const direct = firstNode >= 0 ? sBody.slice(0, firstNode) : sBody;
  const effects = direct.match(/<Effect\b[^>]*\/>/g) || [];
  const nodeEffects = firstNode >= 0 ? (sBody.slice(firstNode).match(/<Effect\b/g) || []).length : 0;
  r.strandBodyStart = sStart;
  r.nodeEffects = nodeEffects;
  if (nodeEffects && !opts.allowNodes) { r.state = 'busy'; r.reason = `"${modelName}" has its own tilt effects on its node rows. Turn on "make tilt effects Additive" for this one, or fix it by hand.`; return r; }
  if (!effects.length) { r.ok = true; r.state = 'empty'; return r; }
  if (effects.length === 1) {
    const e = effects[0];
    const ref = parseInt(attr(e, 'ref'), 10), st = parseInt(attr(e, 'startTime'), 10), en = parseInt(attr(e, 'endTime'), 10);
    const db = section(text, 'EffectDB');
    const settings = db && !db.empty ? entryAt(text.slice(db.start, db.close), 'Effect', ref) : null;
    const s = settings ? parseSettings(settings) : {};
    const curves = Object.keys(s).some((k) => k.startsWith('E_VALUECURVE_DMX') && /Active=TRUE/.test(s[k]));
    if (attr(e, 'name') === 'DMX' && st <= r.stepMs && en >= r.durationMs - 1000 && s.T_CHOICE_LayerMethod === 'Additive' && !curves) {
      r.ok = true; r.state = 'lift';
      r.lift = { tag: e, ref, palette: attr(e, 'palette'), values: Array.from({ length: 48 }, (_, i) => parseInt(s['E_SLIDER_DMX' + (i + 1)] || '0', 10)) };
      r.liftTagIndex = sStart + direct.indexOf(e);
      return r;
    }
  }
  r.state = 'busy';
  r.reason = `"${modelName}" Strand 1 already has other tilt effects (${effects.length}). Fix this one by hand.`;
  return r;
}

// Appends one entry to a list section; returns {text, index}.
function appendEntry(text, tag, listTag, content) {
  const sec = section(text, listTag);
  if (!sec) throw new Error(`No <${listTag}> section in this sequence.`);
  if (sec.empty) {
    const repl = `<${listTag}>\n    <${tag}>${content}</${tag}>\n  </${listTag}>`;
    return { text: text.slice(0, sec.open) + repl + text.slice(sec.open + sec.emptyLen), index: 0 };
  }
  const index = countEntries(text.slice(sec.start, sec.close), tag);
  const line = `  <${tag}>${content}</${tag}>\n  `;
  // insert before the closing tag, keeping xLights' indentation
  let at = sec.close;
  let before = text.slice(0, at);
  const trimmed = before.replace(/[ \t]*$/, '');
  return { text: trimmed + '  ' + line.trimEnd() + '\n  ' + text.slice(at), index };
}

// values: array of DMX values (index 0 = DMX1). Returns new file text.
function applyLift(text, modelName, values, opts) {
  opts = opts || {};
  const a = analyze(text, modelName, opts);
  if (!a.ok) throw new Error(a.reason || 'Cannot edit this sequence.');
  const vals = Array.from({ length: 48 }, (_, i) => Math.max(0, Math.min(255, Math.round(values[i] || 0))));
  let t = text;
  const eff = appendEntry(t, 'Effect', 'EffectDB', liftSettings(vals)); t = eff.text;
  let palette;
  if (a.state === 'lift') palette = a.lift.palette;
  else { const p = appendEntry(t, 'ColorPalette', 'ColorPalettes', LIFT_PALETTE); t = p.text; palette = p.index; }
  const endTime = Math.ceil(a.durationMs / a.stepMs) * a.stepMs;
  // positions moved because we inserted text before ElementEffects; re-analyze
  const b = analyze(t, modelName, opts);
  if (a.state === 'lift') {
    const newTag = b.lift.tag.replace(/\sref="\d+"/, ` ref="${eff.index}"`);
    t = t.slice(0, b.liftTagIndex) + newTag + t.slice(b.liftTagIndex + b.lift.tag.length);
  } else {
    const effTag = `<Effect ref="${eff.index}" name="DMX" startTime="0" endTime="${endTime}" palette="${palette}" />`;
    const el = b.element;
    if (b.strandBodyStart !== undefined) {
      t = t.slice(0, b.strandBodyStart) + '\n        ' + effTag + t.slice(b.strandBodyStart);
    } else if (el.selfClosing) {
      const open = el.tag.replace(/\s*\/>$/, '>');
      t = t.slice(0, el.start) + open + '\n      <EffectLayer />\n      <Strand index="0">\n        ' + effTag + '\n      </Strand>\n    </Element>' + t.slice(el.end);
    } else {
      const body = t.slice(el.openEnd, el.end);
      const emptyStrand = /<Strand index="0"\s*\/>/.exec(body);
      if (emptyStrand) {
        const at = el.openEnd + emptyStrand.index;
        t = t.slice(0, at) + '<Strand index="0">\n        ' + effTag + '\n      </Strand>' + t.slice(at + emptyStrand[0].length);
      } else {
        // new strand goes after the model's effect layers, before any other strands
        const firstStrand = body.search(/<Strand\b/);
        let at;
        if (firstStrand >= 0) at = el.openEnd + firstStrand;
        else at = el.end;
        const pre = t.slice(0, at).replace(/[ \t]*$/, '');
        const insert = '      <Strand index="0">\n        ' + effTag + '\n      </Strand>\n' + (firstStrand >= 0 ? '      ' : '    ');
        t = pre + (pre.endsWith('\n') ? '' : '\n') + insert + t.slice(at);
      }
    }
  }
  const check = analyze(t, modelName, opts);
  if (!check.ok || check.state !== 'lift') throw new Error('Edit check failed. The sequence was not changed.');
  for (let i = 0; i < 48; i++) if (check.lift.values[i] !== vals[i]) throw new Error('Edit check failed. The sequence was not changed.');
  return t;
}

// targets: { [elementName]: { channels: [tilt channel numbers] | 'all' } }
// Finds DMX effects on those rows that move tilt and are not Additive yet.
function findTiltEffects(text, targets) {
  const db = section(text, 'EffectDB');
  const settings = [];
  if (db && !db.empty) {
    const re = /<Effect(?:\s*\/>|>([\s\S]*?)<\/Effect>)/g; const body = text.slice(db.start, db.close); let m;
    while ((m = re.exec(body))) settings.push(m[1] || '');
  }
  const ee = text.indexOf('<ElementEffects>'), eeEnd = text.indexOf('</ElementEffects>');
  const found = [];
  if (ee < 0) return { found, settings };
  const re = /<Element\b[^>]*?(\/?)>/g; re.lastIndex = ee; let m;
  while ((m = re.exec(text)) && m.index < eeEnd) {
    if (m[1] === '/') continue;
    const name = (attr(m[0], 'name') || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const end = text.indexOf('</Element>', m.index);
    const tgt = targets[name];
    if (tgt) {
      const body = text.slice(m.index, end);
      const er = /<Effect\b[^>]*\/>/g; let e;
      while ((e = er.exec(body))) {
        if (attr(e[0], 'name') !== 'DMX') continue;
        const ref = parseInt(attr(e[0], 'ref'), 10);
        const s = parseSettings(settings[ref] || '');
        if (s.T_CHOICE_LayerMethod === 'Additive') continue;
        const chans = tgt.channels === 'all' ? Array.from({ length: 48 }, (_, i) => i + 1) : tgt.channels;
        const moves = chans.some((c) => (parseInt(s['E_SLIDER_DMX' + c] || '0', 10) > 0) || /Active=TRUE/.test(s['E_VALUECURVE_DMX' + c] || ''));
        if (!moves) continue;
        found.push({ element: name, index: m.index + e.index, tag: e[0], ref });
      }
    }
    re.lastIndex = end;
  }
  return { found, settings };
}

function makeTiltAdditive(text, targets) {
  const { found, settings } = findTiltEffects(text, targets);
  if (!found.length) return { text, count: 0 };
  let t = text;
  const newRef = {};
  for (const f of found) {
    if (newRef[f.ref] !== undefined) continue;
    const parts = (settings[f.ref] || '').split(/,(?=[A-Z]_[A-Za-z0-9_]+=)/).filter((x) => x && !x.startsWith('T_CHOICE_LayerMethod='));
    parts.push('T_CHOICE_LayerMethod=Additive');
    parts.sort((a, b) => (a.split('=')[0] < b.split('=')[0] ? -1 : 1));
    const r = appendEntry(t, 'Effect', 'EffectDB', parts.join(','));
    t = r.text; newRef[f.ref] = r.index;
  }
  // effect tags moved by the inserted text; find them again and rewrite from the end
  const again = findTiltEffects(t, targets).found.filter((f) => newRef[f.ref] !== undefined);
  again.sort((a, b) => b.index - a.index);
  for (const f of again) {
    const tag = f.tag.replace(/\sref="\d+"/, ` ref="${newRef[f.ref]}"`);
    t = t.slice(0, f.index) + tag + t.slice(f.index + f.tag.length);
  }
  if (findTiltEffects(t, targets).found.length) throw new Error('Additive switch check failed. The sequence was not changed.');
  return { text: t, count: again.length };
}

const api = { findTiltEffects, makeTiltAdditive, analyze, applyLift, liftSettings, parseSettings, LIFT_PALETTE };
root.XsqLift = api;
if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
