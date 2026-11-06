import { flushSync } from 'react-dom';

export type ViewTransitionCallback = () => Promise<void> | void;

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
  const applyFocus = () => {
    if (options?.focusTargetSelector) {
      const target = document.querySelector<HTMLElement>(options.focusTargetSelector);
      target?.focus({ preventScroll: true });
    }
  };

  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    callback();
    applyFocus();
    return;
  }

  // prefers-reduced-motion が有効な場合は即座に状態更新のみ実行
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    callback();
    applyFocus();
    return;
  }

  const transition = document.startViewTransition(() => {
    flushSync(() => {
      callback();
    });
  });

  transition.finished.finally(() => {
    applyFocus();
  });
}
