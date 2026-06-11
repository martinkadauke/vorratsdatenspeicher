export interface User {
  id: number;
  username: string;
  email: string | null;
  is_admin: boolean;
  prefers_dark: boolean;
  preferred_lang: string;
  has_seen_tour: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}
