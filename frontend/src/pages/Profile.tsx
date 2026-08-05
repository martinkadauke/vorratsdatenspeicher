import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LogOut, Sparkles, Inbox, Bell, ChevronDown, ChevronRight, Paperclip, Undo2, Mail } from 'lucide-react';
import { api } from '../api/client';
import { MailForwardHelp } from '../components/MailForwardHelp';
import { useAuth } from '../context/auth';
import { setLanguage } from '../i18n';
import { pushSupported, pushStatus, enablePush, disablePush } from '../lib/push';
import { Card, Button, Input, Label, Select, Switch, Modal } from '../components/ui';
import { RefundReconcileDialog } from '../components/RefundReconcileDialog';
import { RefundMailModal, type RefundMailItem } from '../components/RefundMailModal';
import type { RefundCandidate, RefundBookPayload } from '../api/types';
import { AppVersion } from '../components/AppVersion';
import { cn } from '../lib/utils';
import { EmojiPicker } from '../components/EmojiPicker';
import { confirm } from '../components/Confirm';
import { toast } from '../components/Toast';

export function Profile() {
  const { t } = useTranslation();
  const { user, logout, refreshUser, demo } = useAuth();
  const navigate = useNavigate();
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwSaved, setPwSaved] = useState(false);

  // E-mail-forwarding tutorial. Opens from ?help=mailforward (the 7th-of-month reminder's
  // deep-link) or the Help card button; "nicht mehr anzeigen" persists has_seen_email_tutorial.
  const [searchParams, setSearchParams] = useSearchParams();
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    if (searchParams.get('help') === 'mailforward') setHelpOpen(true);
  }, [searchParams]);
  const closeHelp = () => {
    setHelpOpen(false);
    if (searchParams.get('help')) {
      const p = new URLSearchParams(searchParams);
      p.delete('help');
      setSearchParams(p, { replace: true });
    }
  };

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/me', { method: 'PATCH', body }),
    onSuccess: () => void refreshUser(),
  });

  const changePw = useMutation({
    mutationFn: () => api('/api/me', { method: 'PATCH', body: { old_password: oldPw, password: newPw } }),
    onSuccess: () => { setOldPw(''); setNewPw(''); setPwSaved(true); setTimeout(() => setPwSaved(false), 3000); },
  });

  if (!user) return null;

  return (
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-lg font-bold">{t('profile.title')}</h1>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
            {user.emoji ? <span aria-hidden>{user.emoji}</span> : user.username[0]?.toUpperCase()}
          </div>
          <div>
            <div className="font-semibold">{user.username}</div>
            {user.is_admin && <div className="text-xs text-emerald-600 dark:text-emerald-500">Admin</div>}
          </div>
        </div>

        <div>
          <Label>{t('profile.emoji')}</Label>
          <EmojiPicker value={user.emoji} onChange={e => patch.mutate({ emoji: e })} />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t('profile.darkMode')}</span>
          <Switch
            checked={user.prefers_dark}
            onChange={v => {
              document.documentElement.classList.toggle('dark', v);
              patch.mutate({ prefers_dark: v });
            }}
          />
        </div>

        <div>
          <Label>{t('profile.language')}</Label>
          <Select
            value={user.preferred_lang}
            onChange={e => {
              setLanguage(e.target.value);
              patch.mutate({ preferred_lang: e.target.value });
            }}
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </Select>
        </div>
      </Card>

      <PushSettings />

      {/* No mailbox/IMAP on the public demo — the backend doesn't register those routes there,
          and nobody should type real e-mail credentials into a throwaway demo household. */}
      {!demo && <MailboxSettings />}

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">{t('profile.changePw')}</h2>
        <div>
          <Label>{t('profile.oldPw')}</Label>
          <Input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} />
        </div>
        <div>
          <Label>{t('profile.newPw')}</Label>
          <Input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} />
        </div>
        {changePw.isError && <p className="text-sm text-red-500">{(changePw.error as Error).message}</p>}
        {pwSaved && <p className="text-sm text-emerald-600">{t('profile.saved')}</p>}
        <Button onClick={() => changePw.mutate()} disabled={!oldPw || !newPw || changePw.isPending}>
          {t('common.save')}
        </Button>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">{t('profile.helpHeading')}</h2>
        <Button
          variant="secondary"
          onClick={() => window.dispatchEvent(new Event('vds:open-tour'))}
        >
          <Sparkles size={14} /> {t('profile.replayTour')}
        </Button>
        {!demo && (
          <Button variant="secondary" onClick={() => setHelpOpen(true)}>
            <Mail size={14} /> {t('mailForward.openButton')}
          </Button>
        )}
      </Card>

      <Button variant="secondary" onClick={() => { logout(); navigate('/login'); }}>
        <LogOut size={16} /> {t('nav.logout')}
      </Button>

      <AppVersion className="pt-1 text-center text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-600" />

      <Modal open={helpOpen} onClose={closeHelp} title={t('mailForward.title')} wide>
        <MailForwardHelp />
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            onClick={() => { patch.mutate({ has_seen_email_tutorial: true }); closeHelp(); }}
          >
            {t('mailForward.dontShowAgain')}
          </button>
          <Button variant="secondary" onClick={closeHelp}>{t('mailForward.close')}</Button>
        </div>
      </Modal>
    </div>
  );
}

/** Web Push opt-in (browser notifications) for offers + shared shopping lists. */
function PushSettings() {
  const { t } = useTranslation();
  const supported = pushSupported();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  useEffect(() => { void pushStatus().then(setOn).catch(() => { /* ignore */ }); }, []);

  const toggle = async (v: boolean) => {
    if (busy) return;
    setBusy(true); setErr(null); setTestMsg(null);
    try {
      if (v) await enablePush(); else await disablePush();
      setOn(v);
    } catch (e) {
      setErr((e as Error).message === 'denied' ? t('profile.push.denied') : t('profile.push.failed'));
    } finally { setBusy(false); }
  };

  const sendTest = async () => {
    setTestMsg(null);
    try {
      const r = await api<{ sent: number }>('/api/push/test', { method: 'POST' });
      setTestMsg(r.sent > 0 ? t('profile.push.testSent', { n: r.sent }) : t('profile.push.testNone'));
    } catch { setTestMsg(t('profile.push.failed')); }
  };

  // Per-user opt-out for the monthly to-do reminders (1st/7th/15th). No pref row = opted in.
  const [remindersOn, setRemindersOn] = useState(true);
  useEffect(() => {
    void api<{ prefs: { kind: string; push: boolean }[] }>('/api/me/notification-prefs')
      .then(r => { const p = r.prefs.find(x => x.kind === 'reminders'); if (p) setRemindersOn(p.push); })
      .catch(() => { /* default on */ });
  }, []);
  const toggleReminders = async (v: boolean) => {
    setRemindersOn(v);
    try { await api('/api/me/notification-prefs', { method: 'PUT', body: { kind: 'reminders', push: v } }); }
    catch { setRemindersOn(!v); }
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <Bell size={16} className="text-emerald-600 dark:text-emerald-500" />
        <h2 className="text-base font-semibold">{t('profile.push.heading')}</h2>
      </div>
      <p className="text-xs text-zinc-500">{t('profile.push.intro')}</p>
      {supported ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t('profile.push.enable')}</span>
            <Switch checked={on} onChange={toggle} />
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          {on && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={sendTest}>{t('profile.push.test')}</Button>
              {testMsg && <span className="text-xs text-zinc-600 dark:text-zinc-300">{testMsg}</span>}
            </div>
          )}
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <div className="flex flex-col pr-2">
              <span className="text-sm font-medium">{t('profile.push.reminders')}</span>
              <span className="text-[11px] text-zinc-400">{t('profile.push.remindersHint')}</span>
            </div>
            <Switch checked={remindersOn} onChange={toggleReminders} />
          </div>
          <p className="text-[11px] text-zinc-400">{t('profile.push.iosHint')}</p>
        </>
      ) : (
        <p className="text-xs text-zinc-500">{t('profile.push.unsupported')}</p>
      )}
    </Card>
  );
}

interface MailboxConfig {
  configured: boolean;
  imap_host?: string;
  imap_port?: number;
  imap_secure?: boolean;
  imap_user?: string;
  folder?: string;
  enabled?: boolean;
  make_private?: boolean;
  last_poll_at?: string | null;
  last_ok_at?: string | null;
  last_error?: string | null;
}

/** Per-user IMAP mailbox for automatic e-mail receipt import (Path B). The user
 *  connects their own mailbox; forwarded invoices get filed as their receipts. */
function MailboxSettings() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery<MailboxConfig>({ queryKey: ['mailbox'], queryFn: () => api('/api/me/mailbox') });

  const [host, setHost] = useState('');
  const [port, setPort] = useState(993);
  const [secure, setSecure] = useState(true);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [folder, setFolder] = useState('INBOX');
  const [enabled, setEnabled] = useState(true);
  const [makePrivate, setMakePrivate] = useState(true); // personal mailbox → personal receipts by default
  const [seeded, setSeeded] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data && !seeded) {
      if (data.configured) {
        setHost(data.imap_host ?? '');
        setPort(data.imap_port ?? 993);
        setSecure(data.imap_secure ?? true);
        setUser(data.imap_user ?? '');
        setFolder(data.folder ?? 'INBOX');
        setEnabled(data.enabled ?? true);
        setMakePrivate(data.make_private ?? false);
      }
      setSeeded(true);
    }
  }, [data, seeded]);

  const configured = !!data?.configured;
  const body = () => ({ imap_host: host, imap_port: port, imap_secure: secure, imap_user: user, imap_pass: pass, folder, enabled, make_private: makePrivate });

  const save = useMutation({
    mutationFn: () => api('/api/me/mailbox', { method: 'PUT', body: body() }),
    onSuccess: () => { setPass(''); void qc.invalidateQueries({ queryKey: ['mailbox'] }); },
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; messages?: number; error?: string }>('/api/me/mailbox/test', { method: 'POST', body: body() }),
    onSuccess: r => setTestMsg(r.ok ? t('profile.mailbox.testOk', { n: r.messages ?? 0 }) : t('profile.mailbox.testFail', { error: r.error ?? '' })),
    onError: e => setTestMsg(t('profile.mailbox.testFail', { error: (e as Error).message })),
  });
  const run = useMutation({
    mutationFn: () => api<{ imported?: number; error?: string }>('/api/me/mailbox/run', { method: 'POST' }),
    onSuccess: r => {
      setRunMsg(r.error ? t('profile.mailbox.runFail', { error: r.error })
        : r.imported ? t('profile.mailbox.runOk', { n: r.imported }) : t('profile.mailbox.runNone'));
      void qc.invalidateQueries({ queryKey: ['mailbox'] });
    },
    onError: e => setRunMsg(t('profile.mailbox.runFail', { error: (e as Error).message })),
  });
  const backfill = useMutation({
    mutationFn: () => api<{ filled?: number; error?: string }>('/api/me/mailbox/backfill-emails', { method: 'POST' }),
    onSuccess: r => setRunMsg(r.error ? t('profile.mailbox.runFail', { error: r.error }) : t('profile.mailbox.backfillDone', { n: r.filled ?? 0 })),
    onError: e => setRunMsg(t('profile.mailbox.runFail', { error: (e as Error).message })),
  });
  const reocr = useMutation({
    mutationFn: () => api<{ queued?: number }>('/api/me/mailbox/reocr', { method: 'POST' }),
    onSuccess: r => setRunMsg(t('profile.mailbox.reocrQueued', { n: r.queued ?? 0 })),
    onError: e => setRunMsg(t('profile.mailbox.runFail', { error: (e as Error).message })),
  });
  const remove = useMutation({
    mutationFn: () => api('/api/me/mailbox', { method: 'DELETE' }),
    onSuccess: () => {
      setHost(''); setUser(''); setPass(''); setFolder('INBOX'); setEnabled(true); setMakePrivate(true);
      setTestMsg(null); setRunMsg(null);
      void qc.invalidateQueries({ queryKey: ['mailbox'] });
    },
  });

  const canSave = !!host.trim() && !!user.trim() && (configured || !!pass);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Inbox size={16} className="text-emerald-600 dark:text-emerald-500" />
        <h2 className="text-base font-semibold">{t('profile.mailbox.heading')}</h2>
      </div>
      <p className="text-xs text-zinc-500">{t('profile.mailbox.intro')}</p>

      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <Label>{t('profile.mailbox.host')}</Label>
          <Input value={host} onChange={e => setHost(e.target.value)} placeholder="imap.gmail.com" autoComplete="off" />
        </div>
        <div>
          <Label>{t('profile.mailbox.port')}</Label>
          <Input type="number" value={port} onChange={e => setPort(parseInt(e.target.value, 10) || 993)} />
        </div>
      </div>
      <div>
        <Label>{t('profile.mailbox.user')}</Label>
        <Input value={user} onChange={e => setUser(e.target.value)} placeholder="name@example.com" autoComplete="off" />
      </div>
      <div>
        <Label>{t('profile.mailbox.password')}</Label>
        <Input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder={configured ? '••••••••' : ''} autoComplete="new-password" />
        {configured && <p className="mt-1 text-[11px] text-zinc-400">{t('profile.mailbox.passwordKeep')}</p>}
      </div>
      <div>
        <Label>{t('profile.mailbox.folder')}</Label>
        <Input value={folder} onChange={e => setFolder(e.target.value)} placeholder="INBOX" autoComplete="off" />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{t('profile.mailbox.secure')}</span>
        <Switch checked={secure} onChange={setSecure} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{t('profile.mailbox.enabled')}</span>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>
      <div className="flex items-center justify-between">
        <span className="pr-2 text-sm font-medium">{t('profile.mailbox.makePrivate')}</span>
        <Switch checked={makePrivate} onChange={setMakePrivate} />
      </div>

      <p className="text-[11px] text-zinc-400">{t('profile.mailbox.privacyNote')}</p>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>{t('profile.mailbox.save')}</Button>
        <Button variant="secondary" onClick={() => { setTestMsg(null); test.mutate(); }} disabled={!host.trim() || !user.trim() || test.isPending}>{t('profile.mailbox.test')}</Button>
        {configured && <Button variant="secondary" onClick={() => { setRunMsg(null); run.mutate(); }} disabled={run.isPending}>{t('profile.mailbox.run')}</Button>}
        {configured && <Button variant="secondary" onClick={() => { setRunMsg(null); backfill.mutate(); }} disabled={backfill.isPending}>{t('profile.mailbox.backfill')}</Button>}
        {configured && <Button variant="secondary" onClick={() => { setRunMsg(null); reocr.mutate(); }} disabled={reocr.isPending}>{t('profile.mailbox.reocr')}</Button>}
      </div>

      {testMsg && <p className="text-xs text-zinc-600 dark:text-zinc-300">{testMsg}</p>}
      {runMsg && <p className="text-xs text-zinc-600 dark:text-zinc-300">{runMsg}</p>}

      {configured && data?.last_poll_at && (
        <p className="text-[11px] text-zinc-400">
          {t('profile.mailbox.lastPoll', { when: new Date(data.last_poll_at).toLocaleString(i18n.language) })}
          {data.last_error && <span className="text-red-500"> · {t('profile.mailbox.lastErrorLabel')}: {data.last_error}</span>}
        </p>
      )}

      <p className="text-[11px] text-zinc-400">{t('profile.mailbox.hint')}</p>

      {configured && <ImportLog />}

      {configured && (
        <button
          className="self-start text-xs text-red-500 hover:underline"
          onClick={async () => {
            if (await confirm({ title: t('profile.mailbox.remove'), message: t('profile.mailbox.removeConfirm'), confirmLabel: t('profile.mailbox.remove'), cancelLabel: t('common.cancel'), danger: true })) {
              remove.mutate();
            }
          }}
        >
          {t('profile.mailbox.remove')}
        </button>
      )}
    </Card>
  );
}

interface LogEntry {
  id: number;
  status: string;            // imported | skipped | failed | processing | income
  reason: string | null;
  einkauf_id: number | null; // set only if the receipt still exists
  income_id: number | null;  // set only if the mail was booked as one-off income
  income_amount: number | null;
  created_at: string;
  subject: string | null;
  roh_ladenname: string | null;
  items: number;
}

interface IncomePreview { ledgerId: number; amount: number; datum: string | null; category_path: string; description: string; confidence: number }
const INCOME_CATEGORIES = ['Gehalt', 'Erstattung', 'Verkauf', 'Geschenk', 'Sonstiges'] as const;

/** Pick a coloured badge + label key for an import-log row. An 'imported' row
 *  with zero line items is called out separately — it made a receipt shell but
 *  the extractor found nothing, which is exactly the case a user needs to see. */
function statusMeta(e: LogEntry): { cls: string; key: string } {
  if (e.status === 'income') return { cls: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300', key: 'income' };
  if (e.status === 'refund') return { cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', key: 'refund' };
  if (e.status === 'refund_suggested') return { cls: 'bg-amber-50 text-amber-700 ring-1 ring-amber-300 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-800', key: 'refundSuggested' };
  if (e.status === 'processing') return { cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300', key: 'processing' };
  if (e.status === 'failed') return { cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', key: 'failed' };
  if (e.status === 'skipped') return { cls: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300', key: 'skipped' };
  if (e.items > 0) return { cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', key: 'imported' };
  return { cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', key: 'importedEmpty' };
}

/** Collapsible per-user log of what the e-mail import did with each fetched mail
 *  — the answer to "I labelled the invoice but no receipt appeared". Lazy-loads
 *  when opened so it costs nothing on a normal Profile visit. */
function ImportLog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, refetch, isFetching } = useQuery<{ entries: LogEntry[] }>({
    queryKey: ['mailbox-log'],
    queryFn: () => api('/api/me/mailbox/log'),
    enabled: open,
  });
  const entries = data?.entries ?? [];

  const [incomePreview, setIncomePreview] = useState<IncomePreview | null>(null);
  const [refundDlg, setRefundDlg] = useState<{ ledgerId: number; amount: number; item?: string | null; merchant?: string | null; candidates: RefundCandidate[] } | null>(null);
  const [mailView, setMailView] = useState<number | null>(null); // ledger id of a refund_suggested mail to view
  const mailViewQ = useQuery({
    queryKey: ['refund-mail-log', mailView],
    queryFn: () => api<RefundMailItem>(`/api/me/mailbox/log/${mailView}/refund-mail`),
    enabled: mailView != null,
  });

  type RetryResp = {
    status?: string; einkauf_id?: number | null; error?: string;
    income?: { amount: number; datum: string | null; category_path: string; description: string; confidence: number };
    refund?: { amount: number; datum: string | null; merchant: string; description: string; confidence: number };
    candidates?: RefundCandidate[];
  };
  // One endpoint, several bodies: {} plain retry · {instruction} AI reinterpret · confirm handled below.
  const retry = useMutation({
    mutationFn: (v: { id: number; instruction?: string }) =>
      api<RetryResp>(`/api/me/mailbox/log/${v.id}/retry`, { method: 'POST', body: v.instruction ? { instruction: v.instruction } : {} }),
    onSuccess: (r, v) => {
      if (r.error) { toast(t('profile.mailbox.log.retryFail', { error: r.error }), 'error'); return; }
      if (r.status === 'preview' && r.income) {   // income proposed — confirm the amount before booking
        setIncomePreview({ ledgerId: v.id, amount: r.income.amount, datum: r.income.datum, category_path: r.income.category_path, description: r.income.description, confidence: r.income.confidence });
        return;
      }
      if (r.status === 'refund_preview' && r.refund) {   // refund proposed — reconcile on the receipt, then book
        setRefundDlg({ ledgerId: v.id, amount: r.refund.amount, merchant: r.refund.merchant, candidates: r.candidates ?? [] });
        return;
      }
      if (r.einkauf_id) toast(t('profile.mailbox.log.retryImported'), 'success');
      else toast(t('profile.mailbox.log.retryNone'), 'info');
      void qc.invalidateQueries({ queryKey: ['mailbox-log'] });
    },
    onError: (e) => toast(t('profile.mailbox.log.retryFail', { error: (e as Error).message }), 'error'),
  });

  const bookRefund = useMutation({
    mutationFn: (p: RefundBookPayload & { ledgerId: number }) => api<RetryResp>(`/api/me/mailbox/log/${p.ledgerId}/retry`, {
      method: 'POST',
      body: { confirmRefund: { einkauf_id: p.einkauf_id, discount_only: p.discount_only, amount: p.amount, description: p.description, lines: p.lines } },
    }),
    onSuccess: (r) => {
      if (r.error) { toast(t('profile.mailbox.log.retryFail', { error: r.error }), 'error'); return; }
      toast(t('profile.mailbox.log.refundBooked'), 'success');
      setRefundDlg(null);
      void qc.invalidateQueries({ queryKey: ['mailbox-log'] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
    },
    onError: (e) => toast(t('profile.mailbox.log.retryFail', { error: (e as Error).message }), 'error'),
  });

  // Open the reconciliation for an AUTO-DETECTED 'refund_suggested' entry (fetches candidates).
  const openReconcile = useMutation({
    mutationFn: (id: number) => api<{ refund: { amount: number; merchant: string | null; item: string | null }; candidates: RefundCandidate[] }>(`/api/me/mailbox/log/${id}/refund-preview`),
    onSuccess: (r, id) => setRefundDlg({ ledgerId: id, amount: r.refund.amount, merchant: r.refund.merchant, item: r.refund.item, candidates: r.candidates }),
    onError: (e) => toast(t('profile.mailbox.log.retryFail', { error: (e as Error).message }), 'error'),
  });

  const bookIncome = useMutation({
    mutationFn: (p: IncomePreview) => api<RetryResp>(`/api/me/mailbox/log/${p.ledgerId}/retry`, {
      method: 'POST',
      body: { confirmIncome: { amount: p.amount, datum: p.datum, category_path: p.category_path, description: p.description } },
    }),
    onSuccess: (r) => {
      if (r.error) { toast(t('profile.mailbox.log.retryFail', { error: r.error }), 'error'); return; }
      toast(t('profile.mailbox.log.incomeBooked'), 'success');
      setIncomePreview(null);
      void qc.invalidateQueries({ queryKey: ['mailbox-log'] });
    },
    onError: (e) => toast(t('profile.mailbox.log.retryFail', { error: (e as Error).message }), 'error'),
  });

  return (
    <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <button
        className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-200"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        {t('profile.mailbox.log.heading')}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-zinc-400">{t('profile.mailbox.log.intro')}</p>
            <button
              className="shrink-0 text-[11px] text-emerald-600 hover:underline disabled:opacity-50"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {t('profile.mailbox.log.refresh')}
            </button>
          </div>
          {isLoading ? (
            <p className="text-xs text-zinc-500">{t('common.loading')}</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-zinc-500">{t('profile.mailbox.log.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
              {entries.map(e => (
                <LogRow
                  key={e.id}
                  e={e}
                  onOpen={() => {
                    if (e.income_id) navigate('/finanzen');
                    else if (e.einkauf_id) navigate(`/receipts/${e.einkauf_id}`);
                  }}
                  onRetry={() => retry.mutate({ id: e.id })}
                  onInstruct={(instruction) => retry.mutate({ id: e.id, instruction })}
                  onReconcile={() => openReconcile.mutate(e.id)}
                  onViewMail={() => setMailView(e.id)}
                  busy={(retry.isPending && retry.variables?.id === e.id) || (openReconcile.isPending && openReconcile.variables === e.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {incomePreview && (
        <IncomeConfirm
          preview={incomePreview}
          onChange={setIncomePreview}
          onCancel={() => setIncomePreview(null)}
          onBook={() => bookIncome.mutate(incomePreview)}
          booking={bookIncome.isPending}
        />
      )}

      {refundDlg && (
        <RefundReconcileDialog
          amount={refundDlg.amount}
          item={refundDlg.item}
          merchant={refundDlg.merchant}
          candidates={refundDlg.candidates}
          booking={bookRefund.isPending}
          onClose={() => setRefundDlg(null)}
          onBook={(p) => bookRefund.mutate({ ...p, ledgerId: refundDlg.ledgerId })}
          onViewMail={() => setMailView(refundDlg.ledgerId)}
        />
      )}
      {mailView != null && (
        <RefundMailModal mails={mailViewQ.data ? [mailViewQ.data] : []} onClose={() => setMailView(null)} />
      )}
    </div>
  );
}

/** Confirm dialog for a refund the AI proposed from a mail. The user picks the ORIGINAL receipt
 *  (and the exact position it refunds) so the refunded item vanishes from product statistics, and
 *  confirms the amount before the negative position is booked. Empty candidates → guidance to add
 *  it manually on the receipt. */

/** Confirm dialog for an income the AI proposed from a mail — the amount is shown and editable
 *  BEFORE anything is written to the books (the mail is vendor-authored text, so a human okays
 *  the number). Category/date/description are editable too. */
function IncomeConfirm({ preview, onChange, onCancel, onBook, booking }: {
  preview: IncomePreview; onChange: (p: IncomePreview) => void; onCancel: () => void; onBook: () => void; booking: boolean;
}) {
  const { t } = useTranslation();
  const valid = Number.isFinite(preview.amount) && preview.amount > 0;
  return (
    <Modal open onClose={onCancel} title={t('profile.mailbox.log.incomeTitle')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('profile.mailbox.log.incomeHint')}</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('profile.mailbox.log.incomeAmount')}</Label>
            <Input type="number" step="0.01" min="0" value={String(preview.amount)}
              onChange={ev => onChange({ ...preview, amount: Number(ev.target.value) })} />
          </div>
          <div>
            <Label>{t('profile.mailbox.log.incomeDate')}</Label>
            <Input type="date" value={preview.datum ?? ''} onChange={ev => onChange({ ...preview, datum: ev.target.value || null })} />
          </div>
        </div>
        <div>
          <Label>{t('profile.mailbox.log.incomeCategory')}</Label>
          <Select value={preview.category_path} onChange={ev => onChange({ ...preview, category_path: ev.target.value })}>
            {INCOME_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <div>
          <Label>{t('profile.mailbox.log.incomeDescription')}</Label>
          <Input value={preview.description} onChange={ev => onChange({ ...preview, description: ev.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button onClick={onBook} disabled={!valid || booking}>
            {booking ? t('common.saving') : t('profile.mailbox.log.incomeBook')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function LogRow({ e, onOpen, onRetry, onInstruct, onReconcile, onViewMail, busy }: {
  e: LogEntry; onOpen: () => void; onRetry: () => void; onInstruct: (instruction: string) => void;
  onReconcile: () => void; onViewMail: () => void; busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [instructOpen, setInstructOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const m = statusMeta(e);
  const laden = (e.roh_ladenname || '').trim();
  const title = (e.subject || laden || t('profile.mailbox.log.noSubject')).trim();
  const date = new Date(e.created_at).toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit', year: '2-digit' });
  // A skipped/failed mail that produced neither a receipt nor an income can be re-run — plainly,
  // or with an instruction that tells the AI what it really is. Resolved rows link out instead.
  const canRetry = !e.einkauf_id && !e.income_id && (e.status === 'skipped' || e.status === 'failed');
  const resolved = e.einkauf_id || e.income_id;
  return (
    <li className="py-1.5">
      <div className="flex items-start gap-2">
        <span className={cn('mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium', m.cls)}>
          {e.status === 'income' && e.income_amount != null
            ? t('profile.mailbox.log.status.incomeAmount', { amount: Number(e.income_amount).toFixed(2) })
            : t(`profile.mailbox.log.status.${m.key}`, { n: e.items })}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">{title}</p>
          {e.reason && <p className="text-[11px] leading-tight text-zinc-500">{e.reason}</p>}
          {canRetry && instructOpen && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              <textarea
                value={instruction}
                onChange={ev => setInstruction(ev.target.value)}
                rows={2}
                placeholder={t('profile.mailbox.log.instructionPlaceholder')}
                className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-[12px] text-zinc-800 placeholder:text-zinc-400 focus:border-sky-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => instruction.trim() && onInstruct(instruction.trim())}
                  disabled={busy || !instruction.trim()}
                  className="rounded-lg bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  {busy ? t('profile.mailbox.log.instructing') : t('profile.mailbox.log.instructApply')}
                </button>
                <button onClick={() => setInstructOpen(false)} className="text-[11px] text-zinc-500 hover:underline">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[10px] text-zinc-400">{date}</p>
          {resolved ? (
            <button onClick={onOpen} className="text-[11px] text-emerald-600 hover:underline">
              {e.income_id ? t('profile.mailbox.log.viewIncome') : t('profile.mailbox.log.view')}
            </button>
          ) : e.status === 'refund_suggested' ? (
            <div className="flex flex-col items-end gap-0.5">
              <button onClick={onReconcile} disabled={busy} className="text-[11px] font-medium text-amber-600 hover:underline disabled:opacity-50">
                {busy ? t('common.loading') : t('profile.mailbox.log.reconcile', 'prüfen')}
              </button>
              <button onClick={onViewMail} className="inline-flex items-center gap-0.5 text-[11px] text-zinc-500 hover:underline">
                <Paperclip size={11} /> {t('profile.mailbox.log.viewMail', 'Mail')}
              </button>
            </div>
          ) : canRetry ? (
            <div className="flex flex-col items-end gap-0.5">
              <button onClick={onRetry} disabled={busy} className="text-[11px] text-sky-600 hover:underline disabled:opacity-50">
                {busy ? t('profile.mailbox.log.retrying') : t('profile.mailbox.log.retry')}
              </button>
              {!instructOpen && (
                <button onClick={() => setInstructOpen(true)} className="text-[11px] text-zinc-500 hover:underline">
                  {t('profile.mailbox.log.instructOpen')}
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
