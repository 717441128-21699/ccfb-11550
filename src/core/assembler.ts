// Reconstruct nested JSON rows from per-leaf definition/repetition level
// streams (Parquet shredding model).
//
// Each leaf column's records for one row are converted by walking the schema
// path and switching on the container kind at each level:
//   - standard 3-level LIST  -> plain JSON array
//   - MAP                    -> plain JSON object
//   - generic repeated group -> array of objects
//   - plain struct           -> object
// Empty containers (present, no elements) differ from null fields via the
// schema node's nullDefinitionLevel / maxDefinitionLevel.

import { FieldRepetitionType, SchemaNode } from './types.js';
import type { ColumnReadResult } from './column.js';
import type { DecodedValue } from './value.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface LeafRecords {
  defs: number[];
  reps: number[];
  values: DecodedValue[];
}

const PAIR_MARKER = '__mapPair';

function isListWrapper(node: SchemaNode): boolean {
  if (node.logicalType?.type === 'LIST') return true;
  const child = node.children[0];
  return (
    node.children.length === 1 &&
    child !== undefined &&
    child.repetition === FieldRepetitionType.REPEATED
  );
}

function isMapGroup(node: SchemaNode): boolean {
  // The node may be the outer MAP group (logical type MAP) or the repeated
  // key_value entry itself (a repeated group with exactly key/value children).
  if (node.logicalType?.type === 'MAP') return true;
  if (
    node.repetition === FieldRepetitionType.REPEATED &&
    node.children.length === 2 &&
    node.children[0].name === 'key' &&
    node.children[1].name === 'value'
  ) {
    return true;
  }
  const child = node.children[0];
  return (
    node.children.length === 1 &&
    child !== undefined &&
    child.repetition === FieldRepetitionType.REPEATED &&
    child.children.length === 2 &&
    (child.name === 'key_value' || child.name === 'keyValue')
  );
}

function normalizeScalar(v: DecodedValue): JsonValue {
  if (v === null) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) {
    return '0x' + [...v].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (v as any).toString?.() ?? String(v);
}

function resolveNodePath(root: SchemaNode, namePath: string[]): SchemaNode[] {
  const out: SchemaNode[] = [];
  let current = root;
  for (let depth = 1; depth < namePath.length; depth++) {
    const next = current.children.find((c) => c.name === namePath[depth]);
    if (!next) throw new Error(`schema path broken at ${namePath[depth]}`);
    out.push(next);
    current = next;
  }
  return out;
}

interface BuildCtx {
  index: number;
  records: LeafRecords;
}

/** Entry point: build one top-level field from one column's row records. */
export function buildField(path: SchemaNode[], records: LeafRecords): JsonValue {
  if (records.defs.length === 0) return null;
  const top = path[0];
  // Whole field null?
  if (records.defs[0] < top.nullDefinitionLevel) return null;

  const ctx: BuildCtx = { index: 0, records };
  return buildLevel(path, 0, ctx);
}

/**
 * Build the value contributed at path[depth]. Consumes records whose rep level
 * belongs to this node; stops when a record belongs to an outer level.
 */
function buildLevel(path: SchemaNode[], depth: number, ctx: BuildCtx): JsonValue {
  const node = path[depth];
  const isLeaf = depth === path.length - 1;

  if (node.repetition !== FieldRepetitionType.REPEATED) {
    return buildNonRepeated(path, depth, ctx, isLeaf);
  }

  // Repeated node. A repeated group whose subtree (on this leaf's path) is not
  // a MAP is rendered as a LIST array — this covers both the standard 3-level
  // layout and Arrow's extra outer repeated wrapper.
  if (isMapGroup(node)) return buildMap(path, depth, ctx, node);
  return buildList(path, depth, ctx, node, isLeaf);
}

function buildNonRepeated(
  path: SchemaNode[],
  depth: number,
  ctx: BuildCtx,
  isLeaf: boolean,
): JsonValue {
  const node = path[depth];
  const rec = ctx.records.defs[ctx.index];
  if (rec === undefined) return null;
  // Absent optional group/scalar.
  if (rec < node.maxDefinitionLevel) {
    // Only consume a record that belongs to this node (rep 0 at top, or the
    // enclosing repeated level). For nested optional groups inside repeats,
    // records are consumed by the repeated driver instead.
    if (depth === 0 || ctx.records.reps[ctx.index] < (path[depth - 1]?.maxRepetitionLevel ?? 0) + 1) {
      ctx.index++;
    }
    return null;
  }
  if (isLeaf) {
    const v = ctx.records.values[ctx.index];
    ctx.index++;
    return normalizeScalar(v);
  }
  // Descend into the child group.
  const child = path[depth + 1];
  const childValue = buildLevel(path, depth + 1, ctx);
  // A repeated child is either an anonymous LIST/MAP wrapper (transparent) or a
  // named list field nested inside a struct (must keep its field name).
  if (child.repetition === FieldRepetitionType.REPEATED) {
    // Anonymous wrapper nodes inside a LIST/MAP are transparent. A named list
    // field nested inside a struct keeps its name so sibling fields merge.
    const anonymousWrapper = child.name === 'list' || child.name === 'element' || isMapGroup(child);
    if (anonymousWrapper || depth === 0) {
      return childValue;
    }
    return { [node.name]: childValue };
  }
  // Plain struct: key the child by its name.
  return { [child.name]: childValue };
}

/** Standard LIST: one or more nested repeated groups ending at the element. */
function buildList(
  path: SchemaNode[],
  depth: number,
  ctx: BuildCtx,
  node: SchemaNode,
  isLeaf: boolean,
): JsonValue[] {
  // Find the deepest repeated node on the path (the actual element holder),
  // tolerating Arrow's extra outer repeated wrapper (e.g. ids -> list -> elem).
  let deepestRepeated = depth;
  for (let d = depth + 1; d < path.length; d++) {
    if (path[d].repetition === FieldRepetitionType.REPEATED) deepestRepeated = d;
  }
  const holder = path[deepestRepeated];
  const elementNode = holder.children[0];

  // Empty list: record present at the repeated group but below the element.
  if (
    ctx.records.defs[ctx.index] < elementNode.maxDefinitionLevel &&
    ctx.records.defs[ctx.index] >= node.nullDefinitionLevel
  ) {
    ctx.index++;
    return [];
  }

  // Recursively build the (possibly nested) array from repetition levels.
  return buildRepeatedArray(path, depth, deepestRepeated, ctx);
}

/**
 * Build an array for the repeated node at `repDepth`. Nested repeated nodes
 * below it produce nested arrays; the boundary between sibling elements is the
 * node's own repetition level (RL 0 starts the first element of a row).
 */
function buildRepeatedArray(
  path: SchemaNode[],
  repDepth: number,
  deepestRepeated: number,
  ctx: BuildCtx,
): JsonValue[] {
  const node = path[repDepth];
  const elementRep = node.maxRepetitionLevel;
  const array: JsonValue[] = [];
  const startIndex = ctx.index;
  const total = ctx.records.defs.length;

  // Determine the slice of records belonging to this array by scanning until
  // a repetition level below this node's element level appears (outer scope).
  while (ctx.index < total) {
    const rep = ctx.records.reps[ctx.index];
    if (rep < elementRep && ctx.index > startIndex) break;

    // A new element of THIS array starts when rep <= elementRep and we are at
    // an element boundary. For the first record of a row, rep can be 0.
    const startsElement = rep < elementRep || rep === elementRep;

    if (repDepth === deepestRepeated) {
      // Leaf-level repeated holder: emit scalar or struct elements.
      const leaf = path[path.length - 1];
      const elementNode = node.children[0];
      if (path[path.length - 1] === elementNode) {
        if (ctx.records.defs[ctx.index] >= leaf.maxDefinitionLevel) {
          array.push(normalizeScalar(ctx.records.values[ctx.index]));
        } else {
          array.push(null);
        }
        ctx.index++;
      } else {
        array.push(buildElementStruct(path, deepestRepeated + 1, ctx, elementRep));
      }
    } else {
      // Nested repeated: each element is itself an array from the next level.
      if (startsElement || array.length === 0) {
        const nextRepeated = nextRepeatedDepth(path, repDepth, deepestRepeated);
        array.push(buildRepeatedArray(path, nextRepeated, deepestRepeated, ctx));
      } else {
        // Continuation into the current nested array: merge into last element.
        const nextRepeated = nextRepeatedDepth(path, repDepth, deepestRepeated);
        const inner = buildRepeatedArray(path, nextRepeated, deepestRepeated, ctx);
        const last = array[array.length - 1];
        if (Array.isArray(last)) last.push(...inner);
        else array.push(inner);
      }
    }
  }
  return array;
}

function nextRepeatedDepth(path: SchemaNode[], from: number, limit: number): number {
  for (let d = from + 1; d <= limit; d++) {
    if (path[d].repetition === FieldRepetitionType.REPEATED) return d;
  }
  return limit;
}

/**
 * Build one repeated struct element from the CURRENT record. Each column read
 * carries only one leaf, so the element object holds that single leaf key;
 * sibling leaves from other columns merge later via deepMerge on the row.
 */
function buildElementStruct(
  path: SchemaNode[],
  elementDepth: number,
  ctx: BuildCtx,
  elementRep: number,
): Record<string, JsonValue> {
  const obj: Record<string, JsonValue> = {};
  assignLeafPath(path, elementDepth, ctx, obj);
  void elementRep;
  return obj;
}

/** Assign the current leaf record into obj following intermediate struct names. */
function assignLeafPath(
  path: SchemaNode[],
  fromDepth: number,
  ctx: BuildCtx,
  rootObj: Record<string, JsonValue>,
): void {
  let current = rootObj;
  // fromDepth names the struct node that rootObj represents; its own name is
  // not re-wrapped, only the nested struct names below it.
  for (let d = fromDepth + 1; d < path.length - 1; d++) {
    const name = path[d].name;
    let next = current[name];
    if (next === undefined || next === null) {
      next = {};
      current[name] = next;
    }
    current = next as Record<string, JsonValue>;
  }
  const leaf = path[path.length - 1];
  if (ctx.records.defs[ctx.index] >= leaf.maxDefinitionLevel) {
    current[leaf.name] = normalizeScalar(ctx.records.values[ctx.index]);
  } else {
    current[leaf.name] = null;
  }
  ctx.index++;
}

/** Generic repeated group: array of objects (no LIST/MAP convention). */
function buildRepeatedStructs(
  path: SchemaNode[],
  depth: number,
  ctx: BuildCtx,
  node: SchemaNode,
  isLeaf: boolean,
): JsonValue[] {
  const elementRep = node.maxRepetitionLevel;
  const array: JsonValue[] = [];
  if (
    ctx.records.defs[ctx.index] < node.maxDefinitionLevel &&
    ctx.records.defs[ctx.index] >= node.nullDefinitionLevel
  ) {
    ctx.index++;
    return array;
  }
  while (ctx.index < ctx.records.defs.length) {
    const rep = ctx.records.reps[ctx.index];
    if (rep < elementRep) break;
    if (isLeaf) {
      array.push(normalizeScalar(ctx.records.values[ctx.index]));
      ctx.index++;
    } else {
      array.push(buildElementStruct(path, depth, ctx, elementRep));
    }
  }
  return array;
}

/**
 * MAP entry group (the repeated key_value node) -> plain object. Each column
 * carries either the key or the value leaf; sibling columns merge later via
 * mergeAny, keyed by array position before this object is finalized.
 */
function buildMap(
  path: SchemaNode[],
  depth: number,
  ctx: BuildCtx,
  node: SchemaNode,
): Record<string, JsonValue> {
  // `node` is the repeated entry (key_value). Its parent is the outer map group.
  const outerMap = path[depth - 1] ?? node;
  const keyNode = node.children[0];
  const pairRep = node.maxRepetitionLevel;
  const underKey = path.some((n) => n === keyNode);
  const leaf = path[path.length - 1];

  // Empty map: a record present at the outer map level but below the entry.
  if (
    ctx.records.defs[ctx.index] < node.maxDefinitionLevel &&
    ctx.records.defs[ctx.index] >= outerMap.nullDefinitionLevel
  ) {
    ctx.index++;
    return {};
  }

  // Build a parallel structure the row merger can align: an array of pair
  // objects. finalizeMaps collapses it into a plain object once both the key
  // and value columns have merged.
  const pairs: Record<string, JsonValue>[] = [];
  while (ctx.index < ctx.records.defs.length) {
    const rep = ctx.records.reps[ctx.index];
    if (rep < pairRep && ctx.index > 0 && rep !== 0) break;
    let pair = pairs[pairs.length - 1];
    if (pair === undefined || rep === pairRep || rep === 0) {
      pair = { [PAIR_MARKER]: true, key: null, value: null };
      pairs.push(pair);
    }
    if (ctx.records.defs[ctx.index] >= leaf.maxDefinitionLevel) {
      const v = normalizeScalar(ctx.records.values[ctx.index]);
      if (underKey) pair.key = v;
      else pair.value = v;
    }
    ctx.index++;
  }
  // Return as a pair array; finalizeMaps converts to an object.
  return { [PAIR_CONTAINER]: pairs } as unknown as Record<string, JsonValue>;
}

const PAIR_CONTAINER = '__pairs';

export function finalizeMaps(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(finalizeMaps);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, JsonValue>;
    // Collapse a map's working pair array into a plain object.
    if (PAIR_CONTAINER in obj && Array.isArray(obj[PAIR_CONTAINER])) {
      const out: Record<string, JsonValue> = {};
      for (const pair of obj[PAIR_CONTAINER] as Record<string, JsonValue>[]) {
        out[String(pair.key)] = finalizeMaps(pair.value ?? null);
      }
      return out;
    }
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === PAIR_MARKER) continue;
      out[k] = finalizeMaps(v);
    }
    return out;
  }
  return value;
}

/**
 * Assemble all rows. Columns are in schema DFS leaf order with aligned row
 * boundaries (rep 0 starts each top-level row).
 */
export function assembleJsonRows(
  root: SchemaNode,
  columns: ColumnReadResult[],
  rowCount: number,
): JsonValue[] {
  const perColumnSlices: LeafRecords[][] = columns.map((col) => {
    const slices: LeafRecords[] = [];
    let start = 0;
    for (let i = 1; i <= col.repetitionLevels.length; i++) {
      if (i === col.repetitionLevels.length || col.repetitionLevels[i] === 0) {
        slices.push({
          defs: col.definitionLevels.slice(start, i),
          reps: col.repetitionLevels.slice(start, i),
          values: col.values.slice(start, i),
        });
        start = i;
      }
    }
    return slices;
  });

  const rows: JsonValue[] = [];
  for (let row = 0; row < rowCount; row++) {
    const merged: Record<string, JsonValue> = {};
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci];
      const slice = perColumnSlices[ci][row];
      if (!slice) continue;
      const path = resolveNodePath(root, col.node.path);
      const topName = path[0].name;
      const built = buildField(path, slice);
      merged[topName] = mergeTop(merged[topName], path, built);
    }
    rows.push(finalizeMaps(merged));
  }
  return rows;
}

/**
 * Merge a column's built top-level value with what earlier columns already
 * produced. buildField already returns the fully shaped value (scalar, struct
 * object, list array or map object) keyed under the correct nested names, so
 * here we only deep-merge it into the existing row fragment.
 */
function mergeTop(existing: JsonValue | undefined, _path: SchemaNode[], built: JsonValue): JsonValue {
  void _path;
  if (existing === undefined) return built;
  return mergeAny(existing, built);
}

function deepMerge(
  target: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { ...target };
  for (const [k, v] of Object.entries(incoming)) {
    out[k] = k in out ? mergeAny(out[k], v) : v;
  }
  return out;
}

/** Merge two JSON values, recursively combining objects and array elements. */
function mergeAny(target: JsonValue, incoming: JsonValue): JsonValue {
  if (incoming === null || incoming === undefined) return target ?? incoming;
  if (target === null || target === undefined) return incoming;
  if (Array.isArray(target) && Array.isArray(incoming)) {
    const len = Math.max(target.length, incoming.length);
    const out: JsonValue[] = [];
    for (let i = 0; i < len; i++) {
      out.push(
        target[i] === undefined ? incoming[i]
          : incoming[i] === undefined ? target[i]
          : mergeAny(target[i], incoming[i]),
      );
    }
    return out;
  }
  if (isPlainObject(target) && isPlainObject(incoming)) {
    return deepMerge(target, incoming);
  }
  return target;
}

function isPlainObject(v: JsonValue): v is Record<string, JsonValue> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
