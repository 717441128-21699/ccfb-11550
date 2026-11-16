import { readFileSync } from 'node:fs';
const bytes = readFileSync('tests/data/24_all_nulls.parquet');
for (const off of [19, 20, 21, 22]) {
  console.log(`@${off}:`, [...bytes.slice(off, off + 24)]
    .map((b) => b.toString(16).padStart(2, '0')).join(' '));
}

