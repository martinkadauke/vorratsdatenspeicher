import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, Play, ChevronRight, History } from 'lucide-react';
import { api } from '../api/client';
import type { FamilyMember, MaintenanceEvent, User } from '../api/types';
import { Card, Button, Input, Label, Select, Switch, Spinner, Badge } from '../components/ui';
import { useFamily } from '../components/ConsumerChips';
import { useAuth } from '../context/auth';
import { cronToHuman } from '../lib/utils';

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
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold">{t('admin.title')}</h1>
      <AiProvidersSection />
      <AiTasksSection />
      <ChurnerSection />
      <CategoriesLinkSection />
      <UsersSection />
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
  const { data } = useQuery({
    queryKey: [`${provider}-health`],
    queryFn: () => provider === 'searxng'
      ? api<{ ok: boolean; error?: string }>('/api/searxng/health')
      : api<{ ok: boolean; error?: string }>(`/api/ai/health?provider=${provider}`),
    retry: false,
    refetchInterval: 60_000,
  });
  const ok = data?.ok;
  return (
    <Badge
      title={data?.error ?? ''}
      className={ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
                    : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'}
    >
      {label}: {ok ? t('admin.healthy') : t('admin.unhealthy')}
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

// ── Churner runtime settings ─────────────────────────────────────────────
function ChurnerSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => api<Record<string, unknown>>('/api/config'),
  });
  const { data: status } = useQuery({
    queryKey: ['maintenance-status'],
    queryFn: () => api<{ churner: { running: boolean }; recategorize: { running: boolean } }>('/api/maintenance/status'),
    refetchInterval: 10_000,
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
        </div>
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
                onClick={() => {
                  if (confirm(t('common.confirm'))) remove.mutate(u.id);
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
          <div
            key={m.id}
            className="grid items-center gap-1.5 rounded-xl border border-zinc-100 px-1.5 py-2 dark:border-zinc-800 sm:gap-2 sm:px-3"
            style={{ gridTemplateColumns: '40px minmax(0,1fr) 32px 28px' }}
          >
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
              onClick={() => { if (confirm(t('common.confirm'))) remove.mutate(m.id); }}
              className="flex h-9 items-center justify-center rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
              aria-label={t('common.delete')}
            ><Trash2 size={15} /></button>
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
