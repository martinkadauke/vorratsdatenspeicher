import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api } from './client';

/** Whether this browser can do WebAuthn at all (needs a secure context — HTTPS or localhost). */
export const passkeySupported = (): boolean => browserSupportsWebAuthn();

export interface PasskeyInfo {
  id: number;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Register a new passkey for the currently signed-in user (Face ID / fingerprint / device PIN). */
export async function registerPasskey(name?: string): Promise<void> {
  const { options, challengeId } = await api<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>(
    '/api/auth/passkey/register/options', { method: 'POST', body: {} });
  const response = await startRegistration({ optionsJSON: options });
  await api('/api/auth/passkey/register/verify', { method: 'POST', body: { challengeId, response, name } });
}

/** Passwordless login. Returns the JWT so the caller can bootstrap the session like signup does. */
export async function loginWithPasskey(): Promise<string> {
  const { options, challengeId } = await api<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>(
    '/api/auth/passkey/login/options', { method: 'POST', body: {} });
  const response = await startAuthentication({ optionsJSON: options });
  const { token } = await api<{ token: string }>(
    '/api/auth/passkey/login/verify', { method: 'POST', body: { challengeId, response } });
  return token;
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const { credentials } = await api<{ credentials: PasskeyInfo[] }>('/api/auth/passkey/list');
  return credentials;
}

export async function deletePasskey(id: number): Promise<void> {
  await api(`/api/auth/passkey/${id}`, { method: 'DELETE' });
}
