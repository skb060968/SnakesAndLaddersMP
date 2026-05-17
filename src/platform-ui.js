/* Platform-level UI helpers — screen management + toast notifications. */

/**
 * Hides all .screen elements and shows the one matching screenId.
 */
export function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.setAttribute('hidden', ''));
  const target = document.getElementById(screenId);
  if (target) target.removeAttribute('hidden');
}

let _toastTimer = null;

/**
 * Shows a transient toast message at the bottom of the screen.
 */
export function showToast(message, durationMs = 1500) {
  let toast = document.getElementById('game-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'game-toast';
    toast.className = 'game-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove('fade-out');
  // Force reflow so re-applying class restarts the animation
  void toast.offsetWidth;
  toast.classList.add('fade-out');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, durationMs);
}
