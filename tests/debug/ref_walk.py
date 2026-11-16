"""Walk a raw snappy block's tag stream using the same accounting the reference
decoder uses, printing every tag so the TS walk can be diffed against it."""
import sys

path = sys.argv[1]
off = int(sys.argv[2])
length = int(sys.argv[3])
data = open(path, 'rb').read()
block = data[off:off + length]

# varint
p = 0
shift = 0
declared = 0
while True:
    b = block[p]; p += 1
    declared |= (b & 0x7f) << shift
    if not (b & 0x80):
        break
    shift += 7
print('declared', declared)

out_pos = 0
tag_no = 0
while p < len(block):
    at = p
    tag = block[p]; p += 1
    kind = tag & 3
    tag_no += 1
    if kind == 0:
        six = tag >> 2
        if six < 60:
            lit = six + 1
        else:
            ex = six - 59
            stored = 0
            for i in range(ex):
                stored |= block[p] << (8 * i); p += 1
            lit = stored + 1
        p += lit
        out_pos += lit
        detail = f'LIT len={lit}'
    elif kind == 1:
        length_copy = 4 + (tag >> 2)
        offset_copy = ((tag >> 5) & 0x07) << 8 | block[p]; p += 1
        out_pos += length_copy
        detail = f'COPY1 len={length_copy} off={offset_copy}'
    elif kind == 2:
        length_copy = 1 + (tag >> 2)
        offset_copy = block[p] | (block[p + 1] << 8); p += 2
        out_pos += length_copy
        detail = f'COPY2 len={length_copy} off={offset_copy}'
    else:
        length_copy = 1 + (tag >> 2)
        offset_copy = block[p] | (block[p + 1] << 8) | (block[p + 2] << 16) | (block[p + 3] << 24); p += 4
        out_pos += length_copy
        detail = f'COPY4 len={length_copy} off={offset_copy}'
    if 70 <= tag_no <= 80:
        print(f'#{tag_no} @{at} tag=0x{tag:02x} {detail} outPos={out_pos}')
print('walk total', out_pos, 'declared', declared, 'tags', tag_no, 'consumed', p, len(block))
