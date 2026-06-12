import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Tree, type NodeApi, type NodeRendererProps } from 'react-arborist';
import {
  ArrowLeft, Send, Sparkles, Plus, Trash2, ChevronRight, ChevronDown,
  FolderTree, RefreshCw, Play, AlertTriangle,
} from 'lucide-react';
import { api } from '../api/client';
import { Card, Button, Input, Spinner } from '../components/ui';

// ── tree data model ────────────────────────────────────────────────────────
interface CatNode {
  id: string;
  name: string;
  emoji: string | null;
  children?: CatNode[];
}

interface CategoryRow {
  path: string; parent_path: string | null; emoji: string | null; is_meta: boolean;
}

interface ChatMsg { role: 'user' | 'assistant'; content: string; proposal?: ProposalEntry[] | null }
interface ProposalEntry { path: string; emoji?: string | null }

let _id = 0;
const nid = () => `n${++_id}_${Date.now() % 100000}`;

/** Build a CatNode tree from flat path rows (Meta/* excluded). */
function buildTree(rows: { path: string; emoji?: string | null }[]): CatNode[] {
  const roots: CatNode[] = [];
  const byPath = new Map<string, CatNode>();
  const sorted = [...rows].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const r of sorted) {
    if (r.path.toLowerCase() === 'meta' || r.path.toLowerCase().startsWith('meta/')) continue;
    const parts = r.path.split('/');
    const node: CatNode = { id: nid(), name: parts[parts.length - 1], emoji: r.emoji ?? null, children: [] };
    byPath.set(r.path, node);
    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parent = byPath.get(parts.slice(0, -1).join('/'));
      if (parent) (parent.children ??= []).push(node);
      else roots.push(node); // orphan — keep visible rather than dropping
    }
  }
  return roots;
}

/** Flatten the tree back to ordered path entries for the apply endpoint. */
function flattenTree(nodes: CatNode[], prefix = ''): { path: string; emoji: string | null }[] {
  const out: { path: string; emoji: string | null }[] = [];
  for (const n of nodes) {
    const path = prefix ? `${prefix}/${n.name}` : n.name;
    out.push({ path, emoji: n.emoji });
    if (n.children?.length) out.push(...flattenTree(n.children, path));
  }
  return out;
}

function subtreeDepth(n: CatNode): number {
  if (!n.children?.length) return 1;
  return 1 + Math.max(...n.children.map(subtreeDepth));
}

// immutable tree ops
function removeNodes(nodes: CatNode[], ids: Set<string>): CatNode[] {
  return nodes.filter(n => !ids.has(n.id)).map(n => ({
    ...n,
    children: n.children ? removeNodes(n.children, ids) : undefined,
  }));
}
function findNodes(nodes: CatNode[], ids: Set<string>): CatNode[] {
  const found: CatNode[] = [];
  for (const n of nodes) {
    if (ids.has(n.id)) found.push(n);
    if (n.children) found.push(...findNodes(n.children, ids));
  }
  return found;
}
function insertNodes(nodes: CatNode[], parentId: string | null, index: number, toInsert: CatNode[]): CatNode[] {
  if (parentId === null) {
    const copy = [...nodes];
    copy.splice(index, 0, ...toInsert);
    return copy;
  }
  return nodes.map(n => {
    if (n.id === parentId) {
      const kids = [...(n.children ?? [])];
      kids.splice(index, 0, ...toInsert);
      return { ...n, children: kids };
    }
    return { ...n, children: n.children ? insertNodes(n.children, parentId, index, toInsert) : undefined };
  });
}
function renameNode(nodes: CatNode[], id: string, name: string): CatNode[] {
  return nodes.map(n => n.id === id
    ? { ...n, name }
    : { ...n, children: n.children ? renameNode(n.children, id, name) : undefined });
}

// ── page ───────────────────────────────────────────────────────────────────
export function CategoriesAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [tree, setTree] = useState<CatNode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [applyResult, setApplyResult] = useState<{ categories: number; orphaned_artikel: number } | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const [treeWidth, setTreeWidth] = useState(400);

  const { data: catRows, isLoading } = useQuery({
    queryKey: ['categories-admin'],
    queryFn: () => api<CategoryRow[]>('/api/categories'),
  });

  const { data: status } = useQuery({
    queryKey: ['maintenance-status'],
    queryFn: () => api<{ recategorize: { running: boolean } }>('/api/maintenance/status'),
    refetchInterval: 5_000,
  });
  const recatRunning = status?.recategorize.running ?? false;

  // initial tree from server (only once / when not dirty)
  useEffect(() => {
    if (catRows && !dirty) setTree(buildTree(catRows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catRows]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const el = treeContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTreeWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chat = useMutation({
    mutationFn: (msgs: ChatMsg[]) =>
      api<{ message: string; proposal: ProposalEntry[] | null }>('/api/categories/chat', {
        method: 'POST',
        body: { messages: msgs.map(m => ({ role: m.role, content: m.content })) },
      }),
    onSuccess: (res) => {
      setMessages(m => [...m, { role: 'assistant', content: res.message, proposal: res.proposal }]);
    },
    onError: (err: Error) => {
      setMessages(m => [...m, { role: 'assistant', content: `⚠️ ${err.message}` }]);
    },
  });

  const send = () => {
    const text = input.trim();
    if (!text || chat.isPending) return;
    const next: ChatMsg[] = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    chat.mutate(next);
  };

  const adoptProposal = (proposal: ProposalEntry[]) => {
    setTree(buildTree(proposal));
    setDirty(true);
    setApplyResult(null);
  };

  const applyCategories = useMutation({
    mutationFn: () => api<{ ok: boolean; categories: number; orphaned_artikel: number }>('/api/categories/apply', {
      method: 'POST',
      body: { categories: flattenTree(tree) },
    }),
    onSuccess: (res) => {
      setApplyResult({ categories: res.categories, orphaned_artikel: res.orphaned_artikel });
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['categories-admin'] });
      void qc.invalidateQueries({ queryKey: ['categories'] });
    },
  });

  const recategorize = useMutation({
    mutationFn: (onlyMissing: boolean) =>
      api('/api/maintenance/recategorize', { method: 'POST', body: { only_missing: onlyMissing } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance-status'] }),
  });

  // tree handlers
  const onMove = ({ dragIds, parentId, index }: { dragIds: string[]; parentId: string | null; index: number }) => {
    const ids = new Set(dragIds);
    const moving = findNodes(tree, ids);
    const without = removeNodes(tree, ids);
    setTree(insertNodes(without, parentId, index, moving));
    setDirty(true);
  };
  const onRename = ({ id, name }: { id: string; name: string }) => {
    const clean = name.replace(/\//g, '·').trim();
    if (!clean) return;
    setTree(t2 => renameNode(t2, id, clean));
    setDirty(true);
  };
  const onDelete = ({ ids }: { ids: string[] }) => {
    setTree(t2 => removeNodes(t2, new Set(ids)));
    setDirty(true);
  };
  const onCreate = ({ parentId, index }: { parentId: string | null; index: number; type: 'internal' | 'leaf' }) => {
    const node: CatNode = { id: nid(), name: t('categoriesAdmin.newCategory'), emoji: null, children: [] };
    setTree(t2 => insertNodes(t2, parentId, index, [node]));
    setDirty(true);
    return { id: node.id };
  };
  const disableDrop = ({ parentNode, dragNodes }: { parentNode: NodeApi<CatNode> | null; dragNodes: NodeApi<CatNode>[] }) => {
    const parentLevel = parentNode && parentNode.id !== '__REACT_ARBORIST_INTERNAL_ROOT__' ? parentNode.level + 1 : 0;
    const deepest = Math.max(...dragNodes.map(d => subtreeDepth(d.data)));
    return parentLevel + deepest > 3;
  };

  const addRoot = () => {
    const node: CatNode = { id: nid(), name: t('categoriesAdmin.newCategory'), emoji: null, children: [] };
    setTree(t2 => [...t2, node]);
    setDirty(true);
  };

  const lastProposal = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const p = messages[i].proposal;
      if (p?.length) return p;
    }
    return null;
  }, [messages]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link to="/admin" className="shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-lg font-bold">{t('categoriesAdmin.title')}</h1>
          <p className="text-sm text-zinc-500">{t('categoriesAdmin.subtitle')}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── KI chat ── */}
        <Card className="flex h-[600px] flex-col p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={16} className="text-emerald-500" /> {t('categoriesAdmin.chatTitle')}
          </div>
          <div className="flex-1 overflow-y-auto pr-1">
            {!messages.length && (
              <p className="px-2 py-6 text-center text-sm text-zinc-400">{t('categoriesAdmin.chatEmpty')}</p>
            )}
            <div className="flex flex-col gap-2">
              {messages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div className={
                    m.role === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-md bg-emerald-600 px-3 py-2 text-sm text-white'
                      : 'max-w-[85%] rounded-2xl rounded-bl-md bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800'
                  }>
                    <div className="whitespace-pre-wrap">{m.content}</div>
                    {m.proposal && m.proposal.length > 0 && (
                      <button
                        onClick={() => adoptProposal(m.proposal!)}
                        className="mt-2 flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                      >
                        <FolderTree size={13} /> {t('categoriesAdmin.adoptProposal', { count: m.proposal.length })}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {chat.isPending && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-md bg-zinc-100 px-3 py-2 dark:bg-zinc-800">
                    <span className="inline-flex gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:300ms]" />
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={t('categoriesAdmin.chatPlaceholder')}
            />
            <Button onClick={send} disabled={!input.trim() || chat.isPending}>
              <Send size={15} />
            </Button>
          </div>
        </Card>

        {/* ── tree editor ── */}
        <Card className="flex h-[600px] flex-col p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FolderTree size={16} className="text-emerald-500" /> {t('categoriesAdmin.treeTitle')}
              {dirty && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">{t('categoriesAdmin.unsaved')}</span>}
            </div>
            <button
              onClick={addRoot}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
            >
              <Plus size={13} /> {t('categoriesAdmin.addRoot')}
            </button>
          </div>
          <p className="mb-2 text-xs text-zinc-400">{t('categoriesAdmin.treeHint')}</p>

          <div ref={treeContainerRef} className="min-h-0 flex-1">
            {isLoading ? <Spinner /> : (
              <Tree<CatNode>
                data={tree}
                onMove={onMove}
                onRename={onRename}
                onDelete={onDelete}
                onCreate={onCreate}
                disableDrop={disableDrop}
                width={treeWidth}
                height={440}
                rowHeight={32}
                indent={22}
                openByDefault
              >
                {CatNodeRow}
              </Tree>
            )}
          </div>
        </Card>
      </div>

      {/* ── apply + recategorize ── */}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => { if (confirm(t('categoriesAdmin.applyConfirm'))) applyCategories.mutate(); }} disabled={applyCategories.isPending || !tree.length}>
            <FolderTree size={15} /> {applyCategories.isPending ? t('admin.running') : t('categoriesAdmin.apply')}
          </Button>
          <Button variant="secondary" onClick={() => recategorize.mutate(false)} disabled={recatRunning}>
            <RefreshCw size={15} /> {recatRunning ? t('admin.running') : t('admin.recategorize')}
          </Button>
          <Button variant="ghost" onClick={() => recategorize.mutate(true)} disabled={recatRunning}>
            <Play size={15} /> {t('admin.recategorizeMissing')}
          </Button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('categoriesAdmin.applyHint')}</p>
        {applyCategories.isError && (
          <p className="text-sm text-red-500">{(applyCategories.error as Error).message}</p>
        )}
        {applyResult && (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/40 dark:text-emerald-300">
            <AlertTriangle size={15} className="shrink-0" />
            {t('categoriesAdmin.applied', { count: applyResult.categories, orphans: applyResult.orphaned_artikel })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── tree row renderer ──────────────────────────────────────────────────────
function CatNodeRow({ node, style, dragHandle }: NodeRendererProps<CatNode>) {
  const hasKids = (node.data.children?.length ?? 0) > 0;
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`group flex h-full items-center gap-1 rounded-lg pr-1 text-sm ${node.isSelected ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}
      onDoubleClick={() => node.edit()}
    >
      <button
        onClick={(e) => { e.stopPropagation(); node.toggle(); }}
        className={`shrink-0 p-0.5 text-zinc-400 ${hasKids ? '' : 'invisible'}`}
      >
        {node.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {node.data.emoji && <span className="shrink-0 text-base leading-none">{node.data.emoji}</span>}
      {node.isEditing ? (
        <input
          autoFocus
          defaultValue={node.data.name}
          className="min-w-0 flex-1 rounded border border-emerald-400 bg-white px-1 py-0.5 text-sm outline-none dark:bg-zinc-900"
          onBlur={e => node.submit(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') node.submit(e.currentTarget.value);
            if (e.key === 'Escape') node.reset();
          }}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{node.data.name}</span>
      )}
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        {node.level < 2 && (
          <button
            title="Unterkategorie"
            onClick={(e) => { e.stopPropagation(); void node.tree.create({ parentId: node.id, type: 'internal' }); }}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-emerald-600 dark:hover:bg-zinc-700"
          >
            <Plus size={13} />
          </button>
        )}
        <button
          title="Löschen"
          onClick={(e) => { e.stopPropagation(); void node.tree.delete(node.id); }}
          className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
