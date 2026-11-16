import { ByteReader } from '../../src/core/io.js';

const stream = new Uint8Array([
  0x1c, 0x01, 0x0f, 0xfe, 0xcf, 0xfb, 0xfb, 0xd7, 0xf7, 0xfe, 0x22, 0x01, 0x0d, 0x5a,
  0xc5, 0xfe, 0xdf, 0xfd, 0xba, 0x46, 0x01, 0x09, 0xfe, 0xef, 0xfb, 0x1f,
]);
const reader = new ByteReader(stream);
let produced = 0;
let runNo = 0;
while (reader.remaining > 0 && produced < 200) {
  const at = reader.offset;
  const header = reader.varint();
  runNo++;
  if ((header & 1) === 0) {
    const count = header;
    const bw = 1;
    reader.offset += Math.ceil((count * bw) / 8);
    console.log(`run${runNo} @${at} BITPACK count=${count} advance=${Math.ceil(count / 8)} -> offset ${reader.offset}`);
    produced += count;
  } else {
    const count = header >>> 1;
    const value = reader.u8();
    console.log(`run${runNo} @${at} RLE count=${count} value=${value} -> offset ${reader.offset}`);
    produced += count;
  }
}
console.log('produced', produced, 'remaining', reader.remaining);

