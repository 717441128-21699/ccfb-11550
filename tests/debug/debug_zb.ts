import { readFileSync } from 'node:fs';
const b = Array.from(readFileSync('tests/data/03_primitive_zstd.parquet').subarray(41, 60));
console.log(b.map((x) => x.toString(16).padStart(2, '0')).join(' '));
// frame: 4 magic, 1 descriptor (0x20), then block header 3 bytes
const bh = b[5] | (b[6] << 8) | (b[7] << 16);
console.log('block header raw =', bh, 'lastBlock', bh & 1, 'type', (bh >> 1) & 3, 'size', bh >>> 3);
// descriptor 0x20 = singleSegment flag?
console.log('descriptor 0x20: singleSegment=', (0x20 & 0x20) !== 0, 'fcsFlag=', 0x20 >>> 6);

