import { readFileSync } from 'node:fs';
import { unpackLittleEndian } from '../../src/core/encodings.js';

const body = readFileSync('tests/data/_delta_s.bin');
const data = body.subarray(36 + 11); // mini-block data starts at file offset 11
const out: number[] = [];
unpackLittleEndian(data, 0, 3, 32, out, 0);
console.log('32 values bw=3:', out.join(','));
console.log('has NaN:', out.some((v) => Number.isNaN(v)));
// expected deltas relative; just check they're small ints

