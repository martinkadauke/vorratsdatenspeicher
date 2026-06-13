const TOKEN_KEY = 'vds_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && !path.includes('/auth/login')) {
    setToken(null);
    window.dispatchEvent(new Event('vds:logout'));
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json() as { error?: string; message?: string };
      // read-only accounts get a friendly message instead of the raw error code
      message = data.error === 'read_only' && data.message ? data.message : (data.error ?? message);
    } catch { /* keep statusText */ }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}
