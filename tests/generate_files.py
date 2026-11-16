"""Generate 50 Parquet files covering encodings, compressions, logical types
and nested shapes, plus canonical expected JSON decoded with pyarrow.

Run:  py tests/generate_files.py
Output: tests/data/*.parquet and tests/data/expected.json
"""
from __future__ import annotations

import decimal
import json
import math
import os
import random
from datetime import date, datetime, timezone

import pyarrow as pa
import pyarrow.parquet as pq

RNG = random.Random(20261116)
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
os.makedirs(DATA_DIR, exist_ok=True)


# --------------------------------------------------------------------------
# Canonical rendering 鈥?must match src/core/value.ts + assembler.ts exactly.
# --------------------------------------------------------------------------

def render_int(v):
    return str(int(v))


def render_date(days):
    d = date.fromordinal(date(1970, 1, 1).toordinal() + int(days))
    return d.isoformat()


def render_time(raw, unit):
    divisor = {"ms": 1_000, "us": 1_000_000, "ns": 1_000_000_000}[unit]
    total = int(raw)
    h = total // 3600 // divisor
    m = (total // 60 // divisor) % 60
    s = (total // divisor) % 60
    frac = total % divisor
    out = f"{h:02d}:{m:02d}:{s:02d}"
    if frac != 0:
        width = {"ms": 3, "us": 6, "ns": 9}[unit]
        out += "." + str(frac).zfill(width)
    return out


def render_timestamp(raw, unit, is_utc):
    divisor = {"ms": 1_000, "us": 1_000_000, "ns": 1_000_000_000}[unit]
    seconds = raw // divisor
    rem = raw % divisor
    if raw < 0 and rem != 0:
        rem = divisor + rem
    d = datetime.fromtimestamp(int(seconds), timezone.utc)
    width = {"ms": 3, "us": 6, "ns": 9}[unit]
    base = d.strftime("%Y-%m-%d %H:%M:%S")
    suffix = "UTC" if is_utc else "local-wall-clock"
    return f"{base}.{str(rem).zfill(width)} {suffix}"


def render_int96(raw_nanos):
    # INT96 has no timezone; render as a wall-clock instant with ns precision.
    return render_timestamp(int(raw_nanos), "ns", False)


def safe_float():
    """Finite float in a textual range where JS and Python repr agree."""
    v = RNG.uniform(-1_000_000.0, 1_000_000.0)
    v = round(v, RNG.randint(1, 6))
    if v == 0.0:
        v = 1.5
    return v


def canon_scalar(scalar: pa.Scalar, physical_hint=None):
    if not scalar.is_valid:
        return None
    t = scalar.type
    if pa.types.is_boolean(t):
        return scalar.as_py()
    if pa.types.is_int32(t) or pa.types.is_uint32(t) or pa.types.is_int8(t) or pa.types.is_int16(t) \
            or pa.types.is_uint8(t) or pa.types.is_uint16(t):
        return int(scalar.as_py())
    if pa.types.is_int64(t) or pa.types.is_uint64(t):
        return render_int(scalar.as_py())
    if pa.types.is_float16(t):
        return float(scalar.as_py())
    if pa.types.is_floating(t):
        v = float(scalar.as_py())
        assert math.isfinite(v) and v != 0.0
        return v
    if pa.types.is_decimal(t):
        return str(scalar.as_py())
    if pa.types.is_date(t):
        return render_date(scalar.cast(pa.int32()).as_py())
    if pa.types.is_time(t):
        unit = t.unit
        raw_type = pa.int32() if unit == "ms" else pa.int64()
        return render_time(scalar.cast(raw_type).as_py(), unit)
    if pa.types.is_timestamp(t):
        raw = scalar.cast(pa.int64()).as_py()
        return render_timestamp(raw, t.unit, t.tz is not None)
    if pa.types.is_string(t) or pa.types.is_large_string(t):
        return scalar.as_py()
    if pa.types.is_binary(t) or pa.types.is_large_binary(t) or pa.types.is_fixed_size_binary(t):
        return "0x" + scalar.as_py().hex()
    if str(t) == "extension<uuid>" or t.equals(pa.uuid()):
        return str(scalar.as_py())
    if physical_hint == "INT96":
        return render_int96(scalar.cast(pa.int64()).as_py())
    raise AssertionError(f"unsupported scalar type {t}")


def canon_array(arr, physical_hint=None):
    if isinstance(arr, pa.ChunkedArray):
        arr = arr.combine_chunks()
    if pa.types.is_null(arr.type):
        return [None] * len(arr)
    if pa.types.is_struct(arr.type):
        fields = [canon_array(arr.field(i)) for i in range(arr.type.num_fields)]
        names = [arr.type.field(i).name for i in range(arr.type.num_fields)]
        out = []
        for row in range(len(arr)):
            if arr.is_null()[row].as_py():
                out.append(None)
            else:
                out.append({names[i]: fields[i][row] for i in range(len(names))})
        return out
    if pa.types.is_list(arr.type) or pa.types.is_large_list(arr.type):
        flat = canon_array(arr.values)
        offsets = arr.offsets.to_pylist()
        out = []
        for row in range(len(arr)):
            if arr.is_null()[row].as_py():
                out.append(None)
            else:
                start, end = offsets[row], offsets[row + 1]
                out.append(flat[start:end])
        return out
    if pa.types.is_map(arr.type):
        keys = canon_array(arr.keys)
        items = canon_array(arr.items)
        offsets = arr.offsets.to_pylist()
        out = []
        for row in range(len(arr)):
            if arr.is_null()[row].as_py():
                out.append(None)
            else:
                start, end = offsets[row], offsets[row + 1]
                out.append({str(keys[j]): items[j] for j in range(start, end)})
        return out
    return [canon_scalar(arr[i], physical_hint) for i in range(len(arr))]


# --------------------------------------------------------------------------
# Data builders
# --------------------------------------------------------------------------

def rand_text(prefix, n=8):
    return f"{prefix}-{RNG.randrange(10 ** n):0{n}d}"


def make_primitives(n, with_nulls=True):
    cols = {
        "b": [RNG.choice([True, False]) for _ in range(n)],
        "i32": [RNG.randrange(-100_000, 100_000) for _ in range(n)],
        "i64": [RNG.randrange(-10 ** 18, 10 ** 18) for _ in range(n)],
        "u64": [RNG.randrange(0, 2 ** 64) for _ in range(n)],
        "f32": [safe_float() for _ in range(n)],
        "f64": [safe_float() * 1000.0 for _ in range(n)],
        "s": [rand_text("str") for _ in range(n)],
        "bin": [RNG.randbytes(RNG.randrange(1, 12)) for _ in range(n)],
    }
    if with_nulls:
        for key in list(cols):
            cols[key] = [None if RNG.random() < 0.15 else v for v in cols[key]]
    return cols


def build_table(name):
    n = 200
    if name in ("primitive_plain_dup1", "primitive_plain_dup2"):
        name = "primitive_plain"
    if name == "empty_table":
        return pa.table({"id": pa.array([], pa.int32()), "s": pa.array([], pa.string())})
    if name == "single_row":
        return pa.table({"id": [42], "s": ["only"]})
    if name in ("primitive_plain", "primitive_snappy", "primitive_gzip", "primitive_zstd",
                "primitive_dict", "nulls_heavy", "large_rows", "high_cardinality",
                "dict_wide_indices", "v2_mixed", "v2_dict", "no_stats", "comprehensive"):
        cols = make_primitives(n if name != "large_rows" else 10_000,
                               with_nulls=name != "large_rows")
        if name == "nulls_heavy":
            cols = {k: [None if RNG.random() < 0.7 else v for v in vals] for k, vals in cols.items()}
        if name == "high_cardinality" or name == "dict_wide_indices":
            cols["s"] = [f"card-{i}" for i in range(n)]
        schema = pa.schema([
            pa.field("b", pa.bool_()),
            pa.field("i32", pa.int32()),
            pa.field("i64", pa.int64()),
            pa.field("u64", pa.uint64()),
            pa.field("f32", pa.float32()),
            pa.field("f64", pa.float64()),
            pa.field("s", pa.string()),
            pa.field("bin", pa.binary()),
        ])
        return pa.table(cols, schema=schema)
    if name == "int_widths":
        return pa.table({
            "i8": pa.array([RNG.randrange(-128, 128) for _ in range(n)], pa.int8()),
            "i16": pa.array([RNG.randrange(-32768, 32768) for _ in range(n)], pa.int16()),
            "u8": pa.array([RNG.randrange(0, 256) for _ in range(n)], pa.uint8()),
            "u16": pa.array([RNG.randrange(0, 65536) for _ in range(n)], pa.uint16()),
            "u32": pa.array([RNG.randrange(0, 2 ** 32) for _ in range(n)], pa.uint32()),
        })
    if name == "decimals_int32":
        vals = [
            None if RNG.random() < 0.2
            else f"{RNG.randrange(-999, 999)}.{RNG.randrange(0, 100):02d}"
            for _ in range(n)
        ]
        return pa.table({"d": pa.array(
            [None if v is None else decimal.Decimal(v) for v in vals],
            type=pa.decimal128(5, 2))})
    if name == "decimals_int64":
        vals = [f"{RNG.randrange(-10**11, 10**11)}.{RNG.randrange(0,10000):04d}" for _ in range(n)]
        return pa.table({"d": pa.array([decimal.Decimal(v) for v in vals], type=pa.decimal128(15, 4))})
    if name == "decimals_fixed":
        vals = [f"{RNG.randrange(-10**20, 10**20)}.{RNG.randrange(0,10**6):06d}" for _ in range(n)]
        return pa.table({"d": pa.array([decimal.Decimal(v) for v in vals], type=pa.decimal128(26, 6))})
    if name == "decimals256":
        vals = [f"{RNG.randrange(-10**40, 10**40)}.{RNG.randrange(0,10**10):010d}" for _ in range(n)]
        return pa.table({"d": pa.array([decimal.Decimal(v) for v in vals], type=pa.decimal256(50, 10))})
    if name == "dates_times":
        return pa.table({
            "d": pa.array([date(2020, 1, 1).toordinal() - date(1970, 1, 1).toordinal() + i
                           for i in range(n)], pa.date32()),
            "tms": pa.array([i * 7 % 86_400_000 for i in range(n)], pa.time32("ms")),
            "tus": pa.array([i * 13 % 86_400_000_000 for i in range(n)], pa.time64("us")),
            "tns": pa.array([i * 17 % 86_400_000_000_000 for i in range(n)], pa.time64("ns")),
        })
    if name == "timestamps":
        base = 1_600_000_000
        return pa.table({
            "ts_ms_utc": pa.array([(base + i) * 1000 for i in range(n)], pa.timestamp("ms", "UTC")),
            "ts_us_utc": pa.array([(base + i) * 1_000_000 for i in range(n)], pa.timestamp("us", "UTC")),
            "ts_ns_utc": pa.array([(base + i) * 1_000_000_000 for i in range(n)], pa.timestamp("ns", "UTC")),
            "ts_ms_naive": pa.array([(base + i) * 1000 for i in range(n)], pa.timestamp("ms")),
            "ts_us_naive": pa.array([(base + i) * 1_000_000 for i in range(n)], pa.timestamp("us")),
        })
    if name == "int96_ts":
        return pa.table({
            "event_at": pa.array([datetime(2021, 1, 1, 12, 0, 0).timestamp() * 1e9 + i * 1000
                                  for i in range(n)], pa.timestamp("ns")),
        })
    if name == "uuid_col":
        import uuid
        return pa.table({"u": pa.array(
            [uuid.UUID(int=RNG.randrange(2 ** 128)) for _ in range(n)], pa.uuid())})
    if name == "bool_v1":
        return pa.table({"flag": pa.array([RNG.choice([True, False]) for _ in range(n)] + [None] * 10)})
    if name == "bool_v2":
        return pa.table({"flag": pa.array([RNG.choice([True, False]) for _ in range(n)] + [None] * 10)})
    if name == "all_nulls":
        return pa.table({
            "a": pa.nulls(n, pa.int32()),
            "b": pa.nulls(n, pa.string()),
        })
    if name in ("strings_plain", "strings_delta", "binary_delta_length", "large_strings"):
        if name == "large_strings":
            return pa.table({"s": [rand_text("x", 6) * RNG.randrange(1, 40) for _ in range(n)]})
        return pa.table({
            "s": [None if RNG.random() < 0.1 else rand_text("s") for _ in range(n)],
            "bin": [None if RNG.random() < 0.1 else RNG.randbytes(RNG.randrange(1, 20)) for _ in range(n)],
        })
    if name == "delta_int32":
        return pa.table({"v": [i * 3 - 300 for i in range(n)]})
    if name == "delta_int64":
        return pa.table({"v": pa.array([i * 7 - 700 for i in range(n)], pa.int64())})
    if name == "nested_optional_struct":
        inner = [{"x": i, "y": rand_text("y")} if RNG.random() > 0.3 else None for i in range(n)]
        return pa.table({"id": list(range(n)), "st": pa.array(inner, pa.struct([
            ("x", pa.int32()), ("y", pa.string())]))})
    if name == "nested_deep_struct":
        return pa.table({"st": pa.array([
            {"a": i, "mid": {"b": i * 2, "deep": {"c": rand_text("c")}}} for i in range(n)
        ], pa.struct([
            ("a", pa.int32()),
            ("mid", pa.struct([("b", pa.int32()), ("deep", pa.struct([("c", pa.string())]))])),
        ]))})
    if name == "list_int":
        return pa.table({"ids": pa.array([
            None if RNG.random() < 0.15 else list(range(RNG.randrange(0, 6))) for _ in range(n)
        ], pa.list_(pa.int32()))})
    if name == "list_strings":
        return pa.table({"tags": [[rand_text("t", 4) for _ in range(RNG.randrange(0, 5))] for _ in range(n)]})
    if name == "list_empty_null":
        vals = []
        for i in range(n):
            r = i % 3
            vals.append(None if r == 0 else ([] if r == 1 else [i, i + 1]))
        return pa.table({"v": pa.array(vals, pa.list_(pa.int32()))})
    if name == "list_of_struct":
        return pa.table({"items": pa.array([
            [{"k": j, "name": rand_text("n", 3)} for j in range(RNG.randrange(0, 4))] for _ in range(n)
        ], pa.list_(pa.struct([("k", pa.int32()), ("name", pa.string())])))})
    if name == "list_of_list":
        return pa.table({"grid": pa.array([
            None if i % 5 == 0 else [[j, j + 1] for j in range(i % 4)] for i in range(n)
        ], pa.list_(pa.list_(pa.int32())))})
    if name == "map_simple":
        return pa.table({"m": pa.array([
            None if i % 6 == 0 else {f"k{j}": j * i for j in range(RNG.randrange(1, 4))} for i in range(n)
        ], pa.map_(pa.string(), pa.int32()))})
    if name == "map_null_values":
        return pa.table({"m": pa.array([
            {"a": None, "b": 2} if i % 2 == 0 else {"a": i} for i in range(n)
        ], pa.map_(pa.string(), pa.int32()))})
    if name == "struct_with_list":
        return pa.table({"st": pa.array([
            {"head": i, "tail": [i, i + 1, i + 2]} for i in range(n)
        ], pa.struct([("head", pa.int32()), ("tail", pa.list_(pa.int32()))]))})
    if name == "list_struct_list":
        return pa.table({"groups": pa.array([
            [{"name": f"g{j}", "vals": [j, j * 2]} for j in range(RNG.randrange(1, 3))] for _ in range(n)
        ], pa.list_(pa.struct([("name", pa.string()), ("vals", pa.list_(pa.int64()))])))})
    if name == "multi_row_groups":
        return pa.table({"id": list(range(950)), "g": [f"g{i % 7}" for i in range(950)]})
    if name == "row_groups_uneven":
        return pa.table({"id": list(range(437)), "s": [rand_text("r") for _ in range(437)]})
    if name == "fixed_binary":
        return pa.table({"fb": pa.array([RNG.randbytes(8) for _ in range(n)], pa.binary(8))})
    if name == "enumish_strings":
        return pa.table({"level": pa.array([RNG.choice(["LOW", "MEDIUM", "HIGH"]) for _ in range(n)])})
    raise AssertionError(f"no builder for {name}")


# --------------------------------------------------------------------------
# Scenario matrix (exactly 50)
# --------------------------------------------------------------------------

def write_kwargs(name):
    kw = {}
    if name in ("primitive_plain", "strings_plain", "delta_int32", "delta_int64"):
        kw["use_dictionary"] = False
    if name == "primitive_dict" or name == "enumish_strings":
        kw["use_dictionary"] = True
    if name in ("primitive_snappy",):
        kw["compression"] = "snappy"
    if name in ("primitive_gzip", "strings_delta"):
        kw["compression"] = "gzip"
    if name in ("primitive_zstd", "dict_wide_indices", "comprehensive", "nested_deep_struct"):
        kw["compression"] = "zstd"
    if name == "list_strings":
        kw["compression"] = "snappy"
    if name in ("map_simple", "list_of_list"):
        kw["compression"] = "gzip"
    if name == "bool_v2" or name == "v2_mixed" or name == "v2_dict":
        kw["data_page_version"] = "2.0"
    if name == "v2_dict":
        kw["use_dictionary"] = True
    if name == "no_stats":
        kw["write_statistics"] = False
    if name == "large_rows":
        kw["data_page_size"] = 8 * 1024
        kw["use_dictionary"] = False
    if name == "strings_delta":
        kw["use_dictionary"] = False
        kw["column_encoding"] = {"s": "DELTA_BYTE_ARRAY", "bin": "DELTA_LENGTH_BYTE_ARRAY"}
    if name == "binary_delta_length":
        kw["use_dictionary"] = False
        kw["column_encoding"] = {"bin": "DELTA_LENGTH_BYTE_ARRAY", "s": "DELTA_BYTE_ARRAY"}
    if name == "delta_int32":
        kw["column_encoding"] = {"v": "DELTA_BINARY_PACKED"}
    if name == "delta_int64":
        kw["use_dictionary"] = False
        kw["column_encoding"] = {"v": "DELTA_BINARY_PACKED"}
    if name == "int96_ts":
        kw["use_deprecated_int96_timestamps"] = True
        kw["use_dictionary"] = False
    if name == "multi_row_groups":
        kw["row_group_size"] = 250
    if name == "row_groups_uneven":
        kw["row_group_size"] = 137
    if name == "comprehensive":
        kw["row_group_size"] = 512
        kw["data_page_size"] = 16 * 1024
    return kw


SCENARIOS = [
    "primitive_plain", "primitive_snappy", "primitive_gzip", "primitive_zstd",
    "primitive_dict", "nulls_heavy", "large_rows", "high_cardinality",
    "dict_wide_indices", "v2_mixed", "v2_dict", "no_stats", "comprehensive",
    "int_widths",
    "decimals_int32", "decimals_int64", "decimals_fixed", "decimals256",
    "dates_times", "timestamps", "int96_ts", "uuid_col",
    "bool_v1", "bool_v2", "all_nulls",
    "strings_plain", "strings_delta", "binary_delta_length", "large_strings",
    "delta_int32", "delta_int64",
    "nested_optional_struct", "nested_deep_struct",
    "list_int", "list_strings", "list_empty_null", "list_of_struct",
    "list_of_list", "map_simple", "map_null_values",
    "struct_with_list", "list_struct_list",
    "multi_row_groups", "row_groups_uneven",
    "fixed_binary", "enumish_strings", "single_row", "empty_table",
    "primitive_plain_dup1", "primitive_plain_dup2",
]


def physical_type_for(pf, rg_idx, col_idx):
    try:
        return pf.metadata.row_group(rg_idx).column(col_idx).physical_type
    except Exception:
        return None


def main():
    assert len(SCENARIOS) == 50, f"need 50 scenarios, got {len(SCENARIOS)}"
    expected = {}
    manifest = []

    for idx, name in enumerate(SCENARIOS):
        table = build_table(name)
        path = os.path.join(DATA_DIR, f"{idx:02d}_{name}.parquet")
        kwargs = write_kwargs(name)
        pq.write_table(table, path, **kwargs)

        pf = pq.ParquetFile(path)
        row_groups = []
        for rg_idx in range(pf.num_row_groups):
            rg_table = pf.read_row_group(rg_idx)
            rows = []
            col_data = rg_table.to_pydict()
            canon_cols = {cname: canon_array(rg_table.column(cname)) for cname in col_data}
            for r in range(rg_table.num_rows):
                rows.append({cname: canon_cols[cname][r] for cname in canon_cols})

            columns = []
            for ci, field in enumerate(rg_table.schema):
                arrow_name = field.name
                physical = physical_type_for(pf, rg_idx, ci)
                arr = rg_table.column(ci)
                top_level = not (pa.types.is_struct(field.type) or pa.types.is_list(field.type)
                                 or pa.types.is_map(field.type) or pa.types.is_large_list(field.type))
                null_count = arr.null_count
                columns.append({
                    "name": arrow_name,
                    "physical": physical,
                    "topLevel": top_level,
                    "nullCount": int(null_count),
                    "flatValues": canon_array(arr, physical) if top_level else None,
                })
            row_groups.append({"numRows": rg_table.num_rows, "rows": rows, "columns": columns})

        expected[name] = {
            "file": os.path.basename(path),
            "numRows": pf.metadata.num_rows,
            "numRowGroups": pf.num_row_groups,
            "rowGroups": row_groups,
            "hasStatistics": kwargs.get("write_statistics", True),
            "compression": kwargs.get("compression", "snappy/default"),
        }
        manifest.append((name, os.path.basename(path), table.num_rows, table.num_columns))

    with open(os.path.join(DATA_DIR, "expected.json"), "w", encoding="utf-8") as f:
        json.dump(expected, f, ensure_ascii=False, separators=(",", ":"))

    print(f"generated {len(SCENARIOS)} files in {DATA_DIR}")
    for name, fname, rows, cols in manifest:
        print(f"  {fname:40s} rows={rows:<6} cols={cols}")


if __name__ == "__main__":
    main()

