import React from "react";
import Pill from "@/components/ui/Pill";

type KpiCardProps = {
  title: string;
  value: string;
  unit?: string;
  delta?: string;
  badge?: string;
  onEvidence?: () => void;
  onGraph?: () => void;
  theme?: "dark" | "light";
};

export default function KpiCard(props: KpiCardProps) {
  const { title, value, unit, delta, badge, onEvidence, onGraph, theme = "dark" } = props;
  const cardClass =
    theme === "dark"
      ? "rounded-2xl border border-white/10 bg-white/[0.03] shadow-[0_0_0_1px_rgba(255,255,255,0.03)] p-5 overflow-hidden"
      : "rounded-2xl border border-slate-200 bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.04)] p-5 overflow-hidden";
  const titleClass = theme === "dark" ? "text-sm text-white/70 truncate" : "text-sm text-slate-500 truncate";
  const valueClass = theme === "dark" ? "text-2xl font-bold tracking-tight text-white" : "text-2xl font-bold tracking-tight text-slate-900";
  const unitClass = theme === "dark" ? "text-sm text-white/70" : "text-sm text-slate-500";

  return (
    <div
      className={`${cardClass} ${
        onEvidence
          ? theme === "dark"
            ? "cursor-pointer transition hover:border-white/20 hover:bg-white/[0.06]"
            : "cursor-pointer transition hover:border-slate-300 hover:bg-slate-50"
          : ""
      }`}
      onClick={onEvidence}
      role={onEvidence ? "button" : undefined}
      tabIndex={onEvidence ? 0 : undefined}
      onKeyDown={
        onEvidence
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onEvidence?.();
            }
          : undefined
      }
      aria-label={onEvidence ? `Open evidence for ${title}` : undefined}
    >
      <div className="grid gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={titleClass}>{title}</div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 max-w-[55%]">
            {badge ? <Pill theme={theme}>{badge}</Pill> : null}
            {onGraph ? (
              <Pill
                asButton
                theme={theme}
                onClick={(e) => {
                  e.stopPropagation();
                  onGraph?.();
                }}
                aria-label={`Open graph for ${title}`}
              >
                📈
              </Pill>
            ) : null}
            {onEvidence ? (
              <Pill
                asButton
                theme={theme}
                onClick={(e) => {
                  e.stopPropagation();
                  onEvidence?.();
                }}
                aria-label={`Open evidence for ${title}`}
              >
                Evidence
              </Pill>
            ) : null}
          </div>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className={valueClass}>{value}</div>
            {unit ? <div className={unitClass}>{unit}</div> : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2 max-w-[55%]">
            {delta ? <Pill theme={theme}>{delta}</Pill> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
