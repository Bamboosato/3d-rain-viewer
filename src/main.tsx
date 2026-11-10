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
    const notice = document.createElement('div');
    notice.className = 'app-update-notice';
    notice.setAttribute('role', 'region');
    notice.setAttribute('aria-label', 'アプリの更新');
    const copy = document.createElement('div');
    const message = document.createElement('p');
    message.id = 'app-update-message';
    message.textContent = '新しいバージョンがあります';
    message.setAttribute('role', 'status');
    const reason = document.createElement('p');
    reason.id = 'app-update-reason';
    reason.className = 'app-update-reason';
    reason.textContent = '編集・取り込みの完了後に更新できます';
    reason.hidden = true;
    copy.append(message, reason);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '更新';
    button.className = 'app-update-button';
    notice.append(copy, button);
    notice.hidden = true;
    document.body.appendChild(notice);
    const refreshState = () => {
      notice.hidden = !updatePending;
      button.disabled = isUpdateBlocked() || hasPendingFavoritesPayload();
      if (button.disabled) applyRequested = false;
      reason.hidden = !button.disabled;
      button.setAttribute('aria-describedby', button.disabled ? 'app-update-message app-update-reason' : 'app-update-message');
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
