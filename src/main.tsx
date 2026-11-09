import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { isUpdateBlocked } from './lib/updateGuard';
import { hasPendingFavoritesPayload } from './lib/favoritesTransfer';

if ('serviceWorker' in navigator) {
  if (!import.meta.env.DEV) {
    let hadController = !!navigator.serviceWorker.controller;
    let updatePending = false;
    let registration: ServiceWorkerRegistration | undefined;
    let applyRequested = false;
    let applyTimer: ReturnType<typeof setTimeout> | undefined;
    const button = document.createElement('button');
    button.textContent = '更新があります。再読み込み';
    button.className = 'fixed top-16 right-4 z-[100] rounded bg-sky-900 p-3 text-white disabled:opacity-50';
    button.hidden = true;
    document.body.appendChild(button);
    const refreshState = () => {
      button.hidden = !updatePending;
      button.disabled = isUpdateBlocked() || hasPendingFavoritesPayload();
      if (button.disabled) applyRequested = false;
      button.textContent = button.disabled ? '編集・取り込みの完了後に更新できます' : '更新があります。再読み込み';
    };
    button.onclick = () => {
      refreshState();
      if (button.disabled) return;
      if (!registration?.waiting) { window.location.reload(); return; }
      // A ready worker can still be waiting in the browser. Apply only on a safe user action.
      applyRequested = true;
      registration.waiting.postMessage({ type: 'RAIN3D_APPLY_UPDATE' });
      clearTimeout(applyTimer);
      applyTimer = setTimeout(() => { applyRequested = false; refreshState(); }, 10000);
    };
    window.addEventListener('rain3d-update-state', refreshState);
    window.addEventListener('hashchange', refreshState);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      updatePending = true;
      refreshState();
      if (applyRequested && !button.disabled) {
        clearTimeout(applyTimer);
        window.location.reload();
      }
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          registration = reg;
          const checkWaiting = () => {
            if (reg.waiting && navigator.serviceWorker.controller) { updatePending = true; refreshState(); }
          };
          const watchInstalling = () => {
            reg.installing?.addEventListener('statechange', checkWaiting);
            checkWaiting();
          };
          reg.addEventListener('updatefound', watchInstalling);
          watchInstalling();
          reg.update().catch(() => {});
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
              reg.update().catch(() => {});
            }
          });
        })
        .catch((err) => {
          console.warn('Service Worker registration skipped:', err);
        });
    });
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
