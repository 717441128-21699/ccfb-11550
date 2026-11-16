import { readFileSync } from 'node:fs';
import { MemoryFile, ByteReader } from '../../src/core/io.js';
import { readFooter, readPageHeader } from '../../src/core/metadata.js';
import { decompressPage } from '../../src/core/codecs.js';
import { decodeRleBitPackedHybrid } from '../../src/core/encodings.js';

const target = process.argv[2] ?? '13_int_widths.parquet';
const bytes = readFileSync(`tests/data/${target}`);
const file = new MemoryFile(bytes, target);
const { metadata } = await readFooter(file);
const meta = metadata.rowGroups[0].columns[0].metaData!;
let offset = Number(meta.dataPageOffset);
const { header } = await readPageHeader(file, offset);
const comp = await file.readAt(header.bodyOffset, header.compressedPageSize);
const body = await decompressPage(comp, { codec: meta.codec, pageLabel: 'd', uncompressedSize: header.uncompressedPageSize });

// def: 4-byte len + data
const defLen = new ByteReader(body).u32();
let p = 4 + defLen;
console.log('after defs at', p, 'byte=', body[p]);
const bitWidth = body[p];
p++;
const streamLen = new ByteReader(body.subarray(p)).u32();
p += 4;
console.log('index bitWidth', bitWidth, 'streamLen', streamLen, 'stream starts', p);
const stream = body.subarray(p, p + streamLen);
console.log('stream hex:', [...stream.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
const indices = decodeRleBitPackedHybrid(stream, bitWidth, 200);
console.log('indices count', indices.length, 'first15', indices.slice(0, 15).join(','));

