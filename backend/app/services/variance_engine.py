from __future__ import annotations

from typing import Any

from app.services.ratio_engine import find_source_best_period, find_source_by_priority, pick_period


def compute_variance(normalized: dict, period_from: str, period_to: str) -> dict:
    facts = normalized.get("facts", [])
    periods = normalized.get("periods", [])

    period_from_used = pick_period(periods, period_from)
    period_to_used = pick_period(periods, period_to)

    def value_for(period: str, statement: str, keywords: list[str]) -> tuple[float, dict | None]:
        source = find_source_best_period(facts, period, statement, keywords)
        if source and isinstance(source.get("value"), (int, float)):
            return float(source["value"]), source
        return 0.0, None

    def value_for_groups(period: str, statement: str, groups: list[list[str]]) -> tuple[float, dict | None]:
        source = find_source_by_priority(facts, period, statement, groups)
        if source and isinstance(source.get("value"), (int, float)):
            return float(source["value"]), source
        return 0.0, None

    net_profit_from, net_profit_from_src = value_for(period_from_used, "PL", ["net profit", "profit for the period"])
    net_profit_to, net_profit_to_src = value_for(period_to_used, "PL", ["net profit", "profit for the period"])

    income_from, income_from_src = value_for_groups(
        period_from_used,
        "PL",
        [
            ["total income"],
            ["operating income"],
            ["total revenue"],
            ["operating revenue"],
            ["net operating income"],
        ],
    )
    income_to, income_to_src = value_for_groups(
        period_to_used,
        "PL",
        [
            ["total income"],
            ["operating income"],
            ["total revenue"],
            ["operating revenue"],
            ["net operating income"],
        ],
    )

    opex_from, opex_from_src = value_for_groups(
        period_from_used,
        "PL",
        [
            ["operating expenses"],
            ["operating expense"],
            ["operating costs"],
            ["total operating expenses"],
            ["total expenses"],
            ["expenses"],
            ["staff costs"],
            ["general and administrative"],
        ],
    )
    opex_to, opex_to_src = value_for_groups(
        period_to_used,
        "PL",
        [
            ["operating expenses"],
            ["operating expense"],
            ["operating costs"],
            ["total operating expenses"],
            ["total expenses"],
            ["expenses"],
            ["staff costs"],
            ["general and administrative"],
        ],
    )

    impairment_from, impairment_from_src = value_for(period_from_used, "PL", ["impairment"])
    impairment_to, impairment_to_src = value_for(period_to_used, "PL", ["impairment"])

    tax_from, tax_from_src = value_for(period_from_used, "PL", ["tax"])
    tax_to, tax_to_src = value_for(period_to_used, "PL", ["tax"])

    income_delta = income_to - income_from
    opex_delta = opex_to - opex_from
    impairment_delta = impairment_to - impairment_from
    tax_delta = tax_to - tax_from

    running = net_profit_from
    bridge = []
    for key, label, delta, missing in [
        ("income_change", "Income change", income_delta, income_from_src is None or income_to_src is None),
        ("opex_change", "Opex change", opex_delta, opex_from_src is None or opex_to_src is None),
        ("impairment_change", "Impairment change", impairment_delta, impairment_from_src is None or impairment_to_src is None),
        ("tax_change", "Tax change", tax_delta, tax_from_src is None or tax_to_src is None),
    ]:
        running += delta
        bridge.append(
            {
                "driver_key": key,
                "label": label,
                "delta": delta,
                "running_total": running,
                "missing_inputs": missing,
            }
        )

    residual = net_profit_to - running
    reconciles = abs(residual) < 1e-6
    if not reconciles:
        running += residual
        bridge.append(
            {
                "driver_key": "residual",
                "label": "Residual",
                "delta": residual,
                "running_total": running,
                "missing_inputs": False,
            }
        )

    evidence = {
        "income_change": [income_from_src, income_to_src],
        "opex_change": [opex_from_src, opex_to_src],
        "impairment_change": [impairment_from_src, impairment_to_src],
        "tax_change": [tax_from_src, tax_to_src],
    }

    return {
        "period_from": period_from_used,
        "period_to": period_to_used,
        "start": {"key": "net_profit", "value": net_profit_from, "evidence": [net_profit_from_src]},
        "bridge": bridge,
        "end": {"key": "net_profit", "value": net_profit_to, "evidence": [net_profit_to_src]},
        "reconciles": reconciles,
        "notes": ["Bridge decomposes net profit movement into income, opex, impairment, tax, and residual if needed."],
        "evidence": evidence,
    }
