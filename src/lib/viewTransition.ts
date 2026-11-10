import { flushSync } from 'react-dom';

export type ViewTransitionCallback = () => Promise<void> | void;

let latestTransition = 0;

/**
 * ブラウザネイティブの View Transitions API ラッパーユーティリティ。
 * 未対応ブラウザでは即座にコールバックを実行して安全にフォールバックします。
 * Reactの状態更新を同期的にDOMへ反映するため flushSync を併用し、
 * トランジション完了後にアクセシビリティ用のフォーカス移動もオプションで実行可能です。
 */
export function runViewTransition(
  callback: ViewTransitionCallback,
  options?: { focusTargetSelector?: string }
): void {
  const generation = ++latestTransition;
  const reportFailure = (phase: string, error: unknown) => {
    console.error(`View transition ${phase} failed:`, error);
  };
  const applyFocus = () => {
    if (generation !== latestTransition || typeof document === 'undefined' || document.visibilityState === 'hidden') return;
    if (options?.focusTargetSelector) {
      const target = document.querySelector<HTMLElement>(options.focusTargetSelector);
      if (target?.isConnected && !target.closest('[hidden], [inert], [aria-hidden="true"]') &&
          !target.matches(':disabled') && target.getClientRects().length > 0) {
        target.focus({ preventScroll: true });
      }
    }
  };

  let updateStarted = false;
  const update = () => {
    updateStarted = true;
    let result: ReturnType<ViewTransitionCallback> = undefined;
    flushSync(() => { result = callback(); });
    // Preserve the async contract: the browser must observe completion/failure.
    return result;
  };
  const withoutAnimation = () => {
    try {
      void Promise.resolve(update()).then(applyFocus, error => reportFailure('update', error))
        .catch(error => reportFailure('focus', error));
    } catch (error) {
      reportFailure('update', error);
    }
  };

  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    withoutAnimation();
    return;
  }

  // prefers-reduced-motion が有効な場合は即座に状態更新のみ実行
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    withoutAnimation();
    return;
  }

  try {
    const transition = document.startViewTransition(update);
    // Observe all three promises immediately. A skipped animation rejects ready
    // while the state update and finished can still succeed. Report actual update
    // errors once, including AbortError thrown by the callback itself.
    void Promise.allSettled([transition.ready, transition.updateCallbackDone, transition.finished])
      .then(([ready, updated, finished]) => {
        if (updated.status === 'rejected') {
          reportFailure('update', updated.reason);
          return;
        }
        if (finished.status === 'rejected') {
          reportFailure('completion', finished.reason);
          return;
        }
        if (ready.status === 'rejected' && ready.reason?.name !== 'AbortError') {
          reportFailure('animation', ready.reason);
        }
        applyFocus();
      }).catch(error => reportFailure('focus', error));
  } catch (error) {
    reportFailure('start', error);
    // A failure to start an animation must not drop or repeat the state update.
    if (!updateStarted) withoutAnimation();
  }
}
