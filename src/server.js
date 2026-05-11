import express from 'express';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';
import api from './routes/index.js';
import { errorMiddleware } from './lib/errors.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use('/api', api);
app.use(express.static(path.join(ROOT_DIR, 'public')));

// SPA fallback for magic-link landing pages.
app.get(['/enroll', '/login'], (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});

app.use(errorMiddleware);

app.listen(config.port, () => {
  console.log(`sred listening on ${config.origin} (port ${config.port})`);
});
