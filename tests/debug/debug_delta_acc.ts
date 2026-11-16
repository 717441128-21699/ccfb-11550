import { readFileSync } from 'node:fs';
import { ByteReader, zigzagDecode } from '../../src/core/io.js';
import { unpackLittleEndian } from '../../src/core/encodings.js';

const body = readFileSync('tests/data/_delta_s.bin');
const data = body.subarray(36);
const r = new ByteReader(data);
const blockSize = r.varint();
const numMini = r.varint();
const total = r.varint();
const first = zigzagDecode(r.varint());
const miniBlockSize = blockSize / numMini;
const out = new Array(total);
out[0] = first;
let written = 1;
const minDelta = zigzagDecode(r.varint());
const widths = [];
for (let i = 0; i < numMini; i++) widths.push(r.u8());
const valuesLeft = Math.min(blockSize, total - written);
console.log('out[0] before loop =', out[0], 'r.offset', r.offset);
for (let mb = 0; mb < numMini; mb++) {
  const take = Math.min(miniBlockSize, valuesLeft - mb * miniBlockSize);
  const tmp: number[] = [];
  unpackLittleEndian(data, r.offset * 8, widths[mb], miniBlockSize, tmp, 0);
  r.offset += Math.ceil((miniBlockSize * widths[mb]) / 8);
  console.log(`mb${mb} bw=${widths[mb]} take=${take} tmp hasNaN=${tmp.some(Number.isNaN)} tmpAll=${tmp.join(',')}`);
  if (mb === 0) {
    for (let i = 0; i < take; i++) {
      if (i < 3) console.log(`  i=${i} written=${written} prev=${out[written - 1]}(${typeof out[written - 1]}) tmp=${tmp[i]}(${typeof tmp[i]}) md=${minDelta}(${typeof minDelta}) sum=${out[written - 1] + tmp[i] + minDelta}`);
      out[written++] = out[written - 1] + tmp[i] + minDelta;
    }
  } else {
    for (let i = 0; i < take; i++) out[written++] = out[written - 1] + tmp[i] + minDelta;
  }
}
console.log('after block0 first8:', out.slice(0, 8), 'written', written);

