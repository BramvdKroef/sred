import { Router } from 'express';
import authRouter from './auth.js';

const api = Router();

api.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// /api/webauthn/*, /api/recovery, /api/logout, /api/me
api.use('/', authRouter);

// TODO: mount resource routers here as they're built:
// api.use('/users',     usersRouter);
// api.use('/claimants', claimantsRouter);
// api.use('/periods',   periodsRouter);
// api.use('/projects',  projectsRouter);
// api.use('/labour',    labourRouter);
// api.use('/evidence',  evidenceRouter);
// api.use('/expenses',  expensesRouter);
// api.use('/exports',   exportsRouter);

export default api;
