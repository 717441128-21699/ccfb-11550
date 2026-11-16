import { ParquetFile } from '../core/parquet.js';
import { checkStatistics } from '../core/stats.js';
import { valueToText, type DecodedValue } from '../core/value.js';
import {
  CompressionCodec,
  ConvertedType,
  Encoding,
  FieldRepetitionType,
  PageType,
  Type,
  type SchemaNode,
} from '../core/types.js';
import { openParquetSource } from './blob-file.js';

const grid = document.getElementById('grid')!;
const dropzone = document.getElementById('dropzone')!;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const overlay = document.getElementById('dropOverlay')!;
const errorBanner = document.getElementById('errorBanner')!;
const overviewEl = document.getElementById('overview')!;
const rgListEl = document.getElementById('rgList')!;
const chunkDetailEl = document.getElementById('chunkDetail')!;
const pagesEl = document.getElementById('pages')!;
const tableWrap = document.getElementById('tableWrap')!;
const pageInfo = document.getElementById('pageInfo')!;
const prevBtn = document.getElementById('prevPage') as HTMLButtonElement;
const nextBtn = document.getElementById('nextPage') as HTMLButtonElement;
const rawToggle = document.getElementById('rawToggle') as HTMLInputElement;

let pf: ParquetFile | null = null;
let selectedRG = 0;
let selectedLeaf = 0;
let rowPage = 0;
const ROWS_PER_PAGE = 100;

function showError(msg: string): void {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
  setTimeout(() => (errorBanner.hidden = true), 8000);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function typeName(t: Type | undefined): string {
  return t === undefined ? 'GROUP' : Type[t];
}

function repName(r: FieldRepetitionType | undefined): string {
  return r === undefined ? '' : FieldRepetitionType[r].toLowerCase();
}

// ---------- Panel 1: overview ----------

function renderOverview(): void {
  if (!pf) return;
  const m = pf.metadata;
  const kv = m.keyValueMetadata ?? [];
  const schemaHtml = renderSchemaTree(pf.schemaRoot, 0);
  overviewEl.innerHTML = `
    <dl class="kv">
      <dt>文件名</dt><dd>${esc(pf.cached.name)}</dd>
      <dt>文件大小</dt><dd>${pf.size.toLocaleString()} 字节</dd>
      <dt>版本</dt><dd>${m.version}${m.createdBy ? ` · ${esc(m.createdBy)}` : ''}</dd>
      <dt>行数</dt><dd>${m.numRows.toString()}</dd>
      <dt>行组数</dt><dd>${m.rowGroups.length}</dd>
      <dt>叶子列数</dt><dd>${pf.leaves.length}</dd>
      <dt>读取缓存</dt><dd>${pf.cacheStats.blocks} 块 · ${(pf.cacheStats.cachedBytes / 1024).toFixed(1)} KiB</dd>
      ${kv.map((x) => `<dt>${esc(x.key)}</dt><dd>${x.value ? esc(x.value) : ''}</dd>`).join('')}
    </dl>
    <h3 style="margin:16px 0 8px;font-size:13px;color:var(--muted)">Schema</h3>
    <div class="schema-tree">${schemaHtml}</div>
  `;
}

function renderSchemaTree(node: SchemaNode, depth: number): string {
  const repeated = node.repetition === FieldRepetitionType.REPEATED;
  const logical = node.logicalType ? logicalLabel(node) : '';
  const conv = node.convertedType !== undefined && !node.logicalType
    ? `<span class="badge">${ConvertedType[node.convertedType]}</span>` : '';
  const typeBadge = node.physicalType !== undefined
    ? `<span class="badge type">${typeName(node.physicalType)}${node.typeLength ? `(${node.typeLength})` : ''}</span>` : '';
  const repBadge = node.repetition !== undefined ? `<span class="badge">${repName(node.repetition)}</span>` : '';
  const children = node.children
    .map((c) => renderSchemaTree(c, depth + 1))
    .join('');
  return `
    <div class="schema-node ${repeated ? 'repeated' : ''}">
      <span class="nm">${esc(node.name)}</span>
      ${repBadge}${typeBadge}${logical}${conv}
      <span class="meta">DL=${node.maxDefinitionLevel} RL=${node.maxRepetitionLevel}</span>
      ${children ? `<div class="schema-children">${children}</div>` : ''}
    </div>`;
}

function logicalLabel(node: SchemaNode): string {
  const lt = node.logicalType!;
  let label = lt.type;
  if (lt.type === 'DECIMAL') label += `(${lt.precision},${lt.scale})`;
  if (lt.type === 'INTEGER') label += `(${lt.bitWidth},${lt.isSigned ? 'signed' : 'unsigned'})`;
  if (lt.type === 'TIMESTAMP' || lt.type === 'TIME') label += ` ${lt.unit!.kind}`;
  return `<span class="badge logical">${esc(label)}</span>`;
}

// ---------- Panel 2: row groups & column chunks ----------

function renderRowGroups(): void {
  if (!pf) return;
  rgListEl.innerHTML = pf.metadata.rowGroups
    .map((rg, rgi) => {
      const chips = rg.columns
        .map((cc, ci) => {
          const leaf = pf!.leaves[ci];
          const codec = CompressionCodec[cc.metaData!.codec];
          const active = rgi === selectedRG && ci === selectedLeaf ? ' active' : '';
          return `<button class="chunk-chip${active}" data-rg="${rgi}" data-ci="${ci}">
            ${esc(leaf.name)}<span class="codec">${codec}</span></button>`;
        })
        .join('');
      return `
        <div class="rg-card">
          <h3>行组 ${rgi} · ${rg.numRows.toString()} 行 · ${rg.columns.length} 列块</h3>
          <div class="chunk-grid">${chips}</div>
        </div>`;
    })
    .join('');
  rgListEl.querySelectorAll<HTMLElement>('.chunk-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      selectedRG = Number(chip.dataset.rg);
      selectedLeaf = Number(chip.dataset.ci);
      rowPage = 0;
      renderRowGroups();
      void renderChunkDetail();
    });
  });
}

async function renderChunkDetail(): Promise<void> {
  if (!pf) return;
  const leaf = pf.leaves[selectedLeaf];
  const chunk = pf.metadata.rowGroups[selectedRG].columns[selectedLeaf];
  const meta = chunk.metaData!;
  chunkDetailEl.innerHTML = '<p class="hint">读取列块并校验统计…</p>';
  let overview;
  try {
    overview = await pf.readRowGroup(selectedRG);
  } catch (err) {
    chunkDetailEl.innerHTML = `<p class="compress-err">读取失败：${esc((err as Error).message)}</p>`;
    return;
  }
  const col = overview.columns[selectedLeaf];
  const check = checkStatistics(col.read);
  const encodings = meta.encodings.map((e) => Encoding[e]).join(', ');
  const statNull = check.nullCount.ok ? 'ok' : 'bad';
  const statMin = check.min.ok ? 'ok' : 'bad';
  const statMax = check.max.ok ? 'ok' : 'bad';
  chunkDetailEl.innerHTML = `
    <dl class="kv">
      <dt>路径</dt><dd>${esc(meta.pathInSchema.join(' / '))}</dd>
      <dt>物理类型</dt><dd>${typeName(leaf.physicalType)}</dd>
      <dt>压缩</dt><dd>${CompressionCodec[meta.codec]}</dd>
      <dt>编码</dt><dd>${esc(encodings)}</dd>
      <dt>值记录数</dt><dd>${meta.numValues.toString()}</dd>
      <dt>压缩大小</dt><dd>${meta.totalCompressedSize.toString()} B</dd>
      <dt>解压大小</dt><dd>${meta.totalUncompressedSize.toString()} B</dd>
    </dl>
    <div class="stat-row">
      <span class="stat-pill ${statNull}">null 计数 ${check.nullCount.actual}${check.nullCount.ok ? ' ✓' : ' ✗'}</span>
      <span class="stat-pill ${statMin}">min ${check.min.actual === undefined ? '—' : esc(valueToText(check.min.actual))}${check.min.ok ? ' ✓' : ' ✗'}</span>
      <span class="stat-pill ${statMax}">max ${check.max.actual === undefined ? '—' : esc(valueToText(check.max.actual))}${check.max.ok ? ' ✓' : ' ✗'}</span>
    </div>
    ${check.issues.length ? `<p class="compress-err">统计异常：${esc(check.issues.join('；'))}</p>` : '<p class="stat-pill ok">统计与真实数据一致</p>'}
  `;
  void renderPages();
  const isNested = pf.leaves.some((n) => n.maxRepetitionLevel > 0);
  void (isNested ? renderNestedRows() : renderDataTable());
}

// ---------- Panel 3: pages ----------

async function renderPages(): Promise<void> {
  if (!pf) return;
  const overview = await pf.readRowGroup(selectedRG);
  const col = overview.columns[selectedLeaf];
  const rows = col.read.pages
    .map((p) => {
      const t = PageType[p.header.type];
      const enc = p.encoding !== undefined ? Encoding[p.encoding] : '—';
      const err = p.decompressionError
        ? `<span class="compress-err">${esc(p.decompressionError)}</span>`
        : '<span class="compress-ok">已解压</span>';
      return `
        <tr class="${p.decompressionError ? 'page-error' : ''}">
          <td>${p.ordinal}</td>
          <td>${t}</td>
          <td class="enc-tag">${enc}</td>
          <td>${p.numValues}</td>
          <td>${p.compressedSize} / ${p.uncompressedSize}</td>
          <td>${err}</td>
        </tr>`;
    })
    .join('');
  pagesEl.innerHTML = `
    <table class="page-table">
      <thead><tr><th>#</th><th>类型</th><th>编码</th><th>值数</th><th>压缩/解压 B</th><th>压缩状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${col.read.pages.some((p) => p.decompressionError)
      ? '<p class="compress-err" style="margin-top:10px">存在无法解压的页（见上表红字），已跳过其数据但保留页结构。</p>' : ''}`;
}

// ---------- Panel 4: data browsing ----------

async function renderDataTable(): Promise<void> {
  if (!pf) return;
  const overview = await pf.readRowGroup(selectedRG);
  const col = overview.columns[selectedLeaf];
  const leaf = pf.leaves[selectedLeaf];
  const read = col.read;
  const totalRows = Number(pf.metadata.rowGroups[selectedRG].numRows);
  const totalPages = Math.max(1, Math.ceil(totalRows / ROWS_PER_PAGE));
  rowPage = Math.min(rowPage, totalPages - 1);
  prevBtn.disabled = rowPage === 0;
  nextBtn.disabled = rowPage >= totalPages - 1;
  pageInfo.textContent = `行 ${rowPage * ROWS_PER_PAGE}–${Math.min((rowPage + 1) * ROWS_PER_PAGE, totalRows)} / ${totalRows}`;

  // For a flat leaf, read.values aligns to records; show a single column.
  const values: DecodedValue[] = rawToggle.checked ? read.physicalValues : read.values;
  const start = rowPage * ROWS_PER_PAGE;
  const slice = values.slice(start, start + ROWS_PER_PAGE);
  const rowsHtml = slice
    .map((v, i) => {
      if (v === null) return `<tr><td class="num">${start + i}</td><td class="null">null</td></tr>`;
      const text = valueToText(v);
      const cls = typeof v === 'number' || typeof v === 'bigint' ? 'num' : '';
      return `<tr><td class="num">${start + i}</td><td class="${cls}">${esc(text)}</td></tr>`;
    })
    .join('');
  tableWrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th style="width:70px">#</th><th>${esc(leaf.name)} (${typeName(leaf.physicalType)})</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

// ---------- Nested JSON row view ----------

async function renderNestedRows(): Promise<void> {
  if (!pf) return;
  const totalRows = Number(pf.metadata.rowGroups[selectedRG].numRows);
  const totalPages = Math.max(1, Math.ceil(totalRows / ROWS_PER_PAGE));
  rowPage = Math.min(rowPage, totalPages - 1);
  prevBtn.disabled = rowPage === 0;
  nextBtn.disabled = rowPage >= totalPages - 1;
  pageInfo.textContent = `行 ${rowPage * ROWS_PER_PAGE}–${Math.min((rowPage + 1) * ROWS_PER_PAGE, totalRows)} / ${totalRows}`;
  const rows = await pf.readRows(selectedRG);
  const slice = rows.slice(rowPage * ROWS_PER_PAGE, (rowPage + 1) * ROWS_PER_PAGE);
  tableWrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th style="width:70px">#</th><th>JSON 行</th></tr></thead>
      <tbody>${slice
        .map((r, i) => `<tr><td class="num">${rowPage * ROWS_PER_PAGE + i}</td>
          <td class="nested">${esc(JSON.stringify(r))}</td></tr>`)
        .join('')}</tbody>
    </table>`;
}

// ---------- File loading ----------

async function loadFile(blob: Blob): Promise<void> {
  try {
    const source = openParquetSource(blob);
    pf = await ParquetFile.open(source);
    selectedRG = 0;
    selectedLeaf = 0;
    rowPage = 0;
    grid.hidden = false;
    renderOverview();
    renderRowGroups();
    await renderChunkDetail();
  } catch (err) {
    showError(`解析失败：${(err as Error).message}`);
    throw err;
  }
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) void loadFile(fileInput.files[0]);
});
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});

for (const el of [document.body, dropzone]) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    overlay.hidden = false;
    dropzone.classList.add('drag');
  });
  el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) overlay.hidden = true;
    dropzone.classList.remove('drag');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    overlay.hidden = true;
    dropzone.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f);
  });
}

prevBtn.addEventListener('click', () => {
  rowPage--;
  void (pf!.leaves[selectedLeaf].maxRepetitionLevel > 0 ? renderNestedRows() : renderDataTable());
});
nextBtn.addEventListener('click', () => {
  rowPage++;
  void (pf!.leaves[selectedLeaf].maxRepetitionLevel > 0 ? renderNestedRows() : renderDataTable());
});
rawToggle.addEventListener('change', () => void renderDataTable());
