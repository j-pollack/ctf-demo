// Dependency-free server-rendered charts. Hover uses native SVG <title>; every chart also
// ships a table view, so no value is hover-only.
// ponytail: no crosshair/JS tooltips; add a client component if native titles feel slow.

export const usd = (dollars: number, compact = false) =>
  compact && Math.abs(dollars) >= 1000
    ? `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(dollars)}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const count = (value: number, compact = false) =>
  new Intl.NumberFormat(
    "en-US",
    compact ? { notation: "compact", maximumFractionDigits: 1 } : {},
  ).format(value);
export const pct = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : "—";
export const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
export const month = (iso: string) =>
  new Date(`${iso}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });

// Clean axis ticks: 0..max in 1/2/2.5/5 × 10^n steps.
export function niceTicks(max: number, target = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / target,
    power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  return Array.from(
    { length: Math.ceil(max / step - 1e-9) + 1 },
    (_, i) => +(i * step).toPrecision(12),
  );
}

const W = 640,
  H = 220,
  L = 48,
  R = 12,
  T = 14,
  B = 26;
const plotW = W - L - R,
  plotH = H - T - B;

// Rect with a 4px rounded data-end, square at the baseline.
function bar(x: number, y: number, w: number, h: number, round: boolean) {
  const r = round ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function Axes({
  ticks,
  format,
  labels,
}: {
  ticks: number[];
  format: (v: number) => string;
  labels: string[];
}) {
  const max = ticks.at(-1)!,
    band = plotW / labels.length,
    every = Math.ceil(labels.length / 6);
  return (
    <>
      {ticks.map((tick) => {
        const y = T + plotH - (tick / max) * plotH;
        return (
          <g key={tick}>
            <line x1={L} x2={W - R} y1={y} y2={y} className={tick ? "grid" : "baseline"} />
            <text x={L - 8} y={y} dy="0.32em" textAnchor="end">
              {format(tick)}
            </text>
          </g>
        );
      })}
      {labels.map((label, i) =>
        i % every === 0 || i === labels.length - 1 ? (
          <text key={i} x={L + band * (i + 0.5)} y={H - 6} textAnchor="middle">
            {label}
          </text>
        ) : null,
      )}
    </>
  );
}

export type Series = { name: string; color: string };

// Stacked columns; segment 0 sits on the baseline. 2px surface gap between segments.
export function Columns({
  labels,
  values,
  series,
  format,
  title,
}: {
  labels: string[];
  values: number[][];
  series: Series[];
  format: (v: number) => string;
  title: (i: number) => string;
}) {
  const ticks = niceTicks(Math.max(0, ...values.map((v) => v.reduce((a, b) => a + b, 0))));
  const max = ticks.at(-1)!,
    band = plotW / labels.length,
    width = Math.min(24, band - 2);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label={series.map((s) => s.name).join(", ")}
    >
      <Axes ticks={ticks} format={format} labels={labels} />
      {values.map((stack, i) => {
        const x = L + band * i + (band - width) / 2;
        let base = T + plotH;
        const top = stack.findLastIndex((v) => v > 0);
        return (
          <g key={i}>
            <title>{title(i)}</title>
            <rect x={L + band * i} y={T} width={band} height={plotH} className="hit" />
            {stack.map((value, s) => {
              const h = (value / max) * plotH;
              if (h <= 0) return null;
              const gap = s > 0 && base < T + plotH ? 2 : 0;
              base -= h;
              return (
                <path
                  key={s}
                  d={bar(x, base, width, Math.max(0, h - gap), s === top)}
                  fill={series[s].color}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

// Single-series line with a 10% area wash and a labelled end point.
export function Area({
  labels,
  values,
  color,
  format,
  title,
}: {
  labels: string[];
  values: number[];
  color: string;
  format: (v: number) => string;
  title: (i: number) => string;
}) {
  const ticks = niceTicks(Math.max(0, ...values));
  const max = ticks.at(-1)!,
    band = plotW / labels.length;
  const point = (v: number, i: number) =>
    [L + band * (i + 0.5), T + plotH - (v / max) * plotH] as const;
  const points = values.map(point),
    line = points.map(([x, y]) => `${x},${y}`).join(" L");
  const [ex, ey] = points.at(-1) ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Spend">
      <Axes ticks={ticks} format={format} labels={labels} />
      {points.length > 0 && (
        <>
          <path
            d={`M${points[0][0]},${T + plotH} L${line} L${ex},${T + plotH}Z`}
            fill={color}
            opacity={0.1}
          />
          <path
            d={`M${line}`}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle cx={ex} cy={ey} r={4} fill={color} className="ring" />
        </>
      )}
      {values.map((_, i) => (
        <rect key={i} x={L + band * i} y={T} width={band} height={plotH} className="hit">
          <title>{title(i)}</title>
        </rect>
      ))}
    </svg>
  );
}

export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1e-9, ...values),
    w = 240,
    h = 32;
  const pts = values.map((v, i) => [
    (i / Math.max(1, values.length - 1)) * (w - 6) + 3,
    h - 3 - (v / max) * (h - 6),
  ]);
  const [lx, ly] = pts.at(-1) ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" aria-hidden="true">
      <polyline points={pts.join(" ")} fill="none" className="spark-line" />
      <circle cx={lx} cy={ly} r={3} fill={color} />
    </svg>
  );
}

// Horizontal bars, one series: label · bar · value at the tip.
export function Bars({
  rows,
  color,
}: {
  rows: { label: string; sub?: string; value: number; display: string }[];
  color: string;
}) {
  if (!rows.length) return <p className="empty">No data yet.</p>;
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <ul className="bars">
      {rows.map((row, i) => (
        <li key={i} title={`${row.label}${row.sub ? ` · ${row.sub}` : ""}: ${row.display}`}>
          <span className="bars-label">
            {row.label}
            {row.sub && <small>{row.sub}</small>}
          </span>
          <span className="bars-track">
            <span style={{ width: `${(row.value / max) * 100}%`, background: color }} />
          </span>
          <span className="bars-value">{row.display}</span>
        </li>
      ))}
    </ul>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="legend">
      {series.map((s) => (
        <li key={s.name}>
          <i style={{ background: s.color }} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <details className="data">
      <summary>Table</summary>
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
