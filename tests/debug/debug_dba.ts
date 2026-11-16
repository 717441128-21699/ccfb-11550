import { readFileSync } from 'node:fs';
import { decodeDeltaBinaryPacked32WithOffset } from '../../src/core/encodings.js';

const data = readFileSync('tests/data/_delta_s.bin');
const prefix = decodeDeltaBinaryPacked32WithOffset(data);
console.log('prefix consumed', prefix.bytesConsumed, 'values', prefix.values.slice(0, 8));
const suffix = decodeDeltaBinaryPacked32WithOffset(data.subarray(prefix.bytesConsumed));
console.log('suffix consumed', suffix.bytesConsumed, 'lengths', suffix.values.slice(0, 8));
console.log('total file', data.length, 'suffix data starts at', prefix.bytesConsumed + suffix.bytesConsumed);

