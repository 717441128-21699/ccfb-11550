"""Decompress a snappy block and save the reference output for byte diffing."""
import sys
import snappy

path = sys.argv[1]
off = int(sys.argv[2])
length = int(sys.argv[3])
out_path = sys.argv[4]
data = open(path, 'rb').read()
block = data[off:off + length]
out = snappy.decompress(block)
open(out_path, 'wb').write(out)
print('wrote', len(out), 'bytes to', out_path)
