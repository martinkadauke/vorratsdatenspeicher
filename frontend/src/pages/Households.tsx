import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Trash2 } from 'lucide-react';
import { api } from '../api/client';

interface Household {
  id: number;
  name: string;
  created_at: string;
  users: number;
  receipts: number;
  articles: number;
}

/** Platform super-admin: view every demo household and delete one (with all its data). */
export function Households() {
  const { i18n } = useTranslation();
  const de = i18n.language.startsWith('de');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ['households'], queryFn: () => api<Household[]>('/api/households') });
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/households/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['households'] }); },
  });

  const onDelete = (h: Household) => {
    const ok = window.confirm(
      de
        ? `Haushalt „${h.name}" (${h.users} Nutzer, ${h.receipts} Belege) UNWIDERRUFLICH löschen?`
        : `Permanently delete household “${h.name}" (${h.users} users, ${h.receipts} receipts)?`,
    );
    if (ok) del.mutate(h.id);
  };

  const wipeAll = useMutation({
    mutationFn: () => api<{ households: number; files: number }>('/api/households/wipe-all', { method: 'POST' }),
    onSuccess: (r) => {
      window.alert(de ? `${r.households} Haushalt(e) und ${r.files} Datei(en) gelöscht.` : `Wiped ${r.households} household(s) and ${r.files} file(s).`);
      void qc.invalidateQueries({ queryKey: ['households'] });
    },
  });
  const onWipeAll = () => {
    const ok = window.confirm(de
      ? 'ALLE nutzergenerierten Haushalte UNWIDERRUFLICH löschen — inklusive aller Daten UND Dateien (Belegfotos)? Nur dein Plattform-Haushalt (#1) bleibt.'
      : 'Permanently delete ALL user-generated households — including every row AND file (receipt photos)? Only your platform household (#1) remains.');
    if (ok) wipeAll.mutate();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 flex items-center gap-2 text-xl font-bold"><Building2 size={22} /> {de ? 'Haushalte' : 'Households'}</h1>
          <p className="text-sm text-zinc-500">{de ? 'Alle Demo-Haushalte — nur für Super-Admin.' : 'All demo households — super-admin only.'}</p>
        </div>
        <button
          onClick={onWipeAll}
          disabled={wipeAll.isPending}
          title={de ? 'Alle nutzergenerierten Haushalte + Dateien löschen' : 'Delete all user-generated households + files'}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-300 px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
        >
          <Trash2 size={16} /> {wipeAll.isPending ? '…' : (de ? 'Alle wipen' : 'Wipe all')}
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-400">…</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="p-3">ID</th>
                <th className="p-3">Name</th>
                <th className="p-3 text-right">{de ? 'Nutzer' : 'Users'}</th>
                <th className="p-3 text-right">{de ? 'Belege' : 'Receipts'}</th>
                <th className="p-3">{de ? 'Erstellt' : 'Created'}</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {data?.map(h => (
                <tr key={h.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="p-3 tabular-nums text-zinc-400">{h.id}</td>
                  <td className="p-3 font-medium">
                    {h.name}
                    {h.id === 1 && (
                      <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                        {de ? 'Plattform' : 'Platform'}
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums">{h.users}</td>
                  <td className="p-3 text-right tabular-nums">{h.receipts}</td>
                  <td className="p-3 text-zinc-500">{new Date(h.created_at).toLocaleDateString()}</td>
                  <td className="p-3 text-right">
                    {h.id !== 1 && (
                      <button
                        onClick={() => onDelete(h)}
                        disabled={del.isPending}
                        title={de ? 'Haushalt löschen' : 'Delete household'}
                        className="rounded-lg p-1.5 text-zinc-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-950/40"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
