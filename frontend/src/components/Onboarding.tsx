import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Bot, Globe, Tags, Home, Users, Wallet, Mail, Inbox, PartyPopper, Languages, Plus, Trash2, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { api } from '../api/client';
import { Button, Input, Select, Label, Switch, Modal, FeedbackIconButton } from './ui';
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
const AI_PROVIDERS = [
  { id: 'openai', label: 'ChatGPT', sub: 'OpenAI', cfgKey: 'openai.api_key' },
  { id: 'anthropic', label: 'Claude', sub: 'Anthropic', cfgKey: 'anthropic.api_key' },
  { id: 'ollama', label: 'Ollama', sub: 'lokal', cfgKey: 'ollama.url' },
] as const;
type AiProviderId = typeof AI_PROVIDERS[number]['id'];

// Full wizard = the single-household admin (off-demo) OR the demo platform super-admin
// (operator): sets up AI, mail, accounts, …
const FULL_STEPS = [
  { icon: Languages, emoji: '🌍', key: 'lang' },
  { icon: Sparkles, emoji: '👋', key: 'welcome' },
  { icon: Bot, emoji: '🤖', key: 'ai' },
  { icon: Globe, emoji: '🔎', key: 'websearch' },
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
      for (const p of ['ollama', 'deepseek', 'anthropic', 'openai']) void qc.invalidateQueries({ queryKey: [`${p}-health`] });
      void qc.invalidateQueries({ queryKey: ['ai-models'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

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
  // ⚠️ A step may hold unsaved input behind its own Save button. "Weiter" used to just advance,
  // so choosing Ollama in the AI step and pressing Weiter — the obvious thing to do — wrote
  // NOTHING, and the instance silently kept its mixed defaults (some tasks on Anthropic without
  // an API key). A step can register a commit here; it returns false to keep the wizard put when
  // the input cannot be saved yet, so the reason is visible instead of the choice being dropped.
  const commit = useRef<null | (() => Promise<boolean>)>(null);
  const next = async () => {
    if (commit.current && !(await commit.current())) return;
    if (step < STEP_META.length - 1) setStep(step + 1); else finish();
  };
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

          {cur.key === 'ai' && <AiSetup config={config} t={t} registerCommit={fn => { commit.current = fn; }} />}

          {cur.key === 'websearch' && <SearxSetup config={config} t={t} registerCommit={fn => { commit.current = fn; }} />}

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

/** Onboarding one-click AI setup (father-simplification, FB-01): pick ONE provider —
 *  ChatGPT / Claude / Ollama — and enter its credential inline in the SAME step (no card
 *  switch). OpenAI + Anthropic auto-pick a good model for every task (text AND vision/OCR),
 *  so there is no second "models" step; Ollama additionally asks for the image-recognition
 *  model + the model for everything else. Saving points ALL tasks at that provider via
 *  /api/onboarding/ai-quickset, then re-checks the provider's health so the green
 *  "Verbindung erfolgreich" appears immediately — no click in/out needed. DeepSeek +
 *  per-task mix-and-match live in the admin area only. */
function AiSetup({ config, t, registerCommit }: { config: Record<string, unknown> | undefined; t: TFunction; registerCommit: (fn: null | (() => Promise<boolean>)) => void }) {
  const qc = useQueryClient();
  // Pre-select the provider whose credential is already stored (re-visiting the step).
  const savedProvider = AI_PROVIDERS.find(p => String(config?.[p.cfgKey] ?? '').trim())?.id;
  const [chosen, setChosen] = useState<AiProviderId | null>(savedProvider ?? null);
  const [apiKey, setApiKey] = useState('');
  const [url, setUrl] = useState(String(config?.['ollama.url'] ?? ''));
  // ⚠️ Seed from the stored model ONLY when the stored provider is Ollama. Reading ai.ocr.model
  // unconditionally is what put `claude-sonnet-5` — the CLOUD default — into the local-Ollama
  // field. Revisiting the step must show what you saved; a fresh setup starts empty and gets
  // filled once the instance tells us what it actually has.
  const ollamaWasChosen = (k: string) => config?.[k] === 'ollama';
  const [ocrModel, setOcrModel] = useState(ollamaWasChosen('ai.ocr.provider') ? String(config?.['ai.ocr.model'] ?? '') : '');
  const [kiModel, setKiModel] = useState(ollamaWasChosen('ai.recategorize.provider') ? String(config?.['ai.recategorize.model'] ?? '') : '');
  const [saving, setSaving] = useState(false);
  const [keyHelp, setKeyHelp] = useState(false);
  // Show the health line after a successful save (or immediately for an already-set provider).
  const [confirmed, setConfirmed] = useState(!!savedProvider);
  // What the BACKEND currently knows as ollama.url — it probes the stored value, so the typed
  // URL has to be persisted before "is it reachable?" can mean anything.
  const [urlSaved, setUrlSaved] = useState(String(config?.['ollama.url'] ?? '').trim());

  // Push the typed URL into config, debounced: one write per pause, not one per keystroke.
  useEffect(() => {
    if (chosen !== 'ollama') return;
    const v = url.trim();
    if (v === urlSaved) return;
    const id = setTimeout(() => {
      void api(`/api/config/ollama.url`, { method: 'PUT', body: { value: v } })
        .then(() => setUrlSaved(v))
        .catch(() => { /* a typo simply stays unreachable */ });
    }, 700);
    return () => clearTimeout(id);
  }, [url, urlSaved, chosen]);

  // Live reachability of the Ollama socket — drives the red/green field, before any saving.
  const ollamaHealth = useQuery({
    queryKey: ['ollama-health', urlSaved],
    queryFn: () => api<{ ok: boolean; error?: string }>('/api/ai/health?provider=ollama'),
    enabled: chosen === 'ollama' && !!urlSaved,
    retry: false, refetchInterval: 15_000,
  });
  const ollamaUp = ollamaHealth.data?.ok === true;

  // Only once it answers do we ask what it has. The backend also tells us which models can read
  // images (local rules first, best-effort web lookup for the rest) and what we would recommend.
  const ollamaModels = useQuery({
    queryKey: ['ollama-models', urlSaved],
    queryFn: () => api<{
      models: { name: string; vision: boolean; source: 'known' | 'web' }[];
      recommended: { ocr: string | null; text: string | null; ocrWanted: string; textWanted: string };
    }>('/api/onboarding/ollama-models'),
    enabled: chosen === 'ollama' && ollamaUp,
    retry: false, staleTime: 60_000,
  });

  // Prefill with OUR pick — but only if they actually have it pulled; otherwise leave it empty
  // rather than proposing a model that would fail on first use. Never overwrites a manual choice.
  useEffect(() => {
    const r = ollamaModels.data?.recommended;
    if (!r) return;
    setOcrModel(prev => prev || r.ocr || '');
    setKiModel(prev => prev || r.text || '');
  }, [ollamaModels.data]);

  // The chosen provider's health drives the green check. It refetches after save (we invalidate
  // its key), so the indicator flips to green as soon as the just-saved credential verifies —
  // this is the fix for "grün greift nicht sofort".
  const { data: health, isFetching: healthLoading } = useQuery({
    queryKey: [`${chosen}-health`],
    queryFn: () => api<{ ok: boolean; error?: string }>(`/api/ai/health?provider=${chosen}`),
    enabled: !!chosen && confirmed,
    retry: false, refetchInterval: 60_000,
  });

  const pick = (id: AiProviderId) => { setChosen(id); setConfirmed(false); setApiKey(''); };
  // Ollama can only be saved once the instance actually answered — otherwise we would store
  // model names nobody has verified against a machine that may not exist.
  const canSave = chosen === 'ollama'
    ? !!(ollamaUp && ocrModel.trim() && kiModel.trim())
    : !!apiKey.trim();

  const save = async () => {
    if (!chosen || !canSave) return false;
    setSaving(true);
    try {
      const body = chosen === 'ollama'
        ? { provider: 'ollama', url: url.trim(), ocr_model: ocrModel.trim(), ki_model: kiModel.trim() }
        : { provider: chosen, api_key: apiKey.trim() };
      await api('/api/onboarding/ai-quickset', { method: 'POST', body });
      setConfirmed(true);
      await qc.invalidateQueries({ queryKey: ['config'] });
      await qc.invalidateQueries({ queryKey: [`${chosen}-health`] });
      toast(t('onboarding.ai.saved'), 'success');
      return true;
    } catch (e) {
      toast((e as Error).message || t('common.error'), 'error');
      return false;
    } finally { setSaving(false); }
  };

  // "Weiter" saves this step. Nobody should have to notice that the choice they just made needs a
  // second, separate click to survive — that is exactly how an instance ended up with Ollama
  // picked in the wizard and half its tasks still pointing at Anthropic. Nothing chosen → the step
  // is genuinely optional and we move on; chosen but not yet saveable → stay put and say why,
  // rather than dropping the input on the floor.
  useEffect(() => {
    registerCommit(async () => {
      if (!chosen || confirmed) return true;
      if (!canSave) {
        toast(chosen === 'ollama' ? t('onboarding.ai.needOllama') : t('onboarding.ai.needKey'), 'error');
        return false;
      }
      return await save();
    });
    return () => registerCommit(null);
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{t('onboarding.ai.pickQuestion')}</p>
      <div className="grid grid-cols-3 gap-2">
        {AI_PROVIDERS.map(p => (
          <button key={p.id} type="button" onClick={() => pick(p.id)}
            className={cn('flex flex-col items-center gap-0.5 rounded-xl border-2 px-2 py-3 text-center transition-colors',
              chosen === p.id
                ? 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                : 'border-zinc-200 text-zinc-700 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-200')}>
            <span className="text-sm font-semibold">{p.label}</span>
            <span className="text-[10px] font-normal text-zinc-400">{p.id === 'ollama' ? t('onboarding.ai.localSub') : p.sub}</span>
          </button>
        ))}
      </div>

      {chosen && chosen !== 'ollama' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="mb-0">{t('onboarding.ai.keyLabel', { name: chosen === 'openai' ? 'ChatGPT' : 'Claude' })}</Label>
            {/* Nobody arrives at this field already owning an API key — say where to get one. */}
            <button type="button" onClick={() => setKeyHelp(true)}
              className="shrink-0 text-[11px] font-medium text-emerald-600 underline hover:text-emerald-700 dark:text-emerald-400">
              {t('onboarding.ai.keyHelpOpen')}
            </button>
          </div>
          <Input type="password" autoComplete="off" placeholder={chosen === 'openai' ? 'sk-…' : 'sk-ant-…'}
            value={apiKey} onChange={e => { setApiKey(e.target.value); setConfirmed(false); }} />
          <p className="text-[11px] leading-relaxed text-zinc-400">{t('onboarding.ai.keyHint', { name: chosen === 'openai' ? 'OpenAI' : 'Anthropic' })}</p>
        </div>
      )}

      {keyHelp && chosen && chosen !== 'ollama' && (
        <Modal open onClose={() => setKeyHelp(false)} title={t('onboarding.ai.keyHelpTitle', { name: chosen === 'openai' ? 'ChatGPT' : 'Claude' })}>
          <div className="flex flex-col gap-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            <p>{t('onboarding.ai.keyHelpIntro')}</p>
            <ol className="ml-4 list-decimal space-y-2">
              <li>
                {t('onboarding.ai.keyHelpStep1')}{' '}
                <a href={chosen === 'openai' ? 'https://platform.openai.com/api-keys' : 'https://console.anthropic.com/settings/keys'}
                  target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-emerald-600 underline dark:text-emerald-400">
                  {chosen === 'openai' ? 'platform.openai.com' : 'console.anthropic.com'} <ExternalLink size={11} />
                </a>
              </li>
              <li>{t('onboarding.ai.keyHelpStep2')}</li>
              <li>{t('onboarding.ai.keyHelpStep3')}</li>
              <li>{t('onboarding.ai.keyHelpStep4')}</li>
            </ol>
            <p className="rounded-lg bg-zinc-100 p-2.5 text-xs dark:bg-zinc-800">{t('onboarding.ai.keyHelpCost')}</p>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setKeyHelp(false)}>{t('common.close')}</Button>
            </div>
          </div>
        </Modal>
      )}

      {chosen === 'ollama' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <Label className="mb-0">{t('onboarding.ai.ollamaUrl')}</Label>
              {!!urlSaved && (
                <span title={ollamaHealth.data?.error ?? ''} className={cn('flex shrink-0 items-center gap-1 text-[11px] font-medium',
                  ollamaHealth.isFetching && !ollamaHealth.data ? 'text-zinc-400' : ollamaUp ? 'text-emerald-600' : 'text-red-500')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full',
                    ollamaHealth.isFetching && !ollamaHealth.data ? 'bg-zinc-400' : ollamaUp ? 'bg-emerald-500' : 'bg-red-500')} />
                  {ollamaHealth.isFetching && !ollamaHealth.data ? t('onboarding.ai.checking')
                    : ollamaUp ? t('onboarding.ai.reachable') : t('onboarding.ai.unreachable')}
                </span>
              )}
            </div>
            {/* Red until it answers, green once it does — the field itself carries the verdict. */}
            <Input type="text" autoComplete="off" placeholder="http://…:11434" value={url}
              className={!urlSaved ? '' : ollamaUp ? '!border-emerald-400 focus:!border-emerald-500' : '!border-red-400 focus:!border-red-500'}
              onChange={e => { setUrl(e.target.value); setConfirmed(false); }} />
          </div>

          {ollamaUp && (
            <>
              {/* What WE would run. Named even when they don't have it — so they know what to pull. */}
              <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <p className="font-semibold">{t('onboarding.ai.recTitle')}</p>
                <p className="mt-1">
                  {t('onboarding.ai.recOcr')} <code className="font-mono font-semibold">{ollamaModels.data?.recommended.ocrWanted ?? 'mistral-small3.2'}</code>
                  {' · '}
                  {t('onboarding.ai.recText')} <code className="font-mono font-semibold">{ollamaModels.data?.recommended.textWanted ?? 'qwen2.5:14b'}</code>
                </p>
                {ollamaModels.data && !ollamaModels.data.recommended.ocr && (
                  <p className="mt-1.5">{t('onboarding.ai.recMissing', { model: ollamaModels.data.recommended.ocrWanted })}</p>
                )}
              </div>

              <ModelPick label={t('onboarding.ai.ocrModel')} value={ocrModel} onChange={v => { setOcrModel(v); setConfirmed(false); }}
                models={ollamaModels.data?.models ?? []} loading={ollamaModels.isFetching} visionOnlyHint t={t} />
              <ModelPick label={t('onboarding.ai.kiModel')} value={kiModel} onChange={v => { setKiModel(v); setConfirmed(false); }}
                models={ollamaModels.data?.models ?? []} loading={ollamaModels.isFetching} t={t} />
            </>
          )}
        </div>
      )}

      {chosen && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={save} disabled={!canSave || saving}>{saving ? '…' : t('onboarding.ai.save')}</Button>
          {confirmed && (
            <span title={health?.error ?? ''} className={cn('flex items-center gap-1.5 text-xs font-medium',
              healthLoading || !health ? 'text-zinc-400' : health.ok ? 'text-emerald-600' : 'text-red-500')}>
              <span className={cn('h-1.5 w-1.5 rounded-full',
                healthLoading || !health ? 'bg-zinc-400' : health.ok ? 'bg-emerald-500' : 'bg-red-500')} />
              {healthLoading || !health ? t('onboarding.ai.checking') : health.ok ? t('onboarding.ai.reachable') : (health.error || t('onboarding.ai.unreachable'))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** One model field for the Ollama setup: pick from what the instance actually serves (so a typo
 *  can't reach the save), with a free-text fallback while the list is still loading or if the
 *  household runs something we didn't get back. Models that can read images are marked — picking
 *  a text-only model for receipt scanning is the one mistake worth preventing here. */
function ModelPick({ label, value, onChange, models, loading, visionOnlyHint, t }: {
  label: string; value: string; onChange: (v: string) => void;
  models: { name: string; vision: boolean; source: 'known' | 'web' }[];
  loading: boolean; visionOnlyHint?: boolean; t: TFunction;
}) {
  const chosenModel = models.find(m => m.name === value);
  // A picked model that the instance no longer lists stays selectable, so an existing setup is
  // never silently rewritten by this dropdown.
  const options = value && !chosenModel ? [{ name: value, vision: false, source: 'known' as const }, ...models] : models;
  const warnNoVision = !!visionOnlyHint && !!chosenModel && !chosenModel.vision;
  return (
    <div className="flex flex-col gap-1">
      <Label className="mb-0">{label}</Label>
      {loading && !models.length ? (
        <Input value="…" disabled />
      ) : options.length ? (
        <Select value={value} onChange={e => onChange(e.target.value)}>
          <option value="">{t('onboarding.ai.modelPick')}</option>
          {options.map(m => (
            <option key={m.name} value={m.name}>
              {m.name}{m.vision ? ` — ${t('onboarding.ai.canVision')}${m.source === 'web' ? '?' : ''}` : ''}
            </option>
          ))}
        </Select>
      ) : (
        <Input type="text" autoComplete="off" value={value} onChange={e => onChange(e.target.value)} placeholder="z. B. qwen2.5:14b" />
      )}
      {warnNoVision && <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">{t('onboarding.ai.notVision')}</p>}
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

/** Web search (SearXNG). VDS uses it to find shop leaflets, product pictures and — during this very
 *  wizard — whether a local model can read images. Without it those features are simply blank, which
 *  is worse than being asked one question here: an instance shipped with an empty `searxng.url` and
 *  nothing ever said so. Optional on purpose: a household with no instance must still get through
 *  the wizard, so we explain what stays dark rather than blocking. */
function SearxSetup({ config, t, registerCommit }: { config: Record<string, unknown> | undefined; t: TFunction; registerCommit: (fn: null | (() => Promise<boolean>)) => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(String(config?.['searxng.url'] ?? ''));
  const [saving, setSaving] = useState(false);
  const trimmed = url.trim().replace(/\/$/, '');

  const persist = async (value: string) => {
    await api('/api/config/searxng.url', { method: 'PUT', body: { value } });
    await qc.invalidateQueries({ queryKey: ['config'] });
    await qc.invalidateQueries({ queryKey: ['searxng-health'] });
  };

  // The health probe runs in the BACKEND, so it can only test what the backend has stored — hence
  // the debounced save while typing, same as the Ollama field.
  useEffect(() => {
    if (trimmed === String(config?.['searxng.url'] ?? '')) return;
    const id = setTimeout(() => { void persist(trimmed).catch(() => {}); }, 700);
    return () => clearTimeout(id);
  }, [trimmed]);

  const { data: health, isFetching } = useQuery({
    queryKey: ['searxng-health', trimmed],
    queryFn: () => api<{ ok: boolean; error?: string }>('/api/searxng/health'),
    enabled: !!trimmed,
    retry: false,
  });
  const up = !!health?.ok;

  useEffect(() => {
    registerCommit(async () => {
      setSaving(true);
      try { await persist(trimmed); } catch { /* a wizard step must not trap the user */ }
      finally { setSaving(false); }
      return true;
    });
    return () => registerCommit(null);
  });

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label>{t('onboarding.websearch.field')}</Label>
        <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://192.168.1.10:8080" autoComplete="off"
          className={cn(trimmed && (up ? 'border-emerald-500 focus:border-emerald-500' : 'border-red-500 focus:border-red-500'))} />
        {trimmed && (
          <p className={cn('mt-1 text-xs', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
            {isFetching ? t('onboarding.websearch.checking') : up ? t('onboarding.websearch.ok') : t('onboarding.websearch.bad')}
          </p>
        )}
        {saving && <p className="mt-1 text-xs text-zinc-400">…</p>}
      </div>
      <p className="rounded-xl border-2 border-orange-300 bg-orange-50 p-3 text-xs leading-relaxed text-orange-900 dark:border-orange-700/60 dark:bg-orange-950/30 dark:text-orange-200">
        {t('onboarding.websearch.without')}
      </p>
    </div>
  );
}
