import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ArrowDownRight, TriangleAlert } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';
import { api } from '../api/client';
import { Card } from './ui';
import { eur, cn } from '../lib/utils';

interface WeeklyTrend {
  weeks: { week: string; spend: number }[];
  current: { week: string; spend: number };
  previous: { week: string; spend: number };
  avg4: number;
  delta_pct: number | null;
  anomaly: boolean;
}

interface OverspendRow {
  path: string;
  label: string;
  spend: number;
  avg3: number;
  overshoot_pct: number;
}

export function TrendBar({ member }: { member: number | null }) {
  const { t } = useTranslation();
  const memberParam = member !== null ? `?member=${member}` : '';

  const { data: weekly } = useQuery({
    queryKey: ['trends-weekly', member],
    queryFn: () => api<WeeklyTrend>(`/api/trends/weekly${memberParam}`),
  });
  const { data: overspend } = useQuery({
    queryKey: ['trends-overspend'],
    queryFn: () => api<OverspendRow[]>('/api/trends/overspend'),
    enabled: member === null,
  });

  if (!weekly) return null;

  const delta = weekly.delta_pct;
  const up = delta !== null && delta > 0;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-500">{t('trends.thisWeek')}</div>
          <div className="tabular text-2xl font-bold">{eur(weekly.current.spend)}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs">
            {delta !== null && (
              <span className={cn('inline-flex items-center gap-0.5 font-medium',
                up ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-500')}>
                {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                {Math.abs(delta).toFixed(0)}%
              </span>
            )}
            <span className="text-zinc-400">
              {t('trends.vsLastWeek')} ({eur(weekly.previous.spend)})
            </span>
          </div>
        </div>
        <div className="h-12 w-24 shrink-0 sm:w-32">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={weekly.weeks}>
              <Line
                type="monotone"
                dataKey="spend"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
              />
              <Tooltip
                content={({ active, payload }) =>
                  active && payload?.[0] ? (
                    <div className="rounded bg-zinc-900 px-2 py-1 text-[10px] text-white">
                      {payload[0].payload.week}: {eur(payload[0].value as number)}
                    </div>
                  ) : null
                }
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {weekly.anomaly && (
        <div className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
          <TriangleAlert size={13} />
          {t('trends.anomaly', { avg: eur(weekly.avg4) })}
        </div>
      )}

      {overspend && overspend.length > 0 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {overspend.map(o => (
            <Link
              key={o.path}
              to="/stats"
              className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700 hover:border-amber-300 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400"
              title={`${eur(o.spend)} vs Ø ${eur(o.avg3)}`}
            >
              {o.label} <span className="font-semibold">+{Math.round(o.overshoot_pct)}%</span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
