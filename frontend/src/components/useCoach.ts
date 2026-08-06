import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/auth';

export interface CoachState {
  dismissed: string[];
  events: Record<string, boolean>;
  milestones: { receipts: number; artikelname_set: boolean };
}

/** Progressive onboarding coach (FB-01): the signed-in user's per-user progress plus the
 *  server-computed milestones the driver needs. Only active off-demo for a logged-in user
 *  (the demo is wiped nightly, so a coach there is pointless). */
export function useCoach() {
  const { user, demo } = useAuth();
  const qc = useQueryClient();
  const enabled = !!user && !demo;
  const { data } = useQuery({
    queryKey: ['coach'],
    queryFn: () => api<CoachState>('/api/onboarding/coach'),
    enabled,
    staleTime: 60_000,
  });
  const invalidate = (): void => { void qc.invalidateQueries({ queryKey: ['coach'] }); };
  const dismiss = useMutation({
    mutationFn: (stage: string) => api('/api/onboarding/coach/dismiss', { method: 'POST', body: { stage } }),
    onSuccess: invalidate,
  });
  const recordEvent = useMutation({
    mutationFn: (event: string) => api('/api/onboarding/coach/event', { method: 'POST', body: { event } }),
    onSuccess: invalidate,
  });
  const reset = useMutation({
    mutationFn: () => api('/api/onboarding/coach/reset', { method: 'POST' }),
    onSuccess: invalidate,
  });
  return { enabled, coach: data ?? null, dismiss, recordEvent, reset };
}
