import { Router } from 'express';
import authRouter from './auth.js';
import claimantsRouter from './claimants.js';
import projectsRouter from './projects.js';
import usersRouter from './users.js';
import userClaimantsRouter from './user-claimants.js';
import labourRouter from './labour.js';
import periodsRouter from './periods.js';
import evidenceRouter from './evidence.js';

const api = Router();

api.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// /api/webauthn/*, /api/recovery, /api/logout, /api/me
api.use('/', authRouter);
api.use('/users', usersRouter);
api.use('/user-claimants', userClaimantsRouter);
api.use('/claimants', claimantsRouter);
api.use('/projects', projectsRouter);
api.use('/labour', labourRouter);
api.use('/periods', periodsRouter);
api.use('/evidence', evidenceRouter);

// TODO: mount remaining resource routers as they're built:
// api.use('/expenses', expensesRouter);
// api.use('/exports',  exportsRouter);

export default api;
