import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import React, { useState } from 'react';
import { runViewTransition } from '../src/lib/viewTransition';

// Perspectives: state commits and async failure; interruption/order boundaries;
// focus on visible/current UI; API/reduced-motion differences. No storage mocks:
// favorite persistence and real animation promises are covered by the VT E2E.
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transition() {
  const ready = deferred(), updated = deferred(), finished = deferred();
  return { ready, updated, finished, api: {
    ready: ready.promise, updateCallbackDone: updated.promise, finished: finished.promise,
  }, complete() { ready.resolve(); updated.resolve(); finished.resolve(); } };
}
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const originalStart = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
let root: Root | undefined;
let errorLog: ReturnType<typeof vi.spyOn>;
function installStart(start: unknown) {
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
}
function button(id = 'target') {
  const target = document.createElement('button'); target.id = id;
  document.body.append(target);
  vi.spyOn(target, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  return { target, focus: vi.spyOn(target, 'focus') };
}
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  if (root) { flushSync(() => root!.unmount()); root = undefined; }
  document.body.replaceChildren(); vi.restoreAllMocks();
  if (originalStart) Object.defineProperty(document, 'startViewTransition', originalStart);
  else delete (document as any).startViewTransition;
});

describe('runViewTransition', () => {
  it('commits once and focuses only after a successful animation completes', async () => {
    const t = transition(), update = vi.fn(), { focus } = button();
    installStart((callback: () => void) => { callback(); return t.api; });
    runViewTransition(update, { focusTargetSelector: '#target' });
    expect(update).toHaveBeenCalledTimes(1);
    t.ready.resolve(); t.updated.resolve(); await drain(); expect(focus).not.toHaveBeenCalled();
    t.finished.resolve(); await drain();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true }); expect(errorLog).not.toHaveBeenCalled();
  });

  it.each([true, false])('overlapping updates retain state but only the latest can focus (latest target=%s)', async latestHasTarget => {
    const first = transition(), last = transition();
    const a = button('a'), b = button('b'); const updates: string[] = [];
    installStart(vi.fn().mockImplementationOnce((cb: () => void) => { cb(); return first.api; })
      .mockImplementationOnce((cb: () => void) => { cb(); return last.api; }));
    runViewTransition(() => { updates.push('a'); }, { focusTargetSelector: '#a' });
    runViewTransition(() => { updates.push('b'); }, latestHasTarget ? { focusTargetSelector: '#b' } : undefined);
    last.complete(); await drain();
    first.ready.reject(new DOMException('superseded', 'AbortError'));
    first.updated.resolve(); first.finished.resolve(); await drain();
    expect(updates).toEqual(['a', 'b']); expect(a.focus).not.toHaveBeenCalled();
    expect(b.focus).toHaveBeenCalledTimes(latestHasTarget ? 1 : 0);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each(['Error', 'AbortError'])('reports a genuine update %s once without moving focus', async name => {
    const t = transition(), { focus } = button(); const failure = new DOMException('update failed', name);
    installStart((cb: () => void) => { try { cb(); } catch (error) {
      t.ready.reject(error); t.updated.reject(error); t.finished.reject(error);
    } return t.api; });
    runViewTransition(() => { throw failure; }, { focusTargetSelector: '#target' }); await drain();
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('View transition update failed:', failure);
    expect(focus).not.toHaveBeenCalled();
  });

  it('passes the asynchronous update promise to the browser', async () => {
    const t = transition(), pending = deferred(); let returned: unknown;
    installStart((cb: () => unknown) => { returned = cb(); return t.api; });
    runViewTransition(() => pending.promise);
    expect(returned).toBe(pending.promise);
    pending.resolve(); t.complete(); await drain(); expect(errorLog).not.toHaveBeenCalled();
  });

  it('diagnoses non-abort animation failure while retaining successful update and focus', async () => {
    const t = transition(), { focus } = button(), update = vi.fn();
    installStart((cb: () => void) => { cb(); return t.api; });
    runViewTransition(update, { focusTargetSelector: '#target' });
    const error = new DOMException('duplicate transition names', 'InvalidStateError');
    t.ready.reject(error); t.updated.resolve(); t.finished.resolve(); await drain();
    expect(update).toHaveBeenCalledTimes(1); expect(focus).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('View transition animation failed:', error);
  });

  it.each(['removed', 'hidden', 'inert', 'aria-hidden', 'disabled', 'no-layout', 'background'])('does not focus a %s target/page', async state => {
    const t = transition(), { target, focus } = button();
    installStart((cb: () => void) => { cb(); return t.api; });
    runViewTransition(() => {}, { focusTargetSelector: '#target' });
    if (state === 'removed') target.remove();
    else if (state === 'no-layout') vi.mocked(target.getClientRects).mockReturnValue([] as unknown as DOMRectList);
    else if (state !== 'background') target.setAttribute(state, state === 'aria-hidden' ? 'true' : '');
    if (state === 'background') vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    t.complete(); await drain(); expect(focus).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'reduced-motion'])('flushes React before focusing with %s', async mode => {
    const start = vi.fn(); installStart(mode === 'unsupported' ? undefined : start);
    vi.mocked(window.matchMedia).mockReturnValue({ matches: mode === 'reduced-motion' } as MediaQueryList);
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    let show!: () => void;
    function Fixture() {
      const [visible, setVisible] = useState(false); show = () => setVisible(true);
      return visible ? <button id="new-target" ref={el => {
        if (el) vi.spyOn(el, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
      }}>New</button> : null;
    }
    flushSync(() => root!.render(<Fixture />));
    runViewTransition(show, { focusTargetSelector: '#new-target' }); await drain();
    expect(document.activeElement?.id).toBe('new-target'); expect(start).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('waits for async fallback completion and diagnoses rejection without focus', async () => {
    installStart(undefined); const pending = deferred(), { focus } = button();
    runViewTransition(() => pending.promise, { focusTargetSelector: '#target' }); await drain();
    expect(focus).not.toHaveBeenCalled();
    const error = new Error('async update'); pending.reject(error); await drain();
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('View transition update failed:', error);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each([false, true])('start failure does not drop or repeat update (already started=%s)', async started => {
    const update = vi.fn(), error = new Error('start');
    installStart((cb: () => void) => { if (started) cb(); throw error; });
    runViewTransition(update); await drain(); expect(update).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('View transition start failed:', error);
  });
});
