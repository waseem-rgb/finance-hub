"use client";

import React from "react";
import { useSearchParams } from "next/navigation";
import { BarChart3, Building2, FileSpreadsheet, ShieldCheck, Users } from "lucide-react";
import {
  API_BASE_URL,
  createChatSession,
  getPeriods,
  getRatios,
  getVariance,
  getMetricHistory,
  sendChatMessage,
  uploadAndNormalizeExcel,
  clearPack,
} from "@/lib/api";
import EvidenceDrawer from "@/components/ui/EvidenceDrawer";
import KpiCard from "@/components/dashboard/KpiCard";
import RatioCard from "@/components/dashboard/RatioCard";
import { Role, RoleProvider } from "@/components/dashboard/RoleContext";
import MetricGraphDrawer from "@/components/graphs/MetricGraphDrawer";

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function periodKey(label: string) {
  const match = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[- ]?(\d{2,4})/i.exec(label);
  if (!match) return 0;
  const month = MONTH_INDEX[match[1].toLowerCase()] || 0;
  let year = parseInt(match[2], 10);
  if (year < 100) year += 2000;
  return year * 100 + month;
}

function formatCompact(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return `${n.toFixed(0)}`;
}

function formatMillionValue(value: any) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${(value / 1_000_000).toFixed(1)} M`;
}

function formatMillionAED(value: any) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${(value / 1_000_000).toFixed(2)} M AED`;
}

function unitFor(value: string) {
  return value === "—" || value === "Loading..." ? "" : "AED";
}

type EvidenceItem = {
  statement?: string;
  line_item?: string;
  value?: number;
  period?: string;
  sheet?: string;
  row_index?: number;
  col?: string | number;
  cell?: string;
  lineage?: any;
};

type EvidenceState = {
  title: string;
  value: string | null;
  delta: string | null;
  primary: EvidenceItem | null;
  inputs: Array<EvidenceItem | null>;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: EvidenceItem[];
  summary?: any;
  data_backed?: boolean;
};

type NavSection = "Overview" | "Statements" | "Governance" | "Roles & Access";

function safeText(v: any) {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  return String(v);
}

function prettyNumber(v: any) {
  return formatMillionAED(v);
}

function formatPercent(v: any) {
  if (typeof v !== "number" || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

type RolePermissions = {
  controls: boolean;
  evidence: boolean;
  variance: boolean;
  ratios: boolean;
  exports: boolean;
  chat: boolean;
  regulatory: boolean;
  topKpisOnly: boolean;
  showDeposits: boolean;
  showEquity: boolean;
};

const ROLE_PERMISSIONS: Record<Role, RolePermissions> = {
  CFO: {
    controls: true,
    evidence: true,
    variance: true,
    ratios: true,
    exports: true,
    chat: true,
    regulatory: false,
    topKpisOnly: false,
    showDeposits: true,
    showEquity: true,
  },
  CEO: {
    controls: false,
    evidence: false,
    variance: false,
    ratios: true,
    exports: true,
    chat: false,
    regulatory: false,
    topKpisOnly: true,
    showDeposits: true,
    showEquity: true,
  },
  Director: {
    controls: false,
    evidence: true,
    variance: true,
    ratios: true,
    exports: true,
    chat: false,
    regulatory: false,
    topKpisOnly: false,
    showDeposits: true,
    showEquity: true,
  },
  Shareholder: {
    controls: false,
    evidence: false,
    variance: false,
    ratios: false,
    exports: false,
    chat: false,
    regulatory: false,
    topKpisOnly: true,
    showDeposits: true,
    showEquity: true,
  },
  CB: {
    controls: false,
    evidence: true,
    variance: false,
    ratios: true,
    exports: true,
    chat: false,
    regulatory: true,
    topKpisOnly: false,
    showDeposits: true,
    showEquity: true,
  },
};

const ROLE_SECTIONS: Record<Role, NavSection[]> = {
  CFO: ["Overview", "Statements", "Governance", "Roles & Access"],
  CEO: ["Overview"],
  Director: ["Overview", "Statements", "Governance"],
  Shareholder: ["Overview"],
  CB: ["Overview", "Governance"],
};

function PageWithParams() {
  const searchParams = useSearchParams();
  const initialQueryPeriod = React.useMemo(() => searchParams.get("period"), [searchParams]);

  const [role, setRole] = React.useState<Role>("CFO");

  // IMPORTANT: start with empty period and let /periods pick the latest.
  const [period, setPeriod] = React.useState<string>("");
  const [scenario, setScenario] = React.useState<string>("Actual");
  const [entity, setEntity] = React.useState<string>("");

  const [section, setSection] = React.useState<NavSection>("Overview");

  const [periods, setPeriods] = React.useState<string[]>([]);
  const [periodsLoading, setPeriodsLoading] = React.useState<boolean>(true);
  const [data, setData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [liveStatus, setLiveStatus] = React.useState<"loading" | "connected" | "error">("loading");

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = React.useState<boolean>(false);
  const [uploadPreview, setUploadPreview] = React.useState<{
    filename: string;
    sheets: string[];
    periods: string[];
    facts_count: number;
  } | null>(null);

  const [toast, setToast] = React.useState<{ type: "success" | "error"; message: string } | null>(null);

  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [evidenceState, setEvidenceState] = React.useState<EvidenceState | null>(null);

  const [varianceData, setVarianceData] = React.useState<any>(null);

  const [exportOpen, setExportOpen] = React.useState<boolean>(false);
  const [exportMessage, setExportMessage] = React.useState<string | null>(null);

  const [chatOpen, setChatOpen] = React.useState<boolean>(false);
  const [chatSessionId, setChatSessionId] = React.useState<string | null>(null);
  const [chatInput, setChatInput] = React.useState<string>("");
  const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([]);
  const [summaryData, setSummaryData] = React.useState<any | null>(null);
  const [summaryLoading, setSummaryLoading] = React.useState<boolean>(false);
  const [interpretationData, setInterpretationData] = React.useState<any | null>(null);
  const [interpretationLoading, setInterpretationLoading] = React.useState<boolean>(false);
  const chatScrollRef = React.useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = React.useState<"dark" | "light">("dark");
  const [showApiWarning, setShowApiWarning] = React.useState(false);
  const [graphOpen, setGraphOpen] = React.useState(false);
  const [graphMetric, setGraphMetric] = React.useState<{ key: string; label: string; unit: "AED" | "%" | "number" } | null>(null);
  const [graphData, setGraphData] = React.useState<{ actual: Array<{ period: string; value: number | null; lineage?: any }>; budget: Array<{ period: string; value: number | null; lineage?: any }> }>({ actual: [], budget: [] });
  const graphCache = React.useRef<Map<string, { actual: Array<{ period: string; value: number | null; lineage?: any }>; budget: Array<{ period: string; value: number | null; lineage?: any }> }>>(new Map());

  const periodInitialized = React.useRef(false);
  const varianceRef = React.useRef<HTMLDivElement | null>(null);

  const permissions = ROLE_PERMISSIONS[role];
  const allowedSections = ROLE_SECTIONS[role];
  const canSeeControls = permissions.controls;
  const canSeeRegulatory = permissions.regulatory;
  const canSeeEvidence = permissions.evidence;
  const canSeeVariance = permissions.variance;
  const canSeeRatios = permissions.ratios;
  const showTopKpisOnly = permissions.topKpisOnly;
  const canSeeExports = permissions.exports;
  const canSeeChat = permissions.chat;
  const showDeposits = permissions.showDeposits;
  const showEquity = permissions.showEquity;
  const isLight = theme === "light";

  const pageBg = isLight ? "bg-[#F5F7FB] text-slate-900" : "bg-[#070A12] text-white";
  const panelClass = isLight
    ? "rounded-3xl border border-slate-200 bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.04)]"
    : "rounded-3xl border border-white/10 bg-white/[0.03]";
  const panelMuted = isLight ? "text-slate-500" : "text-white/60";
  const panelSubtle = isLight ? "text-slate-600" : "text-white/50";
  const panelText = isLight ? "text-slate-900" : "text-white";
  const sidebarClass = isLight
    ? "rounded-3xl border border-slate-200 bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.04)]"
    : "rounded-3xl border border-white/10 bg-white/[0.03]";
  const navActive = isLight ? "bg-slate-100 text-slate-900" : "bg-white/10 text-white";
  const navInactive = isLight
    ? "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    : "text-white/70 hover:bg-white/5 hover:text-white";
  const rolePanel = isLight ? "rounded-2xl border border-slate-200 bg-white p-3" : "rounded-2xl border border-white/10 bg-white/5 p-3";
  const roleChipActive = isLight
    ? "border-slate-300 bg-slate-900 text-white"
    : "border-white/20 bg-white/10 text-white";
  const roleChipInactive = isLight
    ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
    : "border-white/10 bg-transparent text-white/70 hover:bg-white/5";
  const chipClass = isLight
    ? "rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600"
    : "rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70";
  const buttonPrimary = isLight
    ? "rounded-2xl border border-slate-200 bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
    : "rounded-2xl border border-white/10 bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15";
  const buttonGhost = isLight
    ? "rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
    : "rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 hover:bg-white/10";
  const selectClass = isLight
    ? "max-w-[200px] truncate rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none"
    : "max-w-[200px] truncate rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 outline-none";
  const cardInner = isLight ? "border-slate-200 bg-white text-slate-700" : "border-white/10 bg-white/5 text-white/70";
  const chatPanel = isLight
    ? "w-[320px] max-w-[85vw] rounded-2xl border border-slate-200 bg-white shadow-2xl"
    : "w-[320px] max-w-[85vw] rounded-2xl border border-white/10 bg-[#0B0F1A] shadow-2xl";
  const chatHeader = isLight ? "text-slate-500" : "text-white/50";
  const chatTitle = isLight ? "text-slate-900" : "text-white/90";
  const chatBubbleUser = isLight ? "bg-slate-100 text-slate-800 border-slate-200" : "bg-white/5 text-white/80 border-white/10";
  const chatBubbleAssistant = isLight ? "bg-white text-slate-700 border-slate-200" : "bg-white/[0.03] text-white/70 border-white/10";
  const chatInputClass = isLight
    ? "flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none"
    : "flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 outline-none";
  const chatSendClass = isLight
    ? "rounded-xl border border-slate-200 bg-slate-900 px-3 py-2 text-xs text-white hover:bg-slate-800"
    : "rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs text-white/80 hover:bg-white/15";
  const toastSuccessClass = isLight
    ? "border-slate-200 bg-white text-slate-800"
    : "border-white/10 bg-white/10 text-white";

  React.useEffect(() => {
    let cancelled = false;

    async function loadPeriods() {
      setPeriodsLoading(true);
      const res = await getPeriods();
      if (cancelled) return;

      if (res.ok) {
        const sorted = [...(res.data.periods || [])].sort((a, b) => periodKey(a) - periodKey(b));
        setPeriods(sorted);
        if (res.data.entity) {
          setEntity(res.data.entity);
        }

        // Initialize period only once, prefer query param if valid, else latest.
        if (!periodInitialized.current) {
          if (sorted.length > 0) {
            if (initialQueryPeriod && sorted.includes(initialQueryPeriod)) {
              setPeriod(initialQueryPeriod);
            } else {
              setPeriod(sorted[sorted.length - 1]);
            }
          } else {
            setPeriod(""); // no data yet
          }
          periodInitialized.current = true;
        }
      }

      setPeriodsLoading(false);
    }

    loadPeriods();
    return () => {
      cancelled = true;
    };
  }, [initialQueryPeriod]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const isLocalApi = API_BASE_URL.includes("127.0.0.1") || API_BASE_URL.includes("localhost");
    const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    setShowApiWarning(isLocalApi && !isLocalHost);
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function loadRatios() {
      if (!period) {
        setData(null);
        setLoading(false);
        setLiveStatus("loading");
        return;
      }

      setLoading(true);
      setLiveStatus("loading");
      const res = await getRatios(entity, period, scenario);
      if (cancelled) return;

      if (res.ok) {
        setData(res.data);
        if (res.data?.entity && res.data.entity !== entity) {
          setEntity(res.data.entity);
        }
        setLiveStatus("connected");
      } else {
        setData(null);
        setLiveStatus("error");
      }
      setLoading(false);
    }

    loadRatios();
    return () => {
      cancelled = true;
    };
  }, [entity, period, scenario]);

  const previousPeriod = React.useMemo(() => {
    if (!periods.length || !period) return null;
    const sorted = [...periods].sort((a, b) => periodKey(a) - periodKey(b));
    const idx = sorted.indexOf(period);
    if (idx > 0) return sorted[idx - 1];
    return sorted.length > 1 ? sorted[0] : null;
  }, [periods, period]);

  React.useEffect(() => {
    let cancelled = false;
    async function loadVariance() {
      if (!canSeeVariance || !previousPeriod || !period) return;
      const res = await getVariance(previousPeriod, period, scenario);
      if (cancelled) return;
      setVarianceData(res.ok ? res.data : null);
    }
    loadVariance();
    return () => {
      cancelled = true;
    };
  }, [canSeeVariance, previousPeriod, period, scenario]);

  React.useEffect(() => {
    if (!chatOpen) return;
    const node = chatScrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [chatMessages, chatOpen]);

  async function handleExcelUpload(file: File) {
    try {
      setUploading(true);
      const res = await uploadAndNormalizeExcel(file);
      if (res.ok) {
        setUploadPreview(res.data);
        if (res.data.entity) {
          setEntity(res.data.entity);
        }
        setToast({ type: "success", message: `Uploaded: ${res.data.filename}` });

        // refresh periods from backend (source of truth)
        const periodsRes = await getPeriods();
        if (periodsRes.ok) {
          const sorted = [...(periodsRes.data.periods || [])].sort((a, b) => periodKey(a) - periodKey(b));
          setPeriods(sorted);
          if (periodsRes.data.entity) {
            setEntity(periodsRes.data.entity);
          }
          if (sorted.length > 0) setPeriod(sorted[sorted.length - 1]);
        }
      } else {
        setToast({ type: "error", message: res.message || "Upload failed" });
      }
    } catch (err) {
      setToast({ type: "error", message: "Upload failed" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setTimeout(() => setToast(null), 2500);
    }
  }

  function openEvidence(key: string, title: string, value: string, delta: string | null) {
    if (!canSeeEvidence) return;

    // Prefer explicit lineage block if present; fall back to sources lineage
    const lineage =
      data?.lineage?.[key] ??
      data?.sources?.[key]?.lineage ??
      data?.sources?.[key] ??
      null;

    const inputs = (lineage?.inputs || []).map((i: any) =>
      i
        ? {
            ...i,
            row_index: i.row_index ?? i.row,
            col: i.col ?? i.column,
          }
        : null
    );
    const primary = lineage && !lineage.inputs ? lineage : null;

    setEvidenceState({
      title,
      value,
      delta,
      primary,
      inputs,
    });
    setEvidenceOpen(true);
  }

  async function openGraph(metricKey: string, label: string, unit: "AED" | "%" | "number") {
    setGraphMetric({ key: metricKey, label, unit });
    setGraphOpen(true);
    const cacheKey = `${metricKey}:${entity}`;
    const cached = graphCache.current.get(cacheKey);
    if (cached) {
      setGraphData(cached);
      return;
    }
    if (!entity) return;
    const [actualRes, budgetRes] = await Promise.all([
      getMetricHistory(metricKey, entity, "Actual"),
      getMetricHistory(metricKey, entity, "Budget"),
    ]);
    const payload = {
      actual: actualRes.ok ? actualRes.data : [],
      budget: budgetRes.ok ? budgetRes.data : [],
    };
    graphCache.current.set(cacheKey, payload);
    setGraphData(payload);
  }

  async function handleExportBoardPack() {
    try {
      const res = await fetch(`${API_BASE_URL}/exports/board-pack`);
      if (!res.ok) {
        let message = "Board Pack export failed.";
        try {
          const body = await res.json();
          if (body?.detail) message = body.detail;
        } catch {
          // ignore
        }
        setExportMessage(message);
        setTimeout(() => setExportMessage(null), 2500);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "board-pack.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportMessage("Board Pack PDF downloaded.");
      setTimeout(() => setExportMessage(null), 2500);
    } catch {
      setExportMessage("Board Pack export failed.");
      setTimeout(() => setExportMessage(null), 2500);
    }
  }

  async function ensureChatSession() {
    if (chatSessionId) return chatSessionId;
    const res = await createChatSession();
    if (res.ok) {
      setChatSessionId(res.data.session_id);
      return res.data.session_id;
    }
    throw new Error(res.message || "Failed to start session");
  }

  async function handleSendChat(messageOverride?: string) {
    const text = (messageOverride ?? chatInput).trim();
    if (!text) return;
    if (!messageOverride) setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: text }]);

    const evidenceContext = [];
    if (evidenceState?.primary) evidenceContext.push(evidenceState.primary);
    if (evidenceState?.inputs?.length) {
      evidenceState.inputs.forEach((i) => {
        if (i) evidenceContext.push(i);
      });
    }

    try {
      const sessionId = await ensureChatSession();
      const res = await sendChatMessage(sessionId, text, entity, period || "", scenario, evidenceContext);
      if (res.ok) {
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "",
            citations: res.data.citations as EvidenceItem[],
            summary: res.data.summary,
            data_backed: res.data.data_backed,
          },
        ]);
        const words = res.data.answer.split(" ");
        let i = 0;
        const interval = setInterval(() => {
          i += 1;
          setChatMessages((prev) => {
            const next = [...prev];
            const idx = next.length - 1;
            if (idx >= 0 && next[idx].role === "assistant") {
              next[idx] = {
                ...next[idx],
                content: words.slice(0, i).join(" "),
              };
            }
            return next;
          });
          if (i >= words.length) {
            clearInterval(interval);
          }
        }, 20);
      } else {
        setChatMessages((prev) => [...prev, { role: "assistant", content: res.message || "No answer." }]);
      }
    } catch {
      setChatMessages((prev) => [...prev, { role: "assistant", content: "Sorry, I could not answer that right now." }]);
    }
  }

  async function generateStructuredSummary() {
    if (!period) {
      setToast({ type: "error", message: "Select a period first." });
      setTimeout(() => setToast(null), 2500);
      return;
    }
    try {
      setSummaryLoading(true);
      const sessionId = await ensureChatSession();
      const prompt =
        "Create a CFO-grade structured summary for this period with sections: Executive Summary, Key KPIs, Key Ratios, Risks/Alerts, Evidence Notes (cite sheet/row/col), and Next Questions.";
      const res = await sendChatMessage(sessionId, prompt, entity, period, scenario);
      if (res.ok) {
        setSummaryData(res.data.summary || { executive_summary: res.data.answer });
      } else {
        setSummaryData({ executive_summary: res.message || "Could not generate summary." });
      }
    } catch {
      setSummaryData({ executive_summary: "Could not generate summary right now." });
    } finally {
      setSummaryLoading(false);
    }
  }

  async function generateInterpretation() {
    if (!period) {
      setToast({ type: "error", message: "Select a period first." });
      setTimeout(() => setToast(null), 2500);
      return;
    }
    try {
      setInterpretationLoading(true);
      const sessionId = await ensureChatSession();
      const prompt =
        "Interpret the financial report from a CFO perspective with sections: Executive Summary, Profitability, Efficiency, Balance Sheet, and Risks. Keep it concise and evidence-based.";
      const res = await sendChatMessage(sessionId, prompt, entity, period, scenario);
      if (res.ok) {
        setInterpretationData(res.data.interpretation || { executive_summary: res.data.answer });
      } else {
        setInterpretationData({ executive_summary: res.message || "Could not generate interpretation." });
      }
    } catch {
      setInterpretationData({ executive_summary: "Could not generate interpretation right now." });
    } finally {
      setInterpretationLoading(false);
    }
  }

  const roleLabel =
    role === "CB" ? "Central Bank / Regulator View" : role === "Shareholder" ? "Investor View" : `${role} View`;

  const showLoading = loading;
  const hasPack = !!data?.computed;
  const showError = !data && !!period;

  const totalAssetsValue = showLoading
    ? "Loading..."
    : !hasPack || showError
    ? "—"
    : formatMillionValue(data?.kpis?.total_assets?.value);

  const depositsValue = showLoading
    ? "Loading..."
    : !hasPack || showError
    ? "—"
    : formatMillionValue(data?.kpis?.customers_deposits?.value);

  const equityValue = showLoading
    ? "Loading..."
    : !hasPack || showError
    ? "—"
    : formatMillionValue(data?.kpis?.total_equity?.value);

  const netProfitValue = showLoading
    ? "Loading..."
    : !hasPack || showError
    ? "—"
    : formatMillionValue(data?.kpis?.net_profit?.value);

  const ctiValue = showLoading
    ? "Loading..."
    : !hasPack || showError || data?.ratios?.cost_to_income?.value == null
    ? "—"
    : `${(data.ratios.cost_to_income.value * 100).toFixed(2)}%`;

  const roaValue = showLoading
    ? "Loading..."
    : !hasPack || showError || data?.ratios?.roa_annualized?.value == null
    ? "—"
    : `${(data.ratios.roa_annualized.value * 100).toFixed(2)}%`;

  const roeValue = showLoading
    ? "Loading..."
    : !hasPack || showError || data?.ratios?.roe_annualized?.value == null
    ? "—"
    : `${(data.ratios.roe_annualized.value * 100).toFixed(2)}%`;

  const totalAssetsDelta = showLoading ? "Loading..." : !hasPack ? "—" : data?.kpis?.total_assets?.delta ?? null;
  const depositsDelta = showLoading ? "Loading..." : !hasPack ? "—" : data?.kpis?.customers_deposits?.delta ?? null;
  const equityDelta = showLoading ? "Loading..." : !hasPack ? "—" : data?.kpis?.total_equity?.delta ?? null;
  const netProfitDelta = showLoading ? "Loading..." : !hasPack ? "—" : data?.kpis?.net_profit?.delta ?? null;

  const displayPeriod = data?.period_used || period || "—";
  const computed = data?.computed;

  const varianceBridge = varianceData?.bridge || [];
  let runningTotal = typeof varianceData?.start?.value === "number" ? varianceData.start.value : 0;

  const navItems = ([
    { label: "Overview", icon: BarChart3 },
    { label: "Statements", icon: FileSpreadsheet },
    { label: "Governance", icon: ShieldCheck },
    { label: "Roles & Access", icon: Users },
  ] as const).filter((item) => allowedSections.includes(item.label));

  React.useEffect(() => {
    if (!allowedSections.includes(section)) {
      setSection(allowedSections[0]);
    }
  }, [allowedSections, section]);

  const sourcesForStatements = React.useMemo(() => {
    const src = data?.sources || {};
    const rows: Array<{
      key: string;
      statement: string;
      line_item: string;
      period: string;
      value: number | null;
      sheet?: string;
      row?: number | null;
      col?: string | null;
      derived?: boolean;
    }> = [];

    Object.keys(src).forEach((k) => {
      const v = src[k];
      if (!v) return;
      if (v.inputs) return;
      rows.push({
        key: k,
        statement: safeText(v.statement || v.sheet || "—"),
        line_item: safeText(v.line_item || "—"),
        period: safeText(v.period || displayPeriod),
        value: typeof v.value === "number" ? v.value : null,
        sheet: v.lineage?.sheet,
        row: typeof v.lineage?.row_index === "number" ? v.lineage.row_index : null,
        col: v.lineage?.column || v.lineage?.col || null,
      });
    });

    const derived = [
      { key: "cost_to_income", label: "Cost-to-Income", value: data?.ratios?.cost_to_income?.value },
      { key: "roa_annualized", label: "ROA (annualized)", value: data?.ratios?.roa_annualized?.value },
      { key: "roe_annualized", label: "ROE (annualized)", value: data?.ratios?.roe_annualized?.value },
    ];
    derived.forEach((d) => {
      rows.push({
        key: d.key,
        statement: "Derived",
        line_item: d.label,
        period: safeText(displayPeriod),
        value: typeof d.value === "number" ? d.value : null,
        derived: true,
      });
    });

    // stable order
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return rows;
  }, [data, displayPeriod]);

  function formatStatementValue(row: { derived?: boolean; value: number | null }) {
    if (row.value == null) return "—";
    if (row.derived) {
      return `${(row.value * 100).toFixed(2)}%`;
    }
    return prettyNumber(row.value);
  }

  const statementsPlaceholder = (
    <div className={cn("p-5 backdrop-blur", panelClass)}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Statements</h2>
        <span className={cn("text-xs", panelSubtle)}>Normalized sources (current period)</span>
      </div>

      {!hasPack ? (
        <div className={cn("mt-4 rounded-2xl border p-4 text-sm", cardInner)}>
          Upload and normalize a pack to view statement line-items.
        </div>
      ) : sourcesForStatements.length === 0 ? (
        <div className={cn("mt-4 rounded-2xl border p-4 text-sm", cardInner)}>
          No statement sources found yet.
        </div>
      ) : (
        <div className={cn("mt-4 overflow-hidden rounded-2xl border", isLight ? "border-slate-200" : "border-white/10")}>
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className={cn("sticky top-0", isLight ? "bg-white" : "bg-[#0B0F1A]")}>
                <tr className={cn("border-b", isLight ? "border-slate-200 text-slate-600" : "border-white/10 text-white/70")}>
                  <th className="px-3 py-2">Key</th>
                  <th className="px-3 py-2">Statement</th>
                  <th className="px-3 py-2">Line item</th>
                  <th className="px-3 py-2">Period</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {sourcesForStatements.map((r) => (
                  <tr key={r.key} className={cn("border-b", isLight ? "border-slate-200 text-slate-700" : "border-white/5 text-white/80")}>
                    <td className={cn("px-3 py-2 font-mono text-[11px]", isLight ? "text-slate-500" : "text-white/70")}>{r.key}</td>
                    <td className="px-3 py-2">{r.statement}</td>
                    <td className="px-3 py-2">{r.line_item}</td>
                    <td className="px-3 py-2">{r.period}</td>
                    <td className="px-3 py-2">{formatStatementValue(r)}</td>
                    <td className="px-3 py-2">
                      {r.derived ? (
                        <button
                          className={cn("rounded-full border px-2 py-1 text-[10px]", cardInner)}
                          onClick={() => openEvidence(r.key, r.line_item, r.value == null ? "—" : prettyNumber(r.value), null)}
                        >
                          Evidence
                        </button>
                      ) : (
                        <span className={cn("rounded-full border px-2 py-1 text-[10px]", cardInner)}>
                          {r.sheet || "—"} • Row {r.row ?? "—"} • Col {r.col ?? "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  const governancePlaceholder = (
    <div className={cn("p-5 backdrop-blur", panelClass)}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Governance</h2>
        <span className={cn("text-xs", panelSubtle)}>Audit trail + controls (next)</span>
      </div>
      <div className="mt-4 space-y-3">
        <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
          <div className={cn("text-xs", panelMuted)}>Dataset</div>
          <div className={cn("mt-1", panelText)}>{hasPack ? "Pack uploaded + normalized" : "No pack uploaded yet"}</div>
        </div>
        <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
          <div className={cn("text-xs", panelMuted)}>Evidence standard</div>
          <div className={cn("mt-1", panelText)}>Each KPI should map to: Sheet • Row • Column • Line item • Period</div>
        </div>
        <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
          <div className={cn("text-xs", panelMuted)}>Exports</div>
          <div className={cn("mt-1", panelText)}>Board pack + regulator pack + XBRL later</div>
        </div>
      </div>
    </div>
  );

  const rolesPlaceholder = (
    <div className={cn("p-5 backdrop-blur", panelClass)}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Roles & Access</h2>
        <span className={cn("text-xs", panelSubtle)}>UI gating active</span>
      </div>
      <div className={cn("mt-4 space-y-2 text-sm", panelMuted)}>
        <div className={cn("rounded-2xl border p-4", cardInner)}>
          <div className={cn("text-xs", panelMuted)}>CFO</div>
          <div className="mt-1">Full access: upload, evidence, variance, exports, AI assistant.</div>
        </div>
        <div className={cn("rounded-2xl border p-4", cardInner)}>
          <div className={cn("text-xs", panelMuted)}>CEO</div>
          <div className="mt-1">Headline KPIs only (no drilldowns / variance).</div>
        </div>
        <div className={cn("rounded-2xl border p-4", cardInner)}>
          <div className={cn("text-xs", panelMuted)}>Director</div>
          <div className="mt-1">KPIs + ratios + evidence drawer (variance hidden).</div>
        </div>
        <div className={cn("rounded-2xl border p-4", cardInner)}>
          <div className={cn("text-xs", panelMuted)}>Shareholder</div>
          <div className="mt-1">Simplified headline view only.</div>
        </div>
        <div className={cn("rounded-2xl border p-4", cardInner)}>
          <div className={cn("text-xs", panelMuted)}>Central Bank</div>
          <div className="mt-1">Regulatory pack placeholder (coming soon).</div>
        </div>
      </div>
    </div>
  );

  return (
    <RoleProvider role={role} setRole={setRole}>
      <div className={cn("min-h-screen", pageBg)}>
        <div className="pointer-events-none fixed inset-0 opacity-60">
          <div
            className={cn(
              "absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full blur-3xl",
              isLight ? "bg-slate-200/70" : "bg-white/10"
            )}
          />
          <div
            className={cn(
              "absolute bottom-[-260px] right-[-180px] h-[520px] w-[520px] rounded-full blur-3xl",
              isLight ? "bg-slate-200/50" : "bg-white/5"
            )}
          />
        </div>

        <div className="relative mx-auto flex max-w-[1400px] gap-6 p-6">
          <aside className="hidden w-[280px] shrink-0 lg:block">
            <div className={cn(sidebarClass, "p-4 backdrop-blur")}>
              <div className="flex items-center gap-3 px-2 py-3">
                <div className={cn("flex h-10 w-10 items-center justify-center rounded-2xl", isLight ? "bg-slate-100" : "bg-white/10")}>
                  <Building2 className={cn("h-5 w-5", isLight ? "text-slate-700" : "text-white/90")} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold tracking-tight">Finance Hub</p>
                </div>
              </div>

              <nav className="mt-4 space-y-1">
                {navItems.map((item) => {
                  const active = section === item.label;
                  return (
                    <button
                      key={item.label}
                      onClick={() => setSection(item.label)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-sm transition",
                        active ? navActive : navInactive
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </button>
                  );
                })}
              </nav>

              <div className={cn("mt-6", rolePanel)}>
                <p className={cn("text-xs", panelMuted)}>Role</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(["CFO", "CEO", "Director", "Shareholder", "CB"] as Role[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => setRole(r)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs transition",
                        r === role ? roleChipActive : roleChipInactive
                      )}
                      aria-label={`Switch role to ${r}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <p className={cn("mt-2 text-[11px]", panelSubtle)}>{roleLabel}</p>
              </div>
            </div>
          </aside>

          <main className="flex-1">
            <div className={cn(panelClass, "p-4 backdrop-blur")}>
              {showApiWarning ? (
                <div className={cn("mb-3 rounded-2xl border px-3 py-2 text-xs", cardInner)}>
                  API base is still localhost. Set `NEXT_PUBLIC_API_BASE_URL` in production.
                </div>
              ) : null}
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="w-full">
                  <h1 className="text-2xl font-bold leading-tight tracking-tight md:text-3xl whitespace-normal break-words">Executive Summary</h1>
                  <p className={cn("mt-1 text-sm", panelMuted)}>
                    {entity || "—"} {displayPeriod ? `• ${displayPeriod}` : ""} {scenario ? `• ${scenario}` : ""}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={selectClass}
                    value={entity}
                    onChange={(e) => setEntity(e.target.value)}
                    disabled={!entity}
                  >
                    {entity ? <option value={entity}>{entity}</option> : <option value="">No entity</option>}
                  </select>

                  <select
                    className={selectClass.replace("max-w-[200px]", "max-w-[140px]")}
                    value={period || ""}
                    onChange={(e) => setPeriod(e.target.value)}
                    disabled={periodsLoading}
                    title={periodsLoading ? "Loading periods..." : "Select period"}
                  >
                    {periodsLoading ? (
                      <option value="">Loading...</option>
                    ) : periods.length ? (
                      periods.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))
                    ) : (
                      <option value="">{period || "No periods yet"}</option>
                    )}
                  </select>

                  <select
                    className={selectClass.replace("max-w-[200px]", "max-w-[140px]")}
                    value={scenario}
                    onChange={(e) => setScenario(e.target.value)}
                  >
                    <option>Actual</option>
                    <option>Budget</option>
                    <option>Forecast</option>
                    <option>Stress</option>
                  </select>

                  {canSeeControls ? (
                    <button
                      className={cn("whitespace-nowrap disabled:opacity-60", buttonPrimary)}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                    >
                      {uploading ? "Uploading..." : "Upload Pack"}
                    </button>
                  ) : (
                    <button
                      className={cn("whitespace-nowrap", buttonGhost)}
                      onClick={() => {
                        setToast({ type: "error", message: "Viewer roles cannot upload. Switch to CFO." });
                        setTimeout(() => setToast(null), 2500);
                      }}
                    >
                      View Pack
                    </button>
                  )}

                  {canSeeControls ? (
                    <button
                      className={cn("whitespace-nowrap", buttonGhost)}
                      onClick={() => {
                        void (async () => {
                          const res = await clearPack();
                          if (!res.ok) {
                            setToast({ type: "error", message: res.message || "Failed to clear pack." });
                            setTimeout(() => setToast(null), 2500);
                            return;
                          }
                          setData(null);
                          setPeriods([]);
                          setPeriod("");
                          setEntity("");
                          setUploadPreview(null);
                          setVarianceData(null);
                          setLiveStatus("loading");
                          setSummaryData(null);
                          setChatMessages([]);
                          setChatInput("");
                          setChatOpen(false);
                          setChatSessionId(null);
                          setToast({ type: "success", message: "Cleared backend pack. Re-fetching periods..." });
                          setTimeout(() => setToast(null), 2500);
                          periodInitialized.current = false;
                          const periodsRes = await getPeriods();
                          if (periodsRes.ok) {
                            const sorted = [...(periodsRes.data.periods || [])].sort((a, b) => periodKey(a) - periodKey(b));
                            setPeriods(sorted);
                            if (sorted.length > 0) setPeriod(sorted[sorted.length - 1]);
                          }
                        })();
                      }}
                    >
                      Clear Data
                    </button>
                  ) : null}

                  <button
                    className={cn("whitespace-nowrap", buttonGhost)}
                    onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                  >
                    Theme: {theme === "dark" ? "Dark" : "Light"}
                  </button>

                  {canSeeExports ? (
                    <div className="relative">
                      <button
                        className={cn("whitespace-nowrap", buttonGhost)}
                        onClick={() => setExportOpen((v) => !v)}
                      >
                        Export
                      </button>
                      {exportOpen ? (
                        <div className={cn("absolute right-0 top-[110%] z-10 w-48 rounded-2xl border p-2 shadow-xl", isLight ? "border-slate-200 bg-white" : "border-white/10 bg-[#0B0F1A]")}>
                          <button
                            className={cn("w-full rounded-xl px-3 py-2 text-left text-xs", isLight ? "text-slate-700 hover:bg-slate-100" : "text-white/80 hover:bg-white/5")}
                            onClick={() => {
                              setExportOpen(false);
                              void handleExportBoardPack();
                            }}
                          >
                            Board Pack (PDF/PPT)
                          </button>
                          <button
                            className={cn("mt-1 w-full rounded-xl px-3 py-2 text-left text-xs", isLight ? "text-slate-500 hover:bg-slate-100" : "text-white/60 hover:bg-white/5")}
                            onClick={() => {
                              setExportOpen(false);
                              setExportMessage("Regulator Pack coming soon.");
                              setTimeout(() => setExportMessage(null), 2500);
                            }}
                          >
                            Regulator Pack
                          </button>
                          <button
                            className={cn("mt-1 w-full rounded-xl px-3 py-2 text-left text-xs", isLight ? "text-slate-400 hover:bg-slate-100" : "text-white/50 hover:bg-white/5")}
                            onClick={() => {
                              setExportOpen(false);
                              setExportMessage("XBRL export coming later.");
                              setTimeout(() => setExportMessage(null), 2500);
                            }}
                          >
                            XBRL (later)
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleExcelUpload(file);
                }}
              />

              {uploadPreview ? (
                <div className={cn("mt-3 rounded-2xl border p-3 text-xs", cardInner)}>
                  Uploaded: {uploadPreview.filename} • Sheets: {uploadPreview.sheets.join(", ")} • Periods:{" "}
                  {uploadPreview.periods.join(", ")} • Facts: {uploadPreview.facts_count}
                </div>
              ) : null}

              {exportMessage ? <p className={cn("mt-2 text-xs", panelMuted)}>{exportMessage}</p> : null}
            </div>

            {/* CONTENT AREA (Tabs) */}
            <div className="mt-6">
              {section === "Overview" ? (
                <>
                  <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <KpiCard
                      title="Total Assets"
                      value={totalAssetsValue}
                      unit={unitFor(totalAssetsValue)}
                      delta={totalAssetsDelta}
                      badge="BS"
                      theme={theme}
                      onGraph={() => void openGraph("total_assets", "Total Assets", "AED")}
                      onEvidence={
                        canSeeEvidence
                          ? () => openEvidence("total_assets", "Total Assets", totalAssetsValue, totalAssetsDelta)
                          : undefined
                      }
                    />
                    {showDeposits ? (
                      <KpiCard
                        title="Customers Deposits"
                        value={depositsValue}
                        unit={unitFor(depositsValue)}
                        delta={depositsDelta}
                        badge="Funding"
                        theme={theme}
                        onGraph={() => void openGraph("customers_deposits", "Customers Deposits", "AED")}
                        onEvidence={
                          canSeeEvidence
                            ? () =>
                                openEvidence(
                                  "customers_deposits",
                                  "Customers Deposits",
                                  depositsValue,
                                  depositsDelta
                                )
                            : undefined
                        }
                      />
                    ) : null}
                    {showEquity ? (
                      <KpiCard
                        title="Total Equity"
                        value={equityValue}
                        unit={unitFor(equityValue)}
                        delta={equityDelta}
                        badge="Capital"
                        theme={theme}
                        onGraph={() => void openGraph("total_equity", "Total Equity", "AED")}
                        onEvidence={
                          canSeeEvidence
                            ? () => openEvidence("total_equity", "Total Equity", equityValue, equityDelta)
                            : undefined
                        }
                      />
                    ) : null}
                    <KpiCard
                      title="Net Profit"
                      value={netProfitValue}
                      unit={unitFor(netProfitValue)}
                      delta={netProfitDelta}
                      badge="PL"
                      theme={theme}
                      onGraph={() => void openGraph("net_profit", "Net Profit", "AED")}
                      onEvidence={
                        canSeeEvidence
                          ? () => openEvidence("net_profit", "Net Profit", netProfitValue, netProfitDelta)
                          : undefined
                      }
                    />
                  </section>

                  {role === "Shareholder" ? (
                    <div className={cn("mt-4 rounded-2xl border p-4 text-sm", cardInner)}>
                      Shareholder view focuses on headline performance. Detailed evidence and variance drivers are
                      available to internal roles.
                    </div>
                  ) : null}

                  {canSeeRatios && hasPack ? (
                    <section className="mt-4 grid gap-4 md:grid-cols-3">
                      <RatioCard
                        title="Cost-to-Income"
                        value={ctiValue}
                        subtitle="Operating expenses / total income"
                        badge="Ratio"
                        valueTitle="Uses absolute operating expenses in numerator"
                        theme={theme}
                        onGraph={() => void openGraph("cost_to_income", "Cost-to-Income", "%")}
                        onEvidence={
                          canSeeEvidence
                            ? () => openEvidence("cost_to_income", "Cost-to-Income", ctiValue, null)
                            : undefined
                        }
                      />
                      <RatioCard
                        title="ROA (annualized)"
                        value={roaValue}
                        subtitle="Net profit / avg assets"
                        badge="Ratio"
                        theme={theme}
                        onGraph={() => void openGraph("roa_annualized", "ROA (annualized)", "%")}
                        onEvidence={
                          canSeeEvidence ? () => openEvidence("roa_annualized", "ROA (annualized)", roaValue, null) : undefined
                        }
                      />
                      {!showTopKpisOnly ? (
                        <RatioCard
                          title="ROE (annualized)"
                          value={roeValue}
                          subtitle="Net profit / avg equity"
                          badge="Ratio"
                          theme={theme}
                          onGraph={() => void openGraph("roe_annualized", "ROE (annualized)", "%")}
                          onEvidence={
                            canSeeEvidence ? () => openEvidence("roe_annualized", "ROE (annualized)", roeValue, null) : undefined
                          }
                        />
                      ) : null}
                    </section>
                  ) : null}

                  {/* Structured summary (not dummy) */}
                  <div className={cn("mt-6 p-5 backdrop-blur", panelClass)}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2 className="text-sm font-semibold">Structured Summary</h2>
                        <p className={cn("mt-1 text-xs", panelSubtle)}>
                          Generates a CFO-style narrative using current KPIs/ratios and evidence citations.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className={cn("whitespace-nowrap disabled:opacity-60", buttonGhost)}
                          onClick={() => void generateInterpretation()}
                          disabled={interpretationLoading || !hasPack}
                          title={!hasPack ? "Upload a pack first" : "Interpret report"}
                        >
                          {interpretationLoading ? "Interpreting..." : "Interpret Report"}
                        </button>
                        <button
                          className={cn("whitespace-nowrap disabled:opacity-60", buttonPrimary)}
                          onClick={() => void generateStructuredSummary()}
                          disabled={summaryLoading || !hasPack}
                          title={!hasPack ? "Upload a pack first" : "Generate summary"}
                        >
                          {summaryLoading ? "Generating..." : "Generate Summary"}
                        </button>
                      </div>
                    </div>

                    {summaryData ? (
                      <div className="mt-4 space-y-3">
                        <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                          <div className={cn("text-xs", panelMuted)}>Executive Summary</div>
                          <div className="mt-2">{summaryData.executive_summary ?? "—"}</div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                          <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                            <div className={cn("text-xs", panelMuted)}>Key KPIs</div>
                            <div className="mt-2 space-y-1 text-sm">
                              <div>Total assets: {prettyNumber(summaryData.key_kpis?.total_assets)}</div>
                              <div>Total equity: {prettyNumber(summaryData.key_kpis?.total_equity)}</div>
                              <div>Net profit: {prettyNumber(summaryData.key_kpis?.net_profit)}</div>
                            </div>
                            <div className="mt-3">
                              <button
                                className={cn("rounded-full border px-2 py-1 text-[10px]", cardInner)}
                                onClick={() => openEvidence("total_assets", "Total Assets", totalAssetsValue, totalAssetsDelta)}
                              >
                                Show evidence
                              </button>
                            </div>
                          </div>

                          <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                            <div className={cn("text-xs", panelMuted)}>Profitability</div>
                            <div className="mt-2 space-y-1">
                              <div>ROA: {formatPercent(summaryData.profitability?.roa)}</div>
                              <div>ROE: {formatPercent(summaryData.profitability?.roe)}</div>
                            </div>
                            <div className="mt-3">
                              <button
                                className={cn("rounded-full border px-2 py-1 text-[10px]", cardInner)}
                                onClick={() => openEvidence("roa_annualized", "ROA (annualized)", roaValue, null)}
                              >
                                Show evidence
                              </button>
                            </div>
                          </div>

                          <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                            <div className={cn("text-xs", panelMuted)}>Efficiency</div>
                            <div className="mt-2">Cost-to-income: {formatPercent(summaryData.efficiency?.cost_to_income)}</div>
                            <div className="mt-3">
                              <button
                                className={cn("rounded-full border px-2 py-1 text-[10px]", cardInner)}
                                onClick={() => openEvidence("cost_to_income", "Cost-to-Income", ctiValue, null)}
                              >
                                Show evidence
                              </button>
                            </div>
                          </div>

                          <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                            <div className={cn("text-xs", panelMuted)}>Balance Sheet Highlights</div>
                            <div className="mt-2">
                              Total assets: {prettyNumber(summaryData.balance_sheet?.total_assets)}
                            </div>
                            <div className="mt-1">
                              Total equity: {prettyNumber(summaryData.balance_sheet?.total_equity)}
                            </div>
                          </div>
                        </div>

                        <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                          <div className={cn("text-xs", panelMuted)}>Risks / Anomalies</div>
                          <div className="mt-2 text-sm">
                            {(summaryData.risks || []).length ? (summaryData.risks || []).join(" • ") : "—"}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className={cn("mt-4 rounded-2xl border p-4 text-sm", cardInner)}>
                        {hasPack
                          ? "Click “Generate Summary” to create a structured interpretation."
                          : "Upload a pack to enable structured interpretation."}
                      </div>
                    )}

                    {interpretationData ? (
                      <div className="mt-4 space-y-3">
                        <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                          <div className={cn("text-xs", panelMuted)}>Interpretation (CFO view)</div>
                          <div className="mt-2">{interpretationData.executive_summary ?? "—"}</div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                          <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                            <div className={cn("text-xs", panelMuted)}>Profitability</div>
                            <div className="mt-2">{interpretationData.profitability ?? "—"}</div>
                          </div>
                          <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                            <div className={cn("text-xs", panelMuted)}>Efficiency</div>
                            <div className="mt-2">{interpretationData.efficiency ?? "—"}</div>
                          </div>
                          <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                            <div className={cn("text-xs", panelMuted)}>Balance Sheet</div>
                            <div className="mt-2">{interpretationData.balance_sheet ?? "—"}</div>
                          </div>
                          <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                            <div className={cn("text-xs", panelMuted)}>Risks / Focus</div>
                            <div className="mt-2">
                              {(interpretationData.risks || []).length ? (interpretationData.risks || []).join(" • ") : "—"}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <section className="mt-6 grid gap-4 lg:grid-cols-3">
                    <div ref={varianceRef} className={cn("lg:col-span-2 p-5 backdrop-blur", panelClass)}>
                      <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Variance Drivers</h2>
                        <span className={cn("text-xs", panelSubtle)}>
                          {canSeeVariance
                            ? `${varianceData?.period_from || "—"} → ${varianceData?.period_to || "—"}`
                            : "Coming next: waterfall bridges + drilldown"}
                        </span>
                      </div>

                      {canSeeVariance && hasPack ? (
                        <div className="mt-4 space-y-3">
                          {varianceData?.start ? (
                            <div className={cn("flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-left text-sm", cardInner)}>
                              <div className="min-w-0">
                                <p className={cn("truncate text-xs", panelMuted)}>Net Profit (start)</p>
                                <p className={cn("mt-1 text-xs", panelSubtle)}>
                                  {varianceData.period_from || "—"}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                <span className={cn("text-xs", panelMuted)}>
                                  {typeof varianceData.start.value === "number"
                                    ? formatMillionAED(varianceData.start.value)
                                    : "—"}
                                </span>
                              </div>
                            </div>
                          ) : null}
                          {varianceBridge.length ? (
                            varianceBridge.map((item: any) => {
                              runningTotal = typeof item.running_total === "number" ? item.running_total : runningTotal + (item.delta || 0);

                              return (
                                <div
                                  key={item.driver_key || item.label}
                                  className={cn("flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-left text-sm", cardInner)}
                                >
                                  <div className="min-w-0">
                                    <p className={cn("truncate text-xs", panelMuted)}>{item.label}</p>
                                    <p className={cn("mt-1 text-xs", panelSubtle)}>
                                      {item.missing_inputs ? "Missing inputs" : `Running total: ${formatMillionAED(runningTotal)}`}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-3">
                                    <span className={cn("text-xs", panelMuted)}>
                                      {item.delta == null ? "—" : `${item.delta >= 0 ? "+" : ""}${formatMillionAED(item.delta)}`}
                                    </span>
                                    {item.driver_key ? (
                                      <button
                                        className={cn("whitespace-nowrap rounded-full border px-2 py-1 text-[11px]", cardInner)}
                                        onClick={() => {
                                          if (varianceData?.evidence?.[item.driver_key]) {
                                            const inputs = (varianceData.evidence[item.driver_key] || []).map((i: any) =>
                                              i
                                          ? {
                                              ...i,
                                              sheet: i.lineage?.sheet || i.sheet,
                                              row_index: i.lineage?.row_index ?? i.row_index ?? i.row,
                                              col: i.lineage?.column || i.col,
                                            }
                                          : null
                                      );
                                      setEvidenceState({
                                        title: item.label,
                                        value: `${item.delta >= 0 ? "+" : ""}${formatMillionAED(item.delta)}`,
                                        delta: null,
                                        primary: null,
                                        inputs,
                                      });
                                            setEvidenceOpen(true);
                                          } else {
                                            setToast({ type: "error", message: "No variance evidence yet." });
                                            setTimeout(() => setToast(null), 2500);
                                          }
                                        }}
                                      >
                                        Evidence
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className={cn("rounded-2xl border p-4 text-sm", cardInner)}>
                              Upload and normalize a pack to compute variance bridge.
                            </div>
                          )}
                          {varianceData?.end ? (
                            <div className={cn("flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-left text-sm", cardInner)}>
                              <div className="min-w-0">
                                <p className={cn("truncate text-xs", panelMuted)}>Net Profit (end)</p>
                                <p className={cn("mt-1 text-xs", panelSubtle)}>
                                  {varianceData.period_to || "—"}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                <span className={cn("text-xs", panelMuted)}>
                                  {typeof varianceData.end.value === "number"
                                    ? formatMillionAED(varianceData.end.value)
                                    : "—"}
                                </span>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className={cn("mt-4 rounded-2xl border p-4 text-sm", cardInner)}>
                          This panel will become the CFO-grade “Why did it change?” engine: income mix → depositor
                          share → opex → impairment → tax → net profit.
                        </div>
                      )}
                    </div>

                    <div className={cn("p-5 backdrop-blur", panelClass)}>
                      <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Evidence & Governance</h2>
                        <span className={cn("text-xs", panelSubtle)}>{canSeeRegulatory ? "Regulator mode" : "Audit-ready"}</span>
                      </div>

                      {role === "CB" ? (
                        <div className={cn("mt-4 rounded-2xl border p-4 text-sm", cardInner)}>
                          Regulatory pack coming soon. We will surface supervisory evidence packs and audit trails here.
                        </div>
                      ) : (
                        <div className="mt-4 space-y-3">
                          <div className={cn("rounded-2xl border p-3", cardInner)}>
                            <p className={cn("text-xs", panelMuted)}>Dataset Status</p>
                            <p className={cn("mt-1 text-sm", panelText)}>{canSeeControls ? "Draft / In Review" : "Approved / Published"}</p>
                          </div>

                          <div className={cn("rounded-2xl border p-3", cardInner)}>
                            <p className={cn("text-xs", panelMuted)}>Lineage</p>
                            <p className={cn("mt-1 text-sm", panelText)}>Every KPI will link to: Upload → Sheet → Cell Range</p>
                          </div>

                          <div className={cn("rounded-2xl border p-3", cardInner)}>
                            <p className={cn("text-xs", panelMuted)}>Exports</p>
                            <p className={cn("mt-1 text-sm", panelText)}>Board Pack (PDF/PPT) • Regulator Pack • XBRL-ready (later)</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </section>

                  <p className={cn("mt-6 text-xs", panelSubtle)}>Live data refreshes from the latest uploaded financial pack.</p>
                </>
              ) : section === "Statements" ? (
                statementsPlaceholder
              ) : section === "Governance" ? (
                governancePlaceholder
              ) : (
                rolesPlaceholder
              )}
            </div>
          </main>
        </div>

        <EvidenceDrawer
          open={evidenceOpen}
          onClose={() => setEvidenceOpen(false)}
          title={evidenceState?.title || "Evidence"}
          value={evidenceState?.value || "—"}
          delta={evidenceState?.delta || null}
          primary={evidenceState?.primary || null}
          inputs={evidenceState?.inputs || []}
          theme={theme}
        />

        {canSeeChat ? (
          <div className="fixed bottom-6 right-6 z-40">
            {chatOpen ? (
              <div className={chatPanel}>
                <div className={cn("flex items-center justify-between border-b px-4 py-3", isLight ? "border-slate-200" : "border-white/10")}>
                  <div>
                    <p className={cn("text-xs", chatHeader)}>Finance Hub AI</p>
                    <p className={cn("text-sm", chatTitle)}>Ask about KPIs</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className={cn("rounded-full border px-2 py-1 text-[11px]", cardInner)}
                      onClick={() => setChatOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                </div>

                <div className={cn("space-y-2 border-b px-4 py-3 text-xs", isLight ? "border-slate-200" : "border-white/10")}>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { label: "Explain ROA", msg: "Explain ROA" },
                      { label: "Interpret Report", msg: "Interpret the report" },
                      { label: "Show evidence for Total Assets", msg: "Show evidence for total assets" },
                      { label: "Why did profit change?", msg: "Why did profit change?", scrollVariance: true },
                    ].map((item) => (
                      <button
                        key={item.label}
                        className={cn("rounded-full border px-3 py-1 text-[11px]", cardInner)}
                        onClick={() => {
                          if (item.scrollVariance) {
                            setRole("CFO");
                            setSection("Overview");
                            setTimeout(() => varianceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
                          }
                          void handleSendChat(item.msg);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div
                  ref={chatScrollRef}
                  className={cn("max-h-[240px] space-y-2 overflow-y-auto px-4 py-3 text-sm", isLight ? "text-slate-700" : "text-white/80")}
                >
                  {chatMessages.length === 0 ? (
                    <div className={cn("rounded-xl border p-3 text-xs", cardInner)}>
                      Try: “Explain ROA”, “Why did profit change?”, “Show evidence for total assets”.
                    </div>
                  ) : (
                    chatMessages.map((msg, idx) => (
                      <div
                        key={`${msg.role}-${idx}`}
                        className={cn(
                          "rounded-xl border p-3 text-xs",
                          msg.role === "user" ? chatBubbleUser : chatBubbleAssistant
                        )}
                      >
                        {msg.role === "assistant" && msg.data_backed === false ? (
                          <div className={cn("mb-2 inline-flex items-center rounded-full border px-2 py-1 text-[10px]", cardInner)}>
                            Not data-backed
                          </div>
                        ) : null}
                        <div>{msg.content}</div>
                        {msg.summary ? (
                          <div className={cn("mt-3 space-y-2 text-[11px]", panelMuted)}>
                            <div className={cn("rounded-lg border p-2", cardInner)}>
                              <div className={cn("text-xs", panelMuted)}>Executive summary</div>
                              <div>{msg.summary.executive_summary}</div>
                            </div>
                            <div className={cn("rounded-lg border p-2", cardInner)}>
                              <div className={cn("text-xs", panelMuted)}>Key KPIs</div>
                              <div>Total assets: {prettyNumber(msg.summary.key_kpis?.total_assets)}</div>
                              <div>Total equity: {prettyNumber(msg.summary.key_kpis?.total_equity)}</div>
                              <div>Net profit: {prettyNumber(msg.summary.key_kpis?.net_profit)}</div>
                              <button
                                className={cn("mt-2 rounded-full border px-2 py-1 text-[10px]", cardInner)}
                                onClick={() => openEvidence("total_assets", "Total Assets", totalAssetsValue, totalAssetsDelta)}
                              >
                                Show evidence
                              </button>
                            </div>
                            <div className={cn("rounded-lg border p-2", cardInner)}>
                              <div className={cn("text-xs", panelMuted)}>Efficiency</div>
                              <div>Cost-to-income: {msg.summary.efficiency?.cost_to_income}</div>
                              <button
                                className={cn("mt-2 rounded-full border px-2 py-1 text-[10px]", cardInner)}
                                onClick={() => openEvidence("cost_to_income", "Cost-to-Income", ctiValue, null)}
                              >
                                Show evidence
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {msg.citations && msg.citations.length > 0 ? (
                          <div className={cn("mt-2 space-y-1 text-[10px]", panelMuted)}>
                            {msg.citations.map((c, cidx) => (
                              <div key={`${c.line_item}-${cidx}`}>
                                {(c.sheet || c.statement || "—")} • Row {c.row_index ?? "—"} • Col{" "}
                                {(c as any)?.col ?? (c as any)?.lineage?.column ?? "—"} • {c.line_item || "—"} •{" "}
                                {c.value ?? "—"}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>

                <div className="flex items-center gap-2 px-3 py-3">
                  <input
                    className={chatInputClass}
                    placeholder="Ask about ROA, ROE, or net profit..."
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSendChat();
                    }}
                  />
                  <button className={chatSendClass} onClick={() => void handleSendChat()}>
                    Send
                  </button>
                </div>
              </div>
            ) : (
              <button
                className={cn(
                  "rounded-full px-4 py-3 text-xs font-semibold text-white shadow-lg",
                  "bg-[#1C39BB] hover:bg-[#243FBD] border border-[#1C39BB]/40"
                )}
                onClick={() => setChatOpen(true)}
              >
                AI Assistant
              </button>
            )}
          </div>
        ) : null}

        {toast ? (
          <div
            className={cn(
              "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border px-4 py-2 text-xs",
              toast.type === "success" ? toastSuccessClass : "border-red-400/30 bg-red-500/10 text-red-100"
            )}
          >
            {toast.message}
          </div>
        ) : null}

        {graphMetric ? (
          <MetricGraphDrawer
            open={graphOpen}
            onClose={() => setGraphOpen(false)}
            metricKey={graphMetric.key}
            label={graphMetric.label}
            unit={graphMetric.unit}
            data={graphData}
            theme={theme}
            onEvidence={(point) => {
              const lineage = point.lineage ?? null;
              const inputs = (lineage?.inputs || []).map((i: any) =>
                i
                  ? {
                      ...i,
                      row_index: i.row_index ?? i.row,
                      col: i.col ?? i.column,
                    }
                  : null
              );
              const primary = lineage && !lineage.inputs ? lineage : null;
              setEvidenceState({
                title: graphMetric.label,
                value:
                  graphMetric.unit === "%"
                    ? `${((point.value ?? 0) * 100).toFixed(2)}%`
                    : graphMetric.unit === "AED"
                    ? formatMillionAED(point.value ?? null)
                    : String(point.value ?? "—"),
                delta: null,
                primary,
                inputs,
              });
              setEvidenceOpen(true);
            }}
          />
        ) : null}
      </div>
    </RoleProvider>
  );
}

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <PageWithParams />
    </React.Suspense>
  );
}
