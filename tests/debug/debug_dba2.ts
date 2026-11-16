import { readFileSync } from 'node:fs';
import { ByteReader } from '../../src/core/io.js';
import { decodeDeltaByteArray } from '../../src/core/encodings.js';

const body = readFileSync('tests/data/_delta_s.bin');
const defLen = new ByteReader(body).u32();
console.log('def stream len', defLen);
const payloadStart = 4 + defLen;
console.log('payload starts at', payloadStart, 'hex:', [...body.slice(payloadStart, payloadStart + 8)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
const arr = decodeDeltaByteArray(body.subarray(payloadStart));
console.log('decoded', arr.length, 'first3:', arr.slice(0, 3).map((u) => Buffer.from(u).toString()));

