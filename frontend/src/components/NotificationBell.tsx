import { useState } from 'react';
import { Bell } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { Notification } from '../api/types';
import { cn } from '../lib/utils';

function notificationText(n: Notification, t: (k: string, o?: Record<string, unknown>) => string): string {
  const p = n.payload as Record<string, string | number | undefined>;
  switch (n.type) {
    case 'churner.auto_applied':
      return t('bell.churnerApplied', { old: p.old_canonical ?? p.original_text ?? '?', new: p.new_canonical ?? '?' });
    case 'churner.queued':
      return t('bell.churnerQueued', { name: p.proposed_canonical ?? '?' });
    case 'churner.run.summary':
      return t('bell.churnerSummary', { applied: p.auto_applied ?? 0, queued: p.queued ?? 0 });
    case 'recategorize.done':
      return t('bell.recategorized', { updated: p.updated ?? 0 });
    default:
      return n.type;
  }
}

function targetFor(n: Notification): string {
  switch (n.type) {
    case 'churner.queued': return '/queue';
    case 'churner.auto_applied': return '/names';
    default: return '/admin';
  }
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: countData } = useQuery({
    queryKey: ['notifications-count'],
    queryFn: () => api<{ count: number }>('/api/notifications/unread-count'),
    refetchInterval: 30_000,
  });

  const { data: items } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<Notification[]>('/api/notifications?limit=30'),
    enabled: open,
  });

  const markRead = useMutation({
    mutationFn: (id: number) => api(`/api/notifications/${id}`, { method: 'PATCH', body: { read: true } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notifications-count'] });
    },
  });

  const markAll = useMutation({
    mutationFn: () => api('/api/notifications/read-all', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notifications-count'] });
    },
  });

  const unread = countData?.count ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="relative rounded-xl p-2 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <Bell size={20} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
              <span className="text-sm font-semibold">{t('bell.title')}</span>
              {unread > 0 && (
                <button onClick={() => markAll.mutate()} className="text-xs text-emerald-600 hover:underline dark:text-emerald-500">
                  {t('bell.markAll')}
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {!items?.length && <div className="py-8 text-center text-sm text-zinc-400">{t('bell.empty')}</div>}
              {items?.map(n => (
                <button
                  key={n.id}
                  onClick={() => {
                    if (!n.read_at) markRead.mutate(n.id);
                    setOpen(false);
                    navigate(targetFor(n));
                  }}
                  className={cn(
                    'block w-full border-b border-zinc-50 px-4 py-2.5 text-left text-sm last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/50',
                    !n.read_at && 'bg-emerald-50/50 dark:bg-emerald-950/20',
                  )}
                >
                  <div className="line-clamp-2">{notificationText(n, t)}</div>
                  <div className="mt-0.5 text-xs text-zinc-400">
                    {new Date(n.created_at).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE')}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
