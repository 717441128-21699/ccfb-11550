import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressSnappy } from '../../src/core/codecs.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? '06_large_rows.parquet';
const bytes = readFileSync(join(here, 'data', target));
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);

for (let ci = 0; ci < 2; ci++) {
  const meta = metadata.rowGroups[0].columns[ci].metaData!;
  let offset = Number(meta.dataPageOffset);
  const { header } = await readPageHeader(file, offset);
  const compressed = await file.readAt(header.bodyOffset, header.compressedPageSize);
  const body = decompressSnappy(compressed, header.uncompressedPageSize);
  const r = new ByteReader(body);
  const defLen = r.u32();
  console.log(`\ncol ${ci} (${meta.pathInSchema.join('.')}) defLen=${defLen} bodyLen=${body.length}`);
  // walk runs
  let p = 4;
  const end = 4 + defLen;
  let runs = 0;
  let total = 0;
  while (p < end && runs < 8) {
    // read varint
    let hdr = 0, shift = 0, start = p;
    for (;;) {
      const b = body[p++];
      hdr |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if ((hdr & 1) === 0) {
      const groups = hdr >>> 1;
      const cnt = groups * 8;
      const byteCost = Math.ceil((cnt * 1) / 8);
      console.log(`  @${start} bit-packed header=${hdr} groups=${groups} values=${cnt} byteCost=${byteCost}`);
      p += byteCost;
      total += cnt;
    } else {
      const cnt = hdr >>> 1;
      const val = body[p++];
      console.log(`  @${start} RLE header=${hdr} count=${cnt} value=${val}`);
      total += cnt;
    }
    runs++;
  }
  console.log(`  total so far ${total}, stream ended at ${p}/${end}`);
}

