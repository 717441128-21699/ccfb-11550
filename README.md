# 浏览器版 Parquet 拆解工具

一个**纯 TypeScript、零 Parquet 第三方依赖**的本地 Parquet 解析器与四栏可视化界面。
文件全程在浏览器内解析，不上传、不离开本机；通过分块随机访问支持 2GB 级文件。

## 快速开始

```bash
npm install
npm run dev        # 启动 http://localhost:5173，拖入 .parquet 文件即可
npm run build      # 类型检查 + 生产构建到 dist/
npm run test       # 50 个 pyarrow 生成文件的逐值一致性测试
npm run test:e2e   # Playwright 真实浏览器端到端测试
npm run gen        # 重新生成 50 个不同写法的测试文件（需 Python + pyarrow）
```

## 四栏界面

1. **文件概览** — 尾部 Thrift 元数据、版本、行数、KV 元信息，以及带
   `group / repeated`、定义级（DL）、重复级（RL）、物理与逻辑类型标注的 schema 树。
2. **行组与列块** — 每个 row group / column chunk，点击后展示压缩方式、编码、
   尺寸，并把 min/max/null_count 统计与**从真实页数据重新计算**的结果核对，错误标红。
3. **页级明细** — 每个 page 的类型、编码、值数、压缩前后大小，以及解压状态；
   无法解压的页会精确标注是哪个行列的哪一页，而不是整体失败。
4. **数据浏览** — 分页查看解码值，可切换物理值/逻辑值；嵌套列以 JSON 行展示
   按 definition/repetition level 还原的结构。

## 架构

```
src/core/
  io.ts        随机访问抽象、LRU 分块缓存、ByteReader、varint/zigzag
  thrift.ts    描述符驱动的 Thrift Compact Protocol 解码器（无代码生成库）
  types.ts     parquet.thrift 枚举/结构与 schema 树模型
  metadata.ts  FileMetaData 解析、schema 树与 DL/RL/空值阈值计算
  encodings.ts RLE/bit-packing hybrid、legacy bit-packing、
               DELTA_BINARY_PACKED(32/64)、DELTA_LENGTH_BYTE_ARRAY、DELTA_BYTE_ARRAY
  codecs.ts    手写 Snappy raw block、GZIP(DecompressionStream)、ZSTD 分发
  zstd.ts      手写 ZSTD 帧解码器（FSE 表、Huffman 字面量、序列匹配）
  value.ts     PLAIN 物理解码 + 逻辑类型（DECIMAL/DATE/TIME/TIMESTAMP/INT96/UUID…）
  column.ts    页遍历、definition/repetition level、字典与各编码数据装配
  stats.ts     min/max/null_count 与真实数据的交叉校验
  assembler.ts 按 DL/RL 把打平列还原成嵌套 JSON（LIST/MAP/struct）
  parquet.ts   门面：按需读取列块/行组/行，不预读整个文件
src/ui/        Vite + 原生 DOM 的四栏界面与 Blob 随机访问源
```

### 大文件策略

`CachedFile` 以 4MiB 块（可配置）缓存随机读取，只在命中时拉取对应字节区间，
footer 与各 page header 复用缓存，不会把整个文件读入内存。UI 侧 `Blob.slice()`
天然支持范围读取；Node 测试侧提供等价的文件描述符实现。

## 编码与压缩覆盖

- **编码**：PLAIN、PLAIN_DICTIONARY / RLE_DICTIONARY、RLE 与 bit-packing hybrid、
  legacy BIT_PACKED、DELTA_BINARY_PACKED（INT32/INT64）、DELTA_LENGTH_BYTE_ARRAY、
  DELTA_BYTE_ARRAY。
- **压缩**：UNCOMPRESSED、SNAPPY（手写）、GZIP（Web Streams，Node 回退 zlib）、
  ZSTD（手写，见下方限制）。
- **逻辑类型**：STRING/ENUM/JSON、INT(8..64, 有/无符号)、DECIMAL（INT32/INT64/
  FIXED_LEN_BYTE_ARRAY，含 256 位）、DATE、TIME、TIMESTAMP（ms/us/ns）、INT96、
  UUID、FLOAT16。

## 测试

`tests/generate_files.py` 用 pyarrow 生成 50 个覆盖不同系统/写法的文件，并导出
pyarrow 读到的规范 JSON。`tests/run_tests.ts` 对每个文件：

- 逐值比对每个叶子列与 pyarrow 结果；
- 比对完整嵌套 JSON 行；
- 核对 null 计数与 min/max 统计；
- 校验随机访问读取字节数有界。

当前 **45/50 完整通过**。

## 已知限制

剩余 5 个文件均为优雅降级，不影响其它列与页结构的展示：

- 4 个文件使用了高压缩率 ZSTD 字典页（Huffman 多流 + FSE mode 2/3 双分布）。
  手写 ZSTD 解码器覆盖常见单块帧与预定义/原始 FSE 表；这些复杂块会在**页级明细**
  中精确报错（行列名 + 页类型 + 页序号），数据页相应降级，界面不崩溃。
- 1 个 `list<struct<list>>` 深层嵌套（list 内嵌 struct 再内嵌 list）的最内层数组
  尚未合并回 struct 字段，同列的标量字段与外层结构正确。

这些场景在 `tests/run_tests.ts` 中以显式断言保留，便于后续补全时直接验证。
