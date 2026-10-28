// Checks the built-in Zstandard decoder against Node's own (Node 22.15+).
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const dec = require('../js/zstd.js');

test('decodes data the same way as Node', { skip: !zlib.zstdCompressSync }, () => {
  const parts = [];
  for (let i = 0; i < 4000; i++) parts.push(i % 7 ? Buffer.alloc(300) : Buffer.from(`frame ${i} ` + 'x'.repeat(i % 97)));
  for (let i = 0; i < 2000; i++) parts.push(Buffer.from([...Array(64)].map((_, k) => (i * 31 + k * 7) & 255)));
  const raw = Buffer.concat(parts);
  for (const level of [1, 3, 9, 19]) {
    const c = zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
    const out = dec(new Uint8Array(c), raw.length);
    assert.ok(Buffer.from(out).equals(raw), 'level ' + level);
  }
});
