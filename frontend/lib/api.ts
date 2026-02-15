const RAW_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ||
  (process.env.NODE_ENV === "production" ? "https://api.momentumfirmfinance.com" : "http://127.0.0.1:8000");
export const API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, "");
const VALID_ROLES = new Set(["CFO", "CEO", "Director", "Shareholder", "CB"]);
let activeRole = "CFO";
const API_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || 20000);

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  // Dev-only startup diagnostic for confirming resolved API target.
  console.info("[finance-hub] API_BASE_URL:", API_BASE_URL);
}

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error: string; message: string };

export function setApiRole(role: string) {
  if (VALID_ROLES.has(role)) {
    activeRole = role;
  }
}

function withRoleHeader(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers || undefined);
  headers.set("X-User-Role", activeRole);
  return { ...(init || {}), headers };
}

async function handleResponse<T>(res: Response): Promise<ApiOk<T> | ApiErr> {
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // ignore
    }
    return { ok: false, error: "HTTP_ERROR", message };
  }
  const data = (await res.json()) as T;
  return { ok: true, data };
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiOk<T> | ApiErr> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    const res = await fetch(`${API_BASE_URL}${path}`, withRoleHeader({ ...(init || {}), signal: controller.signal }));
    clearTimeout(timeout);
    return await handleResponse<T>(res);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: "TIMEOUT_ERROR", message: "Request timed out" };
    }
    return { ok: false, error: "NETWORK_ERROR", message: err instanceof Error ? err.message : "Network error" };
  }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE_URL}${path}`, withRoleHeader({ ...(init || {}), signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
  }
}

export function getPeriods() {
  return request<{
    entity: string | null;
    periods: string[];
    latest_upload_id: string | null;
    has_pack: boolean;
  }>("/periods");
}

export function getRatios(entity: string, period: string, scenario: string) {
  const qs = new URLSearchParams({ entity, period, scenario });
  return request<any>(`/ratios?${qs.toString()}`, { cache: "no-store" });
}

export function uploadAndNormalizeExcel(file: File) {
  const form = new FormData();
  form.append("file", file);
  return request<{ upload_id: string; filename: string; entity?: string | null; sheets: string[]; periods: string[]; facts_count: number }>(
    "/uploads/excel/normalize",
    { method: "POST", body: form }
  );
}

export function getVariance(period_from: string, period_to: string, scenario: string) {
  const qs = new URLSearchParams({ period_from, period_to, scenario });
  return request<any>(`/variance?${qs.toString()}`, { cache: "no-store" });
}

export function createChatSession() {
  return request<{ session_id: string }>("/chat/session", { method: "POST" });
}

export function sendChatMessage(
  session_id: string,
  message: string,
  entity?: string,
  period?: string,
  scenario?: string,
  evidence_context?: any[],
  retryCount: number = 0
) {
  const doRequest = () =>
    request<{
      session_id: string;
      answer: string;
      summary?: any;
      interpretation?: any;
      citations: any[];
      used_period: string | null;
      used_metrics: string[];
      data_backed?: boolean;
      meta?: { provider?: string; reason?: string; detail?: string };
    }>(
      "/chat/message",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id, message, entity, period, scenario, evidence_context }),
      }
    );

  if (retryCount <= 0) {
    return doRequest();
  }

  return (async () => {
    let last: ApiOk<any> | ApiErr = await doRequest();
    let attempts = retryCount;
    while (!last.ok && attempts > 0 && (last.error === "NETWORK_ERROR" || /temporar|timeout|unavailable/i.test(last.message))) {
      await new Promise((resolve) => setTimeout(resolve, (retryCount - attempts + 1) * 500));
      last = await doRequest();
      attempts -= 1;
    }
    return last as ApiOk<{
      session_id: string;
      answer: string;
      summary?: any;
      interpretation?: any;
      citations: any[];
      used_period: string | null;
      used_metrics: string[];
      data_backed?: boolean;
      meta?: { provider?: string; reason?: string; detail?: string };
    }> | ApiErr;
  })();
}

export function getBoardPack() {
  return request<{ status: string; pack_id: string | null; sections: string[]; generated_at: string; detail?: string }>(
    "/exports/board-pack"
  );
}

export function clearPack() {
  return request<{ status: string }>("/pack/clear", { method: "POST" });
}

export function createBoardPackJob() {
  return request<{ job_id: string; status: string }>("/exports/board-pack/jobs", { method: "POST" });
}

export function getBoardPackJob(job_id: string) {
  return request<{ job_id: string; status: string; progress: number; error?: string | null; download_ready: boolean; filename?: string | null }>(
    `/exports/board-pack/jobs/${job_id}`
  );
}

export async function downloadBoardPackJob(job_id: string): Promise<ApiOk<Blob> | ApiErr> {
  try {
    const res = await apiFetch(`/exports/board-pack/jobs/${job_id}/download`);
    if (!res.ok) {
      let message = `Request failed: ${res.status}`;
      try {
        const body = await res.json();
        if (body?.detail) message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch {}
      return { ok: false, error: "HTTP_ERROR", message };
    }
    const blob = await res.blob();
    return { ok: true, data: blob };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: "TIMEOUT_ERROR", message: "Request timed out" };
    }
    return { ok: false, error: "NETWORK_ERROR", message: err instanceof Error ? err.message : "Network error" };
  }
}

export async function getMetricHistory(
  metricKey: string,
  entity: string,
  scenario: string
): Promise<ApiOk<Array<{ period: string; value: number | null; lineage?: any }>> | ApiErr> {
  const periodsRes = await getPeriods();
  if (!periodsRes.ok) return periodsRes;
  const periods = periodsRes.data.periods || [];
  const results = await Promise.all(
    periods.map(async (period) => {
      const res = await getRatios(entity, period, scenario);
      if (!res.ok) return { period, value: null, lineage: null };
      const ratios = res.data?.ratios || {};
      const kpis = res.data?.kpis || {};
      let value: number | null = null;
      if (metricKey in kpis) {
        value = kpis[metricKey]?.value ?? null;
      } else if (metricKey in ratios) {
        value = ratios[metricKey]?.value ?? null;
      }
      const lineage = res.data?.lineage?.[metricKey] ?? res.data?.sources?.[metricKey] ?? null;
      return { period, value, lineage };
    })
  );
  return { ok: true, data: results };
}
