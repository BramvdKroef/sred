// UC-A3 step 3 / alt flow A3.a — top-level entry point for attaching an
// existing user (from another claimant) to the current one without going
// through the Add-employee form's email-blur lookup or the edit-user
// drill-in. Hidden by default behind a button next to "Add employee".
//
// The markup lives in the list-view card (rendered by ./list.js) so the
// admin sees both options together; this module just binds the toggle +
// submit handlers.

import { api, dollarsToCents, onSubmit } from '../../api.js';

export function bindAttachExistingForm(ctx) {
  const toggle = document.getElementById('attach-existing-toggle');
  const wrap   = document.getElementById('attach-existing-form-wrap');
  const form   = document.getElementById('attach-existing-form');
  if (!toggle || !wrap || !form) return;

  toggle.addEventListener('click', () => {
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) form.querySelector('input[name="email"]').focus();
  });

  // Same $/yr ↔ $/hr suffix flip as the Add-employee form.
  const compTypeSel = form.querySelector('[data-comp-type-for="attach-existing"]');
  const compUnitEl  = form.querySelector('[data-comp-unit-for="attach-existing"]');
  if (compTypeSel && compUnitEl) {
    const sync = () => { compUnitEl.textContent = compTypeSel.value === 'hourly' ? '($/hr)' : '($/yr)'; };
    compTypeSel.addEventListener('change', sync);
    sync();
  }

  onSubmit(form, async (fd) => {
    const email = (fd.get('email') || '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw new Error('Enter a valid email.');

    // Look up by email — same endpoint the blur-trigger uses. If no match,
    // surface the inline error spec'd by UC-A3 alt flow.
    const r = await api('GET', `/api/users?q=${encodeURIComponent(email)}`);
    const match = (r.items || []).find(u => (u.email || '').toLowerCase() === email);
    if (!match) {
      throw new Error('No user with that email. Use the Add employee form to create them first.');
    }

    const employmentStart = fd.get('employment_start_date') || null;
    const effectiveFrom = fd.get('effective_from') || employmentStart;
    if (!effectiveFrom)
      throw new Error('Provide an employment start date or an effective-from date for the first comp row.');

    const amountCents = dollarsToCents(fd.get('amount'));
    if (amountCents == null || Number.isNaN(amountCents))
      throw new Error('Enter the amount in dollars (e.g. 95000 or 95000.00).');

    await api('POST', `/api/users/${match.id}/attachments`, {
      claimant_id: Number(fd.get('claimant_id')),
      title: fd.get('title') || null,
      is_specified_employee: fd.get('is_specified_employee') === 'on',
      employment_start_date: employmentStart,
      compensation: {
        comp_type: fd.get('comp_type'),
        amount_cents: amountCents,
        effective_from: effectiveFrom,
      },
    });
    form.reset();
    wrap.hidden = true;
    await ctx.reloadAll();
  });
}
