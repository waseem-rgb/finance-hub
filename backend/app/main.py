# backend/app/main.py

import json
import logging
import os
import re
import tempfile
import threading
from io import BytesIO
import traceback
from datetime import datetime, timezone
from textwrap import wrap
from typing import Any, Dict, Optional
from urllib import error as urlerror
from urllib import request as urlrequest

from fastapi import BackgroundTasks, Body, Depends, FastAPI, File, Header, HTTPException, UploadFile, status
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
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_TIMEOUT_SECONDS = int(os.getenv("OPENAI_TIMEOUT_SECONDS", "20"))
OPENAI_MAX_RETRIES = int(os.getenv("OPENAI_MAX_RETRIES", "1"))
AI_LOGGER = logging.getLogger("finance_hub.ai")
ALLOWED_ROLES = {"CFO", "CEO", "Director", "Shareholder", "CB"}

ROLE_ROUTE_ACCESS: dict[str, set[str]] = {
    "view_overview": {"CFO", "CEO", "Director", "Shareholder", "CB"},
    "view_exec_governance": {"CFO", "CEO", "Director", "CB"},
    "cfo_only": {"CFO"},
}

EXPORT_JOBS: Dict[str, Dict[str, Any]] = {}
EXPORT_JOBS_LOCK = threading.Lock()

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
    allow_origin_regex=r"^https://finance(-hub)?-.*\.vercel\.app$",
)


def _extract_role(role_header: Optional[str]) -> str:
    role = (role_header or "").strip()
    if role not in ALLOWED_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "access_denied",
                "detail": "Invalid or missing role. Expected one of: CFO, CEO, Director, Shareholder, CB.",
            },
        )
    return role


def require_roles(access_key: str):
    allowed = ROLE_ROUTE_ACCESS[access_key]

    def _guard(x_user_role: Optional[str] = Header(default=None, alias="X-User-Role")) -> str:
        role = _extract_role(x_user_role)
        if role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "access_denied",
                    "detail": f"Role '{role}' is not allowed for this action.",
                    "allowed_roles": sorted(list(allowed)),
                },
            )
        return role

    return _guard


def _format_million(value: Any) -> str:
    if value is None or not isinstance(value, (int, float)):
        return "—"
    return f"{value / 1_000_000:.2f}M AED"


def _sanitize_markdown_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    text = re.sub(r"[*_`#>]+", "", text)
    text = re.sub(r"\[(.*?)\]\((.*?)\)", r"\1", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def _job_update(job_id: str, **kwargs: Any) -> None:
    with EXPORT_JOBS_LOCK:
        job = EXPORT_JOBS.get(job_id)
        if not job:
            return
        job.update(kwargs)


def _job_create() -> str:
    from uuid import uuid4

    job_id = str(uuid4())
    with EXPORT_JOBS_LOCK:
        EXPORT_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": 0,
            "error": None,
            "download_ready": False,
            "filename": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "completed_at": None,
            "pdf_bytes": None,
        }
    return job_id


class AIProviderError(Exception):
    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def _normalize_interpretation_payload(payload: Any, fallback: Optional[str] = None) -> dict:
    def _norm_text(v: Any, default: Optional[str] = None) -> str:
        cleaned = _sanitize_markdown_text(v)
        return cleaned or (default or "")

    default_exec = fallback or "No interpretation available."
    default_profit = "ROA/ROE and net profit trends should be reviewed with period-over-period drivers."
    default_eff = "Cost-to-income and operating expense trajectory should be monitored against revenue quality."
    default_bs = "Balance sheet review should cover assets, equity, deposits, and leverage buffers."
    default_risks = [
        "Liquidity buffers and funding concentration should be monitored.",
        "Asset quality and concentration trends should be reviewed.",
        "Operational resilience and cost discipline remain focus areas.",
    ]

    if isinstance(payload, dict):
        risks = payload.get("risks")
        if not isinstance(risks, list):
            risks = [str(risks)] if risks else []
        cleaned_risks = [_norm_text(item) for item in risks if _norm_text(item)]
        return {
            "executive_summary": _norm_text(payload.get("executive_summary") or payload.get("answer"), default_exec),
            "profitability": _norm_text(payload.get("profitability"), default_profit),
            "efficiency": _norm_text(payload.get("efficiency"), default_eff),
            "balance_sheet": _norm_text(payload.get("balance_sheet"), default_bs),
            "risks": cleaned_risks or default_risks,
        }
    if isinstance(payload, str) and payload.strip():
        return {
            "executive_summary": _norm_text(payload, default_exec),
            "profitability": default_profit,
            "efficiency": default_eff,
            "balance_sheet": default_bs,
            "risks": default_risks,
        }
    return {
        "executive_summary": _norm_text(fallback, default_exec),
        "profitability": default_profit,
        "efficiency": default_eff,
        "balance_sheet": default_bs,
        "risks": default_risks,
    }


def _get_openai_api_key() -> str | None:
    api_key = os.getenv("OPENAI_API_KEY")
    return api_key.strip() if api_key else None


def _openai_chat_completion(messages: list[dict[str, str]]) -> str:
    api_key = _get_openai_api_key()
    if not api_key:
        raise AIProviderError("AI not configured")

    payload = {
        "model": OPENAI_MODEL,
        "messages": messages,
        "temperature": 0.2,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(
        "https://api.openai.com/v1/chat/completions",
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    last_exc: Optional[Exception] = None
    for attempt in range(OPENAI_MAX_RETRIES + 1):
        try:
            with urlrequest.urlopen(req, timeout=OPENAI_TIMEOUT_SECONDS) as resp:
                body = resp.read().decode("utf-8")
            parsed = json.loads(body)
            return parsed["choices"][0]["message"]["content"]
        except urlerror.HTTPError as exc:
            AI_LOGGER.exception("OpenAI HTTP error (%s): %s", exc.code, str(exc))
            detail = f"AI upstream failure (HTTP {exc.code})"
            if attempt >= OPENAI_MAX_RETRIES:
                raise AIProviderError(detail[:200]) from exc
            last_exc = exc
        except TimeoutError as exc:
            AI_LOGGER.exception("OpenAI timeout: %s", str(exc))
            detail = "AI upstream timeout"
            if attempt >= OPENAI_MAX_RETRIES:
                raise AIProviderError(detail[:200]) from exc
            last_exc = exc
        except Exception as exc:
            AI_LOGGER.exception("OpenAI chat completion failed (%s): %s", exc.__class__.__name__, str(exc))
            lower = (str(exc) or "").lower()
            if "timed out" in lower or "timeout" in lower:
                detail = "AI upstream timeout"
            else:
                detail = "AI upstream failure"
            if attempt >= OPENAI_MAX_RETRIES:
                raise AIProviderError(detail[:200]) from exc
            last_exc = exc
    if last_exc:
        raise AIProviderError("AI upstream failure") from last_exc
    raise AIProviderError("AI upstream failure")


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
    if not _get_openai_api_key():
        return None
    prompt = (
        "You are a CFO writing an executive financial interpretation. "
        "Use M AED notation with 2 decimals for money. Use concise, bank-grade language. "
        "Return ONLY JSON with keys: executive_summary, profitability, efficiency, balance_sheet, risks (array of strings). "
        f"Entity: {entity_name}. Period: {period}. "
        f"Total Assets: {_format_million(assets)}. Total Equity: {_format_million(equity)}. "
        f"Net Profit: {_format_million(net_profit)}. ROA: {roa}. ROE: {roe}. Cost-to-Income: {cti}."
    )
    try:
        content = _openai_chat_completion(
            [
                {"role": "system", "content": "You are a bank-grade CFO analyst."},
                {"role": "user", "content": prompt},
            ]
        )
        try:
            return _normalize_interpretation_payload(json.loads(content))
        except json.JSONDecodeError:
            return _normalize_interpretation_payload(content)
    except AIProviderError:
        return None


def generate_openai_answer(message: str, context: dict, history: list[dict]) -> dict:
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
    content = _openai_chat_completion(
        [
            {"role": "system", "content": "You are a precise, honest assistant."},
            {"role": "user", "content": prompt},
        ]
    )
    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        return {"answer": content, "citations": [], "data_backed": False}
    if not isinstance(payload, dict):
        return {"answer": str(payload), "citations": [], "data_backed": False}
    return payload

@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/debug/status")
def debug_status(_: str = Depends(require_roles("view_exec_governance"))) -> Dict[str, Any]:
    pack = PACK_STORE.get_latest_pack()
    with EXPORT_JOBS_LOCK:
        active_jobs_count = sum(1 for job in EXPORT_JOBS.values() if job.get("status") not in {"completed", "failed"})
    return {
        "status": "ok",
        "openai_key_present": bool(_get_openai_api_key()),
        "last_upload_id": pack.upload_id if pack else None,
        "current_entity": pack.entity if pack else None,
        "active_jobs_count": active_jobs_count,
    }

@app.get("/ratios")
def ratios(
    entity: str = "UAE Entity 01",
    period: str = "Mar-2025",
    scenario: str = "Actual",
    _: str = Depends(require_roles("view_overview")),
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
async def upload_excel(
    file: UploadFile = File(...),
    save: bool = False,
    _: str = Depends(require_roles("cfo_only")),
) -> Dict[str, Any]:
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
async def normalize_excel(
    file: UploadFile = File(...),
    _: str = Depends(require_roles("cfo_only")),
) -> Dict[str, Any]:
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
def get_periods(
    entity: str = "UAE Entity 01",
    _: str = Depends(require_roles("view_overview")),
) -> Dict[str, Any]:
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
def clear_pack(_: str = Depends(require_roles("cfo_only"))) -> Dict[str, Any]:
    PACK_STORE.clear()
    CHAT_STORE.clear()
    return {"status": "cleared"}

@app.get("/variance")
def get_variance(
    period_from: str,
    period_to: str,
    scenario: str = "Actual",
    entity: str = "UAE Entity 01",
    _: str = Depends(require_roles("view_exec_governance")),
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
def create_chat_session(
    _: ChatSessionRequest = Body(default={}),
    role: str = Depends(require_roles("cfo_only")),
) -> Dict[str, Any]:
    session = CHAT_STORE.create_session()
    session.memory["role"] = role
    return {"session_id": session.session_id}


@app.post("/chat/message")
def send_chat_message(
    payload: ChatMessageRequest,
    role: str = Depends(require_roles("cfo_only")),
) -> Dict[str, Any]:
    try:
        session = CHAT_STORE.get_session(payload.session_id)
        if not session:
            raise HTTPException(status_code=400, detail="Invalid session_id")

        session_role = session.memory.get("role")
        if session_role and session_role != role:
            raise HTTPException(
                status_code=403,
                detail={"error": "access_denied", "detail": "Session role mismatch. Start a new chat session."},
            )

        message = payload.message.strip()
        if not message:
            raise HTTPException(status_code=400, detail={"error": "invalid_request", "detail": "Message cannot be empty"})

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
                "data_backed": False,
                "meta": {"provider": "fallback", "reason": "no_pack"},
                "interpretation": _normalize_interpretation_payload(None, answer),
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

        interpretation_structured = _normalize_interpretation_payload(None)
        data_backed = True

        if "interpret" in msg_lower:
            assets_val = sources.get("assets", {}).get("value")
            equity_val = sources.get("equity", {}).get("value")
            net_profit_val = sources.get("net_profit", {}).get("value")
            roa_val = computed.get("ratios", {}).get("roa")
            roe_val = computed.get("ratios", {}).get("roe")
            cti_val = computed.get("ratios", {}).get("cost_to_income")
            default_interp = _normalize_interpretation_payload(
                {
                    "executive_summary": f"For {period_used}, results show net profit of {_format_million(net_profit_val)} against total assets of {_format_million(assets_val)}.",
                    "profitability": f"ROA is {roa_val:.4f} and ROE is {roe_val:.4f} based on reported net profit and equity.",
                    "efficiency": f"Cost-to-income is {cti_val:.4f}, using absolute operating expenses for consistency.",
                    "balance_sheet": f"Total assets are {_format_million(assets_val)} and total equity is {_format_million(equity_val)}.",
                    "risks": ["Validate income and expense classification for period consistency."],
                }
            )
            interpretation_structured = generate_openai_interpretation(
                entity_name=pack.entity or payload.entity or "Entity",
                period=period_used,
                assets=assets_val,
                equity=equity_val,
                net_profit=net_profit_val,
                roa=roa_val,
                roe=roe_val,
                cti=cti_val,
            ) or default_interp

            answer = interpretation_structured.get("executive_summary") or default_interp["executive_summary"]
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

        meta = {"provider": "fallback", "reason": "heuristic"}
        history = session.messages[-8:] if session.messages else []
        if _get_openai_api_key():
            try:
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
                if isinstance(openai_payload.get("answer"), str):
                    answer = openai_payload["answer"]
                    citations = openai_payload.get("citations") or citations
                    data_backed = bool(openai_payload.get("data_backed"))
                    meta = {"provider": "openai", "reason": "ok"}
                else:
                    AI_LOGGER.error("OpenAI payload missing answer field: %s", openai_payload)
                    data_backed = False
                    meta = {"provider": "fallback", "reason": "missing_answer_field"}
            except AIProviderError as exc:
                AI_LOGGER.exception("AI provider error in /chat/message: %s", exc.detail)
                data_backed = False
                reason = "ai_timeout" if "timeout" in exc.detail.lower() else "ai_upstream_failure"
                meta = {"provider": "fallback", "reason": reason, "detail": exc.detail}
            except Exception as exc:
                AI_LOGGER.exception("AI processing failed (%s): %s", exc.__class__.__name__, str(exc))
                data_backed = False
                meta = {"provider": "fallback", "reason": "ai_processing_exception"}
        else:
            data_backed = False
            meta = {"provider": "fallback", "reason": "ai_not_configured"}

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
                "role": role,
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
            "meta": meta,
        }
    except HTTPException:
        raise
    except Exception as exc:
        AI_LOGGER.exception("Unhandled /chat/message error (%s): %s", exc.__class__.__name__, str(exc))
        raise HTTPException(
            status_code=500,
            detail={
                "error": "chat_internal_error",
                "detail": "Chat request failed unexpectedly. Please retry.",
                "error_type": exc.__class__.__name__,
            },
        ) from exc


@app.get("/exports/board-pack")
def export_board_pack(_: str = Depends(require_roles("view_exec_governance"))) -> Response:
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except Exception:
        raise HTTPException(status_code=500, detail="PDF export requires reportlab. Install it and restart the backend.")

    try:
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
        if not pdf_bytes:
            raise HTTPException(status_code=500, detail="Generated PDF is empty")

        filename = f"board-pack-{pack.upload_id}.pdf"
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception as exc:
        AI_LOGGER.exception("Board pack export failed (%s): %s", exc.__class__.__name__, str(exc))
        raise HTTPException(
            status_code=500,
            detail={
                "error": "board_pack_export_failed",
                "detail": "Board pack generation failed. Please try again.",
                "error_type": exc.__class__.__name__,
            },
        ) from exc


def _run_board_pack_export_job(job_id: str) -> None:
    _job_update(job_id, status="running", progress=20)
    try:
        response = export_board_pack("CFO")
        pdf_bytes = response.body if hasattr(response, "body") else None
        if not pdf_bytes:
            raise RuntimeError("empty export bytes")
        filename = "board-pack.pdf"
        disposition = (response.headers or {}).get("Content-Disposition")
        if disposition and "filename=" in disposition:
            filename = disposition.split("filename=", 1)[-1].strip().strip('"')
        _job_update(
            job_id,
            status="completed",
            progress=100,
            filename=filename,
            download_ready=True,
            completed_at=datetime.now(timezone.utc).isoformat(),
            pdf_bytes=pdf_bytes,
        )
    except Exception as exc:
        AI_LOGGER.exception("Export job failed (%s): %s", exc.__class__.__name__, str(exc))
        _job_update(
            job_id,
            status="failed",
            progress=100,
            error=_sanitize_markdown_text(str(exc)) or "Export failed",
            completed_at=datetime.now(timezone.utc).isoformat(),
        )


@app.post("/exports/board-pack/jobs")
def create_board_pack_job(
    background_tasks: BackgroundTasks,
    _: str = Depends(require_roles("view_exec_governance")),
) -> Dict[str, Any]:
    job_id = _job_create()
    background_tasks.add_task(_run_board_pack_export_job, job_id)
    return {"job_id": job_id, "status": "queued"}


@app.get("/exports/board-pack/jobs/{job_id}")
def get_board_pack_job(job_id: str, _: str = Depends(require_roles("view_exec_governance"))) -> Dict[str, Any]:
    with EXPORT_JOBS_LOCK:
        job = EXPORT_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Export job not found")
        return {
            "job_id": job["job_id"],
            "status": job["status"],
            "progress": job["progress"],
            "error": job["error"],
            "download_ready": job["download_ready"],
            "filename": job["filename"],
        }


@app.get("/exports/board-pack/jobs/{job_id}/download")
def download_board_pack_job(job_id: str, _: str = Depends(require_roles("view_exec_governance"))) -> Response:
    with EXPORT_JOBS_LOCK:
        job = EXPORT_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Export job not found")
        if job.get("status") != "completed" or not job.get("pdf_bytes"):
            raise HTTPException(status_code=409, detail="Export not ready")
        filename = job.get("filename") or f"board-pack-{job_id}.pdf"
        pdf_bytes = job["pdf_bytes"]
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@app.get("/routes")
def list_routes():
    return [route.path for route in app.routes]
