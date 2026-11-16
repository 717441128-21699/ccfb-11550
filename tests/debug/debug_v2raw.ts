import { readFileSync } from 'node:fs';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { decodeCompactStruct, THRIFT_DEFS } from '../../src/core/thrift.js';

const bytes = readFileSync('tests/data/23_bool_v2.parquet');
const reader = new ByteReader(bytes.subarray(4, 60));
const raw = decodeCompactStruct<Record<string, unknown>>(reader, THRIFT_DEFS.pageHeader);
console.log('bytesRead', reader.offset);
console.log(JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? `[${v.length}B]` : v), 1));

