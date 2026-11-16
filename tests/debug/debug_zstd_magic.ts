import { readFileSync } from 'node:fs';
const bytes = readFileSync('tests/data/03_primitive_zstd.parquet');
console.log('zstd page body @41 first 12:',
  [...bytes.slice(41, 53)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('expected zstd magic: 28 b5 2f fd');

