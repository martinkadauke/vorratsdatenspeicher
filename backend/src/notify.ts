import sql from './db.js';

export type NotificationType =
  | 'churner.auto_applied'
  | 'churner.queued'
  | 'churner.run.summary'
  | 'recategorize.done';

/** user_id NULL = broadcast (visible to all admins). */
export async function notify(type: NotificationType, payload: Record<string, unknown>, userId?: number): Promise<void> {
  await sql`
    INSERT INTO notification (type, payload, user_id)
    VALUES (${type}, ${sql.json(payload as never)}, ${userId ?? null})
  `;
}
