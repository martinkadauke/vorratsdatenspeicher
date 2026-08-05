import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Bot, Cpu, Tags, Home, Users, Wallet, Mail, Inbox, PartyPopper, Languages, Plus, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { Button, Input, Select, Label, Switch, FeedbackIconButton } from './ui';
import { EmojiSelect } from './EmojiPicker';
import { SmtpHelp } from './SmtpHelp';
import { ImapHelp } from './ImapHelp';
import { useAuth } from '../context/auth';
import { toast } from './Toast';
import type { FamilyMember } from '../api/types';
import { cn } from '../lib/utils';

interface Konto { id: number; name: string; is_shared: boolean; account_type: string }
const KONTO_TYPES = ['giro', 'kreditkarte', 'paypal', 'bargeld', 'krypto', 'depot'];
const DETAILS = ['grob', 'mittel', 'fein'];
const PROVIDERS = ['ollama', 'deepseek', 'anthropic', 'openai'];
const AI_TASKS: [string, string][] = [
  ['ocr', 'admin.taskOcr'],
  ['categories_chat', 'admin.taskCategoriesChat'],
  ['recategorize', 'admin.taskRecategorize'],
  ['churner_stage1', 'admin.taskChurnerStage1'],
  ['churner_stage2', 'admin.taskChurnerStage2'],
  ['model_review', 'admin.taskModelReview'],
  ['nlanalytics', 'onboarding.models.nlanalytics'],
];

// Full wizard = the single-household admin (off-demo) OR the demo platform super-admin
// (operator): sets up AI, mail, accounts, …
const FULL_STEPS = [
  { icon: Languages, emoji: '🌍', key: 'lang' },
  { icon: Sparkles, emoji: '👋', key: 'welcome' },
  { icon: Bot, emoji: '🤖', key: 'ai' },
  { icon: Cpu, emoji: '🧠', key: 'models' },
  { icon: Tags, emoji: '🗂️', key: 'categories' },
  { icon: Home, emoji: '🏡', key: 'household' },
  { icon: Users, emoji: '👨‍👩‍👧‍👦', key: 'family' },
  { icon: Wallet, emoji: '💳', key: 'konten' },
  { icon: Mail, emoji: '✉️', key: 'email' },
  { icon: Inbox, emoji: '📥', key: 'imap' },
  { icon: PartyPopper, emoji: '🎉', key: 'done' },
];
// Slim wizard = a demo household admin: only their own household (address / categories /
// family). Infra + AI (the operator's domain) is excluded.
const SLIM_STEPS = FULL_STEPS.filter(s => ['welcome', 'categories', 'household', 'family', 'done'].includes(s.key));

const composeAddr = (a: { street: string; nr: string; plz: string; city: string }): string => {
  const l1 = [a.street.trim(), a.nr.trim()].filter(Boolean).join(' ');
  const l2 = [a.plz.trim(), a.city.trim()].filter(Boolean).join(' ');
  return [l1, l2].filter(Boolean).join(', ');
};

export function Onboarding() {
  const { t, i18n } = useTranslation();
  const { user, refreshUser, demo } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  // Off-demo (dev/prod): the single admin always gets the full wizard writing to global
  // config. On-demo: the platform super-admin gets the full wizard; a household admin gets
  // the slim wizard (own-household address / categories / family, saved to their row).
  const isSuper = !!user?.is_super_admin;
  const fullWizard = !demo || isSuper;
  // IMAP is disabled entirely on the demo (the backend doesn't even register the routes),
  // so drop that step — it applies to the demo super-admin's full wizard too.
  const STEP_META = (fullWizard ? FULL_STEPS : SLIM_STEPS).filter(s => !(demo && s.key === 'imap'));
  const show = !!user?.is_admin && user?.onboarding_done === false;

  const { data: config } = useQuery({ queryKey: ['config'], queryFn: () => api<Record<string, unknown>>('/api/config'), enabled: show });
  const setCfg = useMutation({
    mutationFn: (b: { key: string; value: unknown }) => api(`/api/config/${b.key}`, { method: 'PUT', body: { value: b.value } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['config'] });
      for (const p of ['ollama', 'deepseek', 'anthropic', 'openai', 'searxng']) void qc.invalidateQueries({ queryKey: [`${p}-health`] });
      void qc.invalidateQueries({ queryKey: ['ai-models'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const setTaskAi = useMutation({
    mutationFn: (b: { task: string; provider: string; model: string }) => api(`/api/ai/tasks/${b.task}`, { method: 'PUT', body: { provider: b.provider, model: b.model } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['config'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const saveTask = (task: string, provider: string, model: string) => {
    if (!model) return;   // never save a task without a model (backend rejects it)
    if (task === 'nlanalytics') { setCfg.mutate({ key: 'ai.nlanalytics.provider', value: provider }); setCfg.mutate({ key: 'ai.nlanalytics.model', value: model }); }
    else setTaskAi.mutate({ task, provider, model });
  };

  const { data: family } = useQuery({ queryKey: ['family'], queryFn: () => api<FamilyMember[]>('/api/family'), enabled: show });
  const { data: konten } = useQuery({ queryKey: ['konten-admin'], queryFn: () => api<Konto[]>('/api/admin/konten'), enabled: show });

  const setLang = useMutation({ mutationFn: (l: string) => api('/api/me', { method: 'PATCH', body: { preferred_lang: l } }), onSuccess: () => void refreshUser() });
  const pickLang = (l: string) => { void i18n.changeLanguage(l); setLang.mutate(l); setCfg.mutate({ key: 'app.default_lang', value: l }); };

  const [addr, setAddr] = useState({ street: '', nr: '', plz: '', city: '' });
  const [detailSel, setDetailSel] = useState<string | null>(null);
  // Demo household admins persist address/categories to THEIR household row — NOT the
  // global operator config (which only the full wizard writes).
  const saveProfile = useMutation({
    mutationFn: (b: { address?: string; categories_detail?: string }) => api('/api/onboarding/profile', { method: 'PUT', body: b }),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const saveAddr = (nextA: typeof addr) => fullWizard
    ? setCfg.mutate({ key: 'household.address', value: composeAddr(nextA) })
    : saveProfile.mutate({ address: composeAddr(nextA) });

  const [newFam, setNewFam] = useState({ name: '', emoji: '🙂' });
  const addFam = useMutation({
    mutationFn: () => api('/api/family', { method: 'POST', body: { name: newFam.name.trim(), emoji: newFam.emoji || null } }),
    onSuccess: () => { setNewFam({ name: '', emoji: '🙂' }); void qc.invalidateQueries({ queryKey: ['family'] }); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const delFam = useMutation({ mutationFn: (id: number) => api(`/api/family/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['family'] }) });
  const patchFam = useMutation({ mutationFn: (b: { id: number; body: { name?: string; emoji?: string } }) => api(`/api/family/${b.id}`, { method: 'PATCH', body: b.body }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['family'] }), onError: (e: Error) => toast(e.message, 'error') });

  const invKonten = () => void qc.invalidateQueries({ queryKey: ['konten-admin'] });
  const patchKonto = useMutation({ mutationFn: (b: { id: number; body: Partial<Konto> }) => api(`/api/admin/konten/${b.id}`, { method: 'PATCH', body: b.body }), onSuccess: invKonten, onError: (e: Error) => toast(e.message, 'error') });
  const [newKonto, setNewKonto] = useState({ name: '', is_shared: false, account_type: 'giro' });
  const addKonto = useMutation({
    mutationFn: () => api('/api/admin/konten', { method: 'POST', body: { name: newKonto.name.trim(), is_shared: newKonto.is_shared, account_type: newKonto.account_type } }),
    onSuccess: () => { setNewKonto({ name: '', is_shared: false, account_type: 'giro' }); invKonten(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const delKonto = useMutation({ mutationFn: (id: number) => api(`/api/admin/konten/${id}`, { method: 'DELETE' }), onSuccess: invKonten, onError: (e: Error) => toast(e.message, 'error') });

  const [smtpTo, setSmtpTo] = useState(user?.email ?? '');
  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const smtpTest = useMutation({
    mutationFn: () => api('/api/smtp/test', { method: 'POST', body: { to: smtpTo } }),
    onSuccess: () => setSmtpResult({ ok: true, msg: t('onboarding.email.testOk') }),
    onError: (e: Error) => setSmtpResult({ ok: false, msg: e.message }),
  });

  const finishMut = useMutation({
    // Demo: per-household flag (household.onboarding_done). Off-demo: global config.
    mutationFn: () => demo
      ? api('/api/onboarding/complete', { method: 'POST' })
      : api('/api/config/onboarding.done', { method: 'PUT', body: { value: true } }),
    onSuccess: async () => {
      // Seed the household's Läden list from its address (OSM, best-effort, non-blocking), so
      // offers-by-store have stores to work with before the first receipt is even scanned.
      void api('/api/stores/discover', { method: 'POST' }).catch(() => {});
      await refreshUser();
      navigate('/receipts');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (!show) return null;

  const finish = () => finishMut.mutate();
  const next = () => (step < STEP_META.length - 1 ? setStep(step + 1) : finish());
  const prev = () => step > 0 && setStep(step - 1);
  const cur = STEP_META[step];
  const Icon = cur.icon;

  const addrField = (k: keyof typeof addr, ph: string, cls: string) => (
    <div className={cls}>
      <Label>{t(`onboarding.household.${k}`)}</Label>
      <Input placeholder={ph} value={addr[k]} onChange={e => setAddr(a => ({ ...a, [k]: e.target.value }))} onBlur={() => saveAddr(addr)} />
    </div>
  );
  const cfgInput = (key: string, opts: { password?: boolean; placeholder?: string; type?: string } = {}) => (
    <Input type={opts.type ?? (opts.password ? 'password' : 'text')} autoComplete="off"
      defaultValue={(config?.[key] as string | number) ?? ''} placeholder={opts.placeholder}
      onBlur={e => e.target.value !== String((config?.[key] as string | number) ?? '') && setCfg.mutate({ key, value: opts.type === 'number' ? Number(e.target.value) : e.target.value })} />
  );
  const detail = detailSel ?? ((config?.['categories.detail'] as string) ?? 'mittel');
  const saveDetail = (d: string) => {
    setDetailSel(d);
    if (fullWizard) setCfg.mutate({ key: 'categories.detail', value: d });
    else saveProfile.mutate({ categories_detail: d });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm">
      <div className="relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900">
        {/* First-run wizard: a broken key/model list here is exactly what we want reported,
            but this z-[60] overlay buries both app-wide feedback triggers. */}
        <FeedbackIconButton className="absolute right-3 top-3 z-10" />
        <div className="flex h-24 shrink-0 items-center justify-center bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-950 dark:to-emerald-900">
          {/* The welcome step is a brand moment; the later steps' emojis are functional
              step icons (AI, categories, household) and stay as they are. */}
          {cur.key === 'welcome'
            ? <img src="/icon-192.png" alt="" className="h-16 w-16 rounded-2xl shadow-sm" />
            : <div className="text-5xl">{cur.emoji}</div>}
        </div>

        {demo && !isSuper && (
          <div className="shrink-0 bg-amber-100 px-4 py-2 text-center text-xs font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            {i18n.language.startsWith('de')
              ? '⚠️ Demo — alle Daten dieses Haushalts werden heute um Mitternacht gelöscht.'
              : '⚠️ Demo — all data in this household is deleted tonight at midnight.'}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-6">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-500">
            <Icon size={18} />
            <span className="text-xs font-medium uppercase tracking-wide">{step + 1} / {STEP_META.length}</span>
          </div>
          <h2 className="text-xl font-bold">{t(`onboarding.${cur.key}.title`)}</h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{t(`onboarding.${cur.key}.body`)}</p>

          {cur.key === 'lang' && (
            <div className="flex gap-2">
              {[['de', 'Deutsch'], ['en', 'English']].map(([code, label]) => (
                <button key={code} type="button" onClick={() => pickLang(code)}
                  className={cn('flex-1 rounded-xl border px-4 py-3 text-sm font-medium transition-colors',
                    i18n.language.startsWith(code) ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40' : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700')}>{label}</button>
              ))}
            </div>
          )}

          {cur.key === 'ai' && (
            <div className="flex flex-col gap-3">
              <ProviderRow provider="anthropic" cfgKey="anthropic.api_key" label="Anthropic — API-Key" password placeholder="sk-ant-…" config={config} setCfg={setCfg} t={t} />
              <ProviderRow provider="deepseek" cfgKey="deepseek.api_key" label="DeepSeek — API-Key" password placeholder="sk-…" config={config} setCfg={setCfg} t={t} />
              <ProviderRow provider="openai" cfgKey="openai.api_key" label="OpenAI — API-Key" password placeholder="sk-…" config={config} setCfg={setCfg} t={t} />
              <ProviderRow provider="ollama" cfgKey="ollama.url" label="Ollama — URL" placeholder="http://…:11434" config={config} setCfg={setCfg} t={t} />
              <ProviderRow provider="searxng" cfgKey="searxng.url" label="SearXNG — URL" placeholder="http://…:8089" fallback={demo ? undefined : 'http://searxng:8080'} config={config} setCfg={setCfg} t={t} />
            </div>
          )}

          {cur.key === 'models' && (
            <div className="flex flex-col gap-2">
              {AI_TASKS.map(([task, labelKey]) => (
                <TaskModelRow key={task} task={task} label={t(labelKey)}
                  cfgProvider={(config?.[`ai.${task}.provider`] as string) ?? 'anthropic'}
                  cfgModel={(config?.[`ai.${task}.model`] as string) ?? ''}
                  visionOnly={task === 'ocr'}
                  saveTask={saveTask} />
              ))}
            </div>
          )}

          {cur.key === 'categories' && (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-3 gap-2">
                {DETAILS.map(d => (
                  <button key={d} type="button" onClick={() => saveDetail(d)}
                    className={cn('rounded-xl border px-2 py-3 text-sm font-medium transition-colors',
                      detail === d ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40' : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700')}>
                    {t(`onboarding.categories.${d}`)}
                  </button>
                ))}
              </div>
              <p className="text-xs text-zinc-400">{t('onboarding.categories.hint')}</p>
            </div>
          )}

          {cur.key === 'household' && (
            <div className="grid grid-cols-6 gap-2">
              {addrField('street', t('onboarding.household.streetPh'), 'col-span-4')}
              {addrField('nr', t('onboarding.household.nrPh'), 'col-span-2')}
              {addrField('plz', t('onboarding.household.plzPh'), 'col-span-2')}
              {addrField('city', t('onboarding.household.cityPh'), 'col-span-4')}
            </div>
          )}

          {cur.key === 'family' && (
            <div className="flex flex-col gap-2">
              {(family ?? []).map(m => (
                <div key={m.id} className="flex items-center gap-2">
                  <EmojiSelect value={m.emoji || '🙂'} onChange={e => patchFam.mutate({ id: m.id, body: { emoji: e } })} />
                  <Input className="flex-1" defaultValue={m.name}
                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== m.name) patchFam.mutate({ id: m.id, body: { name: v } }); }} />
                  <button onClick={() => delFam.mutate(m.id)} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Trash2 size={15} /></button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <EmojiSelect value={newFam.emoji} onChange={e => setNewFam(v => ({ ...v, emoji: e }))} />
                <Input className="flex-1" placeholder={t('onboarding.family.namePlaceholder')} value={newFam.name}
                  onChange={e => setNewFam(v => ({ ...v, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && newFam.name.trim()) addFam.mutate(); }} />
                <Button className="shrink-0" disabled={!newFam.name.trim() || addFam.isPending} onClick={() => addFam.mutate()}><Plus size={16} /></Button>
              </div>
            </div>
          )}

          {cur.key === 'konten' && (
            <div className="flex flex-col gap-2">
              {(konten ?? []).map(k => (
                <div key={k.id} className="flex items-center gap-2">
                  <Input className="flex-1" defaultValue={k.name}
                    onBlur={e => e.target.value.trim() && e.target.value !== k.name && patchKonto.mutate({ id: k.id, body: { name: e.target.value.trim() } })} />
                  <Select className="w-32" value={k.account_type} onChange={e => patchKonto.mutate({ id: k.id, body: { account_type: e.target.value } })}>
                    {KONTO_TYPES.map(ty => <option key={ty} value={ty}>{t(`accountTypes.${ty}`)}</option>)}
                  </Select>
                  {k.is_shared
                    ? <span className="w-8 shrink-0 text-center text-xs text-emerald-600" title={t('onboarding.konten.shared')}>🏠</span>
                    : <button onClick={() => delKonto.mutate(k.id)} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Trash2 size={15} /></button>}
                </div>
              ))}
              <div className="mt-1 flex items-center gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                <Input className="flex-1" placeholder={t('onboarding.konten.namePlaceholder')} value={newKonto.name}
                  onChange={e => setNewKonto(v => ({ ...v, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && newKonto.name.trim()) addKonto.mutate(); }} />
                <Select className="w-32" value={newKonto.account_type} onChange={e => setNewKonto(v => ({ ...v, account_type: e.target.value }))}>
                  {KONTO_TYPES.map(ty => <option key={ty} value={ty}>{t(`accountTypes.${ty}`)}</option>)}
                </Select>
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-500"><Switch checked={newKonto.is_shared} onChange={v => setNewKonto(s => ({ ...s, is_shared: v }))} />{t('onboarding.konten.shared')}</label>
                <Button className="shrink-0" disabled={!newKonto.name.trim() || addKonto.isPending} onClick={() => addKonto.mutate()}><Plus size={16} /></Button>
              </div>
            </div>
          )}

          {cur.key === 'email' && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-6 gap-2">
              <div className="col-span-4"><Label>{t('onboarding.email.host')}</Label>{cfgInput('smtp.host', { placeholder: 'smtp.gmail.com' })}</div>
              <div className="col-span-2"><Label>{t('onboarding.email.port')}</Label>{cfgInput('smtp.port', { type: 'number', placeholder: '587' })}</div>
              <div className="col-span-3"><Label>{t('onboarding.email.user')}</Label>{cfgInput('smtp.user')}</div>
              <div className="col-span-3"><Label>{t('onboarding.email.pass')}</Label>{cfgInput('smtp.pass', { password: true })}</div>
              <div className="col-span-6"><Label>{t('onboarding.email.from')}</Label>{cfgInput('smtp.from', { placeholder: 'VDS <vds@haushalt.de>' })}</div>
              <label className="col-span-6 flex items-center gap-2 text-sm text-zinc-500"><Switch checked={!!config?.['smtp.secure']} onChange={v => setCfg.mutate({ key: 'smtp.secure', value: v })} />{t('onboarding.email.secure')}</label>
              <div className="col-span-4"><Label>{t('onboarding.email.to')}</Label><Input type="email" value={smtpTo} onChange={e => setSmtpTo(e.target.value)} placeholder="test@…" /></div>
              <div className="col-span-2 flex items-end"><Button variant="secondary" className="w-full justify-center" disabled={!smtpTo || smtpTest.isPending} onClick={() => { setSmtpResult(null); smtpTest.mutate(); }}>{t('onboarding.email.test')}</Button></div>
              {smtpResult && <p className={cn('col-span-6 text-xs font-medium', smtpResult.ok ? 'text-emerald-600' : 'text-red-500')}>{smtpResult.ok ? '● ' : '● '}{smtpResult.msg}</p>}
              </div>
              <SmtpHelp />
            </div>
          )}

          {cur.key === 'imap' && <ImapStep t={t} />}

          <div className="flex justify-center gap-1.5 pt-2">
            {STEP_META.map((_, i) => (
              <button key={i} onClick={() => setStep(i)}
                className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-emerald-600' : 'w-1.5 bg-zinc-300 dark:bg-zinc-700')}
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

/** A provider credential field with a live green/red reachability indicator + colored border. */
function ProviderRow({ provider, cfgKey, label, config, setCfg, password, placeholder, fallback, t }: {
  provider: string; cfgKey: string; label: string; config: Record<string, unknown> | undefined;
  setCfg: { mutate: (b: { key: string; value: unknown }) => void }; password?: boolean; placeholder?: string; fallback?: string; t: TFunction;
}) {
  const { data, isLoading } = useQuery({
    queryKey: [`${provider}-health`],
    queryFn: () => provider === 'searxng' ? api<{ ok: boolean; error?: string }>('/api/searxng/health') : api<{ ok: boolean; error?: string }>(`/api/ai/health?provider=${provider}`),
    retry: false, refetchInterval: 60_000,
  });
  const state = isLoading || !data ? 'unknown' : data.ok ? 'ok' : 'down';
  const border = state === 'ok' ? '!border-emerald-400 focus:!border-emerald-500' : state === 'down' ? '!border-red-400 focus:!border-red-500' : '';
  const tone = state === 'ok' ? 'text-emerald-600' : state === 'down' ? 'text-red-500' : 'text-zinc-400';
  const dot = state === 'ok' ? 'bg-emerald-500' : state === 'down' ? 'bg-red-500' : 'bg-zinc-400';
  const saved = String(config?.[cfgKey] ?? '');
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <Label className="mb-0">{label}</Label>
        <span title={data?.error ?? ''} className={cn('flex shrink-0 items-center gap-1 text-[11px] font-medium', tone)}>
          <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
          {state === 'ok' ? t('onboarding.ai.reachable') : state === 'down' ? t('onboarding.ai.unreachable') : '…'}
        </span>
      </div>
      <Input type={password ? 'password' : 'text'} autoComplete="off" className={border}
        defaultValue={saved || fallback || ''} placeholder={placeholder}
        onBlur={e => e.target.value !== saved && setCfg.mutate({ key: cfgKey, value: e.target.value })} />
    </div>
  );
}

/** One AI task's provider + model selector. Provider/model are derived from config (props)
 *  each render, so an external config change reflects immediately. Model options are the
 *  selected provider's real models only (fetched live); OCR is locked to Anthropic + the
 *  vision-only list. Switching provider fetches the NEW provider's models and persists its
 *  first model atomically, so no cross-provider model (e.g. qwen under Anthropic) survives. */
function TaskModelRow({ task, label, cfgProvider, cfgModel, saveTask, visionOnly }: {
  task: string; label: string; cfgProvider: string; cfgModel: string; saveTask: (task: string, provider: string, model: string) => void; visionOnly?: boolean;
}) {
  const provider = cfgProvider || (visionOnly ? 'anthropic' : 'ollama');
  const model = cfgModel;
  const { data, isFetching } = useQuery({
    queryKey: ['ai-models', provider, visionOnly ? 'vision' : 'all'],
    queryFn: () => api<{ models: string[] }>(`/api/ai/models?provider=${provider}${visionOnly ? '&vision=1' : ''}`).then(r => r.models),
    retry: false, staleTime: 60_000,
  });
  const models = data ?? [];
  // Switching provider must not keep the old provider's model: fetch the new provider's
  // list and persist its first model in one write (fall back to the current model only if
  // the new provider serves none).
  const onProvider = async (p: string) => {
    try {
      const list = await api<{ models: string[] }>(`/api/ai/models?provider=${p}${visionOnly ? '&vision=1' : ''}`).then(r => r.models);
      saveTask(task, p, list[0] ?? model);
    } catch { saveTask(task, p, model); }
  };
  const onModel = (m: string) => saveTask(task, provider, m);
  const opts = model && !models.includes(model) ? [model, ...models] : models;   // keep the current/legacy model visible + selectable
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 break-words text-xs font-medium leading-tight text-zinc-600 dark:text-zinc-300" title={label}>{label}</span>
      <Select className="w-24 shrink-0" value={provider} onChange={e => onProvider(e.target.value)}>
        {(visionOnly ? ['anthropic', 'ollama'] : PROVIDERS).map(p => <option key={p} value={p}>{p}</option>)}
      </Select>
      {isFetching ? <Input className="min-w-0 flex-1" value="…" disabled />
        : opts.length ? (
          <Select className="min-w-0 flex-1" value={model} onChange={e => onModel(e.target.value)}>
            {!model && <option value="">—</option>}
            {opts.map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
        ) : (
          <Input className="min-w-0 flex-1" defaultValue={model} placeholder="Modell" onBlur={e => e.target.value !== model && onModel(e.target.value)} />
        )}
    </div>
  );
}

/** The admin's own IMAP mailbox for automatic e-mail receipt import (optional), with a live Test. */
function ImapStep({ t }: { t: TFunction }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['mailbox'], queryFn: () => api<{ configured: boolean; imap_host?: string; imap_port?: number; imap_secure?: boolean; imap_user?: string; folder?: string; enabled?: boolean }>('/api/me/mailbox') });
  const [f, setF] = useState({ imap_host: '', imap_port: 993, imap_secure: true, imap_user: '', imap_pass: '', folder: 'INBOX', enabled: true });
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  useEffect(() => {
    if (data?.configured) setF(v => ({ ...v, imap_host: data.imap_host ?? '', imap_port: data.imap_port ?? 993, imap_secure: data.imap_secure !== false, imap_user: data.imap_user ?? '', folder: data.folder ?? 'INBOX', enabled: data.enabled !== false }));
  }, [data]);
  const save = useMutation({ mutationFn: () => api('/api/me/mailbox', { method: 'PUT', body: f }), onSuccess: () => { toast(t('onboarding.imap.saved'), 'success'); void qc.invalidateQueries({ queryKey: ['mailbox'] }); }, onError: (e: Error) => toast(e.message, 'error') });
  const test = useMutation({
    mutationFn: () => api<{ ok?: boolean; error?: string }>('/api/me/mailbox/test', { method: 'POST', body: f }),
    onSuccess: (r) => setResult({ ok: !!r.ok, msg: r.ok ? t('onboarding.imap.testOk') : (r.error ?? 'error') }),
    onError: (e: Error) => setResult({ ok: false, msg: e.message }),
  });
  return (
    <div className="grid grid-cols-6 gap-2">
      <div className="col-span-4"><Label>{t('onboarding.imap.host')}</Label><Input placeholder="imap.gmail.com" value={f.imap_host} onChange={e => setF(s => ({ ...s, imap_host: e.target.value }))} /></div>
      <div className="col-span-2"><Label>{t('onboarding.imap.port')}</Label><Input type="number" value={f.imap_port} onChange={e => setF(s => ({ ...s, imap_port: Number(e.target.value) || 993 }))} /></div>
      <div className="col-span-3"><Label>{t('onboarding.imap.user')}</Label><Input autoComplete="off" value={f.imap_user} onChange={e => setF(s => ({ ...s, imap_user: e.target.value }))} /></div>
      <div className="col-span-3"><Label>{t('onboarding.imap.pass')}</Label><Input type="password" autoComplete="off" placeholder={data?.configured ? '••••••' : ''} value={f.imap_pass} onChange={e => setF(s => ({ ...s, imap_pass: e.target.value }))} /></div>
      <label className="col-span-6 flex items-center gap-2 text-sm text-zinc-500"><Switch checked={f.imap_secure} onChange={v => setF(s => ({ ...s, imap_secure: v }))} />{t('onboarding.imap.secure')}</label>
      <div className="col-span-6 flex gap-2">
        <Button variant="secondary" className="flex-1 justify-center" disabled={!f.imap_host || !f.imap_user || test.isPending} onClick={() => { setResult(null); test.mutate(); }}>{t('onboarding.imap.test')}</Button>
        <Button className="flex-1 justify-center" disabled={!f.imap_host || !f.imap_user || save.isPending} onClick={() => save.mutate()}>{t('onboarding.imap.save')}</Button>
      </div>
      {result && <p className={cn('col-span-6 text-xs font-medium', result.ok ? 'text-emerald-600' : 'text-red-500')}>● {result.msg}</p>}
      <div className="col-span-6"><ImapHelp /></div>
    </div>
  );
}
