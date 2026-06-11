import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, Play, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import type { FamilyMember, MaintenanceEvent, User } from '../api/types';
import { Card, Button, Input, Label, Select, Switch, Spinner, Badge } from '../components/ui';
import { useFamily } from '../components/ConsumerChips';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

export function Admin() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold">{t('admin.title')}</h1>
      <ChurnerSection />
      <UsersSection />
      <SmtpSection />
      <FamilySection />
      <MaintenanceSection />
    </div>
  );
}

// ── Churner & AI settings ────────────────────────────────────────────────
function ChurnerSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => api<Record<string, unknown>>('/api/config'),
  });
  const { data: models } = useQuery({
    queryKey: ['ollama-models'],
    queryFn: () => api<{ models: string[] }>('/api/ollama/models'),
    retry: false,
  });
  const { data: ollamaHealth } = useQuery({
    queryKey: ['ollama-health'],
    queryFn: () => api<{ ok: boolean }>('/api/ollama/health'),
    retry: false,
  });
  const { data: searxHealth } = useQuery({
    queryKey: ['searxng-health'],
    queryFn: () => api<{ ok: boolean; error?: string }>('/api/searxng/health'),
    retry: false,
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
  const recategorize = useMutation({
    mutationFn: (onlyMissing: boolean) =>
      api('/api/maintenance/recategorize', { method: 'POST', body: { only_missing: onlyMissing } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance-status'] }),
  });

  if (isLoading || !config) return <Section title={t('admin.churner')}><Spinner /></Section>;

  const churnRunning = status?.churner.running ?? false;
  const recatRunning = status?.recategorize.running ?? false;

  return (
    <Section title={t('admin.churner')}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Badge className={ollamaHealth?.ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400' : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'}>
            Ollama: {ollamaHealth?.ok ? t('admin.healthy') : t('admin.unhealthy')}
          </Badge>
          <Badge className={searxHealth?.ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400' : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'}>
            SearXNG: {searxHealth?.ok ? t('admin.healthy') : t('admin.unhealthy')}
          </Badge>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t('admin.churnerEnabled')}</span>
          <Switch
            checked={config['churner.enabled'] as boolean}
            onChange={v => setCfg.mutate({ key: 'churner.enabled', value: v })}
          />
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
            <Label>{t('admin.ollamaModel')}</Label>
            {models?.models.length ? (
              <Select
                value={config['ollama.model'] as string}
                onChange={e => setCfg.mutate({ key: 'ollama.model', value: e.target.value })}
              >
                {!models.models.includes(config['ollama.model'] as string) && (
                  <option value={config['ollama.model'] as string}>{config['ollama.model'] as string}</option>
                )}
                {models.models.map(m => <option key={m} value={m}>{m}</option>)}
              </Select>
            ) : (
              <Input
                defaultValue={config['ollama.model'] as string}
                onBlur={e => e.target.value !== config['ollama.model'] && setCfg.mutate({ key: 'ollama.model', value: e.target.value })}
              />
            )}
          </div>
          <div>
            <Label>{t('admin.cron')}</Label>
            <Input
              defaultValue={config['churner.cron'] as string}
              onBlur={e => e.target.value !== config['churner.cron'] && setCfg.mutate({ key: 'churner.cron', value: e.target.value })}
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
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => churnNow.mutate()} disabled={churnRunning}>
            <Play size={15} /> {churnRunning ? t('admin.running') : t('admin.churnNow')}
          </Button>
          <Button variant="secondary" onClick={() => recategorize.mutate(false)} disabled={recatRunning}>
            <RefreshCw size={15} /> {recatRunning ? t('admin.running') : t('admin.recategorize')}
          </Button>
          <Button variant="ghost" onClick={() => recategorize.mutate(true)} disabled={recatRunning}>
            {t('admin.recategorizeMissing')}
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ── Users (invite-only) ──────────────────────────────────────────────────
function UsersSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [invite, setInvite] = useState({ email: '', username: '', is_admin: false });
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<User[]>('/api/users'),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const sendInvite = useMutation({
    mutationFn: () => api<{ emailed: boolean; invite_link: string }>('/api/users/invite', { method: 'POST', body: invite }),
    onSuccess: (res) => {
      invalidate();
      setInvite({ email: '', username: '', is_admin: false });
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
    onSuccess: (res) => setInviteLink(res.emailed ? null : res.reset_link),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/users/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  return (
    <Section title={t('admin.users')}>
      <div className="flex flex-col gap-2">
        {users?.map(u => (
          <div key={u.id} className="flex items-center gap-3 rounded-xl border border-zinc-100 px-3 py-2 dark:border-zinc-800">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{u.username}</div>
              {u.email && <div className="truncate text-xs text-zinc-400">{u.email}</div>}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
              {t('admin.isAdmin')}
              <Switch checked={u.is_admin} onChange={v => patch.mutate({ id: u.id, body: { is_admin: v } })} />
            </label>
            <Button variant="ghost" className="px-2" title={t('admin.sendReset')}
              onClick={() => sendReset.mutate(u.id)}>🔑</Button>
            <Button variant="ghost" className="px-2 text-red-500" onClick={() => {
              if (confirm(t('common.confirm'))) remove.mutate(u.id);
            }}><Trash2 size={15} /></Button>
          </div>
        ))}

        {inviteLink && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
            <div className="mb-1 font-medium text-amber-700 dark:text-amber-400">{t('admin.linkNotEmailed')}</div>
            <code className="break-all select-all">{inviteLink}</code>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <Label>{t('login.email')}</Label>
            <Input type="email" value={invite.email} onChange={e => setInvite(p => ({ ...p, email: e.target.value }))} />
          </div>
          <div className="flex-1">
            <Label>{t('login.username')}</Label>
            <Input value={invite.username} onChange={e => setInvite(p => ({ ...p, username: e.target.value }))} />
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-zinc-500">
            {t('admin.isAdmin')}
            <Switch checked={invite.is_admin} onChange={v => setInvite(p => ({ ...p, is_admin: v }))} />
          </label>
          <Button onClick={() => sendInvite.mutate()} disabled={!invite.email || !invite.username || sendInvite.isPending}>
            {t('admin.invite')}
          </Button>
        </div>
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
          <div key={m.id} className="flex items-center gap-2 rounded-xl border border-zinc-100 px-3 py-2 dark:border-zinc-800">
            <Input
              className="w-14 text-center"
              defaultValue={m.emoji ?? ''}
              onBlur={e => e.target.value !== (m.emoji ?? '') && patch.mutate({ id: m.id, body: { emoji: e.target.value } })}
            />
            <Input
              className="flex-1"
              defaultValue={m.name}
              onBlur={e => e.target.value !== m.name && e.target.value && patch.mutate({ id: m.id, body: { name: e.target.value } })}
            />
            <input
              type="color"
              defaultValue={m.color ?? '#10b981'}
              onBlur={e => e.target.value !== m.color && patch.mutate({ id: m.id, body: { color: e.target.value } })}
              className="h-9 w-9 cursor-pointer rounded-lg border border-zinc-200 bg-transparent dark:border-zinc-700"
            />
            <Button variant="ghost" className="px-2 text-red-500" onClick={() => {
              if (confirm(t('common.confirm'))) remove.mutate(m.id);
            }}><Trash2 size={15} /></Button>
          </div>
        ))}
        <div className="mt-2 flex items-end gap-2">
          <div className="w-16">
            <Label>Emoji</Label>
            <Input value={newMember.emoji} onChange={e => setNewMember(p => ({ ...p, emoji: e.target.value }))} />
          </div>
          <div className="flex-1">
            <Label>Name</Label>
            <Input value={newMember.name} onChange={e => setNewMember(p => ({ ...p, name: e.target.value }))} />
          </div>
          <input
            type="color"
            value={newMember.color}
            onChange={e => setNewMember(p => ({ ...p, color: e.target.value }))}
            className="h-9 w-9 cursor-pointer rounded-lg border border-zinc-200 bg-transparent dark:border-zinc-700"
          />
          <Button onClick={() => create.mutate()} disabled={!newMember.name}>{t('admin.addMember')}</Button>
        </div>
      </div>
    </Section>
  );
}

// ── Maintenance log ──────────────────────────────────────────────────────
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
        {events?.map(e => (
          <div key={e.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 odd:bg-zinc-50 dark:odd:bg-zinc-900/60">
            <Badge className={
              e.status === 'success' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
              : e.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
            }>
              {e.status}
            </Badge>
            <span className="font-medium">{e.kind}</span>
            <span className="text-zinc-400">{new Date(e.started_at).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE')}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-400">{e.summary ? JSON.stringify(e.summary) : ''}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
