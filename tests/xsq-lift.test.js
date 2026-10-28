// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const X = require('../js/xsq-lift.js');
const { seq } = require('./fixtures/make.js');

const normalTilt = 'E_NOTEBOOK1=Channels 1-16,E_SLIDER_DMX10=127,E_SLIDER_DMX12=40,E_SLIDER_DMX3=255,T_CHOICE_LayerMethod=Normal';
const panOnly = 'E_NOTEBOOK1=Channels 1-16,E_SLIDER_DMX10=127,E_SLIDER_DMX3=255';
const vals = (n) => Array.from({ length: 48 }, (_, i) => (i < 8 ? n : 0));

test('lift settings use the same format as a lift made by hand in xLights', () => {
  const s = X.liftSettings(vals(30));
  assert.match(s, /^E_CHECKBOX_INVDMX1=0,E_CHECKBOX_INVDMX10=0,/);
  assert.match(s, /E_NOTEBOOK_DMX=Channels 1-16,E_SLIDER_DMX1=30,E_SLIDER_DMX10=0,/);
  assert.match(s, /E_SLIDER_DMX8=30,E_SLIDER_DMX9=0,T_CHECKBOX_Canvas=0,T_CHECKBOX_LayerMorph=0,T_CHOICE_LayerMethod=Additive,T_SLIDER_EffectLayerMix=0$/);
});

test('adds a whole-song Additive lift to an empty MH Tilt row', () => {
  const t = seq({ effects: [panOnly] });
  assert.equal(X.analyze(t, 'MH Tilt').state, 'empty');
  const out = X.applyLift(t, 'MH Tilt', vals(25));
  const a = X.analyze(out, 'MH Tilt');
  assert.equal(a.state, 'lift');
  assert.deepEqual(a.lift.values.slice(0, 9), [25, 25, 25, 25, 25, 25, 25, 25, 0]);
  assert.match(out, /<Strand index="0">\n        <Effect ref="1" name="DMX" startTime="0" endTime="180025" palette="1" \/>\n      <\/Strand>/);
  // nothing else removed
  for (const line of t.split('\n')) assert.ok(out.includes(line), 'lost line: ' + line);
});

test('raises an existing lift instead of adding a second one', () => {
  const lift = X.liftSettings(vals(30));
  const t = seq({ effects: [lift], strand: '        <Effect ref="0" name="DMX" startTime="0" endTime="180025" palette="0" />\n' });
  const a = X.analyze(t, 'MH Tilt');
  assert.equal(a.state, 'lift');
  assert.equal(a.lift.values[0], 30);
  const out = X.applyLift(t, 'MH Tilt', vals(38));
  assert.equal((out.match(/<Strand index="0">[\s\S]*?<\/Strand>/)[0].match(/<Effect /g) || []).length, 1);
  assert.equal(X.analyze(out, 'MH Tilt').lift.values[0], 38);
});

test('leaves MH Tilt alone when Strand 1 already has other tilt effects', () => {
  const t = seq({ effects: [normalTilt], strand: '        <Effect ref="0" name="DMX" startTime="1000" endTime="5000" palette="0" />\n' });
  const a = X.analyze(t, 'MH Tilt');
  assert.equal(a.ok, false);
  assert.equal(a.state, 'busy');
  assert.throws(() => X.applyLift(t, 'MH Tilt', vals(10)));
});

test('node-row tilt effects need the Additive switch first', () => {
  const nodes = '        <Node index="0">\n          <Effect ref="0" name="DMX" startTime="1000" endTime="5000" palette="0" />\n        </Node>\n';
  const t = seq({ effects: ['E_SLIDER_DMX1=70,T_CHOICE_LayerMethod=Normal'], nodes });
  assert.equal(X.analyze(t, 'MH Tilt').state, 'busy');
  const targets = { 'MH Tilt': { channels: 'all' } };
  const sw = X.makeTiltAdditive(t, targets);
  assert.equal(sw.count, 1);
  const out = X.applyLift(sw.text, 'MH Tilt', vals(12), { allowNodes: true });
  assert.equal(X.analyze(out, 'MH Tilt', { allowNodes: true }).state, 'lift');
});

test('switches only tilt-moving DMX effects on head rows to Additive', () => {
  const headFx = '        <Effect ref="0" name="DMX" startTime="0" endTime="1000" palette="0" />\n        <Effect ref="1" name="DMX" startTime="1000" endTime="2000" palette="0" />\n';
  const t = seq({ effects: [normalTilt, panOnly], headFx });
  const targets = { 'YPS-MovingHead-1': { channels: [12] } };
  assert.equal(X.findTiltEffects(t, targets).found.length, 1);
  const r = X.makeTiltAdditive(t, targets);
  assert.equal(r.count, 1);
  assert.equal(X.findTiltEffects(r.text, targets).found.length, 0);
  // the pan-only effect still points at its original settings
  assert.match(r.text, /<Effect ref="1" name="DMX" startTime="1000"/);
  assert.match(r.text, /<Effect ref="2" name="DMX" startTime="0" endTime="1000"/);
  assert.match(r.text, /T_CHOICE_LayerMethod=Additive<\/Effect>/);
});
