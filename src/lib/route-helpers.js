// Shared route helpers — entity loaders, period/scope checks reused by
// the labour, expense, evidence, and project flows.

import { db } from '../db/index.js';
import { audit } from './audit.js';
import { badRequest, notFound, forbidden, unprocessable } from './errors.js';

// --- Entity loaders --------------------------------------------------------

export function getEntity(table, id, label = table) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw notFound(`${label} not found`);
  return row;
}

export const getClaimant      = id => getEntity('claimants', id, 'claimant');
export const getProject       = id => getEntity('projects', id, 'project');
export const getPeriod        = id => getEntity('fiscal_periods', id, 'fiscal period');
export const getLabourEntry   = id => getEntity('labour_entries', id, 'labour entry');
export const getExpense       = id => getEntity('expenses', id, 'expense');
export const getEvidence      = id => getEntity('evidence_items', id, 'evidence');
export const getUserClaimant  = id => getEntity('user_claimants', id, 'user_claimant');
export const getT661Export    = id => getEntity('t661_exports', id, 'export');

// --- Period inference ------------------------------------------------------

// Find the open fiscal period covering `date` for `claimantId`, or 422.
export function findOpenPeriod(claimantId, date) {
  const period = db.prepare(`
    SELECT * FROM fiscal_periods
     WHERE claimant_id = ? AND status = 'open' AND ? BETWEEN start_date AND end_date
     LIMIT 1
  `).get(claimantId, date);
  if (!period) {
    throw unprocessable(`no open fiscal period covers ${date} for claimant ${claimantId}`);
  }
  return period;
}

// --- Labour / expense scoping ----------------------------------------------

// Resolve the user_claimant id for a labour/expense POST. Admins must pass
// it explicitly; employees use their own attachment to the project's claimant.
export function resolveUserClaimant({ user, project, requestedUcId }) {
  if (user.role === 'admin') {
    // Accept stringified ints from JSON callers (the body is typically
    // parsed JSON, but route params and some clients send numbers as
    // strings). Number.isInteger("5") is false, so we cast first.
    const id = Number(requestedUcId);
    if (!Number.isInteger(id) || id < 1)
      throw badRequest('admin must specify user_claimant_id');
    const uc = getUserClaimant(id);
    if (uc.claimant_id !== project.claimant_id)
      throw badRequest("user_claimant does not belong to this project's claimant");
    if (uc.status !== 'active')
      throw badRequest('user_claimant attachment is inactive');
    return uc;
  }
  const uc = db.prepare(
    `SELECT * FROM user_claimants WHERE user_id = ? AND claimant_id = ?`
  ).get(user.id, project.claimant_id);
  if (!uc) throw forbidden('you are not attached to this claimant');
  if (uc.status !== 'active') throw forbidden('your attachment to this claimant is inactive');
  return uc;
}

// Admins see everything; employees only their own rows (joined through
// user_claimants.user_id), and only while that attachment is active. Used
// by labour/expense view/edit/delete.
//
// The attachment-status check is what closes the S-3 "deactivated employee
// can still PATCH their old rows" gap: requireAuth blocks the user-level
// `disabled` status, but the per-attachment `user_claimants.status` had no
// enforcement on the mutation path until this helper started checking it.
//
// Contract: a missing OR inactive user_claimant row collapses to `false`
// (treated as "not yours"). Callers MUST NOT use this function as a
// not-found signal for the user_claimant — load the parent entity first
// (which has an FK to user_claimants) and rely on its existence. All
// current callers do exactly that: they fetch a labour_entry / expense
// first, then pass its user_claimant_id here, so the row is guaranteed to
// exist by FK.
export function isOwnerOrAdmin(user, userClaimantId) {
  if (user.role === 'admin') return true;
  const uc = db.prepare(
    `SELECT user_id, status FROM user_claimants WHERE id = ?`
  ).get(userClaimantId);
  return !!uc && uc.user_id === user.id && uc.status === 'active';
}

// Labour & expense rows are immutable once approved, and locked while the
// containing fiscal period is closed.
//
// Exception: an admin who PATCHes their own auto-approved on-behalf entry
// (the labour/expense POST handlers auto-approve when the actor is admin)
// would otherwise be locked out of fixing a typo without going through
// reject → edit → re-approve. When `user` is passed and the entry was
// reviewed_by that same admin, we allow the edit; the route then mirrors
// the rejected-entry path (revert to pending, clear review fields) so
// the entry has to be re-approved deliberately rather than silently
// retaining its approved status across an edit.
// --- Mutate-and-audit shape ------------------------------------------------
//
// The load-before / mutate / load-after / audit dance repeats ~25 times across
// the route handlers. This pair of helpers compresses that to one call.
//
// `mutateAndAudit` loads the entity, runs the writer callback (which performs
// the UPDATE/DELETE and may throw an HttpError to abort), reloads the entity,
// and writes an audit_log row. Returns `{ before, after }` so callers can
// respond with the fresh row and/or short-circuit on no-op writes.
//
// The writer callback receives `before` so multi-step mutations (period
// re-inference, snapshot rows, transactional updates) can inline themselves
// without losing access to the pre-mutation row.
//
// `loader` is one of the entity loaders above (`getProject`, `getLabourEntry`,
// …) but can be any function `(id) -> row` that throws on not-found.
export function mutateAndAudit({ loader, entityType, id, actorUserId, action, write }) {
  const before = loader(id);
  write(before);
  const after = loader(before.id);
  audit(actorUserId, action, entityType, before.id, before, after);
  return { before, after };
}

// `createAndAudit` is the POST companion: runs the writer (which must return
// the new row's id), reloads via `loader`, and writes an audit row with
// `before = undefined`. Returns `{ after }`.
//
// The writer can optionally pass back an alternative `afterJson` object —
// useful for the small number of "metadata-only" audit rows (invite,
// evidence-package) where the captured after-state isn't the entity row
// itself but a summary blob.
export function createAndAudit({ loader, entityType, actorUserId, action, write, afterJson }) {
  const id = write();
  const after = loader(id);
  audit(actorUserId, action, entityType, after.id, undefined, afterJson ?? after);
  return { after };
}

export function assertEditable(entry, { user } = {}) {
  if (entry.status === 'approved') {
    const isAdminSelfApproved =
      user?.role === 'admin' && entry.reviewed_by_user_id === user.id;
    if (!isAdminSelfApproved) {
      throw badRequest('entry is approved and locked; reject it first');
    }
  }
  const period = db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(entry.fiscal_period_id);
  // FK protects us in practice, but an orphan period shouldn't fall
  // through silently as "editable" — surface it as notFound.
  if (!period) throw notFound('fiscal period not found');
  if (period.status === 'closed') throw badRequest('fiscal period is closed');
}
