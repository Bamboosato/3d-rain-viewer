import { useEffect } from 'react';
const blockers = new Set<symbol>();
export function isUpdateBlocked(): boolean { return blockers.size > 0; }
export function useUpdateBlocker(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const token = Symbol();
    blockers.add(token);
    window.dispatchEvent(new Event('rain3d-update-state'));
    return () => { blockers.delete(token); window.dispatchEvent(new Event('rain3d-update-state')); };
  }, [active]);
}
