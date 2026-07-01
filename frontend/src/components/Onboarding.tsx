import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Bot, Home, Users, Wallet, PartyPopper, Plus, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { Button, Input, Select, Label, Switch } from './ui';
import { useAuth } from '../context/auth';
import { toast } from './Toast';
import type { FamilyMember } from '../api/types';
import { cn } from '../lib/utils';

interface Konto { id: number; name: string; is_shared: boolean }

const STEP_META = [
  { icon: Sparkles, emoji: '👋', key: 'welcome' },
  { icon: Bot, emoji: '🤖', key: 'ai' },
  { icon: Home, emoji: '🏡', key: 'household' },
  { icon: Users, emoji: '👨‍👩‍👧‍👦', key: 'family' },
  { icon: Wallet, emoji: '💳', key: 'konten' },
  { icon: PartyPopper, emoji: '🎉', key: 'done' },
];

/** First-run setup wizard for the admin of a fresh install. Self-gated: only renders
 *  when the current user is an admin and the household-global onboarding flag is unset.
 *  Reuses the existing config / family / konten endpoints; on finish it marks
 *  onboarding.done (household-global config) and refreshes the session. */
export function Onboarding() {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const show = !!user?.is_admin && user?.onboarding_done === false;

  const { data: config } = useQuery({
    queryKey: ['config'], queryFn: () => api<Record<string, unknown>>('/api/config'), enabled: show,
  });
  const setCfg = useMutation({
    mutationFn: (b: { key: string; value: unknown }) => api(`/api/config/${b.key}`, { method: 'PUT', body: { value: b.value } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['config'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const { data: family } = useQuery({ queryKey: ['family'], queryFn: () => api<FamilyMember[]>('/api/family'), enabled: show });
  const { data: konten } = useQuery({ queryKey: ['konten-admin'], queryFn: () => api<Konto[]>('/api/admin/konten'), enabled: show });

  const [provider, setProvider] = useState('anthropic');
  useEffect(() => { if (config?.['ai.ocr.provider']) setProvider(config['ai.ocr.provider'] as string); }, [config]);

  const [newFam, setNewFam] = useState({ name: '', emoji: '' });
  const addFam = useMutation({
    mutationFn: () => api('/api/family', { method: 'POST', body: { name: newFam.name.trim(), emoji: newFam.emoji.trim() || null } }),
    onSuccess: () => { setNewFam({ name: '', emoji: '' }); void qc.invalidateQueries({ queryKey: ['family'] }); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const delFam = useMutation({
    mutationFn: (id: number) => api(`/api/family/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['family'] }),
  });

  const [newKonto, setNewKonto] = useState({ name: '', is_shared: false });
  const addKonto = useMutation({
    mutationFn: () => api('/api/admin/konten', { method: 'POST', body: { name: newKonto.name.trim(), is_shared: newKonto.is_shared } }),
    onSuccess: () => { setNewKonto({ name: '', is_shared: false }); void qc.invalidateQueries({ queryKey: ['konten-admin'] }); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const delKonto = useMutation({
    mutationFn: (id: number) => api(`/api/admin/konten/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['konten-admin'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const finishMut = useMutation({
    mutationFn: () => api('/api/config/onboarding.done', { method: 'PUT', body: { value: true } }),
    onSuccess: async () => { await refreshUser(); navigate('/receipts'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (!show) return null;

  const finish = () => finishMut.mutate();
  const next = () => (step < STEP_META.length - 1 ? setStep(step + 1) : finish());
  const prev = () => step > 0 && setStep(step - 1);
  const cur = STEP_META[step];
  const Icon = cur.icon;

  const saveProvider = (p: string) => {
    setProvider(p);
    setCfg.mutate({ key: 'ai.ocr.provider', value: p });
    setCfg.mutate({ key: 'ai.categories_chat.provider', value: p });
  };
  const cfgInput = (key: string, opts: { password?: boolean; placeholder?: string } = {}) => (
    <Input
      type={opts.password ? 'password' : 'text'}
      autoComplete="off"
      defaultValue={(config?.[key] as string) ?? ''}
      placeholder={opts.placeholder}
      onBlur={e => e.target.value !== ((config?.[key] as string) ?? '') && setCfg.mutate({ key, value: e.target.value })}
    />
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm">
      <div className="relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900">
        {/* Hero */}
        <div className="flex h-24 shrink-0 items-center justify-center gap-3 bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-950 dark:to-emerald-900">
          <div className="text-5xl">{cur.emoji}</div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-6">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-500">
            <Icon size={18} />
            <span className="text-xs font-medium uppercase tracking-wide">{step + 1} / {STEP_META.length}</span>
          </div>
          <h2 className="text-xl font-bold">{t(`onboarding.${cur.key}.title`)}</h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{t(`onboarding.${cur.key}.body`)}</p>

          {/* ── AI ── */}
          {cur.key === 'ai' && (
            <div className="flex flex-col gap-3">
              <div>
                <Label>{t('onboarding.ai.provider')}</Label>
                <Select value={provider} onChange={e => saveProvider(e.target.value)}>
                  <option value="anthropic">Anthropic (Claude) — {t('onboarding.ai.recommended')}</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="ollama">Ollama — {t('onboarding.ai.local')}</option>
                </Select>
              </div>
              {provider === 'anthropic' && <div><Label>{t('onboarding.ai.apiKey')}</Label>{cfgInput('anthropic.api_key', { password: true, placeholder: 'sk-ant-…' })}</div>}
              {provider === 'deepseek' && <div><Label>{t('onboarding.ai.apiKey')}</Label>{cfgInput('deepseek.api_key', { password: true, placeholder: 'sk-…' })}</div>}
              {provider === 'ollama' && <div><Label>{t('onboarding.ai.ollamaUrl')}</Label>{cfgInput('ollama.url', { placeholder: 'http://…:11434' })}<p className="mt-1 text-xs text-zinc-400">{t('onboarding.ai.ollamaHint')}</p></div>}
            </div>
          )}

          {/* ── Household ── */}
          {cur.key === 'household' && (
            <div><Label>{t('onboarding.household.address')}</Label>{cfgInput('household.address', { placeholder: t('onboarding.household.placeholder') })}</div>
          )}

          {/* ── Family ── */}
          {cur.key === 'family' && (
            <div className="flex flex-col gap-2">
              {(family ?? []).map(m => (
                <div key={m.id} className="flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
                  <span className="text-lg">{m.emoji || '🙂'}</span>
                  <span className="flex-1 truncate text-sm font-medium">{m.name}</span>
                  <button onClick={() => delFam.mutate(m.id)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Trash2 size={15} /></button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Input className="w-14 text-center" placeholder="🙂" value={newFam.emoji} onChange={e => setNewFam(v => ({ ...v, emoji: e.target.value }))} />
                <Input className="flex-1" placeholder={t('onboarding.family.namePlaceholder')} value={newFam.name}
                  onChange={e => setNewFam(v => ({ ...v, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && newFam.name.trim()) addFam.mutate(); }} />
                <Button className="shrink-0" disabled={!newFam.name.trim() || addFam.isPending} onClick={() => addFam.mutate()}><Plus size={16} /></Button>
              </div>
            </div>
          )}

          {/* ── Konten ── */}
          {cur.key === 'konten' && (
            <div className="flex flex-col gap-2">
              {(konten ?? []).map(k => (
                <div key={k.id} className="flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
                  <Wallet size={15} className="text-zinc-400" />
                  <span className="flex-1 truncate text-sm font-medium">{k.name}</span>
                  {k.is_shared && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">{t('onboarding.konten.shared')}</span>}
                  {!k.is_shared && <button onClick={() => delKonto.mutate(k.id)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Trash2 size={15} /></button>}
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Input className="flex-1" placeholder={t('onboarding.konten.namePlaceholder')} value={newKonto.name}
                  onChange={e => setNewKonto(v => ({ ...v, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && newKonto.name.trim()) addKonto.mutate(); }} />
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500"><Switch checked={newKonto.is_shared} onChange={v => setNewKonto(s => ({ ...s, is_shared: v }))} />{t('onboarding.konten.shared')}</label>
                <Button className="shrink-0" disabled={!newKonto.name.trim() || addKonto.isPending} onClick={() => addKonto.mutate()}><Plus size={16} /></Button>
              </div>
            </div>
          )}

          {/* Progress dots */}
          <div className="flex justify-center gap-1.5 pt-2">
            {STEP_META.map((_, i) => (
              <button key={i} onClick={() => setStep(i)}
                className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-6 bg-emerald-600' : 'w-1.5 bg-zinc-300 dark:bg-zinc-700')}
                aria-label={`${t('tour.gotoStep')} ${i + 1}`} />
            ))}
          </div>

          <div className="mt-1 flex items-center justify-between gap-2">
            <Button variant="ghost" onClick={prev} disabled={step === 0} className="px-3"><ChevronLeft size={16} /> {t('tour.prev')}</Button>
            {step < STEP_META.length - 1 && <button onClick={next} className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">{t('onboarding.skip')}</button>}
            <Button onClick={next} disabled={finishMut.isPending} className="px-4">
              {step === STEP_META.length - 1 ? t('onboarding.finish') : t('tour.next')}
              {step < STEP_META.length - 1 && <ChevronRight size={16} />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
