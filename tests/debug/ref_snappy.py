"""Read page ranges from tests/data/_pages.txt (written by Node, utf-8) and
cross-check each snappy block against the reference python-snappy decoder."""
import sys
import snappy

path = sys.argv[1]
ranges_path = sys.argv[2]
data = open(path, 'rb').read()

with open(ranges_path, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        off, length = map(int, line.split())
        block = data[off:off + length]
        try:
            out = snappy.decompress(block)
            print(f'{off} {length} OK len={len(out)} head={out[:12].hex()}')
        except Exception as exc:
            print(f'{off} {length} FAIL {exc}')
