import re
from typing import Iterable

MONTH_INDEX = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}

PERIOD_RE = re.compile(r"(?i)(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[- ]?(\d{2,4})")


def _period_key(label: str) -> tuple[int, int]:
    match = PERIOD_RE.search(label or "")
    if not match:
        return (0, 0)
    month = MONTH_INDEX[match.group(1).lower()]
    year_str = match.group(2)
    year = int(year_str)
    if year < 100:
        year = 2000 + year
    return (year, month)


def _period_index(label: str) -> int:
    year, month = _period_key(label)
    if year == 0 or month == 0:
        return 0
    return year * 12 + month


def _latest_period(periods: Iterable[str]) -> str | None:
    periods = [p for p in periods if isinstance(p, str) and p.strip()]
    if not periods:
        return None
    return sorted(periods, key=_period_key)[-1]


def _match_line_item(line_item: str, keywords: list[str]) -> bool:
    if not line_item:
        return False
    text = line_item.lower()
    return any(keyword in text for keyword in keywords)


def find_source_for_keywords(facts: list, period: str, statement: str, keywords: list[str]) -> dict | None:
    target_period = _normalize_period(period)
    for fact in facts:
        if fact.get("statement") != statement:
            continue
        if _normalize_period(fact.get("period")) != target_period:
            continue
        if _match_line_item(str(fact.get("line_item", "")), keywords):
            value = fact.get("value")
            if isinstance(value, (int, float)):
                return {
                    "line_item": fact.get("line_item"),
                    "value": float(value),
                    "statement": statement,
                    "period": fact.get("period"),
                    "lineage": fact.get("lineage"),
                }
    return None


def find_source_by_priority(facts: list, period: str, statement: str, keyword_groups: list[list[str]]) -> dict | None:
    for group in keyword_groups:
        match = find_source_best_period(facts, period, statement, group)
        if match:
            return match
    return None


def find_source_best_period(facts: list, period: str, statement: str, keywords: list[str]) -> dict | None:
    exact = find_source_for_keywords(facts, period, statement, keywords)
    if exact:
        return exact
    # fallback: choose closest period match for these keywords
    candidates = []
    for fact in facts:
        if fact.get("statement") != statement:
            continue
        if _match_line_item(str(fact.get("line_item", "")), keywords):
            candidates.append(fact)
    if not candidates:
        return None
    target_idx = _period_index(period or "")
    candidates.sort(key=lambda f: abs(_period_index(f.get("period", "")) - target_idx))
    chosen = candidates[0]
    value = chosen.get("value")
    if not isinstance(value, (int, float)):
        return None
    return {
        "line_item": chosen.get("line_item"),
        "value": float(value),
        "statement": chosen.get("statement"),
        "period": chosen.get("period"),
        "lineage": chosen.get("lineage"),
    }


def _normalize_period(label: str | None) -> str | None:
    if not label:
        return None
    match = PERIOD_RE.search(label)
    if not match:
        return label
    month = match.group(1).title()
    year = match.group(2)
    if len(year) == 4:
        year = year[-2:]
    return f"{month}-{year}"


def pick_period(periods: Iterable[str], requested: str | None) -> str | None:
    periods = [p for p in periods if isinstance(p, str) and p.strip()]
    if not periods:
        return None
    requested_norm = _normalize_period(requested)
    if requested_norm:
        for p in periods:
            if _normalize_period(p) == requested_norm:
                return p
    return _latest_period(periods)


def compute_ratios(normalized: dict, period: str | None = None) -> dict:
    periods = normalized.get("periods", [])
    period_used = pick_period(periods, period)
    facts = normalized.get("facts", [])

    if not period_used:
        return {
            "computed": True,
            "period_used": None,
            "sources": {},
            "ratios": {"roa": None, "roe": None, "cost_to_income": None},
        }

    assets = find_source_best_period(facts, period_used, "BS", ["total assets"])
    customers_deposits = find_source_best_period(
        facts,
        period_used,
        "BS",
        ["customers deposits", "customer deposits", "deposits"],
    )
    equity = find_source_best_period(facts, period_used, "BS", ["total equity", "equity"])
    net_profit = find_source_best_period(facts, period_used, "PL", ["net profit", "profit for the period"])
    total_income = find_source_by_priority(
        facts,
        period_used,
        "PL",
        [
            ["total income"],
            ["operating income"],
            ["total revenue"],
            ["operating revenue"],
        ],
    )
    operating_expenses = find_source_by_priority(
        facts,
        period_used,
        "PL",
        [
            ["operating expenses"],
            ["operating expense"],
            ["operating costs"],
            ["total operating expenses"],
            ["total expenses"],
            ["expenses"],
        ],
    )

    def safe_div(numerator: float | None, denominator: float | None) -> float | None:
        if numerator is None or denominator in (None, 0):
            return None
        return float(numerator) / float(denominator)

    roa = safe_div(net_profit["value"] if net_profit else None, assets["value"] if assets else None)
    roe = safe_div(net_profit["value"] if net_profit else None, equity["value"] if equity else None)
    opex_value = operating_expenses["value"] if operating_expenses else None
    income_value = total_income["value"] if total_income else None
    cti = safe_div(abs(opex_value) if isinstance(opex_value, (int, float)) else None, income_value)

    return {
        "computed": True,
        "period_used": period_used,
        "sources": {
            "assets": assets,
            "customers_deposits": customers_deposits,
            "equity": equity,
            "net_profit": net_profit,
            "total_income": total_income,
            "operating_expenses": operating_expenses,
        },
        "ratios": {
            "roa": roa,
            "roe": roe,
            "cost_to_income": cti,
            "cost_to_income_meta": {
                "numerator": "operating_expenses",
                "denominator": "total_income",
                "numerator_abs": True,
            },
        },
    }
