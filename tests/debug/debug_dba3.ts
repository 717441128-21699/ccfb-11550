import { readFileSync } from 'node:fs';
import { decodeDeltaBinaryPacked32WithOffset } from '../../src/core/encodings.js';

const body = readFileSync('tests/data/_delta_s.bin');
const data = body.subarray(36);
const p = decodeDeltaBinaryPacked32WithOffset(data);
console.log('prefix count', p.values.length, 'consumed', p.bytesConsumed, 'first8', p.values.slice(0, 8));
const s = decodeDeltaBinaryPacked32WithOffset(data.subarray(p.bytesConsumed));
console.log('suffix count', s.values.length, 'consumed', s.bytesConsumed, 'first8', s.values.slice(0, 8));
console.log('header bytes:', [...data.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

