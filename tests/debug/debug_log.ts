import { readFileSync } from 'node:fs';
import { ByteReader } from '../../src/core/io.js';

const bytes = readFileSync('tests/data/24_all_nulls.parquet');
const data = bytes.subarray(4, 19);
const reader = new ByteReader(data);

// Mirror readStruct with logging.
function logStruct(def: { id: number; name: string; kind: string }[], depth: number): Record<string, unknown> {
  const pad = '  '.repeat(depth);
  const byId = new Map(def.map((f) => [f.id, f]));
  const out: Record<string, unknown> = {};
  let lastId = 0;
  for (;;) {
    const header = reader.u8();
    if (header === 0) {
      console.log(`${pad}STOP at reader.offset=${reader.offset}`);
      return out;
    }
    const delta = (header >> 4) & 0x0f;
    const ct = header & 0x0f;
    const id = delta === 0 ? 'zigzag' : lastId + delta;
    if (delta !== 0) lastId = id as number;
    const field = byId.get(id as number);
    console.log(`${pad}header=0x${header.toString(16)} delta=${delta} ct=${ct} resolvedId=${id} -> ${field?.name ?? 'UNKNOWN'}`);
    if (!field) {
      console.log(`${pad}  (skipping unknown field)`);
      // can't easily skip nested; stop for this inspection
      return out;
    }
    if (field.kind === 'struct') {
      out[field.name] = logStruct(field.structDef ?? [], depth + 1);
    } else if (field.kind === 'i32') {
      // emulate zigzag varint
      let v = 0, shift = 0;
      for (;;) { const b = reader.u8(); v |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
      out[field.name] = (v >>> 1) ^ -(v & 1);
    }
  }
}

import { THRIFT_DEFS } from '../../src/core/thrift.js';
logStruct(THRIFT_DEFS.pageHeader as unknown as { id: number; name: string; kind: string }[], 0);
console.log('final offset', reader.offset);

