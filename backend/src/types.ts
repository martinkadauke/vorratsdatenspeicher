export interface User {
  id: number;
  username: string;
  email: string | null;
  is_admin: boolean;
  sees_all_konten: boolean;
  can_write: boolean;
  prefers_dark: boolean;
  preferred_lang: string;
  has_seen_tour: boolean;
  // Computed per request: account ids this user may see (empty when sees_all).
  konto_ids?: number[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}
