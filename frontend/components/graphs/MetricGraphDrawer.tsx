import React from "react";
import { createPortal } from "react-dom";
import MetricChart from "@/components/graphs/MetricChart";

type Point = {
  period: string;
  value: number | null;
  lineage?: any;
};

type Series = {
  name: string;
  color: string;
  data: Point[];
};

type MetricGraphDrawerProps = {
  open: boolean;
  onClose: () => void;
  metricKey: string;
  label: string;
  data: { actual: Point[]; budget: Point[] };
  unit: "AED" | "%" | "number";
  onEvidence: (point: Point) => void;
  theme?: "dark" | "light";
};

export default function MetricGraphDrawer(props: MetricGraphDrawerProps) {
  const { open, onClose, label, data, unit, onEvidence, theme = "dark" } = props;
  const [mounted, setMounted] = React.useState(false);
  const [viewStart, setViewStart] = React.useState(0);
  const [viewCount, setViewCount] = React.useState(6);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const prevOverflow = document.body.style.overflow;
    const prevPosition = document.body.style.position;
    const prevTop = document.body.style.top;
    const prevWidth = document.body.style.width;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = prevOverflow;
      document.body.style.position = prevPosition;
      document.body.style.top = prevTop;
      document.body.style.width = prevWidth;
      window.scrollTo(0, scrollY);
    };
  }, [open, onClose]);

  const totalPoints = Math.max(data.actual.length, data.budget.length);
  React.useEffect(() => {
    setViewStart(0);
    setViewCount(totalPoints || 6);
  }, [totalPoints]);

  const sliceEnd = Math.min(viewStart + viewCount, totalPoints);
  const sliced = {
    actual: data.actual.slice(viewStart, sliceEnd),
    budget: data.budget.slice(viewStart, sliceEnd),
  };

  const panelClass =
    theme === "dark"
      ? "bg-[#0B0F1A] border-white/10 text-white/90"
      : "bg-white border-slate-200 text-slate-900";

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <div className="fixed inset-0 pointer-events-auto bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={`fixed right-0 top-0 z-[91] flex h-screen w-[480px] max-w-[92vw] flex-col overflow-hidden border shadow-2xl ${panelClass}`}
      >
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-white/50">{label}</div>
            <div className="text-lg font-semibold">{label} History</div>
          </div>
          <button
            className="relative z-30 rounded-full border border-white/10 px-3 py-1 text-xs"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [-webkit-overflow-scrolling:touch]">
          {data.actual.length || data.budget.length ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    className={`rounded-full border px-2 py-1 ${theme === "dark" ? "border-white/10 text-white/80" : "border-slate-200 text-slate-700"}`}
                    onClick={() => setViewCount((c) => Math.max(2, c - 2))}
                    disabled={viewCount <= 2}
                  >
                    Zoom In
                  </button>
                  <button
                    className={`rounded-full border px-2 py-1 ${theme === "dark" ? "border-white/10 text-white/80" : "border-slate-200 text-slate-700"}`}
                    onClick={() => setViewCount((c) => Math.min(totalPoints || c, c + 2))}
                    disabled={viewCount >= totalPoints}
                  >
                    Zoom Out
                  </button>
                  <button
                    className={`rounded-full border px-2 py-1 ${theme === "dark" ? "border-white/10 text-white/80" : "border-slate-200 text-slate-700"}`}
                    onClick={() => setViewStart((s) => Math.max(0, s - 1))}
                    disabled={viewStart <= 0}
                  >
                    ◀ Pan
                  </button>
                  <button
                    className={`rounded-full border px-2 py-1 ${theme === "dark" ? "border-white/10 text-white/80" : "border-slate-200 text-slate-700"}`}
                    onClick={() => setViewStart((s) => Math.min(Math.max(0, totalPoints - viewCount), s + 1))}
                    disabled={viewStart + viewCount >= totalPoints}
                  >
                    Pan ▶
                  </button>
                </div>
                <button
                  className={`rounded-full border px-3 py-1 text-[11px] ${
                    theme === "dark" ? "border-white/10 text-white/80" : "border-slate-200 text-slate-700"
                  }`}
                  onClick={() => {
                    const svg = document.getElementById("metric-chart-svg") as SVGSVGElement | null;
                    if (!svg) return;
                    const serializer = new XMLSerializer();
                    const svgText = serializer.serializeToString(svg);
                    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const img = new Image();
                    img.onload = () => {
                      const canvas = document.createElement("canvas");
                      canvas.width = svg.clientWidth * 2;
                      canvas.height = svg.clientHeight * 2;
                      const ctx = canvas.getContext("2d");
                      if (!ctx) return;
                      ctx.scale(2, 2);
                      ctx.drawImage(img, 0, 0);
                      const pngUrl = canvas.toDataURL("image/png");
                      const link = document.createElement("a");
                      link.href = pngUrl;
                      link.download = `${label.replace(/\s+/g, "-").toLowerCase()}.png`;
                      document.body.appendChild(link);
                      link.click();
                      link.remove();
                      URL.revokeObjectURL(url);
                    };
                    img.src = url;
                  }}
                >
                  Export PNG
                </button>
              </div>
              <MetricChart
                series={[
                  { name: "Actual", color: "#60A5FA", data: sliced.actual },
                  { name: "Budget", color: "#F59E0B", data: sliced.budget },
                ]}
                unit={unit}
                theme={theme}
                onPointClick={onEvidence}
              />
              <div className="mt-4 space-y-2">
                {[...data.actual].map((point) => (
                  <div
                    key={point.period}
                    className={`flex items-center justify-between rounded-xl border px-3 py-2 text-xs ${
                      theme === "dark" ? "border-white/10 bg-white/[0.03]" : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{point.period}</div>
                      <div className="text-[11px] opacity-70">
                        {unit === "%"
                          ? `${((point.value ?? 0) * 100).toFixed(2)}%`
                          : unit === "AED"
                          ? `${((point.value ?? 0) / 1_000_000).toFixed(2)} M AED`
                          : point.value ?? "—"}
                      </div>
                    </div>
                    <button
                      className={`rounded-full border px-2 py-1 text-[11px] ${
                        theme === "dark" ? "border-white/10 text-white/80" : "border-slate-200 text-slate-700"
                      }`}
                      onClick={() => onEvidence(point)}
                    >
                      Evidence
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-white/10 p-4 text-sm">
              No data available.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
