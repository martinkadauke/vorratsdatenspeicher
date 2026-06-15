import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, Sparkles, Send, X, Mail, SlidersHorizontal } from 'lucide-react';
import { api } from '../api/client';
import { Card, Button, Input, Spinner, Select } from '../components/ui';
import { AnalyticsTile, type TileType, type TileData, type AnalyticsResult } from '../components/AnalyticsTile';
import { toast } from '../components/Toast';
import { cn } from '../lib/utils';

interface AskResult { clarify?: string | null; options?: string[]; chip?: string; title?: string; summary?: string; tiles: TileData[]; dropped: number }
interface RecentQuery { q: string; chip: string }
const RECENT_KEY = 'vds-analytics-recent';
function loadRecent(): RecentQuery[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.slice(0, 5) : []; } catch { return []; }
}
interface Catalog {
  sources: { key: string; label: string }[];
  konten: { id: number; name: string; is_shared: boolean }[];
}
type FilterSpec = { from?: string; to?: string; source?: string[]; konto_id?: number[]; direction?: 'expense' | 'income' };
interface TileSpec { type: TileType; title: string; query: Record<string, unknown> }

const PRESETS = [
  { key: 'month', label: 'Dieser Monat' },
  { key: '3m', label: '3 Monate' },
  { key: '6m', label: '6 Monate' },
  { key: '12m', label: '12 Monate' },
  { key: 'all', label: 'Alles' },
];

function presetRange(key: string): { from?: string; to?: string } {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (key === 'all') return {};
  if (key === 'month') return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) };
  const months = key === '3m' ? 3 : key === '6m' ? 6 : 12;
  const from = new Date(today); from.setMonth(from.getMonth() - months);
  return { from: iso(from), to: iso(today) };
}

const DEFAULT_TILES: TileSpec[] = [
  { type: 'kpi', title: 'Ausgaben', query: { metric: 'spend' } },
  { type: 'kpi', title: 'Einnahmen', query: { metric: 'income' } },
  { type: 'kpi', title: 'Saldo', query: { metric: 'net' } },
  { type: 'line', title: 'Ausgaben pro Monat', query: { metric: 'spend', grain: 'month', limit: 24 } },
  { type: 'bar', title: 'Top-Kategorien', query: { metric: 'spend', dimensions: ['category'], limit: 8 } },
  { type: 'bar', title: 'Nach Quelle', query: { metric: 'spend', dimensions: ['source'], limit: 8 } },
];

const chip = (active: boolean) => cn(
  'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition',
  active ? 'border-transparent bg-violet-600 text-white' : 'border-zinc-300 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400',
);
const scrollRow = 'flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

function QueryTile({ spec, filters }: { spec: TileSpec; filters: FilterSpec }) {
  const query = { ...spec.query, filters: { ...(spec.query.filters as object ?? {}), ...filters } };
  const { data, isLoading } = useQuery({
    queryKey: ['analytics-q', spec.type, spec.title, JSON.stringify(query)],
    queryFn: () => api<AnalyticsResult>('/api/analytics/query', { method: 'POST', body: query }),
  });
  if (isLoading || !data) return <Card className="flex h-32 items-center justify-center p-3 sm:h-44"><Spinner /></Card>;
  return <AnalyticsTile tile={{ type: spec.type, title: spec.title, rows: data.rows, columns: data.columns, sql: data.sql }} />;
}

export function Analytics() {
  const { i18n } = useTranslation();
  const [preset, setPreset] = useState('6m');
  const [sources, setSources] = useState<string[]>([]);
  const [konto, setKonto] = useState<number | ''>('');
  const [direction, setDirection] = useState<'' | 'expense' | 'income'>('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState<AskResult | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [originalQuestion, setOriginalQuestion] = useState('');
  const [clarifyAnswer, setClarifyAnswer] = useState('');
  const [recent, setRecent] = useState<RecentQuery[]>(loadRecent);

  const pushRecent = (q: string, label: string) => {
    setRecent(prev => {
      const next = [{ q, chip: label }, ...prev.filter(r => r.q !== q)].slice(0, 5);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const { data: catalog } = useQuery({
    queryKey: ['analytics-catalog'],
    queryFn: () => api<Catalog>('/api/analytics/catalog'),
    staleTime: 300_000,
  });

  const filters: FilterSpec = {
    ...presetRange(preset),
    ...(sources.length ? { source: sources } : {}),
    ...(konto !== '' ? { konto_id: [konto] } : {}),
    ...(direction ? { direction } : {}),
  };
  const activeFilters = (direction ? 1 : 0) + (sources.length ? 1 : 0) + (konto !== '' ? 1 : 0);

  const doAsk = async (q: string, prior?: { question: string; clarify: string }) => {
    const text = q.trim();
    if (!text) return;
    setAsking(true); setAskErr(null);
    if (!prior) setOriginalQuestion(text);   // start of a new thread
    try {
      const res = await api<AskResult>('/api/analytics/ask', {
        method: 'POST',
        body: { question: text, lang: i18n.language === 'en' ? 'en' : 'de', ...(prior ? { prior } : {}) },
      });
      setAsk(res);
      setClarifyAnswer('');
      if (!res.clarify) setQuestion('');
      if (!prior) pushRecent(text, res.chip?.trim() || text.slice(0, 22));   // keep last 5 initial queries
    } catch (e) {
      setAskErr((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const answerClarify = (a: string) => {
    if (ask?.clarify) void doAsk(a, { question: originalQuestion, clarify: ask.clarify });
  };

  const sendReport = async () => {
    setSending(true);
    try {
      // Prefer the NL-generated dashboard the user is looking at; else the default view.
      const useDash = ask && !ask.clarify && ask.tiles?.length;
      const body = useDash
        ? { dashboard: { title: ask?.title, summary: ask?.summary, tiles: ask?.tiles } }
        : { filters, periodLabel: PRESETS.find(p => p.key === preset)?.label ?? '' };
      const r = await api<{ sent: boolean; to: string }>('/api/analytics/report', { method: 'POST', body });
      toast(`Report an ${r.to} gesendet`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  const toggleSource = (key: string) =>
    setSources(s => (s.includes(key) ? s.filter(x => x !== key) : [...s, key]));

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LayoutDashboard size={20} className="text-violet-500" />
          <h1 className="text-lg font-bold">Analytics</h1>
        </div>
        <Button variant="secondary" onClick={() => void sendReport()} disabled={sending} className="shrink-0 px-3">
          {sending ? <Spinner /> : <Mail size={15} />}
          <span className="hidden sm:inline">Report senden</span>
        </Button>
      </div>

      {/* Natural-language ask */}
      <Card className="flex flex-col gap-2 p-2.5 sm:p-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Sparkles size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-violet-400" />
            <Input
              className="pl-9"
              placeholder="Frag deine Daten …"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void doAsk(question); }}
            />
          </div>
          <Button onClick={() => void doAsk(question)} disabled={asking || !question.trim()} className="shrink-0">
            {asking ? <Spinner /> : <Send size={16} />}
          </Button>
        </div>
        {recent.length > 0 && (
          <div className={scrollRow}>
            {recent.map(r => (
              <button key={r.q} type="button" onClick={() => void doAsk(r.q)} title={r.q} className={chip(false)}>{r.chip}</button>
            ))}
          </div>
        )}
      </Card>

      {askErr && (
        <Card className="border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {askErr}
        </Card>
      )}

      {ask && (
        <div className="flex flex-col gap-3 rounded-2xl border border-violet-200 bg-violet-50/40 p-2.5 dark:border-violet-900/50 dark:bg-violet-950/20 sm:p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400">
                <Sparkles size={13} /> KI-Antwort
              </div>
              {ask.title && <h2 className="mt-0.5 text-base font-bold">{ask.title}</h2>}
              {ask.summary && <p className="text-sm text-zinc-500 dark:text-zinc-400">{ask.summary}</p>}
            </div>
            <button type="button" onClick={() => setAsk(null)} className="shrink-0 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <X size={16} />
            </button>
          </div>
          {ask.clarify
            ? (
              <Card className="flex flex-col gap-2.5 p-3">
                <p className="text-sm text-zinc-700 dark:text-zinc-200">{ask.clarify}</p>
                {!!ask.options?.length && (
                  <div className="flex flex-wrap gap-1.5">
                    {ask.options.map(o => (
                      <button key={o} type="button" disabled={asking} onClick={() => answerClarify(o)} className={chip(false)}>{o}</button>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    placeholder="Antwort eingeben …"
                    value={clarifyAnswer}
                    disabled={asking}
                    onChange={e => setClarifyAnswer(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') answerClarify(clarifyAnswer); }}
                  />
                  <Button onClick={() => answerClarify(clarifyAnswer)} disabled={asking || !clarifyAnswer.trim()} className="shrink-0">
                    {asking ? <Spinner /> : <Send size={16} />}
                  </Button>
                </div>
              </Card>
            )
            : (
              <div className="grid gap-3 sm:grid-cols-2">
                {ask.tiles.map((tile, i) => (
                  <div key={i} className={cn('min-w-0', tile.type === 'kpi' ? '' : 'sm:col-span-2')}>
                    <AnalyticsTile tile={tile} />
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {/* Filters: presets always visible (scrollable); the rest collapsible */}
      <div className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className={scrollRow}>
            {PRESETS.map(p => (
              <button key={p.key} type="button" onClick={() => setPreset(p.key)} className={chip(preset === p.key)}>{p.label}</button>
            ))}
          </div>
          <button
            type="button" onClick={() => setFiltersOpen(o => !o)}
            className={cn('shrink-0', chip(activeFilters > 0 || filtersOpen))}
          >
            <SlidersHorizontal size={13} className="-mt-0.5 mr-1 inline" />
            {activeFilters > 0 ? `Filter · ${activeFilters}` : 'Filter'}
          </button>
        </div>
        {filtersOpen && (
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-800">
            <div className={scrollRow}>
              {([['', 'Alle'], ['expense', 'Ausgaben'], ['income', 'Einnahmen']] as const).map(([k, lbl]) => (
                <button key={k} type="button" onClick={() => setDirection(k)} className={chip(direction === k)}>{lbl}</button>
              ))}
              {(catalog?.konten.length ?? 0) > 1 && (
                <Select value={String(konto)} onChange={e => setKonto(e.target.value === '' ? '' : Number(e.target.value))} className="h-7 w-auto shrink-0 py-0 text-xs">
                  <option value="">Alle Konten</option>
                  {catalog?.konten.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
                </Select>
              )}
            </div>
            {!!catalog?.sources.length && (
              <div className={scrollRow}>
                {catalog.sources.map(s => (
                  <button key={s.key} type="button" onClick={() => toggleSource(s.key)} className={chip(sources.includes(s.key))}>{s.label}</button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Default dashboard */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {DEFAULT_TILES.slice(0, 3).map(spec => <QueryTile key={spec.title} spec={spec} filters={filters} />)}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {DEFAULT_TILES.slice(3).map(spec => <QueryTile key={spec.title} spec={spec} filters={filters} />)}
      </div>
    </div>
  );
}
