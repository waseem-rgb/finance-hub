import re

import pandas as pd

MONTH_YEAR_RE = re.compile(r"(?i)(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[- ]?(\d{2,4})")
MONTHS = {
    "jan": "Jan",
    "feb": "Feb",
    "mar": "Mar",
    "apr": "Apr",
    "may": "May",
    "jun": "Jun",
    "jul": "Jul",
    "aug": "Aug",
    "sep": "Sep",
    "oct": "Oct",
    "nov": "Nov",
    "dec": "Dec",
}


def _cell_to_str(value: object) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    return str(value).strip()


def _is_period_label(value: object) -> bool:
    text = _cell_to_str(value)
    if not text:
        return False
    return bool(MONTH_YEAR_RE.search(text))


def _normalize_period_label(value: object) -> str | None:
    text = _cell_to_str(value)
    if not text:
        return None
    match = MONTH_YEAR_RE.search(text)
    if not match:
        return None
    month = MONTHS.get(match.group(1).lower(), match.group(1).title())
    year = match.group(2)
    if len(year) == 4:
        year = year[-2:]
    return f"{month}-{year}"


def normalize_financials(file_path: str) -> dict:
    sheets_processed = []
    periods = set()
    facts = []
    warnings = []

    try:
        xls = pd.ExcelFile(file_path, engine="openpyxl")
        sheet_names = xls.sheet_names
    except Exception as exc:
        return {
            "sheets_processed": [],
            "periods": [],
            "facts_count": 0,
            "facts": [],
            "warnings": [f"failed to open workbook: {exc}"],
        }

    def sheet_aliases(name: str) -> list[str]:
        upper = name.upper()
        return [name, upper, upper.replace(" ", ""), upper.replace("-", "")]

    # Parse all sheets; only sheets with detectable period columns will produce facts.
    target_sheets: list[str] = list(sheet_names)

    for sheet_name in target_sheets:
        try:
            raw = pd.read_excel(file_path, sheet_name=sheet_name, header=None, engine="openpyxl")
        except Exception as exc:
            warnings.append(f"{sheet_name}: failed to read sheet ({exc})")
            continue

        raw = raw.dropna(axis=0, how="all").dropna(axis=1, how="all").reset_index(drop=True)
        if raw.empty:
            warnings.append(f"{sheet_name}: empty after cleanup")
            continue

        header_row_index = None
        best_matches = 0
        for row_idx, row in raw.head(40).iterrows():
            matches = sum(1 for cell in row if _is_period_label(cell))
            if matches > best_matches:
                best_matches = matches
                header_row_index = int(row_idx)

        if header_row_index is None or best_matches == 0:
            warnings.append(f"{sheet_name}: header row with period labels not found")
            continue

        # Detect period columns by scanning header row + next 2 rows for period labels
        period_col_indices: list[int] = []
        period_labels: dict[int, str] = {}
        max_row = min(header_row_index + 2, len(raw) - 1)
        for col_idx in range(raw.shape[1]):
            label = None
            for r in range(header_row_index, max_row + 1):
                cell = raw.iat[r, col_idx]
                if _is_period_label(cell):
                    label = _normalize_period_label(cell) or _cell_to_str(cell)
                    break
            if label:
                period_col_indices.append(col_idx)
                period_labels[col_idx] = label

        if not period_col_indices:
            warnings.append(f"{sheet_name}: period columns not found")
            continue

        # Detect line item column as the text-rich column before period columns
        candidate_cols = [i for i in range(raw.shape[1]) if i not in period_col_indices]
        if not candidate_cols:
            warnings.append(f"{sheet_name}: line item column not found")
            continue

        def text_count_idx(col_idx: int) -> int:
            count = 0
            for v in raw.iloc[header_row_index + 1 :, col_idx]:
                if v is None or (isinstance(v, float) and pd.isna(v)):
                    continue
                if isinstance(v, str) and v.strip():
                    count += 1
                elif not isinstance(v, (int, float)):
                    count += 1
            return count

        line_item_col_idx = sorted(candidate_cols, key=text_count_idx, reverse=True)[0]

        def parse_numeric(value: object) -> float | None:
            if value is None or (isinstance(value, float) and pd.isna(value)):
                return None
            if isinstance(value, (int, float)):
                return float(value)
            if isinstance(value, str):
                raw = value.strip()
                if raw in {"", "-", "—", "–"}:
                    return None
                negative = False
                if raw.startswith("(") and raw.endswith(")"):
                    negative = True
                    raw = raw[1:-1]
                raw = raw.replace(",", "")
                raw = raw.replace(" ", "")
                try:
                    num = float(raw)
                    return -num if negative else num
                except Exception:
                    return None
            try:
                num = pd.to_numeric(value, errors="coerce")
                if pd.isna(num):
                    return None
                return float(num)
            except Exception:
                return None

        for row_index in range(header_row_index + 1, len(raw)):
            line_item = raw.iat[row_index, line_item_col_idx]
            if line_item is None or (isinstance(line_item, float) and pd.isna(line_item)):
                continue
            if not isinstance(line_item, str):
                line_item = str(line_item)
            line_item = line_item.strip()
            if not line_item:
                continue

            for col_idx in period_col_indices:
                value = raw.iat[row_index, col_idx]
                numeric = parse_numeric(value)
                if numeric is None:
                    continue
                period_label = period_labels.get(col_idx) or _cell_to_str(raw.iat[header_row_index, col_idx])
                facts.append(
                    {
                        "statement": sheet_name,
                        "line_item": line_item,
                        "period": period_label,
                        "value": float(numeric),
                        "currency": "AED",
                        "lineage": {
                            "sheet": sheet_name,
                            "row_index": int(row_index),
                            "column": period_label,
                        },
                    }
                )
                periods.add(period_label)

        sheets_processed.append(sheet_name)

    return {
        "sheets_processed": sheets_processed,
        "periods": sorted(periods),
        "facts_count": len(facts),
        "facts": facts,
        "warnings": warnings,
    }
