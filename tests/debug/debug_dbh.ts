import { readFileSync } from 'node:fs';
import { ByteReader, zigzagDecode } from '../../src/core/io.js';

const body = readFileSync('tests/data/_delta_s.bin');
const data = body.subarray(36);
const r = new ByteReader(data);
const blockSize = r.varint();
const numMini = r.varint();
const total = r.varint();
const first = zigzagDecode(r.varint());
console.log('blockSize', blockSize, 'miniBlocks', numMini, 'total', total, 'first', first);
const minDelta = zigzagDecode(r.varint());
const widths = [];
for (let i = 0; i < numMini; i++) widths.push(r.u8());
console.log('minDelta', minDelta, 'bitWidths', widths, 'data starts at offset', r.offset);
console.log('data bytes:', [...data.slice(r.offset, r.offset + 16)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

