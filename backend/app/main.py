# backend/app/main.py

import json
import os
import tempfile
from io import BytesIO
import traceback
from datetime import datetime, timezone
from textwrap import wrap
from typing import Any, Dict, Optional
from urllib import request as urlrequest
from urllib.error import URLError

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from app.services.excel_parser import parse_excel
from app.services.normalizer import normalize_financials
from app.services.ratio_engine import compute_ratios
from app.services.variance_engine import compute_variance
from app.services.pack_store import PACK_STORE
from app.services.chat_store import CHAT_STORE

LAST_NORMALIZED: Dict[str, Any] | None = None
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

app = FastAPI(title="Finance Hub API", version="0.1.0")

# Allow local frontend dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://momentumfirmfinance.com",
        "https://www.momentumfirmfinance.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _format_million(value: Any) -> str:
    if value is None or not isinstance(value, (int, float)):
        return "—"
    return f"{value / 1_000_000:.2f}M AED"


def generate_openai_interpretation(
    entity_name: str,
    period: str | None,
    assets: Any,
    equity: Any,
    net_profit: Any,
    roa: Any,
    roe: Any,
    cti: Any,
) -> dict | None:
    if not OPENAI_API_KEY:
        return None
    prompt = (
        "You are a CFO writing an executive financial interpretation. "
        "Use M AED notation with 2 decimals for money. Use concise, bank-grade language. "
        "Return ONLY JSON with keys: executive_summary, profitability, efficiency, balance_sheet, risks (array of strings). "
        f"Entity: {entity_name}. Period: {period}. "
        f"Total Assets: {_format_million(assets)}. Total Equity: {_format_million(equity)}. "
        f"Net Profit: {_format_million(net_profit)}. ROA: {roa}. ROE: {roe}. Cost-to-Income: {cti}."
    )
    payload = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": "You are a bank-grade CFO analyst."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(
        "https://api.openai.com/v1/chat/completions",
        data=data,
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            parsed = json.loads(body)
            content = parsed["choices"][0]["message"]["content"]
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return {"answer": content, "citations": [], "data_backed": False}
    except (URLError, KeyError, json.JSONDecodeError, TimeoutError):
        return None


def generate_openai_answer(message: str, context: dict, history: list[dict]) -> dict | None:
    if not OPENAI_API_KEY:
        return None
    prompt = (
        "You are an expert assistant. Answer any user question. "
        "If the answer relies on financial data, use the provided context and include citations. "
        "If the answer goes beyond available data, clearly say it is not backed by uploaded data. "
        "Return ONLY JSON with keys: answer (string), citations (array), data_backed (boolean). "
        "Each citation item must include: statement, line_item, value, period, sheet, row_index, col. "
        f"User question: {message}\n"
        f"Context JSON: {json.dumps(context)}\n"
        f"Recent chat history: {json.dumps(history)}"
    )
    payload = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": "You are a precise, honest assistant."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(
        "https://api.openai.com/v1/chat/completions",
        data=data,
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            parsed = json.loads(body)
            content = parsed["choices"][0]["message"]["content"]
            return json.loads(content)
    except (URLError, KeyError, json.JSONDecodeError, TimeoutError):
        return None

@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}

@app.get("/ratios")
def ratios(
    entity: str = "UAE Entity 01",
    period: str = "Mar-2025",
    scenario: str = "Actual",
) -> Dict[str, Any]:
    pack = PACK_STORE.get_latest_pack()
    if pack:
        try:
            entity_out = pack.entity or entity
            computed = compute_ratios(
                {"facts": pack.normalized_facts, "periods": pack.periods},
                period,
            )
            sources = computed.get("sources", {})
            ratios_out = computed.get("ratios", {})
            period_used = computed.get("period_used")

            def lineage_from(source: Optional[dict]) -> dict | None:
                if not source:
                    return None
                return {
                    "upload_id": pack.upload_id,
                    "sheet": source.get("lineage", {}).get("sheet"),
                    "statement": source.get("statement"),
                    "period": source.get("period"),
                    "row_index": source.get("lineage", {}).get("row_index"),
                    "col": source.get("lineage", {}).get("column"),
                    "cell": source.get("lineage", {}).get("cell"),
                    "line_item": source.get("line_item"),
                    "value": source.get("value"),
                }

            def lineage_input(source: Optional[dict], key: str) -> dict | None:
                if not source:
                    return None
                return {
                    "key": key,
                    "value": source.get("value"),
                    "sheet": source.get("lineage", {}).get("sheet"),
                    "row": source.get("lineage", {}).get("row_index"),
                    "col": source.get("lineage", {}).get("column"),
                    "period": source.get("period"),
                    "line_item": source.get("line_item"),
                    "statement": source.get("statement"),
                }

            lineage = {
                "total_assets": lineage_from(sources.get("assets")),
                "customers_deposits": lineage_from(sources.get("customers_deposits")),
                "total_equity": lineage_from(sources.get("equity")),
                "net_profit": lineage_from(sources.get("net_profit")),
                "cost_to_income": {
                    "upload_id": pack.upload_id,
                    "formula": "abs(operating_expenses) / total_income",
                    "inputs": [
                        lineage_input(sources.get("operating_expenses"), "operating_expenses"),
                        lineage_input(sources.get("total_income"), "total_income"),
                    ],
                },
                "roa_annualized": {
                    "upload_id": pack.upload_id,
                    "formula": "net_profit / total_assets",
                    "inputs": [
                        lineage_input(sources.get("net_profit"), "net_profit"),
                        lineage_input(sources.get("assets"), "total_assets"),
                    ],
                },
                "roe_annualized": {
                    "upload_id": pack.upload_id,
                    "formula": "net_profit / total_equity",
                    "inputs": [
                        lineage_input(sources.get("net_profit"), "net_profit"),
                        lineage_input(sources.get("equity"), "total_equity"),
                    ],
                },
            }

            return {
                "entity": entity_out,
                "period_requested": period,
                "period_used": period_used,
                "periods": pack.periods,
                "scenario": scenario,
                "computed": computed.get("computed", True),
                "sources": {
                    "total_assets": sources.get("assets"),
                    "customers_deposits": sources.get("customers_deposits"),
                    "total_equity": sources.get("equity"),
                    "net_profit": sources.get("net_profit"),
                    "total_income": sources.get("total_income"),
                    "operating_expenses": sources.get("operating_expenses"),
                    "cost_to_income": {
                        "inputs": [sources.get("operating_expenses"), sources.get("total_income")]
                    },
                    "roa_annualized": {
                        "inputs": [sources.get("net_profit"), sources.get("assets")]
                    },
                    "roe_annualized": {
                        "inputs": [sources.get("net_profit"), sources.get("equity")]
                    },
                },
                "kpis": {
                    "total_assets": {"value": sources.get("assets", {}).get("value"), "unit": "AED", "delta": None},
                    "customers_deposits": {
                        "value": sources.get("customers_deposits", {}).get("value"),
                        "unit": "AED",
                        "delta": None,
                    },
                    "total_equity": {"value": sources.get("equity", {}).get("value"), "unit": "AED", "delta": None},
                    "net_profit": {"value": sources.get("net_profit", {}).get("value"), "unit": "AED", "delta": None},
                },
                "ratios": {
                    "cost_to_income": {
                        "value": ratios_out.get("cost_to_income"),
                        "unit": "ratio",
                        "label": "Operating expenses / total income",
                        "meta": ratios_out.get("cost_to_income_meta"),
                    },
                    "roa_annualized": {
                        "value": ratios_out.get("roa"),
                        "unit": "ratio",
                        "label": "Net profit / avg assets",
                    },
                    "roe_annualized": {
                        "value": ratios_out.get("roe"),
                        "unit": "ratio",
                        "label": "Net profit / avg equity",
                    },
                },
                "lineage": lineage,
            }
        except Exception:
            pass

    return {
        "entity": None,
        "period_requested": period,
        "period_used": None,
        "periods": [],
        "scenario": scenario,
        "computed": False,
        "lineage": {
            "total_assets": None,
            "customers_deposits": None,
            "total_equity": None,
            "net_profit": None,
            "cost_to_income": {"inputs": []},
            "roa_annualized": {"inputs": []},
            "roe_annualized": {"inputs": []},
        },
        "sources": {
            "total_assets": None,
            "customers_deposits": None,
            "total_equity": None,
            "net_profit": None,
            "total_income": None,
            "operating_expenses": None,
            "cost_to_income": None,
            "roa_annualized": None,
            "roe_annualized": None,
        },
        "kpis": {
            "total_assets": {"value": None, "unit": "AED", "delta": None},
            "customers_deposits": {"value": None, "unit": "AED", "delta": None},
            "total_equity": {"value": None, "unit": "AED", "delta": None},
            "net_profit": {"value": None, "unit": "AED", "delta": None},
        },
        "ratios": {
            "cost_to_income": {
                "value": None,
                "unit": "ratio",
                "label": "Operating expenses / total income",
            },
            "roa_annualized": {
                "value": None,
                "unit": "ratio",
                "label": "Net profit / avg assets",
            },
            "roe_annualized": {
                "value": None,
                "unit": "ratio",
                "label": "Net profit / avg equity",
            },
        },
    }

@app.post("/uploads/excel")
async def upload_excel(file: UploadFile = File(...), save: bool = False) -> Dict[str, Any]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")
    if not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Only .xlsx files are supported")

    temp_path: str | None = None
    try:
        print("Parsing Excel:", file.filename)

        # Save to temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx") as tmp:
            temp_path = tmp.name
            content = await file.read()
            if not content:
                raise HTTPException(status_code=400, detail="Empty file upload")
            tmp.write(content)

        parsed = parse_excel(temp_path)
        parsed["filename"] = file.filename
        if save:
            normalized = normalize_financials(temp_path)
            PACK_STORE.save_pack(parsed, normalized)
        return {
            "filename": file.filename,
            "sheets": parsed.get("sheets", []),
            "preview": parsed.get("preview", {}),
        }

    except HTTPException:
        # Let FastAPI handle it cleanly
        raise

    except Exception as exc:
        # Print full traceback to backend terminal (critical for debugging)
        traceback.print_exc()

        return JSONResponse(
            status_code=400,
            content={
                "detail": f"Failed to parse Excel: {exc}",
                "error": str(exc),
                "error_type": exc.__class__.__name__,
            },
        )

    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                # Don't crash on cleanup issues
                pass

@app.post("/uploads/excel/normalize")
async def normalize_excel(file: UploadFile = File(...)) -> Dict[str, Any]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")
    if not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Only .xlsx files are supported")

    temp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx") as tmp:
            temp_path = tmp.name
            content = await file.read()
            if not content:
                raise HTTPException(status_code=400, detail="Empty file upload")
            tmp.write(content)

        parsed = parse_excel(temp_path)
        parsed["filename"] = file.filename
        normalized = normalize_financials(temp_path)
        upload_id = PACK_STORE.save_pack(parsed, normalized)
        global LAST_NORMALIZED
        LAST_NORMALIZED = normalized
        return {
            "upload_id": upload_id,
            "filename": file.filename,
            "entity": parsed.get("entity"),
            "sheets": parsed.get("sheets", []),
            "periods": normalized.get("periods", []),
            "facts_count": len(normalized.get("facts", [])),
        }

    except HTTPException:
        raise

    except Exception as exc:
        traceback.print_exc()
        return JSONResponse(
            status_code=400,
            content={
                "detail": "Failed to normalize Excel",
                "error": str(exc),
                "error_type": exc.__class__.__name__,
            },
        )

    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass

@app.get("/periods")
def get_periods(entity: str = "UAE Entity 01") -> Dict[str, Any]:
    pack = PACK_STORE.get_latest_pack()
    if not pack:
        return {
            "entity": None,
            "periods": [],
            "latest_upload_id": None,
            "has_pack": False,
        }
    return {
        "entity": pack.entity,
        "periods": pack.periods,
        "latest_upload_id": pack.upload_id,
        "has_pack": True,
    }


@app.post("/pack/clear")
def clear_pack() -> Dict[str, Any]:
    PACK_STORE.clear()
    CHAT_STORE.clear()
    return {"status": "cleared"}

@app.get("/variance")
def get_variance(
    period_from: str,
    period_to: str,
    scenario: str = "Actual",
    entity: str = "UAE Entity 01",
) -> Dict[str, Any]:
    pack = PACK_STORE.get_latest_pack()
    if not pack:
        return {
            "entity": None,
            "period_from": period_from,
            "period_to": period_to,
            "scenario": scenario,
            "bridge": [],
            "evidence": {},
            "notes": "No pack uploaded yet.",
        }
    result = compute_variance(
        {"facts": pack.normalized_facts, "periods": pack.periods},
        period_from,
        period_to,
    )
    return {
        "entity": pack.entity or entity,
        "period_from": result.get("period_from"),
        "period_to": result.get("period_to"),
        "scenario": scenario,
        "start": result.get("start"),
        "bridge": result.get("bridge", []),
        "end": result.get("end"),
        "reconciles": result.get("reconciles"),
        "evidence": result.get("evidence", {}),
        "notes": result.get("notes"),
    }


class ChatSessionRequest(BaseModel):
    pass


class ChatMessageRequest(BaseModel):
    session_id: str
    message: str
    entity: Optional[str] = None
    period: Optional[str] = None
    scenario: Optional[str] = None
    evidence_context: Optional[list[dict]] = None


@app.post("/chat/session")
def create_chat_session(_: ChatSessionRequest = Body(default={})) -> Dict[str, Any]:
    session = CHAT_STORE.create_session()
    return {"session_id": session.session_id}


@app.post("/chat/message")
def send_chat_message(payload: ChatMessageRequest) -> Dict[str, Any]:
    session = CHAT_STORE.get_session(payload.session_id)
    if not session:
        raise HTTPException(status_code=400, detail="Invalid session_id")

    message = payload.message.strip()
    CHAT_STORE.add_message(payload.session_id, "user", message)

    pack = PACK_STORE.get_latest_pack()
    if not pack:
        answer = "No financial pack uploaded yet. Upload and normalize an Excel file first."
        return {
            "session_id": payload.session_id,
            "answer": answer,
            "citations": [],
            "used_period": None,
            "used_metrics": [],
        }

    computed = compute_ratios(
        {"facts": pack.normalized_facts, "periods": pack.periods},
        payload.period,
    )
    period_used = computed.get("period_used")
    sources = computed.get("sources", {})

    used_metrics = []
    citations = []

    def to_evidence_item(source: dict | None) -> dict | None:
        if not source:
            return None
        lineage = source.get("lineage", {})
        return {
            "statement": source.get("statement"),
            "line_item": source.get("line_item"),
            "value": source.get("value"),
            "period": source.get("period"),
            "sheet": lineage.get("sheet"),
            "row_index": lineage.get("row_index"),
            "col": lineage.get("column"),
        }

    def add_metric(metric_key: str, source_key: str):
        source = sources.get(source_key)
        if source:
            used_metrics.append(metric_key)
            item = to_evidence_item(source)
            if item:
                citations.append(item)

    msg_lower = message.lower()

    evidence_list = []
    for key in ["assets", "equity", "net_profit", "customers_deposits", "total_income", "operating_expenses"]:
        item = to_evidence_item(sources.get(key))
        if item:
            evidence_list.append(item)
    if "summary" in msg_lower or "structured" in msg_lower:
        add_metric("total_assets", "assets")
        add_metric("total_equity", "equity")
        add_metric("net_profit", "net_profit")
        add_metric("cost_to_income", "operating_expenses")
        add_metric("cost_to_income", "total_income")

    interpretation_structured = {
        "executive_summary": None,
        "profitability": None,
        "efficiency": None,
        "balance_sheet": None,
        "risks": [],
    }

    if "interpret" in msg_lower:
        assets_val = sources.get("assets", {}).get("value")
        equity_val = sources.get("equity", {}).get("value")
        net_profit_val = sources.get("net_profit", {}).get("value")
        roa_val = computed.get("ratios", {}).get("roa")
        roe_val = computed.get("ratios", {}).get("roe")
        cti_val = computed.get("ratios", {}).get("cost_to_income")

        interpretation_structured = generate_openai_interpretation(
            entity_name=pack.entity or payload.entity or "Entity",
            period=period_used,
            assets=assets_val,
            equity=equity_val,
            net_profit=net_profit_val,
            roa=roa_val,
            roe=roe_val,
            cti=cti_val,
        ) or {
            "executive_summary": f"For {period_used}, results show net profit of {_format_million(net_profit_val)} against total assets of {_format_million(assets_val)}.",
            "profitability": f"ROA is {roa_val:.4f} and ROE is {roe_val:.4f} based on reported net profit and equity.",
            "efficiency": f"Cost-to-income is {cti_val:.4f}, using absolute operating expenses for consistency.",
            "balance_sheet": f"Total assets are {_format_million(assets_val)} and total equity is {_format_million(equity_val)}.",
            "risks": ["Validate income and expense classification for period consistency."],
        }

        answer = interpretation_structured.get("executive_summary") or (
            f"Interpretation for {period_used}: Net profit {_format_million(net_profit_val)} "
            f"on assets {_format_million(assets_val)}. ROA {roa_val:.4f}, ROE {roe_val:.4f}. "
            f"Cost-to-income {cti_val:.4f} using absolute expenses."
        )
    elif "roa" in msg_lower:
        add_metric("roa_annualized", "assets")
        add_metric("roa_annualized", "net_profit")
        value = computed.get("ratios", {}).get("roa")
        answer = (
            f"ROA for {period_used} is {value:.4f} based on Net Profit and Total Assets."
            if isinstance(value, (int, float))
            else f"ROA for {period_used} is not available yet."
        )
    elif "roe" in msg_lower:
        add_metric("roe_annualized", "equity")
        add_metric("roe_annualized", "net_profit")
        value = computed.get("ratios", {}).get("roe")
        answer = (
            f"ROE for {period_used} is {value:.4f} based on Net Profit and Total Equity."
            if isinstance(value, (int, float))
            else f"ROE for {period_used} is not available yet."
        )
    elif "cost" in msg_lower or "cti" in msg_lower:
        add_metric("cost_to_income", "operating_expenses")
        add_metric("cost_to_income", "total_income")
        value = computed.get("ratios", {}).get("cost_to_income")
        answer = (
            f"Cost-to-income for {period_used} is {value:.4f} based on Operating Expenses and Total Income."
            if isinstance(value, (int, float))
            else f"Cost-to-income for {period_used} is not available yet."
        )
    elif "total assets" in msg_lower:
        add_metric("total_assets", "assets")
        value = sources.get("assets", {}).get("value")
        answer = f"Total Assets for {period_used} is {value}."
    elif "net profit" in msg_lower:
        add_metric("net_profit", "net_profit")
        value = sources.get("net_profit", {}).get("value")
        answer = f"Net Profit for {period_used} is {value}."
    else:
        answer = f"I can explain ROA, ROE, cost-to-income, total assets, or net profit. Period in use: {period_used}."

    history = session.messages[-8:] if session.messages else []
    openai_payload = generate_openai_answer(
        message=message,
        context={
            "entity": pack.entity or payload.entity,
            "period": period_used,
            "kpis": {
                "total_assets": sources.get("assets", {}).get("value"),
                "total_equity": sources.get("equity", {}).get("value"),
                "net_profit": sources.get("net_profit", {}).get("value"),
                "customers_deposits": sources.get("customers_deposits", {}).get("value"),
            },
            "ratios": computed.get("ratios"),
            "evidence": evidence_list,
            "evidence_from_drawer": payload.evidence_context or [],
        },
        history=history,
    )
    if openai_payload and isinstance(openai_payload.get("answer"), str):
        answer = openai_payload["answer"]
        citations = openai_payload.get("citations") or citations
        data_backed = bool(openai_payload.get("data_backed"))
    else:
        if OPENAI_API_KEY:
            answer = "AI is temporarily unavailable. Please try again."
            data_backed = False
        else:
            answer = "AI is not configured. Please set OPENAI_API_KEY."
            data_backed = False

    summary = {
        "executive_summary": f"Summary for {period_used} based on latest uploaded pack.",
        "key_kpis": {
            "total_assets": sources.get("assets", {}).get("value"),
            "total_equity": sources.get("equity", {}).get("value"),
            "net_profit": sources.get("net_profit", {}).get("value"),
        },
        "profitability": {
            "roa": computed.get("ratios", {}).get("roa"),
            "roe": computed.get("ratios", {}).get("roe"),
        },
        "efficiency": {
            "cost_to_income": computed.get("ratios", {}).get("cost_to_income"),
        },
        "balance_sheet": {
            "total_assets": sources.get("assets", {}).get("value"),
            "total_equity": sources.get("equity", {}).get("value"),
        },
        "risks": ["Review expense structure if cost-to-income is elevated."],
        "evidence": citations,
    }

    CHAT_STORE.add_message(payload.session_id, "assistant", answer)
    session.memory.update(
        {
            "entity": payload.entity,
            "period": period_used,
            "scenario": payload.scenario,
            "last_metrics": used_metrics,
        }
    )
    return {
        "session_id": payload.session_id,
        "answer": answer,
        "summary": summary,
        "interpretation": interpretation_structured,
        "citations": citations,
        "data_backed": data_backed,
        "used_period": period_used,
        "used_metrics": used_metrics,
    }


@app.get("/exports/board-pack")
def export_board_pack() -> Response:
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except Exception:
        raise HTTPException(status_code=500, detail="PDF export requires reportlab. Install it and restart the backend.")

    pack = PACK_STORE.get_latest_pack()
    if not pack or not pack.periods:
        raise HTTPException(status_code=400, detail="No pack available to export")

    period = pack.periods[-1]
    previous_period = pack.periods[-2] if len(pack.periods) > 1 else period
    computed = compute_ratios({"facts": pack.normalized_facts, "periods": pack.periods}, period)
    ratios = computed.get("ratios", {})
    sources = computed.get("sources", {})
    entity_name = pack.entity or "Executive Summary"
    variance = compute_variance(
        {"facts": pack.normalized_facts, "periods": pack.periods},
        previous_period,
        period,
    )
    interpretation = generate_openai_interpretation(
        entity_name=entity_name,
        period=period,
        assets=sources.get("assets", {}).get("value"),
        equity=sources.get("equity", {}).get("value"),
        net_profit=sources.get("net_profit", {}).get("value"),
        roa=ratios.get("roa"),
        roe=ratios.get("roe"),
        cti=ratios.get("cost_to_income"),
    )

    def fmt(value: Any) -> str:
        return _format_million(value)

    def fmt_pct(value: Any) -> str:
        if value is None or not isinstance(value, (int, float)):
            return "—"
        return f"{value * 100:.2f}%"

    summary_lines = [
        f"Entity: {entity_name}",
        f"Period: {period}",
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        "Executive Summary:",
        f"- Total Assets: {fmt(sources.get('assets', {}).get('value'))} AED",
        f"- Total Equity: {fmt(sources.get('equity', {}).get('value'))} AED",
        f"- Net Profit: {fmt(sources.get('net_profit', {}).get('value'))} AED",
        "",
        "Profitability:",
        f"- ROA (annualized): {fmt_pct(ratios.get('roa'))}",
        f"- ROE (annualized): {fmt_pct(ratios.get('roe'))}",
        "",
        "Efficiency:",
        f"- Cost-to-Income: {fmt_pct(ratios.get('cost_to_income'))}",
    ]

    interpretation_lines = ["", "Structured Interpretation:"]
    if interpretation:
        interpretation_lines.extend(
            [
                f"- Executive Summary: {interpretation.get('executive_summary')}",
                f"- Profitability: {interpretation.get('profitability')}",
                f"- Efficiency: {interpretation.get('efficiency')}",
                f"- Balance Sheet: {interpretation.get('balance_sheet')}",
                f"- Risks / Focus: {'; '.join(interpretation.get('risks') or [])}",
            ]
        )
    else:
        interpretation_lines.append("- Interpretation not available (missing OpenAI API key).")

    variance_lines = [
        "",
        "Variance Bridge:",
        f"- Start Net Profit ({variance.get('period_from')}): {fmt(variance.get('start', {}).get('value'))} AED",
    ]
    for item in variance.get("bridge", []):
        variance_lines.append(
            f"- {item.get('label')}: {fmt(item.get('delta'))} AED (Running: {fmt(item.get('running_total'))} AED)"
        )
    variance_lines.append(
        f"- End Net Profit ({variance.get('period_to')}): {fmt(variance.get('end', {}).get('value'))} AED"
    )

    evidence_lines = ["", "Evidence Table:"]
    for key, src in sources.items():
        if not src:
            continue
        lineage = src.get("lineage", {}) if isinstance(src, dict) else {}
        evidence_lines.append(
            f"- {key}: {fmt(src.get('value'))} AED | {src.get('line_item')} | "
            f"Sheet {lineage.get('sheet')} Row {lineage.get('row_index')} Col {lineage.get('column')} | {src.get('period')}"
        )

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=20,
        textColor=colors.HexColor("#0B1A2B"),
        spaceAfter=12,
    )
    h2 = ParagraphStyle(
        "H2",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=13,
        textColor=colors.HexColor("#0B1A2B"),
        spaceBefore=10,
        spaceAfter=6,
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=10.5,
        leading=14,
        textColor=colors.HexColor("#1B2430"),
    )
    subtle = ParagraphStyle(
        "Subtle",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=13,
        textColor=colors.HexColor("#5B6B7A"),
    )

    story = []
    story.append(Paragraph("Finance Hub — Board Pack", title_style))
    story.append(Paragraph(f"<b>Entity:</b> {entity_name}  &nbsp;&nbsp; <b>Period:</b> {period}", body))
    story.append(Paragraph(f"<b>Generated:</b> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", subtle))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Executive Summary", h2))
    for line in summary_lines[4:]:
        story.append(Paragraph(line.replace("- ", "• "), body))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Structured Interpretation (CFO)", h2))
    for line in interpretation_lines[1:]:
        story.append(Paragraph(line.replace("- ", "• "), body))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Key KPIs & Ratios", h2))
    kpi_table = [
        ["Metric", "Value"],
        ["Total Assets", _format_million(sources.get("assets", {}).get("value"))],
        ["Total Equity", _format_million(sources.get("equity", {}).get("value"))],
        ["Net Profit", _format_million(sources.get("net_profit", {}).get("value"))],
        ["ROA (annualized)", fmt_pct(ratios.get("roa"))],
        ["ROE (annualized)", fmt_pct(ratios.get("roe"))],
        ["Cost-to-Income", fmt_pct(ratios.get("cost_to_income"))],
    ]
    kpi_tbl = Table(kpi_table, colWidths=[3.2 * inch, 2.2 * inch])
    kpi_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B1A2B")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D6DCE5")),
                ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#F7F9FC")),
            ]
        )
    )
    story.append(kpi_tbl)
    story.append(PageBreak())

    story.append(Paragraph("Variance Bridge", h2))
    variance_table = [
        ["Driver", "Delta (M AED)", "Running (M AED)"],
    ]
    for item in variance.get("bridge", []):
        variance_table.append(
            [
                item.get("label"),
                _format_million(item.get("delta")).replace(" AED", ""),
                _format_million(item.get("running_total")).replace(" AED", ""),
            ]
        )
    var_tbl = Table(variance_table, colWidths=[3.2 * inch, 1.4 * inch, 1.4 * inch])
    var_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B1A2B")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D6DCE5")),
                ("BACKGROUND", (0, 1), (-1, -1), colors.white),
            ]
        )
    )
    story.append(Paragraph(f"Start Net Profit: {_format_million(variance.get('start', {}).get('value'))}", body))
    story.append(Spacer(1, 6))
    story.append(var_tbl)
    story.append(Spacer(1, 6))
    story.append(Paragraph(f"End Net Profit: {_format_million(variance.get('end', {}).get('value'))}", body))
    story.append(PageBreak())

    story.append(Paragraph("Evidence Table", h2))
    evidence_table = [["Metric", "Value (M AED)", "Line Item", "Sheet", "Row", "Col", "Period"]]
    for key, src in sources.items():
        if not src:
            continue
        lineage = src.get("lineage", {})
        evidence_table.append(
            [
                key,
                _format_million(src.get("value")).replace(" AED", ""),
                src.get("line_item") or "—",
                lineage.get("sheet") or "—",
                lineage.get("row_index") if lineage.get("row_index") is not None else "—",
                lineage.get("column") or "—",
                src.get("period") or "—",
            ]
        )
    ev_tbl = Table(evidence_table, colWidths=[1.2 * inch, 1.0 * inch, 2.0 * inch, 0.7 * inch, 0.6 * inch, 0.6 * inch, 1.0 * inch])
    ev_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B1A2B")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D6DCE5")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story.append(ev_tbl)

    doc.build(story)
    pdf_bytes = buffer.getvalue()
    buffer.close()

    filename = f"board-pack-{pack.upload_id}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@app.get("/routes")
def list_routes():
    return [route.path for route in app.routes]
