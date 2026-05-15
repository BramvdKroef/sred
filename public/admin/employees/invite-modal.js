import { esc } from '../../api.js';

// Renders a small <dialog> showing invite metadata (target user, purpose,
// relative expiry, delivery status). The raw magic link is intentionally
// NOT shown — V-06's fix removed it from the API response body so an admin
// can't silently mint a sign-in link for another admin. When SMTP is
// disabled the link is logged to stderr; when enabled it's emailed straight
// to the target.
//
// <dialog> over a custom overlay because the SPA has zero existing modal
// CSS, and <dialog> ships native ::backdrop, focus-trap, and Esc-to-close.
// Browser support is fine for an admin-only tool (Chrome/Edge/Safari/Firefox
// all ship `showModal()` since 2022); the fallback path (`.show()`) is
// non-modal but still visible if `showModal` is somehow unavailable.
export function showInviteModal(response, target) {
  // Reuse a single modal element across clicks so we don't pile them up.
  let dlg = document.getElementById('invite-modal');
  if (dlg) dlg.remove();

  const email = target?.email || 'the user';
  const name  = target?.name  || 'User';
  const purposeLabel = response.purpose === 'invite' ? 'Invite (first passkey)' : 'Add device (additional passkey)';
  const expiresRel   = relativeExpiry(response.expires_at);
  const deliveryLine = response.delivered
    ? `Sent to <strong>${esc(email)}</strong>`
    : 'Email delivery is disabled. The magic link was logged to the server console — check stderr.';

  dlg = document.createElement('dialog');
  dlg.id = 'invite-modal';
  dlg.className = 'modal';
  dlg.innerHTML = `
    <h3 class="modal-title">${esc(purposeLabel)}</h3>
    <p class="modal-line"><strong>${esc(name)}</strong> &lt;${esc(email)}&gt;</p>
    <p class="modal-line muted">Expires in ${esc(expiresRel)}</p>
    <p class="modal-body">${deliveryLine}</p>
    <div class="actions mt-md"><button type="button" class="small" data-close>Close</button></div>
  `;
  document.body.appendChild(dlg);
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.show?.();
}

// "expires in 24 hours" / "in 7 minutes" / "in the past" — coarse-grained
// because the invite endpoint already names a fixed TTL and admins just
// want a sanity check, not precision.
function relativeExpiry(iso) {
  if (!iso) return 'an unknown time';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return 'an unknown time';
  if (ms <= 0) return 'the past';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
