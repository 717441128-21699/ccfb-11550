import { readFileSync } from 'node:fs';
import { ByteReader, zigzagDecode } from '../../src/core/io.js';

const bytes = readFileSync('tests/data/24_all_nulls.parquet');
const reader = new ByteReader(bytes);
reader.offset = 20;
let lastId = 0;
for (let i = 0; i < 20; i++) {
  const header = reader.u8();
  if (header === 0) {
    console.log('STOP at offset', reader.offset - 1);
    break;
  }
  const delta = (header >> 4) & 0x0f;
  const ct = header & 0x0f;
  let id: number;
  if (delta === 0) id = zigzagDecode(reader.varint());
  else id = lastId + delta;
  lastId = id;
  let value: unknown = '';
  if (ct === 5 || ct === 4) value = zigzagDecode(reader.varint());
  else if (ct === 1) value = true;
  else if (ct === 2) value = false;
  else if (ct === 12) { console.log(`field ${id} struct (ct12) at ${reader.offset}`); break; }
  else value = `ct=${ct}`;
  console.log(`field id=${id} ct=${ct} value=${value}`);
}

