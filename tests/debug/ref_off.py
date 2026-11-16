"""Print tag #39 context with both offset interpretations, plus surrounding
tags, to pin down the COPY1 bit layout."""
import sys

path = sys.argv[1]
off = int(sys.argv[2])
length = int(sys.argv[3])
block = open(path, 'rb').read()[off:off + length]

# skip varint
p = 0
shift = 0
while True:
    b = block[p]; p += 1
    if not (b & 0x80):
        break
    shift += 7

tag_no = 0
while p < len(block):
    tag = block[p]; at = p; p += 1
    kind = tag & 3
    tag_no += 1
    if kind == 1:
        nxt = block[p]
        # Spec: length = 4 + ((tag >> 2) & 7); offset = ((tag & 0xe0) << 3) | nxt
        spec_len = 4 + ((tag >> 2) & 0x07)
        spec_off = ((tag & 0xe0) << 3) | nxt
        alt_off = (((tag >> 5) & 0x07) << 8) | nxt
        if 36 <= tag_no <= 42:
            print(f'#{tag_no} @{at} tag=0x{tag:02x} next=0x{nxt:02x} '
                  f'spec: len={spec_len} off={spec_off}  alt: off={alt_off}')
        p += 1
    elif kind == 0:
        six = tag >> 2
        if six < 60:
            p += six + 1
        else:
            ex = six - 59
            lit = 1
            for i in range(ex):
                lit += block[p] << (8 * i); p += 1
            p += lit - (lit - 1)  # already counted stored; move by stored
    elif kind == 2:
        p += 2
    else:
        p += 4
