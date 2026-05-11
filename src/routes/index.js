import { Router } from 'express';
import authRouter from './auth.js';
import claimantsRouter from './claimants.js';
import projectsRouter from './projects.js';

const api = Router();

api.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// /api/webauthn/*, /api/recovery, /api/logout, /api/me
api.use('/', authRouter);
api.use('/claimants', claimantsRouter);
api.use('/projects', projectsRouter);

// TODO: mount remaining resource routers as they're built:
// api.use('/users',    usersRouter);
// api.use('/periods',  periodsRouter);
// api.use('/labour',   labourRouter);
// api.use('/evidence', evidenceRouter);
// api.use('/expenses', expensesRouter);
// api.use('/exports',  exportsRouter);

export default api;
