"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface FunnelStage {
  label: string;
  value: number;
}

const COLORS = ["#7c3aed", "#3b6dff", "#17c3d6", "#12b886", "#f5a524", "#ff6b6b"];

// The one chart in the Owner Dashboard — recharts is a new dependency
// introduced specifically for this (the app has no charting library
// anywhere else). Data fetching stays server-side per this app's
// convention; this component only renders already-fetched numbers.
// Rendered dir="ltr": recharts has no RTL layout mode, so the chart
// itself reads left-to-right while its Hebrew category labels render
// as-is (arbitrary text, unaffected by the container's own direction).
export function OwnerFunnelChart({ stages }: { stages: FunnelStage[] }) {
  return (
    <div dir="ltr" style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <BarChart data={stages} layout="vertical" margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e9e5f6" />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: "#6d688a" }} />
          <YAxis
            type="category"
            dataKey="label"
            width={150}
            tick={{ fontSize: 12, fill: "#524d6b" }}
          />
          <Tooltip
            labelStyle={{ direction: "rtl", fontWeight: 600 }}
            contentStyle={{ borderRadius: 12, border: "1px solid #e9e5f6" }}
          />
          <Bar dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={28}>
            {stages.map((stage, i) => (
              <Cell key={stage.label} fill={COLORS[i % COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
