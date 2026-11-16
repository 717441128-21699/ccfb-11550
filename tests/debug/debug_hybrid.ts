import { decodeHybridWithLengthPrefix } from '../../src/core/encodings.js';

// From 02_primitive_gzip page 0, def stream (after the 4-byte length prefix 26):
const body = new Uint8Array([
  0x1a, 0x00, 0x00, 0x00,
  0x1c, 0x01, 0x0f, 0xfe, 0xcf, 0xfb, 0xfb, 0xd7, 0xf7, 0xfe, 0x22, 0x01, 0x0d, 0x5a,
  0xc5, 0xfe, 0xdf, 0xfd, 0xba, 0x46, 0x01, 0x09, 0xfe, 0xef, 0xfb, 0x1f,
]);
try {
  const defs = decodeHybridWithLengthPrefix(body, 1, 200);
  console.log('decoded', defs.length, 'defs; first 20:', defs.slice(0, 20).join(','));
  console.log('distinct:', [...new Set(defs)]);
} catch (e) {
  console.log('FAIL', e instanceof Error ? e.message : String(e));
}

