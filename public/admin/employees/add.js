// Add-employee form (UC-A3 step 1). Two modes wired into a single <form>:
//   - 'create' (default): collect name+role and POST /api/users (which also
//     inserts the first attachment via the `attachments` array).
//   - 'attach': collected when the typed email matches an existing user
//     (alt flow A3.a). name/role are hidden; submit POSTs to
//     /api/users/:id/attachments.
//
// The email-blur lookup is the only path that flips into attach mode from
// the Add form itself — the explicit "Attach existing employee" toggle in
// the same card (see `./attach.js`) is the alternate entry point.

import { api, esc, dollarsToCents, onSubmit } from '../../api.js';

// UC-A3: when an admin types an email that already belongs to a user, surface
// the match and offer to switch the form into "attach to claimant" mode
// (alt flow A3.a — cross-claimant onboarding). The server already rejects
// duplicate emails (UNIQUE constraint on users.email + 409 in
// src/routes/users.js), so without this UX the admin gets an unhelpful
// "email already exists" error and no path forward.
export function bindAddEmployeeForm(ctx) {
  const form = document.getElementById('add-employee-form');
  if (!form) return;
  const emailInput = form.querySelector('input[name="email"]');
  const notice     = form.querySelector('#add-employee-existing');
  const submitBtn  = form.querySelector('[data-submit-label]');
  let existingUserId = null;   // populated when admin opts into attach mode

  const setMode = (mode, user) => {
    form.dataset.mode = mode;
    existingUserId = mode === 'attach' ? user.id : null;
    form.querySelectorAll('[data-only-create]').forEach(el => {
      el.hidden = mode === 'attach';
      el.querySelectorAll('input, select').forEach(i => { i.disabled = mode === 'attach'; });
    });
    const nameInput = form.querySelector('input[name="name"]');
    if (nameInput) nameInput.required = mode === 'create';
    submitBtn.textContent = mode === 'attach' ? 'Attach' : 'Add';
  };

  const lookupEmail = async () => {
    const email = (emailInput.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      notice.hidden = true; notice.innerHTML = ''; setMode('create');
      return;
    }
    try {
      const r = await api('GET', `/api/users?q=${encodeURIComponent(email)}`);
      const match = (r.items || []).find(u => (u.email || '').toLowerCase() === email);
      if (!match) {
        notice.hidden = true; notice.innerHTML = ''; setMode('create');
        return;
      }
      notice.hidden = false;
      notice.innerHTML =
        `User <strong>${esc(match.name)}</strong> (${esc(match.email)}) already exists.
         Switch to attach-to-claimant mode?
         <button type="button" class="small" data-attach-yes>Yes</button>
         <button type="button" class="small secondary" data-attach-no>No</button>`;
      notice.querySelector('[data-attach-yes]').addEventListener('click', () => {
        setMode('attach', match);
        notice.innerHTML =
          `Attach to claimant — creating a new attachment under
           <strong>${esc(match.name)}</strong>. Submit POSTs to the existing user.`;
      });
      notice.querySelector('[data-attach-no]').addEventListener('click', () => {
        notice.hidden = true; notice.innerHTML = ''; setMode('create');
      });
    } catch {
      // search failed — degrade silently to create mode; the server will
      // reject a duplicate email on submit with a clear 409.
      notice.hidden = true; notice.innerHTML = ''; setMode('create');
    }
  };

  // Trigger on blur. Debounced keyup is also reasonable but blur is the
  // simpler model: admin types a complete email, tabs out, sees the prompt.
  emailInput.addEventListener('blur', lookupEmail);

  // Comp-type dropdown flips the unit suffix on the dollar input ($/yr vs $/hr).
  // The stored field still posts as amount_cents — only the label changes.
  const compTypeSel = form.querySelector('[data-comp-type-for="add-employee"]');
  const compUnitEl  = form.querySelector('[data-comp-unit-for="add-employee"]');
  if (compTypeSel && compUnitEl) {
    const sync = () => { compUnitEl.textContent = compTypeSel.value === 'hourly' ? '($/hr)' : '($/yr)'; };
    compTypeSel.addEventListener('change', sync);
    sync();
  }

  onSubmit(form, async (fd) => {
    const employmentStart = fd.get('employment_start_date') || null;
    // Effective_from defaults to employment start date when blank (UC-A3
    // step 1 spec lists employment start date as the primary field; the
    // first comp row should inherit it unless the admin overrides).
    const effectiveFrom = fd.get('effective_from') || employmentStart;
    if (!effectiveFrom)
      throw new Error('Provide an employment start date or an effective-from date for the first comp row.');

    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 95000 or 95000.00).');

    const attachment = {
      claimant_id: Number(fd.get('claimant_id')),
      title: fd.get('title') || null,
      is_specified_employee: fd.get('is_specified_employee') === 'on',
      employment_start_date: employmentStart,
      compensation: {
        comp_type: fd.get('comp_type'),
        amount_cents: amountCents,
        effective_from: effectiveFrom,
      },
    };

    if (form.dataset.mode === 'attach' && existingUserId) {
      await api('POST', `/api/users/${existingUserId}/attachments`, attachment);
    } else {
      await api('POST', '/api/users', {
        email: fd.get('email'),
        name: fd.get('name'),
        role: fd.get('role') || 'employee',
        attachments: [attachment],
      });
    }
    notice.hidden = true; notice.innerHTML = '';
    form.reset();
    setMode('create');
    await ctx.reloadAll();
  });
}
