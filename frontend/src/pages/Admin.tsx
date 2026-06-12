import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, Play, ChevronRight, History, Square, Image as ImageIcon, Download, ExternalLink, Store } from 'lucide-react';
import { api } from '../api/client';
import type { FamilyMember, MaintenanceEvent, User } from '../api/types';
import { Card, Button, Input, Label, Select, Switch, Spinner, Badge, ProgressBar } from '../components/ui';
import { useFamily } from '../components/ConsumerChips';
import { useAuth } from '../context/auth';
import { confirm } from '../components/Confirm';
import { cn, cronToHuman, downloadFile, fmtBytes } from '../lib/utils';
import { toast } from '../components/Toast';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="min-w-0 p-3 sm:p-4">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      <div className="min-w-0">{children}</div>
    </Card>
  );
}

export function Admin() {
  const { t } = useTranslation();
  const { user } = useAuth();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold">{t('admin.title')}</h1>
      <AiProvidersSection />
      <AiTasksSection />
      <ModelReviewSection />
      <TokenUsageSection />
      <ChurnerSection />
      <CategoriesLinkSection />
      <UsersSection />
      <KontenSection />
      {user?.sees_all_konten && <DataManagementSection />}
      <OffersSection />
      <SmtpSection />
      <FamilySection />
      <MaintenanceSection />
    </div>
  );
}

// ── AI Providers (Ollama + DeepSeek connection settings) ─────────────────
type Provider = 'ollama' | 'deepseek' | 'anthropic';

function HealthBadge({ provider, label }: { provider: Provider | 'searxng'; label: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: [`${provider}-health`],
    queryFn: () => provider === 'searxng'
      ? api<{ ok: boolean; error?: string }>('/api/searxng/health')
      : api<{ ok: boolean; error?: string }>(`/api/ai/health?provider=${provider}`),
    retry: false,
    refetchInterval: 60_000,
  });
  // three states: unknown (loading → neutral grey), reachable (green), down (red)
  const state = isLoading || !data ? 'unknown' : data.ok ? 'ok' : 'down';
  const tone = {
    unknown: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
    ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    down: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  }[state];
  const dot = { unknown: 'bg-zinc-400', ok: 'bg-emerald-500', down: 'bg-red-500' }[state];
  return (
    <Badge title={data?.error ?? ''} className={tone}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {label}: {state === 'unknown' ? '…' : state === 'ok' ? t('admin.healthy') : t('admin.unhealthy')}
    </Badge>
  );
}

function AiProvidersSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api<Record<string, unknown>>('/api/config'),
  });

  const setCfg = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api(`/api/config/${key}`, { method: 'PUT', body: { value } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['ollama-health'] });
      void qc.invalidateQueries({ queryKey: ['deepseek-health'] });
      void qc.invalidateQueries({ queryKey: ['anthropic-health'] });
      void qc.invalidateQueries({ queryKey: ['ai-models'] });
    },
  });

  if (!config) return <Section title={t('admin.aiProviders')}><Spinner /></Section>;

  return (
    <Section title={t('admin.aiProviders')}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <HealthBadge provider="ollama" label="Ollama" />
          <HealthBadge provider="deepseek" label="DeepSeek" />
          <HealthBadge provider="anthropic" label="Anthropic" />
          <HealthBadge provider="searxng" label="SearXNG" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>{t('admin.ollamaUrl')}</Label>
            <Input
              defaultValue={config['ollama.url'] as string}
              onBlur={e => e.target.value !== config['ollama.url'] && setCfg.mutate({ key: 'ollama.url', value: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('admin.searxngUrl')}</Label>
            <Input
              defaultValue={config['searxng.url'] as string}
              onBlur={e => e.target.value !== config['searxng.url'] && setCfg.mutate({ key: 'searxng.url', value: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('admin.deepseekUrl')}</Label>
            <Input
              defaultValue={config['deepseek.url'] as string}
              onBlur={e => e.target.value !== config['deepseek.url'] && setCfg.mutate({ key: 'deepseek.url', value: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('admin.deepseekApiKey')}</Label>
            <Input
              type="password"
              autoComplete="off"
              defaultValue={config['deepseek.api_key'] as string}
              placeholder={(config['deepseek.api_key'] as string) ? '••••••••' : 'sk-…'}
              onBlur={e => e.target.value && e.target.value !== config['deepseek.api_key'] && setCfg.mutate({ key: 'deepseek.api_key', value: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('admin.anthropicUrl')}</Label>
            <Input
              defaultValue={config['anthropic.url'] as string}
              onBlur={e => e.target.value !== config['anthropic.url'] && setCfg.mutate({ key: 'anthropic.url', value: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('admin.anthropicApiKey')}</Label>
            <Input
              type="password"
              autoComplete="off"
              defaultValue={config['anthropic.api_key'] as string}
              placeholder={(config['anthropic.api_key'] as string) ? '••••••••' : 'sk-ant-…'}
              onBlur={e => e.target.value && e.target.value !== config['anthropic.api_key'] && setCfg.mutate({ key: 'anthropic.api_key', value: e.target.value })}
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

// ── AI Tasks (per-task provider+model dropdowns) ─────────────────────────
const AI_TASKS = [
  { key: 'recategorize',     i18n: 'admin.taskRecategorize',   descI18n: 'admin.taskRecategorizeDesc' },
  { key: 'churner_stage1',   i18n: 'admin.taskChurnerStage1',  descI18n: 'admin.taskChurnerStage1Desc' },
  { key: 'churner_stage2',   i18n: 'admin.taskChurnerStage2',  descI18n: 'admin.taskChurnerStage2Desc' },
  { key: 'ocr',              i18n: 'admin.taskOcr',            descI18n: 'admin.taskOcrDesc' },
  { key: 'categories_chat',  i18n: 'admin.taskCategoriesChat', descI18n: 'admin.taskCategoriesChatDesc' },
  { key: 'model_review',     i18n: 'admin.taskModelReview',    descI18n: 'admin.taskModelReviewDesc' },
] as const;

interface AiTaskLogRow {
  id: number; task: string; provider: string; model: string;
  source: string; changed_at: string; changed_by: string | null;
}

function AiTaskLog() {
  const { t, i18n } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['ai-task-log'],
    queryFn: () => api<AiTaskLogRow[]>('/api/ai/tasks/log?limit=50'),
  });
  if (isLoading) return <Spinner />;
  if (!data?.length) return <p className="py-2 text-xs text-zinc-400">{t('admin.taskLogEmpty')}</p>;
  const taskLabel = (task: string) => {
    const def = AI_TASKS.find(x => x.key === task);
    return def ? t(def.i18n) : task;
  };
  return (
    <div className="max-h-64 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-xs">
        <tbody>
          {data.map(row => (
            <tr key={row.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
              <td className="whitespace-nowrap px-2 py-1.5 text-zinc-400">
                {new Date(row.changed_at).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="px-2 py-1.5 font-medium">{taskLabel(row.task)}</td>
              <td className="px-2 py-1.5"><span className="text-zinc-400">{row.provider}/</span>{row.model}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-zinc-400">
                {row.source === 'auto_review' ? t('admin.taskLogAuto') : (row.changed_by ?? '–')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskRow({ task, taskLabel, taskDesc, config }: {
  task: typeof AI_TASKS[number]['key'];
  taskLabel: string;
  taskDesc: string;
  config: Record<string, unknown>;
}) {
  const qc = useQueryClient();
  const provider = (config[`ai.${task}.provider`] ?? 'ollama') as Provider;
  const model = (config[`ai.${task}.model`] ?? '') as string;

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: ['ai-models', provider],
    queryFn: () => api<{ models: string[] }>(`/api/ai/models?provider=${provider}`),
    retry: false,
    staleTime: 60_000,
  });

  const setTask = useMutation({
    mutationFn: (body: { provider: Provider; model: string }) =>
      api(`/api/ai/tasks/${task}`, { method: 'PUT', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['config'] }),
  });

  const onProviderChange = (next: Provider) => {
    setTask.mutate({ provider: next, model });
  };
  const onModelChange = (next: string) => {
    setTask.mutate({ provider, model: next });
  };

  const models = modelsData?.models ?? [];
  const modelOptions = !models.includes(model) && model ? [model, ...models] : models;

  return (
    <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-0.5 text-sm font-medium">{taskLabel}</div>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">{taskDesc}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={provider} onChange={e => onProviderChange(e.target.value as Provider)}>
          <option value="ollama">Ollama</option>
          <option value="deepseek">DeepSeek</option>
          <option value="anthropic">Anthropic</option>
        </Select>
        {modelsLoading ? (
          <Input value="…" disabled />
        ) : modelOptions.length ? (
          <Select value={model} onChange={e => onModelChange(e.target.value)}>
            {!model && <option value="">– Modell wählen –</option>}
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
        ) : (
          <Input
            defaultValue={model}
            placeholder="Modell-Name"
            onBlur={e => e.target.value !== model && onModelChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

function AiTasksSection() {
  const { t } = useTranslation();
  const [showLog, setShowLog] = useState(false);
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api<Record<string, unknown>>('/api/config'),
  });

  if (!config) return <Section title={t('admin.aiTasks')}><Spinner /></Section>;

  return (
    <Section title={t('admin.aiTasks')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('admin.aiTasksHint')}</p>
        {AI_TASKS.map(({ key, i18n, descI18n }) => (
          <TaskRow key={key} task={key} taskLabel={t(i18n)} taskDesc={t(descI18n)} config={config} />
        ))}
        <button
          onClick={() => setShowLog(s => !s)}
          className="flex items-center gap-1.5 self-start rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"
        >
          <History size={13} /> {showLog ? t('admin.taskLogHide') : t('admin.taskLogShow')}
        </button>
        {showLog && <AiTaskLog />}
      </div>
    </Section>
  );
}

// ── Bi-weekly AI model review ─────────────────────────────────────────────
interface ModelCandidate { provider: string; model: string; reason: string }
interface ModelProposal { task: string; current_provider: string; current_model: string; api: ModelCandidate | null; open: ModelCandidate | null }
interface ModelReview { id: number; created_at: string; status: string; proposals: ModelProposal[]; decided_at: string | null }
type ReviewAction = 'apply_api' | 'apply_open' | 'reject';

function ModelReviewSection() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: review } = useQuery({
    queryKey: ['model-review-latest'],
    queryFn: () => api<ModelReview | null>('/api/model-review/latest'),
  });
  const run = useMutation({
    mutationFn: () => api<{ proposals: boolean }>('/api/model-review/run', { method: 'POST' }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['model-review-latest'] });
      toast(r.proposals ? t('admin.reviewRunFound') : t('admin.reviewRunNone'), 'success');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: number; action: ReviewAction }) =>
      api(`/api/model-review/${id}/decide`, { method: 'POST', body: { action } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['model-review-latest'] });
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['ai-task-log'] });
      toast(t('admin.reviewDone'), 'success');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const taskLabel = (task: string) => {
    const def = AI_TASKS.find(x => x.key === task);
    return def ? t(def.i18n) : task;
  };
  const cand = (c: ModelCandidate | null) => c
    ? <span><span className="font-medium text-emerald-600 dark:text-emerald-400">{c.model}</span> <span className="text-zinc-400">[{c.provider}]</span></span>
    : <span className="text-zinc-400">—</span>;

  return (
    <Section title={t('admin.reviewTitle')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('admin.reviewHint')}</p>
        <Button variant="secondary" onClick={() => run.mutate()} disabled={run.isPending} className="self-start">
          <Play size={14} /> {run.isPending ? t('admin.reviewRunning') : t('admin.reviewRunBtn')}
        </Button>

        {review && (
          <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 flex items-center justify-between text-xs text-zinc-400">
              <span>{new Date(review.created_at).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE')}</span>
              <Badge className={
                review.status === 'pending' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                : review.status.startsWith('applied') ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'
              }>{t(`admin.reviewStatus_${review.status}`)}</Badge>
            </div>
            <div className="flex flex-col gap-2">
              {review.proposals.map((p, i) => (
                <div key={i} className="rounded-lg bg-zinc-50 p-2 text-xs dark:bg-zinc-800/40">
                  <div className="font-medium">{taskLabel(p.task)} <span className="font-normal text-zinc-400">({t('admin.reviewCurrent')}: {p.current_model})</span></div>
                  <div className="mt-1 grid grid-cols-[3.2rem_1fr] gap-x-2 gap-y-0.5">
                    <span className="text-zinc-400">API:</span>
                    <div>{cand(p.api)}{p.api?.reason && <span className="block text-zinc-400">{p.api.reason}</span>}</div>
                    <span className="text-zinc-400">Open:</span>
                    <div>{cand(p.open)}{p.open?.reason && <span className="block text-zinc-400">{p.open.reason}</span>}</div>
                  </div>
                </div>
              ))}
            </div>
            {review.status === 'pending' && (
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={() => decide.mutate({ id: review.id, action: 'reject' })} disabled={decide.isPending}>
                  {t('admin.reviewReject')}
                </Button>
                <Button variant="secondary" onClick={() => decide.mutate({ id: review.id, action: 'apply_open' })} disabled={decide.isPending}>
                  {t('admin.reviewApplyOpen')}
                </Button>
                <Button onClick={() => decide.mutate({ id: review.id, action: 'apply_api' })} disabled={decide.isPending}>
                  {t('admin.reviewApplyApi')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

// ── Token usage analytics + top-up links ─────────────────────────────────
interface UsageAgg { calls: number; input_tokens: number; output_tokens: number; est_cost_usd: number }
interface UsageResp {
  totals: UsageAgg;
  byProvider: (UsageAgg & { provider: string; top_up_url: string | null })[];
  byModel: (UsageAgg & { provider: string; model: string })[];
  byTask: (UsageAgg & { task: string })[];
  daily: { day: string; input_tokens: number; output_tokens: number; calls: number }[];
}

const fmtTok = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n);
const fmtUsd = (n: number) => n === 0 ? '–' : `$${n.toFixed(n < 1 ? 4 : 2)}`;
/** Providers that can be topped up, shown even before any usage is recorded. */
const TOPUP_LINKS: { provider: string; url: string }[] = [
  { provider: 'Anthropic', url: 'https://console.anthropic.com/settings/billing' },
  { provider: 'DeepSeek', url: 'https://platform.deepseek.com/top_up' },
];

function TokenUsageSection() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['ai-usage'],
    queryFn: () => api<UsageResp>('/api/ai/usage'),
    refetchInterval: 60_000,
  });
  const taskLabel = (task: string) => {
    const def = AI_TASKS.find(x => x.key === task);
    return def ? t(def.i18n) : task;
  };

  return (
    <Section title={t('admin.usageTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('admin.usageHint')}</p>

        {isLoading ? <Spinner /> : !data || !data.totals.calls ? (
          <p className="py-2 text-xs text-zinc-400">{t('admin.usageEmpty')}</p>
        ) : (
          <>
            {/* totals */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t('admin.usageCalls')} value={String(data.totals.calls)} />
              <Stat label={t('admin.usageInput')} value={fmtTok(data.totals.input_tokens)} />
              <Stat label={t('admin.usageOutput')} value={fmtTok(data.totals.output_tokens)} />
              <Stat label={t('admin.usageCost')} value={fmtUsd(data.totals.est_cost_usd)} sub={t('admin.usageEstimate')} />
            </div>

            {/* per provider, with inline top-up */}
            <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-zinc-400 dark:border-zinc-800">
                    <th className="px-2 py-1.5 font-medium">{t('admin.usageProvider')}</th>
                    <th className="px-2 py-1.5 text-right font-medium">{t('admin.usageCalls')}</th>
                    <th className="px-2 py-1.5 text-right font-medium">In</th>
                    <th className="px-2 py-1.5 text-right font-medium">Out</th>
                    <th className="px-2 py-1.5 text-right font-medium">{t('admin.usageCost')}</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.byProvider.map(p => (
                    <tr key={p.provider} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <td className="px-2 py-1.5 font-medium capitalize">{p.provider}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.calls}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtTok(p.input_tokens)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtTok(p.output_tokens)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtUsd(p.est_cost_usd)}</td>
                      <td className="px-2 py-1.5 text-right">
                        {p.top_up_url && (
                          <a href={p.top_up_url} target="_blank" rel="noopener noreferrer"
                             className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950">
                            <ExternalLink size={11} /> {t('admin.usageTopUp')}
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* daily bars (last 30d) */}
            <UsageDailyBars daily={data.daily} />

            {/* per task */}
            <details className="text-xs">
              <summary className="cursor-pointer select-none text-zinc-500 hover:text-emerald-600">{t('admin.usageByTask')}</summary>
              <div className="mt-2 flex flex-col gap-1">
                {data.byTask.map(tk => (
                  <div key={tk.task} className="flex items-center justify-between rounded-lg bg-zinc-50 px-2 py-1 dark:bg-zinc-800/40">
                    <span className="font-medium">{taskLabel(tk.task)}</span>
                    <span className="tabular-nums text-zinc-400">{tk.calls}× · {fmtTok(tk.input_tokens + tk.output_tokens)} Tok · {fmtUsd(tk.est_cost_usd)}</span>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}

        {/* top-up links — always available, even before any usage */}
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <span className="text-xs text-zinc-500">{t('admin.usageTopUpLinks')}:</span>
          {TOPUP_LINKS.map(l => (
            <a key={l.provider} href={l.url} target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-700">
              <ExternalLink size={12} /> {l.provider}
            </a>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-800/40">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-zinc-400">{sub}</div>}
    </div>
  );
}

function UsageDailyBars({ daily }: { daily: UsageResp['daily'] }) {
  const { t } = useTranslation();
  if (!daily.length) return null;
  const max = Math.max(...daily.map(d => d.input_tokens + d.output_tokens), 1);
  return (
    <div>
      <div className="mb-1 text-xs text-zinc-400">{t('admin.usageDaily')}</div>
      <div className="flex h-20 items-end gap-0.5">
        {daily.map(d => {
          const tot = d.input_tokens + d.output_tokens;
          const h = Math.max(2, Math.round((tot / max) * 76));
          return (
            <div key={d.day} className="flex-1 rounded-t bg-emerald-400/70 dark:bg-emerald-500/60"
                 style={{ height: `${h}px` }}
                 title={`${d.day}: ${fmtTok(tot)} Tok · ${d.calls}×`} />
          );
        })}
      </div>
    </div>
  );
}

// ── Churner runtime settings ─────────────────────────────────────────────
interface JobProgress { phase: string; current: number; total: number; label?: string }
interface MaintenanceStatus {
  churner: { enabled: boolean; cron: string; running: boolean; progress: JobProgress | null };
  recategorize: { running: boolean; progress: JobProgress | null };
}

function PhaseProgress({ progress }: { progress: JobProgress }) {
  const { t } = useTranslation();
  const phaseLabel: Record<string, string> = {
    recategorize: t('admin.phaseRecategorize'),
    canonical: t('admin.phaseCanonical'),
    store_icons: t('admin.phaseStoreIcons'),
    canonical_icons: t('admin.phaseCanonicalIcons'),
  };
  const label = phaseLabel[progress.phase] ?? progress.phase;
  // icon phases have no measurable total → indeterminate
  const indeterminate = progress.phase === 'store_icons' || progress.phase === 'canonical_icons' || !progress.total;
  return (
    <ProgressBar
      label={label}
      value={indeterminate ? undefined : progress.current}
      max={indeterminate ? undefined : progress.total}
    />
  );
}

function ChurnerSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => api<Record<string, unknown>>('/api/config'),
  });
  const { data: status } = useQuery({
    queryKey: ['maintenance-status'],
    queryFn: () => api<MaintenanceStatus>('/api/maintenance/status'),
    refetchInterval: q => {
      const s = q.state.data as MaintenanceStatus | undefined;
      return s?.churner.running || s?.recategorize.running ? 1500 : 10_000;
    },
  });

  const setCfg = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api(`/api/config/${key}`, { method: 'PUT', body: { value } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['config'] }),
  });
  const churnNow = useMutation({
    mutationFn: () => api('/api/maintenance/churn', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance-status'] }),
  });
  const churnStop = useMutation({
    mutationFn: () => api('/api/maintenance/churn/stop', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance-status'] }),
  });
  const fetchIcons = useMutation({
    mutationFn: () => api('/api/maintenance/icons', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance-status'] }),
  });

  if (isLoading || !config) return <Section title={t('admin.maintenance')}><Spinner /></Section>;
  const churnRunning = status?.churner.running ?? false;
  const cronStr = (config['churner.cron'] as string) ?? '';
  const lang = (config['app.default_lang'] as string) === 'en' ? 'en' : 'de';

  return (
    <Section title={t('admin.maintenance')}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('admin.maintenanceHint')}</p>

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t('admin.maintenanceEnabled')}</span>
          <Switch
            checked={config['churner.enabled'] as boolean}
            onChange={v => setCfg.mutate({ key: 'churner.enabled', value: v })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>{t('admin.cron')}</Label>
            <Input
              defaultValue={cronStr}
              onBlur={e => e.target.value !== config['churner.cron'] && setCfg.mutate({ key: 'churner.cron', value: e.target.value })}
            />
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{cronToHuman(cronStr, lang)}</p>
          </div>
          <div>
            <Label>{t('admin.defaultLang')}</Label>
            <Select
              value={config['app.default_lang'] as string}
              onChange={e => setCfg.mutate({ key: 'app.default_lang', value: e.target.value })}
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label>{t('admin.confidence')}: {String(config['churner.confidence'])}</Label>
            <input
              type="range"
              min={0.5}
              max={0.95}
              step={0.05}
              defaultValue={config['churner.confidence'] as number}
              onMouseUp={e => setCfg.mutate({ key: 'churner.confidence', value: parseFloat((e.target as HTMLInputElement).value) })}
              onTouchEnd={e => setCfg.mutate({ key: 'churner.confidence', value: parseFloat((e.target as HTMLInputElement).value) })}
              className="w-full accent-emerald-600"
            />
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('admin.confidenceHint')}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => churnNow.mutate()} disabled={churnRunning}>
            <Play size={15} /> {churnRunning ? t('admin.running') : t('admin.churnNow')}
          </Button>
          {churnRunning && (
            <Button variant="danger" onClick={() => churnStop.mutate()} disabled={churnStop.isPending}>
              <Square size={14} /> {churnStop.isPending ? t('admin.stopping') : t('admin.churnStop')}
            </Button>
          )}
          <Button variant="secondary" onClick={() => fetchIcons.mutate()} disabled={churnRunning || fetchIcons.isPending}>
            <ImageIcon size={15} /> {fetchIcons.isPending ? t('admin.running') : t('admin.fetchIcons')}
          </Button>
        </div>
        <p className="text-xs text-zinc-400">{t('admin.fetchIconsHint')}</p>

        {status?.churner.running && status.churner.progress && (
          <PhaseProgress progress={status.churner.progress} />
        )}
        {status?.churner.running && !status.churner.progress && (
          <ProgressBar label={t('admin.running')} />
        )}
      </div>
    </Section>
  );
}

// ── Categories link card ─────────────────────────────────────────────────
function CategoriesLinkSection() {
  const { t } = useTranslation();
  return (
    <Card className="min-w-0 p-3 sm:p-4">
      <RouterLink to="/admin/categories" className="group flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold group-hover:text-emerald-600">{t('categoriesAdmin.title')}</h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{t('categoriesAdmin.linkHint')}</p>
        </div>
        <ChevronRight size={20} className="shrink-0 text-zinc-400 group-hover:text-emerald-600" />
      </RouterLink>
    </Card>
  );
}

// ── Users (invite-only) ──────────────────────────────────────────────────
function UsersSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [invite, setInvite] = useState({ email: '', is_admin: false });
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [createdUsername, setCreatedUsername] = useState<string | null>(null);

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<User[]>('/api/users'),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const sendInvite = useMutation({
    mutationFn: () => api<{ emailed: boolean; invite_link: string; username: string }>('/api/users/invite', { method: 'POST', body: invite }),
    onSuccess: (res) => {
      invalidate();
      setInvite({ email: '', is_admin: false });
      setCreatedUsername(res.username);
      setInviteLink(res.emailed ? null : res.invite_link);
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api(`/api/users/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
  const sendReset = useMutation({
    mutationFn: (id: number) => api<{ emailed: boolean; reset_link: string }>(`/api/users/${id}/send-reset`, { method: 'POST' }),
    onSuccess: (res) => { setCreatedUsername(null); setInviteLink(res.emailed ? null : res.reset_link); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/users/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  return (
    <Section title={t('admin.users')}>
      <div className="flex flex-col gap-2">
        {users?.map(u => {
          const isSelf = u.id === me?.id;
          return (
            <div key={u.id} className="flex items-center gap-2 rounded-xl border border-zinc-100 px-2.5 py-2 dark:border-zinc-800">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {u.username}
                  {isSelf && <span className="ml-1.5 text-xs font-normal text-zinc-400">({t('admin.you')})</span>}
                </div>
                {u.email && <div className="truncate text-xs text-zinc-400">{u.email}</div>}
              </div>
              <label className="flex shrink-0 items-center gap-1 text-xs text-zinc-500" title={t('admin.seesAllKonten')}>
                <span className="hidden sm:inline">{t('admin.seesAll')}</span>
                <Switch
                  checked={u.sees_all_konten ?? false}
                  onChange={v => patch.mutate({ id: u.id, body: { sees_all_konten: v } })}
                />
              </label>
              <label className="flex shrink-0 items-center gap-1 text-xs text-zinc-500" title={t('admin.isAdmin')}>
                <span className="hidden sm:inline">{t('admin.isAdmin')}</span>
                <Switch
                  checked={u.is_admin}
                  disabled={isSelf}
                  onChange={v => patch.mutate({ id: u.id, body: { is_admin: v } })}
                />
              </label>
              <Button
                variant="ghost"
                className="shrink-0 px-2"
                disabled={isSelf}
                title={isSelf ? t('admin.youUseProfileForReset') : t('admin.sendReset')}
                onClick={() => sendReset.mutate(u.id)}
              >🔑</Button>
              <Button
                variant="ghost"
                className="shrink-0 px-2 text-red-500"
                disabled={isSelf}
                title={isSelf ? t('admin.cannotDeleteSelf') : t('common.delete')}
                onClick={async () => {
                  if (await confirm({ message: t('common.confirm'), confirmLabel: t('common.delete'), cancelLabel: t('common.cancel'), danger: true })) remove.mutate(u.id);
                }}
              ><Trash2 size={15} /></Button>
            </div>
          );
        })}

        {inviteLink && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
            <div className="mb-1 font-medium text-amber-700 dark:text-amber-400">{t('admin.linkNotEmailed')}</div>
            {createdUsername && (
              <div className="mb-1 text-amber-700 dark:text-amber-400">
                {t('admin.usernameSetTo')} <strong>{createdUsername}</strong>
              </div>
            )}
            <code className="break-all select-all">{inviteLink}</code>
          </div>
        )}

        <form
          autoComplete="off"
          onSubmit={e => { e.preventDefault(); if (invite.email) sendInvite.mutate(); }}
          className="mt-2 flex flex-wrap items-end gap-2"
        >
          {/* Honeypot decoy: some password managers fill the first email field
              they see; this off-screen one absorbs the autofill so the real
              email input below stays empty. */}
          <input
            type="email"
            tabIndex={-1}
            autoComplete="username"
            aria-hidden
            className="absolute left-[-9999px] h-0 w-0 opacity-0"
            name="vds-decoy"
          />
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <Label>{t('admin.inviteEmail')}</Label>
            <Input
              type="email"
              name="vds-invite-email"
              autoComplete="off"
              spellCheck={false}
              placeholder="anja@familie.de"
              value={invite.email}
              onChange={e => setInvite(p => ({ ...p, email: e.target.value }))}
            />
          </div>
          <label className="flex shrink-0 items-center gap-1.5 pb-2 text-xs text-zinc-500">
            {t('admin.isAdmin')}
            <Switch checked={invite.is_admin} onChange={v => setInvite(p => ({ ...p, is_admin: v }))} />
          </label>
          <Button type="submit" className="shrink-0" disabled={!invite.email || sendInvite.isPending}>
            {t('admin.invite')}
          </Button>
        </form>
        <p className="text-xs text-zinc-400">{t('admin.usernameDerivedHint')}</p>
        {sendInvite.isError && <p className="text-xs text-red-500">{(sendInvite.error as Error).message}</p>}
      </div>
    </Section>
  );
}

// ── Konten (payment accounts) ────────────────────────────────────────────
interface KontoRow { id: number; name: string; is_shared: boolean; user_id: number | null; owner: string | null; receipts: number }

function KontenSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const [newUser, setNewUser] = useState<number | ''>('');

  const { data: konten } = useQuery({
    queryKey: ['admin-konten'],
    queryFn: () => api<KontoRow[]>('/api/admin/konten'),
  });
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<User[]>('/api/users'),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin-konten'] });
  const create = useMutation({
    mutationFn: () => api('/api/admin/konten', { method: 'POST', body: { name: newName, user_id: newUser || null } }),
    onSuccess: () => { setNewName(''); setNewUser(''); invalidate(); },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api(`/api/admin/konten/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/admin/konten/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e: Error) => alert(e.message),
  });

  return (
    <Section title={t('admin.konten')}>
      <div className="flex flex-col gap-2">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('admin.kontenHint')}</p>
        {konten?.map(k => (
          <div key={k.id} className="flex flex-col gap-2 rounded-xl border border-zinc-100 p-2.5 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{k.name}</span>
                {k.is_shared && <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">{t('admin.kontoShared')}</span>}
              </div>
              {!k.is_shared && (
                <Button
                  variant="ghost"
                  className="shrink-0 px-2 text-red-500"
                  disabled={k.receipts > 0}
                  title={k.receipts > 0 ? t('admin.kontoHasReceipts') : t('common.delete')}
                  onClick={async () => { if (await confirm({ message: t('common.confirm'), confirmLabel: t('common.delete'), cancelLabel: t('common.cancel'), danger: true })) remove.mutate(k.id); }}
                ><Trash2 size={15} /></Button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-xs text-zinc-400">{k.receipts} {t('stores.receipts')}</span>
              {!k.is_shared && (
                <label className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
                  <span className="shrink-0">{t('admin.kontoOwner')}</span>
                  <Select
                    value={k.user_id ?? ''}
                    onChange={e => patch.mutate({ id: k.id, body: { user_id: e.target.value ? parseInt(e.target.value, 10) : null } })}
                    className="min-w-0 flex-1"
                  >
                    <option value="">{t('admin.kontoNoOwner')}</option>
                    {users?.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
                  </Select>
                </label>
              )}
            </div>
          </div>
        ))}

        <form onSubmit={e => { e.preventDefault(); if (newName.trim()) create.mutate(); }} className="mt-1 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <Label>{t('admin.kontoName')}</Label>
            <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="z.B. Lena" />
          </div>
          <div>
            <Label>{t('admin.kontoOwner')}</Label>
            <Select value={newUser} onChange={e => setNewUser(e.target.value ? parseInt(e.target.value, 10) : '')} className="w-36">
              <option value="">{t('admin.kontoNoOwner')}</option>
              {users?.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
            </Select>
          </div>
          <Button type="submit" className="shrink-0" disabled={!newName.trim() || create.isPending}>{t('common.add')}</Button>
        </form>
      </div>
    </Section>
  );
}

// ── Data management (super-admin only) ──────────────────────────────────
interface DataStats { receipts: number; artikel: number; konten: number; photo_files: number; photo_bytes: number }

function DataManagementSection() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['data-stats'],
    queryFn: () => api<DataStats>('/api/admin/data-stats'),
  });

  const stat = (label: string, value: string | number) => (
    <div className="rounded-xl border border-zinc-100 px-3 py-2 dark:border-zinc-800">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="tabular text-lg font-semibold">{value}</div>
    </div>
  );

  return (
    <Section title={t('admin.data')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('admin.dataHint')}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stat(t('admin.dataReceipts'), data?.receipts ?? '…')}
          {stat(t('admin.dataArtikel'), data?.artikel ?? '…')}
          {stat(t('admin.dataKonten'), data?.konten ?? '…')}
          {stat(t('admin.dataDisk'), data ? `${fmtBytes(data.photo_bytes)} (${data.photo_files})` : '…')}
        </div>
        <div>
          <Label>{t('admin.dataExport')}</Label>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => downloadFile('/api/exports/receipts.csv', 'vds-belege.csv')}>
              <Download size={14} /> Belege CSV
            </Button>
            <Button variant="secondary" onClick={() => downloadFile('/api/exports/artikel.csv', 'vds-artikel.csv')}>
              <Download size={14} /> Artikel CSV
            </Button>
            <Button variant="secondary" onClick={() => downloadFile('/api/exports/monthly.csv', 'vds-monatlich.csv')}>
              <Download size={14} /> Monatlich CSV
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ── Household address + offer radius + offer-only categories ──────────────
const RADII = [5, 10, 20, 50];

function OffersSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api<Record<string, unknown>>('/api/config'),
  });
  const setCfg = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api(`/api/config/${key}`, { method: 'PUT', body: { value } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['config'] }),
  });
  const { data: avoided } = useQuery({
    queryKey: ['avoided'],
    queryFn: () => api<string[]>('/api/avoided'),
  });
  const unavoid = useMutation({
    mutationFn: (name: string) => api('/api/avoided', { method: 'POST', body: { canonical_names: [name], avoid: false } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['avoided'] }),
  });
  const { data: events } = useQuery({
    queryKey: ['maintenance-events'],
    queryFn: () => api<{ id: number; kind: string; ended_at: string | null; status: string; summary: Record<string, unknown> | null }[]>('/api/maintenance/events?limit=100'),
    refetchInterval: 15_000,
  });
  const lastInfo = events?.find(e => e.kind === 'supermarket.info');
  const fetchInfo = useMutation({
    mutationFn: () => api('/api/maintenance/supermarket-info', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance-events'] }),
  });

  const [newCat, setNewCat] = useState('');

  if (!config) return <Section title={t('admin.offersTitle')}><Spinner /></Section>;

  const address = (config['household.address'] as string) ?? '';
  const radiusEnabled = !!config['offers.radius_enabled'];
  const radiusKm = (config['offers.radius_km'] as number) ?? 10;
  const extra = (config['offers.extra_categories'] as string[]) ?? [];

  const addCat = () => {
    const v = newCat.trim();
    if (!v || extra.some(c => c.toLowerCase() === v.toLowerCase())) { setNewCat(''); return; }
    setCfg.mutate({ key: 'offers.extra_categories', value: [...extra, v] });
    setNewCat('');
  };
  const removeCat = (c: string) =>
    setCfg.mutate({ key: 'offers.extra_categories', value: extra.filter(x => x !== c) });

  return (
    <Section title={t('admin.offersTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('admin.offersHint')}</p>

        {/* household address */}
        <div>
          <Label>{t('admin.householdAddress')}</Label>
          <Input
            defaultValue={address}
            placeholder={t('admin.householdAddressPlaceholder')}
            onBlur={e => e.target.value !== address && setCfg.mutate({ key: 'household.address', value: e.target.value })}
          />
        </div>

        {/* radius toggle + km */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t('admin.offerRadius')}</span>
            <Switch checked={radiusEnabled} onChange={v => setCfg.mutate({ key: 'offers.radius_enabled', value: v })} />
          </div>
          {radiusEnabled && (
            <div className="flex items-center gap-2">
              <Label className="mb-0">{t('admin.offerRadiusKm')}</Label>
              <Select
                className="w-auto"
                value={String(radiusKm)}
                onChange={e => setCfg.mutate({ key: 'offers.radius_km', value: parseInt(e.target.value, 10) })}
              >
                {RADII.map(r => <option key={r} value={r}>{r} km</option>)}
              </Select>
            </div>
          )}
          <p className="text-xs text-zinc-400">{t('admin.offerRadiusHint')}</p>
        </div>

        {/* offer-only warengruppen */}
        <div className="flex flex-col gap-2">
          <Label className="mb-0">{t('admin.offerCategories')}</Label>
          <p className="text-xs text-zinc-400">{t('admin.offerCategoriesHint')}</p>
          <div className="flex flex-wrap gap-1.5">
            {extra.map(c => (
              <span key={c} className="inline-flex items-center gap-1 rounded-lg bg-zinc-100 px-2 py-1 text-xs font-medium dark:bg-zinc-800">
                {c}
                <button type="button" onClick={() => removeCat(c)} className="text-zinc-400 hover:text-red-500">✕</button>
              </span>
            ))}
            {!extra.length && <span className="text-xs text-zinc-400">{t('admin.offerCategoriesEmpty')}</span>}
          </div>
          <div className="flex gap-2">
            <Input
              value={newCat}
              placeholder={t('admin.offerCategoriesPlaceholder')}
              onChange={e => setNewCat(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCat(); } }}
            />
            <Button variant="secondary" onClick={addCat} disabled={!newCat.trim()}>{t('common.add')}</Button>
          </div>
        </div>

        {/* avoid list — products the household decided not to buy */}
        <div className="flex flex-col gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <Label className="mb-0">{t('admin.avoidList')}</Label>
          <p className="text-xs text-zinc-400">{t('admin.avoidListHint')}</p>
          <div className="flex flex-wrap gap-1.5">
            {(avoided ?? []).map(c => (
              <span key={c} className="inline-flex items-center gap-1 rounded-lg bg-red-50 px-2 py-1 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
                {c}
                <button type="button" onClick={() => unavoid.mutate(c)} className="text-red-400 hover:text-red-600" title={t('artikel.unavoid')}>✕</button>
              </span>
            ))}
            {!avoided?.length && <span className="text-xs text-zinc-400">{t('admin.avoidListEmpty')}</span>}
          </div>
        </div>

        {/* supermarket info crawler (opening hours via OSM, nightly) */}
        <div className="flex flex-col gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <Label className="mb-0">{t('admin.supermarketInfo')}</Label>
          <p className="text-xs text-zinc-400">{t('admin.supermarketInfoHint')}</p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => fetchInfo.mutate()} disabled={fetchInfo.isPending || lastInfo?.status === 'running'}>
              <Store size={14} /> {lastInfo?.status === 'running' || fetchInfo.isPending ? t('admin.supermarketInfoRunning') : t('admin.supermarketInfoBtn')}
            </Button>
            {lastInfo && lastInfo.status !== 'running' && (
              <span className="text-xs text-zinc-400">
                {t('admin.supermarketInfoLast', {
                  updated: (lastInfo.summary?.updated as number) ?? 0,
                  checked: (lastInfo.summary?.checked as number) ?? 0,
                })}
              </span>
            )}
          </div>
        </div>

        <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
          {t('admin.offersWip')}
        </p>
      </div>
    </Section>
  );
}

// ── SMTP ─────────────────────────────────────────────────────────────────
function SmtpSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api<Record<string, unknown>>('/api/config'),
  });

  const setCfg = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api(`/api/config/${key}`, { method: 'PUT', body: { value } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['config'] }),
  });

  const test = useMutation({
    mutationFn: () => api('/api/smtp/test', { method: 'POST', body: { to: testTo } }),
    onSuccess: () => setTestResult('✅'),
    onError: (e) => setTestResult(`❌ ${(e as Error).message}`),
  });

  if (!config) return null;

  const textField = (key: string, label: string, type = 'text') => (
    <div>
      <Label>{label}</Label>
      <Input
        type={type}
        defaultValue={String(config[key] ?? '')}
        onBlur={e => e.target.value !== String(config[key] ?? '') && setCfg.mutate({ key, value: type === 'number' ? parseInt(e.target.value, 10) : e.target.value })}
      />
    </div>
  );

  return (
    <Section title="SMTP / E-Mail">
      <div className="grid gap-3 sm:grid-cols-2">
        {textField('smtp.host', 'Host')}
        {textField('smtp.port', 'Port', 'number')}
        {textField('smtp.user', 'Benutzer')}
        {textField('smtp.pass', 'Passwort', 'password')}
        {textField('smtp.from', 'Absender (From)')}
        {textField('app.base_url', 'App Base-URL (für Links)')}
        <div className="flex items-center justify-between sm:col-span-2">
          <span className="text-sm font-medium">TLS/SSL (secure)</span>
          <Switch
            checked={config['smtp.secure'] as boolean}
            onChange={v => setCfg.mutate({ key: 'smtp.secure', value: v })}
          />
        </div>
        <div className="flex items-end gap-2 sm:col-span-2">
          <div className="flex-1">
            <Label>{t('admin.testTo')}</Label>
            <Input type="email" value={testTo} onChange={e => setTestTo(e.target.value)} />
          </div>
          <Button variant="secondary" onClick={() => { setTestResult(null); test.mutate(); }} disabled={!testTo || test.isPending}>
            {t('admin.sendTest')}
          </Button>
        </div>
        {testResult && <p className="text-sm sm:col-span-2">{testResult}</p>}
      </div>
    </Section>
  );
}

// ── Family ───────────────────────────────────────────────────────────────
function FamilySection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: members } = useFamily();
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/api/users') });
  const [newMember, setNewMember] = useState({ name: '', emoji: '', color: '#10b981' });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['family'] });
  const create = useMutation({
    mutationFn: () => api('/api/family', { method: 'POST', body: newMember }),
    onSuccess: () => { invalidate(); setNewMember({ name: '', emoji: '', color: '#10b981' }); },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api(`/api/family/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/family/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  return (
    <Section title={t('admin.family')}>
      <div className="flex flex-col gap-2">
        {members?.map((m: FamilyMember) => (
          <div key={m.id} className="flex flex-col gap-1.5 rounded-xl border border-zinc-100 px-1.5 py-2 dark:border-zinc-800 sm:px-3">
            <div className="grid items-center gap-1.5 sm:gap-2" style={{ gridTemplateColumns: '40px minmax(0,1fr) 32px 28px' }}>
              <Input
                className="h-9 w-full px-0 text-center"
                defaultValue={m.emoji ?? ''}
                onBlur={e => e.target.value !== (m.emoji ?? '') && patch.mutate({ id: m.id, body: { emoji: e.target.value } })}
              />
              <Input
                className="min-w-0"
                defaultValue={m.name}
                onBlur={e => e.target.value !== m.name && e.target.value && patch.mutate({ id: m.id, body: { name: e.target.value } })}
              />
              <input
                type="color"
                defaultValue={m.color ?? '#10b981'}
                onBlur={e => e.target.value !== m.color && patch.mutate({ id: m.id, body: { color: e.target.value } })}
                className="h-9 w-full cursor-pointer rounded-lg border border-zinc-200 bg-transparent p-0 dark:border-zinc-700"
              />
              <button
                type="button"
                onClick={async () => { if (await confirm({ message: t('common.confirm'), confirmLabel: t('common.delete'), cancelLabel: t('common.cancel'), danger: true })) remove.mutate(m.id); }}
                className="flex h-9 items-center justify-center rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
                aria-label={t('common.delete')}
              ><Trash2 size={15} /></button>
            </div>
            <label className="flex items-center gap-1.5 pl-0.5 text-xs text-zinc-500">
              <span className="shrink-0">{t('admin.memberUser')}</span>
              <Select
                value={m.user_id ?? ''}
                onChange={e => patch.mutate({ id: m.id, body: { user_id: e.target.value ? parseInt(e.target.value, 10) : null } })}
                className="min-w-0 flex-1"
              >
                <option value="">{t('admin.kontoNoOwner')}</option>
                {users?.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
              </Select>
            </label>
          </div>
        ))}
        <div
          className="mt-2 grid items-end gap-1.5 sm:gap-2"
          style={{ gridTemplateColumns: '40px minmax(0,1fr) 32px auto' }}
        >
          <div>
            <Label>Emoji</Label>
            <Input className="h-9 px-0 text-center" value={newMember.emoji} onChange={e => setNewMember(p => ({ ...p, emoji: e.target.value }))} />
          </div>
          <div className="min-w-0">
            <Label>Name</Label>
            <Input value={newMember.name} onChange={e => setNewMember(p => ({ ...p, name: e.target.value }))} />
          </div>
          <input
            type="color"
            value={newMember.color}
            onChange={e => setNewMember(p => ({ ...p, color: e.target.value }))}
            className="h-9 w-full cursor-pointer rounded-lg border border-zinc-200 bg-transparent p-0 dark:border-zinc-700"
          />
          <Button className="h-9 px-2 sm:px-3" onClick={() => create.mutate()} disabled={!newMember.name}>
            <span className="hidden sm:inline">{t('admin.addMember')}</span>
            <span className="sm:hidden">+</span>
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ── Maintenance log ──────────────────────────────────────────────────────
function summaryText(summary: Record<string, unknown> | null): string {
  if (!summary) return '';
  if (typeof summary.error === 'string') return `error: ${summary.error}`;
  const parts: string[] = [];
  if (typeof summary.candidates === 'number') parts.push(`${summary.candidates} candidates`);
  if (typeof summary.auto_applied === 'number') parts.push(`${summary.auto_applied} auto-applied`);
  if (typeof summary.queued === 'number') parts.push(`${summary.queued} queued`);
  if (typeof summary.skipped === 'number') parts.push(`${summary.skipped} skipped`);
  if (typeof summary.garbage === 'number' && (summary.garbage as number) > 0) parts.push(`${summary.garbage} garbage`);
  if (typeof summary.total === 'number') parts.push(`${summary.total} total`);
  if (typeof summary.updated === 'number') parts.push(`${summary.updated} updated`);
  if (typeof summary.fallback === 'number' && (summary.fallback as number) > 0) parts.push(`${summary.fallback} fallback`);
  if (typeof summary.trigger === 'string') parts.push(`(${summary.trigger})`);
  return parts.length ? parts.join(' · ') : JSON.stringify(summary);
}

function durationText(start: string, end: string | null): string {
  if (!end) return '…';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function MaintenanceSection() {
  const { t, i18n } = useTranslation();
  const { data: events } = useQuery({
    queryKey: ['maintenance-events'],
    queryFn: () => api<MaintenanceEvent[]>('/api/maintenance/events?limit=20'),
    refetchInterval: 15_000,
  });

  return (
    <Section title={t('admin.maintenance')}>
      <div className="flex flex-col gap-1 text-xs">
        {!events?.length && <div className="py-2 text-center text-zinc-400">–</div>}
        {events?.map(e => (
          <div key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 odd:bg-zinc-50 dark:odd:bg-zinc-900/60">
            <Badge className={
              e.status === 'success' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
              : e.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
            }>
              {e.status}
            </Badge>
            <span className="font-medium">{e.kind}</span>
            <span className="text-zinc-400">{new Date(e.started_at).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE')}</span>
            <span className="text-zinc-400">· {durationText(e.started_at, e.ended_at)}</span>
            <span className="min-w-0 basis-full break-words text-zinc-500 dark:text-zinc-400 sm:basis-0 sm:flex-1 sm:truncate">{summaryText(e.summary)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
