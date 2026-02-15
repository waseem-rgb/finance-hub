import React from "react";
import { createPortal } from "react-dom";

export type EvidenceItem = {
  statement?: string;
  line_item?: string;
  value?: number;
  period?: string;
  sheet?: string;
  row_index?: number;
  col?: string | number;
  cell?: string;
};

type EvidenceDrawerProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  value: string | null;
  delta: string | null;
  primary: EvidenceItem | null;
  inputs: Array<EvidenceItem | null>;
  theme?: "dark" | "light";
};

function EvidenceBlock({ source, theme }: { source: EvidenceItem | null; theme: "dark" | "light" }) {
  if (!source) {
    return (
      <div
        className={`rounded-2xl border p-4 text-sm ${
          theme === "dark" ? "border-white/10 bg-white/[0.03] text-white/60" : "border-slate-200 bg-slate-50 text-slate-500"
        }`}
      >
        Missing source
      </div>
    );
  }
  return (
    <div
      className={`rounded-2xl border p-4 ${
        theme === "dark" ? "border-white/10 bg-white/[0.03] text-white/85" : "border-slate-200 bg-white text-slate-800"
      }`}
    >
      <p className={`text-xs ${theme === "dark" ? "text-white/60" : "text-slate-500"}`}>Statement</p>
      <p className="mt-1 text-sm">{source.statement ?? "—"}</p>

      <p className={`mt-3 text-xs ${theme === "dark" ? "text-white/60" : "text-slate-500"}`}>Period</p>
      <p className="mt-1 text-sm">{source.period ?? "—"}</p>

      <p className={`mt-3 text-xs ${theme === "dark" ? "text-white/60" : "text-slate-500"}`}>Line Item</p>
      <p className="mt-1 text-sm">{source.line_item ?? "—"}</p>

      <p className={`mt-3 text-xs ${theme === "dark" ? "text-white/60" : "text-slate-500"}`}>Value</p>
      <p className="mt-1 text-sm">
        {typeof source.value === "number" ? `${source.value} AED` : "—"}
      </p>

      <div
        className={`mt-3 rounded-xl border p-3 text-xs ${
          theme === "dark" ? "border-white/10 bg-white/5 text-white/70" : "border-slate-200 bg-slate-50 text-slate-600"
        }`}
      >
        <p className={`text-xs ${theme === "dark" ? "text-white/60" : "text-slate-500"}`}>Lineage</p>
        <div className={`mt-2 grid grid-cols-3 gap-2 text-[11px] ${theme === "dark" ? "text-white/70" : "text-slate-600"}`}>
          <div>
            <p className={theme === "dark" ? "text-white/50" : "text-slate-500"}>Sheet</p>
            <p>{source.sheet ?? "—"}</p>
          </div>
          <div>
            <p className={theme === "dark" ? "text-white/50" : "text-slate-500"}>Row</p>
            <p>{source.row_index ?? "—"}</p>
          </div>
          <div>
            <p className={theme === "dark" ? "text-white/50" : "text-slate-500"}>Column</p>
            <p>{source.col ?? "—"}</p>
          </div>
        </div>
        <div className={`mt-2 grid grid-cols-3 gap-2 text-[11px] ${theme === "dark" ? "text-white/70" : "text-slate-600"}`}>
          <div>
            <p className={theme === "dark" ? "text-white/50" : "text-slate-500"}>Cell</p>
            <p>{source.cell ?? "—"}</p>
          </div>
          <div className="col-span-2">
            <p className={theme === "dark" ? "text-white/50" : "text-slate-500"}>Line Item</p>
            <p className="truncate">{source.line_item ?? "—"}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function EvidenceDrawer(props: EvidenceDrawerProps) {
  const { open, onClose, title, value, delta, primary, inputs, theme = "dark" } = props;
  const [mounted, setMounted] = React.useState(false);
  const panelClass =
    theme === "dark"
      ? "fixed inset-y-0 right-0 w-full sm:w-[460px] sm:max-w-[95vw] border-l border-white/10 bg-[#0B0F1A] shadow-2xl transition-transform"
      : "fixed inset-y-0 right-0 w-full sm:w-[460px] sm:max-w-[95vw] border-l border-slate-200 bg-white shadow-2xl transition-transform";
  const headerText = theme === "dark" ? "text-white" : "text-slate-900";
  const subText = theme === "dark" ? "text-white/60" : "text-slate-500";
  const cardBg = theme === "dark" ? "bg-white/[0.03] border-white/10 text-white/85" : "bg-slate-50 border-slate-200 text-slate-800";
  const secondaryBg = theme === "dark" ? "bg-white/5 border-white/10" : "bg-white border-slate-200";

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!mounted) return;
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open, mounted]);

  React.useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[80] transition ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        className={`fixed inset-0 ${theme === "dark" ? "bg-black/40" : "bg-black/20"} backdrop-blur-[2px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        className={`${panelClass} ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-white/10 p-6">
            <div>
              <p className={`text-xs ${subText}`}>Evidence</p>
              <h3 className={`mt-1 text-lg font-semibold ${headerText}`}>{title}</h3>
            </div>
            <button
              className={`rounded-full border px-3 py-1 text-xs ${
                theme === "dark"
                  ? "border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
                  : "border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
              onClick={onClose}
            >
              Close
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            <div className="space-y-3">
              <div className={`rounded-2xl border p-4 ${cardBg}`}>
                <p className={`text-xs ${subText}`}>KPI Value</p>
                <div className="mt-2 flex items-baseline gap-3">
                  <p className={`text-2xl font-semibold tracking-tight ${headerText}`}>{value ?? "—"}</p>
                  {delta ? (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        theme === "dark" ? "border-white/10 bg-white/5 text-white/70" : "border-slate-200 bg-white text-slate-600"
                      }`}
                    >
                      {delta}
                    </span>
                  ) : null}
                </div>
              </div>

              {primary ? <EvidenceBlock source={primary} theme={theme} /> : null}

              {inputs && inputs.length > 0 ? (
                <div className="space-y-2">
                  <p className={`text-xs ${subText}`}>Inputs</p>
                  {inputs.map((src, idx) => (
                    <EvidenceBlock key={`input-${idx}`} source={src} theme={theme} />
                  ))}
                </div>
              ) : null}

              {!primary && (!inputs || inputs.length === 0) ? (
                <div className={`rounded-2xl border p-4 text-sm ${cardBg}`}>
                  Lineage not available yet.
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
