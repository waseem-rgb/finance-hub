import React from "react";

type Point = {
  period: string;
  value: number | null;
};

type Series = {
  name: string;
  color: string;
  data: Point[];
};

type MetricChartProps = {
  series: Series[];
  unit: "AED" | "%" | "number";
  onPointClick?: (point: Point) => void;
  theme?: "dark" | "light";
};

function catmullRomPath(pts: Array<{ x: number; y: number }>) {
  if (pts.length < 2) return "";
  const path = [`M ${pts[0].x} ${pts[0].y}`];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`);
  }
  return path.join(" ");
}

export default function MetricChart(props: MetricChartProps) {
  const { series, unit, onPointClick, theme = "dark" } = props;
  const width = 560;
  const height = 220;
  const padding = 32;

  const periods = series[0]?.data.map((d) => d.period) || [];
  const values = series
    .flatMap((s) => s.data.map((d) => (typeof d.value === "number" ? d.value : null)))
    .filter((v): v is number => v != null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const range = max - min || 1;
  const xStep = periods.length > 1 ? (width - padding * 2) / (periods.length - 1) : 0;

  const axisColor = theme === "dark" ? "#3B4452" : "#CBD5E1";
  const textColor = theme === "dark" ? "#CBD5E1" : "#475569";
  const gridColor = theme === "dark" ? "#253041" : "#E2E8F0";

  function formatValue(val: number | null) {
    if (val == null) return "—";
    if (unit === "%") return `${(val * 100).toFixed(2)}%`;
    if (unit === "AED") return `${(val / 1_000_000).toFixed(2)} M AED`;
    return val.toFixed(2);
  }

  const [hover, setHover] = React.useState<{ x: number; y: number; point: Point } | null>(null);

  return (
    <div className="relative w-full overflow-x-auto">
      <svg width={width} height={height} className="block" id="metric-chart-svg">
        {[0, 1, 2, 3, 4].map((i) => {
          const y = padding + ((height - padding * 2) / 4) * i;
          return (
            <line key={`grid-${i}`} x1={padding} y1={y} x2={width - padding} y2={y} stroke={gridColor} strokeWidth={1} />
          );
        })}
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke={axisColor} strokeWidth={1} />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke={axisColor} strokeWidth={1} />

        <defs>
          {series.map((s, idx) => (
            <linearGradient key={s.name} id={`area-${idx}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {series.map((s, idx) => {
          const pts = s.data.map((d, i) => {
            const x = padding + i * xStep;
            const y = padding + (height - padding * 2) * (1 - ((d.value ?? min) - min) / range);
            return { x, y, point: d };
          });
          const linePath = pts.length > 1 ? catmullRomPath(pts) : "";
          const areaPath =
            pts.length > 1
              ? `${linePath} L ${pts[pts.length - 1].x} ${height - padding} L ${pts[0].x} ${height - padding} Z`
              : "";
          return (
            <g key={s.name}>
              {areaPath ? <path d={areaPath} fill={`url(#area-${idx})`} /> : null}
              {linePath ? <path d={linePath} fill="none" stroke={s.color} strokeWidth={2} /> : null}
              {pts.map((p) => (
                <circle
                  key={`${s.name}-${p.point.period}`}
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill={s.color}
                  className="cursor-pointer"
                  onMouseEnter={() => setHover({ x: p.x, y: p.y, point: p.point })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onPointClick?.(p.point)}
                />
              ))}
            </g>
          );
        })}

        {periods.map((p, i) => (
          <text key={p} x={padding + i * xStep} y={height - 10} fontSize={10} textAnchor="middle" fill={textColor}>
            {p}
          </text>
        ))}
      </svg>

      {hover ? (
        <div
          className={`absolute rounded-xl border px-3 py-2 text-xs shadow-lg ${
            theme === "dark" ? "border-white/10 bg-[#0B0F1A] text-white/90" : "border-slate-200 bg-white text-slate-800"
          }`}
          style={{ left: hover.x + 8, top: hover.y + 8 }}
        >
          <div className="font-semibold">{hover.point.period}</div>
          <div className="opacity-80">{formatValue(hover.point.value)}</div>
          <div className="mt-2 text-[11px] underline cursor-pointer" onClick={() => onPointClick?.(hover.point)}>
            Show evidence
          </div>
        </div>
      ) : null}
    </div>
  );
}
