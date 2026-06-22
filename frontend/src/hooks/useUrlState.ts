import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** A single filter/search/sort value backed by a URL query param.
 *
 *  Use it as a drop-in for useState on list filters: the value lives in the URL,
 *  so navigating into a detail view and pressing Back restores the filter (the
 *  list re-mounts and reads the URL). This is the same pattern Receipts and
 *  Positionen use, factored out so every filtered list can share it.
 *
 *  String-typed. Pass `''` as the default for a plain search box, or `null` for
 *  an "absent = null" filter (category/konto). The default is never written to the
 *  URL (kept clean); reading an absent param returns the default.
 */
// Plain string default (e.g. a search box) → widen the literal to `string` so the
// setter accepts any string. An explicit type arg (enum / string|null) uses the
// generic overload below.
export function useUrlState(key: string, defaultValue: string): [string, (v: string) => void];
export function useUrlState<T extends string | null>(key: string, defaultValue: T): [T, (v: T) => void];
export function useUrlState<T extends string | null>(key: string, defaultValue: T): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = (raw ?? defaultValue) as T;
  const setValue = useCallback((next: T) => {
    const np = new URLSearchParams(params);
    if (next != null && next !== '' && next !== defaultValue) np.set(key, next);
    else np.delete(key);
    setParams(np, { replace: true });
  }, [key, params, setParams, defaultValue]);
  return [value, setValue];
}
