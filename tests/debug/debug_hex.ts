import { readFileSync } from 'node:fs';
import { ByteReader } from '../../src/core/io.js';

const bytes = readFileSync('tests/data/14_decimals_int32.parquet');
const data = bytes.subarray(4, 40);
const reader = new ByteReader(data);
for (let i = 0; i < 18; i++) {
  const b = reader.u8();
  console.log(`offset ${reader.offset - 1}: 0x${b.toString(16)} delta=${b >> 4} ct=${b & 0xf}`);
}

