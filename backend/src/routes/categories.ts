import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';

const CATEGORY_DESIGNER_PROMPT = `Du bist ein Kategorien-Architekt für „Vorratsdatenspeicher" — eine Haushalts-App, die Kassenbons erfasst und Ausgaben nach Kategorien auswertet.

Deine Aufgabe: Gemeinsam mit dem Nutzer eine sinnvolle Kategorie-Hierarchie für SEINEN Haushalt entwerfen. Du bekommst die aktuellen Kategorien (mit Artikel-Anzahl) und eine Stichprobe echter Artikelnamen aus seiner Datenbank.

Design-Prinzipien:
- Maximal 3 Ebenen (z.B. "Lebensmittel/Getränke/Wasser & Sprudel"). Ebene 1 ist der Statistik-Hauptfilter — ideal sind 5-9 Top-Level-Kategorien.
- Kategorien müssen ÜBERSCHNEIDUNGSFREI sein: jeder Artikel hat genau eine richtige Heimat. Im Zweifel lieber gröber.
- Denke an AUSWERTUNG, nicht an Lagerhaltung: Der Nutzer will am Monatsende wissen "wofür ging das Geld drauf". Kategorien wie "Süßkram & Snacks" sind nützlicher als botanische Korrektheit.
- Deutsche Namen, kurz und alltagstauglich. Optional ein passendes Emoji pro Top-Level.
- Schau auf die ECHTEN Artikel des Nutzers: Wenn er viel in Buchläden kauft, braucht er eine Bücher-Kategorie. Wenn keine Tiernahrung vorkommt, schlage keine vor.
- Die Kategorien "Meta/Pfand" und "Meta/Rabatt" sind systemrelevant und bleiben IMMER bestehen — nie entfernen, nie umbenennen, nicht in Vorschläge aufnehmen.

Gesprächsführung:
- Stelle anfangs 2-3 gezielte Fragen (Detailgrad? Sonderbereiche wie Hobby/Baby/Garten? Trennung Drogerie vs. Haushalt?), aber nerve nicht — wenn der Nutzer "mach einfach" sagt, mach einen kompletten Vorschlag.
- Iteriere: Der Nutzer wird Änderungswünsche haben. Behalte den Gesamtvorschlag im Kopf und ändere nur das Gewünschte.
- Wenn ein konkreter, vollständiger Strukturvorschlag steht, liefere ihn als "proposal" mit.

Antworte AUSSCHLIESSLICH mit gültigem JSON (keine Code-Fences):
{"message": "<deine Chat-Antwort an den Nutzer>", "proposal": [{"path": "Lebensmittel", "emoji": "🛒"}, {"path": "Lebensmittel/Obst & Gemüse"}, ...] | null}

- "proposal" nur setzen wenn du einen VOLLSTÄNDIGEN Strukturvorschlag machst (alle Kategorien, nicht nur die geänderten). Sonst null.
- Pfade mit "/" getrennt, Eltern müssen in der Liste vor ihren Kindern stehen.
- Der "path" enthält NUR Text — Emojis gehören AUSSCHLIESSLICH ins "emoji"-Feld, niemals in den Pfad.
- Meta-Kategorien NICHT in proposal aufnehmen (bleiben automatisch erhalten).`;

/** LLMs love sneaking emojis into path segments despite instructions —
 *  strip them out and promote a leading emoji to the emoji field. */
function normalizeProposal(entries: ProposalEntry[]): ProposalEntry[] {
  const pict = /\p{Extended_Pictographic}/gu;
  return entries
    .filter(e => typeof e?.path === 'string' && e.path.trim())
    .map(e => {
      let emoji = e.emoji?.trim() || null;
      const segs = e.path.split('/').map((seg, i, arr) => {
        const found = seg.match(pict);
        if (found && i === arr.length - 1 && !emoji) emoji = found[0];
        return seg.replace(pict, '').replace(/️/g, '').replace(/\s+/g, ' ').trim();
      }).filter(Boolean);
      return { path: segs.join('/'), emoji };
    })
    .filter(e => e.path);
}

interface ChatMessage { role: 'user' | 'assistant'; content: string }
interface ProposalEntry { path: string; emoji?: string | null; display_en?: string | null }

export function categoryRoutes(app: FastifyInstance): void {
  app.get('/api/categories', async (req) => {
    const lang = (req.query as { lang?: string }).lang ?? req.user?.preferred_lang ?? 'de';
    const rows = await sql`
      SELECT id, path, parent_path, display, display_en, level, sort_order, emoji, is_meta
      FROM category ORDER BY sort_order, path
    `;
    return rows.map(r => ({
      ...r,
      label: lang === 'en' && r.display_en ? r.display_en : r.display,
    }));
  });

  app.post('/api/categories', { preHandler: requireAdmin }, async (req, reply) => {
    const { path, display, display_en, emoji, sort_order } = (req.body ?? {}) as {
      path?: string; display?: string; display_en?: string; emoji?: string; sort_order?: number;
    };
    if (!path || !display) return reply.code(400).send({ error: 'path and display required' });
    const parts = path.split('/');
    const level = parts.length;
    if (level > 3) return reply.code(400).send({ error: 'max 3 levels' });
    const parent = level > 1 ? parts.slice(0, -1).join('/') : null;
    if (parent) {
      const exists = await sql`SELECT 1 FROM category WHERE path = ${parent}`;
      if (!exists.length) return reply.code(400).send({ error: `parent ${parent} does not exist` });
    }
    await sql`
      INSERT INTO category (path, parent_path, display, display_en, level, sort_order, emoji)
      VALUES (${path}, ${parent}, ${display}, ${display_en ?? null}, ${level}, ${sort_order ?? 0}, ${emoji ?? null})
    `;
    return { ok: true };
  });

  app.patch('/api/categories/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    for (const key of ['display', 'display_en', 'emoji', 'sort_order']) {
      if (key in body) updates[key] = body[key];
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    const rows = await sql`UPDATE category SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/categories/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const rows = await sql`SELECT path FROM category WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    const path = rows[0].path as string;

    const [children] = await sql`SELECT COUNT(*)::int AS n FROM category WHERE parent_path = ${path}`;
    if (children.n > 0) return reply.code(409).send({ error: 'category has children' });
    const [used] = await sql`SELECT COUNT(*)::int AS n FROM artikel WHERE category_path = ${path}`;
    if (used.n > 0) return reply.code(409).send({ error: `category used by ${used.n} artikel` });

    await sql`DELETE FROM category WHERE id = ${id}`;
    return { ok: true };
  });

  /** Conversational category design. Stateless: the client sends the whole
   *  chat history, we prepend the system prompt + live DB context. */
  app.post('/api/categories/chat', { preHandler: requireAdmin }, async (req, reply) => {
    const { messages } = (req.body ?? {}) as { messages?: ChatMessage[] };
    if (!Array.isArray(messages) || !messages.length) {
      return reply.code(400).send({ error: 'messages required' });
    }

    // Live context: current catalog with usage counts + a sample of real items
    const cats = await sql`
      SELECT c.path, c.emoji, c.is_meta, COUNT(a.id)::int AS artikel
      FROM category c
      LEFT JOIN artikel a ON a.category_path = c.path
      GROUP BY c.path, c.emoji, c.is_meta
      ORDER BY c.path
    `;
    const sample = await sql`
      SELECT COALESCE(canonical_name, ai_guess, name) AS n
      FROM artikel
      ORDER BY RANDOM()
      LIMIT 120
    `;

    const context = JSON.stringify({
      aktuelle_kategorien: cats.map(c => ({ path: c.path, artikel: c.artikel, meta: c.is_meta })),
      artikel_stichprobe: [...new Set(sample.map(s => s.n as string))],
    });

    // Flatten history into one user turn — keeps provider abstraction simple
    // (our LlmProvider interface is single system+user; multi-turn lives here).
    const transcript = messages
      .map(m => `${m.role === 'user' ? 'NUTZER' : 'DU (Architekt)'}: ${m.content}`)
      .join('\n\n');

    try {
      const llm = await providerForTask('categories_chat');
      const raw = await llm.chat({
        system: CATEGORY_DESIGNER_PROMPT,
        user: `KONTEXT AUS DER DATENBANK:\n${context}\n\nBISHERIGES GESPRÄCH:\n${transcript}\n\nAntworte auf die letzte Nutzer-Nachricht (als JSON).`,
        json: true,
      });
      const parsed = parseLlmJson<{ message?: string; proposal?: ProposalEntry[] | null }>(raw);
      const proposal = Array.isArray(parsed.proposal) && parsed.proposal.length
        ? normalizeProposal(parsed.proposal)
        : null;
      return {
        message: parsed.message ?? '…',
        proposal: proposal?.length ? proposal : null,
      };
    } catch (e) {
      req.log.error(`categories chat failed: ${(e as Error).message}`);
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /** Replace the whole category catalog (except Meta/*) with a new tree.
   *  artikel.category_path is intentionally left untouched — dangling paths
   *  get rewritten by the next recategorize run. */
  app.post('/api/categories/apply', { preHandler: requireAdmin }, async (req, reply) => {
    const { categories } = (req.body ?? {}) as { categories?: ProposalEntry[] };
    if (!Array.isArray(categories) || !categories.length) {
      return reply.code(400).send({ error: 'categories required' });
    }

    // Normalize + validate: dedupe, depth ≤ 3, auto-create missing parents.
    const seen = new Set<string>();
    const ordered: { path: string; emoji: string | null; display_en: string | null }[] = [];
    for (const entry of categories) {
      const path = (entry.path ?? '').trim().replace(/^\/+|\/+$/g, '');
      if (!path || seen.has(path)) continue;
      if (path.toLowerCase().startsWith('meta/') || path.toLowerCase() === 'meta') continue; // protected
      const parts = path.split('/').map(p => p.trim()).filter(Boolean);
      if (parts.length > 3) return reply.code(400).send({ error: `max 3 levels: ${path}` });
      // ensure parents exist (in order, before the child)
      for (let d = 1; d < parts.length; d++) {
        const parent = parts.slice(0, d).join('/');
        if (!seen.has(parent)) {
          seen.add(parent);
          ordered.push({ path: parent, emoji: null, display_en: null });
        }
      }
      seen.add(path);
      ordered.push({ path, emoji: entry.emoji ?? null, display_en: entry.display_en ?? null });
    }
    if (!ordered.length) return reply.code(400).send({ error: 'no valid categories after validation' });

    await sql.begin(async tx => {
      await tx`DELETE FROM category WHERE is_meta = FALSE`;
      let sortOrder = 0;
      for (const c of ordered) {
        const parts = c.path.split('/');
        const level = parts.length;
        const parent = level > 1 ? parts.slice(0, -1).join('/') : null;
        await tx`
          INSERT INTO category (path, parent_path, display, display_en, level, sort_order, emoji, is_meta)
          VALUES (${c.path}, ${parent}, ${parts[parts.length - 1]}, ${c.display_en}, ${level}, ${sortOrder++}, ${c.emoji}, FALSE)
          ON CONFLICT (path) DO UPDATE SET emoji = EXCLUDED.emoji, sort_order = EXCLUDED.sort_order
        `;
      }
      await tx`
        INSERT INTO maintenance_event (kind, status, ended_at, summary)
        VALUES ('categories.replaced', 'success', NOW(), ${tx.json({ count: ordered.length, by: req.user!.username })})
      `;
    });

    const [orphans] = await sql`
      SELECT COUNT(*)::int AS n FROM artikel
      WHERE category_path IS NOT NULL
        AND category_path NOT IN (SELECT path FROM category)
    `;
    return { ok: true, categories: ordered.length, orphaned_artikel: orphans.n };
  });
}
