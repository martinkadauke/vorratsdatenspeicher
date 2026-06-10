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

  if (isLoading || !config) return <Section title={useTranslation().t('admin.churner')}><Spinner /></Section>;

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

// ── Users ────────────────────────────────────────────────────────────────
function UsersSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [newUser, setNewUser] = useState({ username: '', password: '', is_admin: false });

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<User[]>('/api/users'),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const create = useMutation({
    mutationFn: () => api('/api/users', { method: 'POST', body: newUser }),
    onSuccess: () => { invalidate(); setNewUser({ username: '', password: '', is_admin: false }); },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api(`/api/users/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
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
            <span className="flex-1 font-medium">{u.username}</span>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
              {t('admin.isAdmin')}
              <Switch checked={u.is_admin} onChange={v => patch.mutate({ id: u.id, body: { is_admin: v } })} />
            </label>
            <Button variant="ghost" className="px-2" onClick={() => {
              const pw = prompt(t('admin.resetPw'));
              if (pw) patch.mutate({ id: u.id, body: { password: pw } });
            }}>🔑</Button>
            <Button variant="ghost" className="px-2 text-red-500" onClick={() => {
              if (confirm(t('common.confirm'))) remove.mutate(u.id);
            }}><Trash2 size={15} /></Button>
          </div>
        ))}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <Label>{t('login.username')}</Label>
            <Input value={newUser.username} onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))} />
          </div>
          <div className="flex-1">
            <Label>{t('login.password')}</Label>
            <Input type="password" value={newUser.password} onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))} />
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-zinc-500">
            {t('admin.isAdmin')}
            <Switch checked={newUser.is_admin} onChange={v => setNewUser(p => ({ ...p, is_admin: v }))} />
          </label>
          <Button onClick={() => create.mutate()} disabled={!newUser.username || !newUser.password}>
            {t('admin.addUser')}
          </Button>
        </div>
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
