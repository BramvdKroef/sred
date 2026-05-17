import { Router } from 'express';
import authRouter from './auth.js';
import claimantsRouter from './claimants.js';
import projectsRouter from './projects.js';
import usersRouter from './users.js';
import userClaimantsRouter from './user-claimants.js';
import labourRouter, { labourImportRouter } from './labour.js';
import periodsRouter from './periods.js';
import evidenceRouter from './evidence.js';
import expensesRouter from './expenses.js';
import exportsRouter from './exports.js';
import auditLogRouter from './audit-log.js';

const api = Router();

api.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// /api/webauthn/*, /api/recovery, /api/logout, /api/me
api.use('/', authRouter);
api.use('/users', usersRouter);
api.use('/user-claimants', userClaimantsRouter);
api.use('/claimants', claimantsRouter);
api.use('/projects', projectsRouter);
api.use('/labour', labourRouter);
// CSV bulk import — admin only. Separate mount so the path matches the
// public spec without colliding with /api/labour/:id.
api.use('/labour-logs', labourImportRouter);
api.use('/periods', periodsRouter);
api.use('/evidence', evidenceRouter);
api.use('/expenses', expensesRouter);
api.use('/exports', exportsRouter);
api.use('/audit-log', auditLogRouter);

export default api;
