import { readFileSync } from 'node:fs';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { decodeCompactStruct, THRIFT_DEFS } from '../../src/core/thrift.js';

const bytes = readFileSync('tests/data/24_all_nulls.parquet');
// Dict page header at offset 4; reference says hlen=14 (body@18)
for (const off of [4, 52]) {
  const window = bytes.subarray(off, off + 64);
  const reader = new ByteReader(window);
  const raw = decodeCompactStruct<Record<string, unknown>>(reader, THRIFT_DEFS.pageHeader);
  console.log(`offset ${off}: bytesRead=${reader.offset} (reference says 14)`);
  console.log('  raw:', JSON.stringify(raw, (_k, v) => (v instanceof Uint8Array ? `[${v.length} bytes]` : v)));
}

