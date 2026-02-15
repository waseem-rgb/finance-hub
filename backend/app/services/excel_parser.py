import re

import pandas as pd

ENTITY_IGNORE_RE = re.compile(r"(?i)^(as at|consolidated|statement|financial position|balance sheet|income statement|notes?)")


def _detect_entity(file_path: str) -> str | None:
    try:
        raw = pd.read_excel(file_path, sheet_name="BS", header=None, engine="openpyxl")
    except Exception:
        try:
            raw = pd.read_excel(file_path, sheet_name=0, header=None, engine="openpyxl")
        except Exception:
            return None

    for row in raw.head(6).itertuples(index=False):
        for cell in list(row)[:4]:
            if cell is None or (isinstance(cell, float) and pd.isna(cell)):
                continue
            text = str(cell).strip()
            if not text or ENTITY_IGNORE_RE.search(text):
                continue
            if len(text) < 3:
                continue
            return text
    return None


def parse_excel(file_path: str) -> dict:
    try:
        workbook = pd.ExcelFile(file_path, engine="openpyxl")
        sheets = workbook.sheet_names
        preview = {}
        for sheet in sheets:
            df = pd.read_excel(workbook, sheet_name=sheet, engine="openpyxl")
            df = df.where(pd.notnull(df), None)
            preview[sheet] = df.head(5).to_dict(orient="records")

        return {
            "sheets": sheets,
            "preview": preview,
            "entity": _detect_entity(file_path),
        }
    except Exception:
        raise
