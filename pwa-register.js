/* ============================================================
   pwa-register.js — SW registration + update detection
   ============================================================ */
(() => {
  if (!('serviceWorker' in navigator)) return;

  // ── Register ──────────────────────────────────────────────
  window.addEventListener('load', async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      console.warn('[PWA] SW registration failed:', err);
      return;
    }

    // ── Detect updates ────────────────────────────────────────
    // Case A: a new SW is found while the page is open
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // New version is ready and waiting — tell it to take over immediately
          newWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });

    // Case B: controller changes (new SW just took over) → reload the page
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      // Brief toast before reload so the user knows what's happening
      _showUpdateToast(() => window.location.reload());
    });

    // Case C: SW activated and sent SW_UPDATED message
    // (handles the tab that was already open when the SW installed)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SW_UPDATED' && !refreshing) {
        refreshing = true;
        _showUpdateToast(() => window.location.reload());
      }
    });

    // Check for an update immediately on every page load
    reg.update().catch(() => {});

    // Also check whenever the user switches back to this tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });

    // Periodic background check every 30 s
    setInterval(() => reg.update().catch(() => {}), 30_000);
  });

  // ── Update toast ──────────────────────────────────────────
  function _showUpdateToast(onDone) {
    // Remove any pre-existing toast
    document.getElementById('_sw-update-toast')?.remove();

    const toast = document.createElement('div');
    toast.id = '_sw-update-toast';
    toast.style.cssText = [
      'position:fixed',
      'bottom:1.25rem',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:99999',
      'background:#1e293b',
      'color:white',
      'padding:.75rem 1.5rem',
      'border-radius:40px',
      'font-size:.875rem',
      'font-weight:600',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
      'display:flex',
      'align-items:center',
      'gap:.6rem',
      'white-space:nowrap',
      'animation:_swSlideUp .3s cubic-bezier(.4,0,.2,1) both',
    ].join(';');

    const spinner = document.createElement('span');
    spinner.style.cssText = 'width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:white;border-radius:50%;display:inline-block;animation:_swSpin .7s linear infinite;flex-shrink:0';

    toast.appendChild(spinner);
    toast.appendChild(document.createTextNode('Updating to latest version…'));
    document.body.appendChild(toast);

    // Inject keyframes once
    if (!document.getElementById('_sw-keyframes')) {
      const style = document.createElement('style');
      style.id = '_sw-keyframes';
      style.textContent = `
        @keyframes _swSlideUp {
          from { opacity:0; transform:translateX(-50%) translateY(16px); }
          to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
        @keyframes _swSpin { to { transform:rotate(360deg); } }
      `;
      document.head.appendChild(style);
    }

    // Reload after a short pause so the toast is visible
    setTimeout(() => {
      toast.remove();
      onDone();
    }, 1800);
  }

  // ── Install prompt ────────────────────────────────────────
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent('pwa:installable'));
  });

  window.installPwa = async () => {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    return outcome === 'accepted';
  };

  window.addEventListener('appinstalled', () => { deferredPrompt = null; });
})();
