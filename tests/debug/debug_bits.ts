import { unpackLittleEndian } from '../../src/core/encodings.js';
import { decodeRleBitPackedHybrid } from '../../src/core/encodings.js';

// One bit-packed group: 8 booleans from byte 0b10110100 LSB-first
// bits LSB->MSB: 0,0,1,0,1,1,0,1
const data = new Uint8Array([0b10110100]);
const out: number[] = [];
unpackLittleEndian(data, 0, 1, 8, out, 0);
console.log('unpacked bits:', out.join(','), 'expected 0,0,1,0,1,1,0,1');

// Hybrid stream: bit-packed run header = 2*1 = 2 (odd? no, 2 is even=RLE under old,
// but under corrected spec odd=bitpack). One group header should be 2*1+1=3.
const stream = new Uint8Array([3, 0b10110100]);
const vals = decodeRleBitPackedHybrid(stream, 1, 8);
console.log('hybrid:', vals.join(','));

