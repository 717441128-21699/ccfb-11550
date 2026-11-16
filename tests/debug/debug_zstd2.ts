import { readFileSync } from 'node:fs';
import { ByteReader } from '../../src/core/io.js';
import { decompressZstd } from '../../src/core/zstd.js';

const bytes = readFileSync('tests/data/03_primitive_zstd.parquet');
const input = bytes.subarray(41, 41 + 68);
const r = new ByteReader(input);
console.log('u32 magic =', '0x' + r.u32().toString(16), 'expected 0x28b52ffd');
console.log('descriptor =', '0x' + input[4].toString(16));
try {
  const out = decompressZstd(input, 59);
  console.log('zstd OK', out.length, 'bytes:', [...out.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
} catch (e) {
  console.log('zstd FAIL', e instanceof Error ? e.message : String(e));
}

