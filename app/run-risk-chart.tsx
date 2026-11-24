import React from "react";

// One session's classifier risk scores (0-1), by the review's number within the session.
export type SessionRiskSeries = {
  id: string;
  ordinal: number;
  points: { review: number; risk: number }[];
};

const colors = ["#426f30", "#a84a23", "#2d6ca5", "#8551a0", "#9b6e00", "#267b74"];
const dashes = [undefined, "7 3", "2 3", "10 3 2 3"];
const width = 300;
const height = 120;
const left = 38;
const right = 12;
const top = 8;
const bottom = 26;

function Marker({
  x,
  y,
  color,
  ordinal,
  title,
}: {
  x: number;
  y: number;
  color: string;
  ordinal: number;
  title?: string;
}) {
  const shape = (ordinal - 1) % 3;
  const marker =
    shape === 0 ? (
      <circle cx={x} cy={y} r="3.5" />
    ) : shape === 1 ? (
      <rect x={x - 3.5} y={y - 3.5} width="7" height="7" />
    ) : (
      <polygon points={`${x},${y - 4.5} ${x + 4.5},${y} ${x},${y + 4.5} ${x - 4.5},${y}`} />
    );
  return (
    <g className="risk-point" fill={color}>
      {title && <title>{title}</title>}
      {marker}
    </g>
  );
}

export function RunRiskChart({ series }: { series: SessionRiskSeries[] }) {
  const last = Math.max(
    1,
    ...series.flatMap((session) => session.points.map((point) => point.review)),
  );
  const x = (review: number) =>
    left + ((review - 1) / Math.max(1, last - 1)) * (width - left - right);
  const y = (risk: number) => top + (1 - risk) * (height - top - bottom);
  return (
    <div className="run-risk-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Classifier risk score by review; each line is one session"
      >
        {[0, 0.5, 1].map((risk) => (
          <g key={risk}>
            <line className="risk-grid" x1={left} x2={width - right} y1={y(risk)} y2={y(risk)} />
            <text className="risk-axis" x={left - 5} y={y(risk) + 3} textAnchor="end">
              {Math.round(risk * 100)}%
            </text>
          </g>
        ))}
        {[...new Set([1, last])].map((review) => (
          <text
            key={review}
            className="risk-axis"
            x={x(review)}
            y={height - 6}
            textAnchor={review === 1 ? "start" : "end"}
          >
            {review}
          </text>
        ))}
        {series.map((session) => {
          const color = colors[(session.ordinal - 1) % colors.length];
          const dash = dashes[(session.ordinal - 1) % dashes.length];
          const points = session.points
            .map((point) => `${x(point.review)},${y(point.risk)}`)
            .join(" ");
          return (
            <g key={session.id} aria-label={`Session ${session.ordinal}`}>
              {session.points.length > 1 && (
                <polyline
                  className="risk-trace"
                  points={points}
                  fill="none"
                  stroke={color}
                  strokeDasharray={dash}
                />
              )}
              {session.points.map((point) => (
                <Marker
                  key={point.review}
                  x={x(point.review)}
                  y={y(point.risk)}
                  color={color}
                  ordinal={session.ordinal}
                  title={`Session ${session.ordinal}, review ${point.review}: ${Math.round(point.risk * 100)}%`}
                />
              ))}
            </g>
          );
        })}
      </svg>
      <p className="risk-axis-title">Review per session</p>
      <div className="risk-legend" aria-label="Session risk scores">
        {series.map((session) => {
          const color = colors[(session.ordinal - 1) % colors.length];
          return (
            <span key={session.id}>
              <svg viewBox="0 0 28 12" aria-hidden="true">
                <line
                  x1="1"
                  x2="27"
                  y1="6"
                  y2="6"
                  stroke={color}
                  strokeWidth="2"
                  strokeDasharray={dashes[(session.ordinal - 1) % dashes.length]}
                />
                <Marker x={14} y={6} color={color} ordinal={session.ordinal} />
              </svg>
              Session {session.ordinal} ·{" "}
              {session.points.length === 0
                ? "No scores"
                : `peak ${Math.round(Math.max(...session.points.map((point) => point.risk)) * 100)}%`}
            </span>
          );
        })}
      </div>
    </div>
  );
}
