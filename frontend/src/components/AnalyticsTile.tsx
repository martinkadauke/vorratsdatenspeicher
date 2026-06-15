import { useState } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Code2 } from 'lucide-react';
import { Card } from './ui';
import { eur } from '../lib/utils';

export interface AnalyticsColumns {
  time: string | null;
  dims: { key: string; label: string }[];
  value: { key: string; label: string; unit: 'eur' | 'count' };
}
export interface AnalyticsRow { bucket?: string; dims: (string | null)[]; value: number }
export interface AnalyticsResult { rows: AnalyticsRow[]; columns: AnalyticsColumns; sql?: string; params?: unknown[] }

export type TileType = 'kpi' | 'line' | 'area' | 'bar' | 'pie' | 'table';
export interface TileData {
  type: TileType; title: string;
  rows: AnalyticsRow[]; columns: AnalyticsColumns; sql?: string;
}

const PALETTE = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

function fmt(v: number, unit: 'eur' | 'count'): string {
  return unit === 'eur' ? eur(v) : new Intl.NumberFormat('de-DE').format(Math.round(v));
}
const axisNum = (unit: 'eur' | 'count') => (v: number) =>
  unit === 'eur' ? new Intl.NumberFormat('de-DE', { notation: 'compact' }).format(v) : String(v);

const tooltipStyle = {
  contentStyle: { fontSize: 12, borderRadius: 8, border: '1px solid #e4e4e7' },
  labelStyle: { fontSize: 11 },
};

export function AnalyticsTile({ tile }: { tile: TileData }) {
  const [showSql, setShowSql] = useState(false);
  const unit = tile.columns.value.unit;
  const data = tile.rows.map(r => ({ x: r.bucket ?? r.dims[0] ?? '—', value: r.value }));
  const empty = !tile.rows.length;

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-semibold">{tile.title || tile.columns.value.label}</h3>
        {tile.sql && (
          <button
            type="button" onClick={() => setShowSql(s => !s)} title="SQL anzeigen"
            className="shrink-0 rounded p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 dark:text-zinc-600 dark:hover:bg-zinc-800"
          >
            <Code2 size={14} />
          </button>
        )}
      </div>

      {empty
        ? <div className="flex h-24 items-center justify-center text-sm text-zinc-400">keine Daten</div>
        : renderBody(tile.type, data, unit, tile)}

      {showSql && tile.sql && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-50 p-2 text-[10px] leading-relaxed text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          {tile.sql}
        </pre>
      )}
    </Card>
  );
}

function renderBody(type: TileType, data: { x: string; value: number }[], unit: 'eur' | 'count', tile: TileData) {
  if (type === 'kpi') {
    const v = data.reduce((s, d) => s + d.value, 0); // usually a single row
    return <div className="py-2 text-3xl font-bold tabular-nums">{fmt(v, unit)}</div>;
  }

  if (type === 'table') {
    return (
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white text-left text-xs text-zinc-400 dark:bg-zinc-900">
            <tr>
              {tile.columns.time && <th className="py-1 pr-2 font-medium">Zeit</th>}
              {tile.columns.dims.map(d => <th key={d.key} className="py-1 pr-2 font-medium">{d.label}</th>)}
              <th className="py-1 text-right font-medium">{tile.columns.value.label}</th>
            </tr>
          </thead>
          <tbody>
            {tile.rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-50 dark:border-zinc-800/60">
                {tile.columns.time && <td className="py-1 pr-2">{r.bucket}</td>}
                {tile.columns.dims.map((_, di) => <td key={di} className="py-1 pr-2">{r.dims[di] ?? '—'}</td>)}
                <td className="py-1 text-right tabular-nums font-medium">{fmt(r.value, unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Recharts pie can't render negative slices (e.g. a negative "net"); fall back
  // to a bar chart so the data is still shown correctly rather than corrupted.
  if (type === 'pie' && !data.some(d => d.value < 0)) {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="x" cx="50%" cy="50%" outerRadius={80} label={false}>
            {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip formatter={(v: number) => fmt(Number(v), unit)} {...tooltipStyle} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'line' || type === 'area') {
    const Chart = type === 'area' ? AreaChart : LineChart;
    return (
      <ResponsiveContainer width="100%" height={220}>
        <Chart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" strokeOpacity={0.4} />
          <XAxis dataKey="x" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} width={44} tickFormatter={axisNum(unit)} />
          <Tooltip formatter={(v: number) => fmt(Number(v), unit)} {...tooltipStyle} />
          {type === 'area'
            ? <Area type="monotone" dataKey="value" stroke="#10b981" fill="#10b981" fillOpacity={0.15} strokeWidth={2} />
            : <Line type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} dot={false} />}
        </Chart>
      </ResponsiveContainer>
    );
  }

  // bar (default)
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" strokeOpacity={0.4} />
        <XAxis dataKey="x" tick={{ fontSize: 10 }} interval={0} angle={data.length > 6 ? -30 : 0} textAnchor={data.length > 6 ? 'end' : 'middle'} height={data.length > 6 ? 50 : 24} />
        <YAxis tick={{ fontSize: 10 }} width={44} tickFormatter={axisNum(unit)} />
        <Tooltip formatter={(v: number) => fmt(Number(v), unit)} {...tooltipStyle} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
