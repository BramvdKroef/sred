// Shared route helpers — entity loaders, period/scope checks reused by
// the labour, expense, evidence, and project flows.

import { db } from '../db/index.js';
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
// user_claimants.user_id). Used by labour/expense view/edit/delete.
//
// Contract: a missing user_claimant row collapses to `false` (treated as
// "not yours"). Callers MUST NOT use this function as a not-found signal
// for the user_claimant — load the parent entity first (which has an FK
// to user_claimants) and rely on its existence. All current callers do
// exactly that: they fetch a labour_entry / expense first, then pass its
// user_claimant_id here, so the row is guaranteed to exist by FK.
export function isOwnerOrAdmin(user, userClaimantId) {
  if (user.role === 'admin') return true;
  const uc = db.prepare(`SELECT user_id FROM user_claimants WHERE id = ?`).get(userClaimantId);
  return !!uc && uc.user_id === user.id;
}

// Labour & expense rows are immutable once approved, and locked while the
// containing fiscal period is closed.
export function assertEditable(entry) {
  if (entry.status === 'approved') {
    throw badRequest('entry is approved and locked; reject it first');
  }
  const period = db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(entry.fiscal_period_id);
  // FK protects us in practice, but an orphan period shouldn't fall
  // through silently as "editable" — surface it as notFound.
  if (!period) throw notFound('fiscal period not found');
  if (period.status === 'closed') throw badRequest('fiscal period is closed');
}
