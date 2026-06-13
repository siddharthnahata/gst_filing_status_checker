const express = require('express');
const sessionManager = require('./services/session-manager');
const { apiKeyAuth } = require('./middleware/api-key');
const authRoutes = require('./routes/auth');
const returnsRoutes = require('./routes/returns');
const publicRoutes = require('./routes/public');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, private, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (body && (body.error || body.status === 'NOT_FILED')) {
      const ctx = {
        sessionId: req.body?.sessionId,
        gstin: req.body?.gstin,
        period: req.body?.returnPeriod || req.body?.month,
        fy: req.body?.financialYear,
      };
      console.error(`[ERR] ${req.method} ${req.path} -> ${res.statusCode} ` +
        `${JSON.stringify(body).slice(0, 1500)} ctx=${JSON.stringify(ctx)}`);
    }
    return origJson(body);
  };
  res.on('finish', () => {
    console.log(`[REQ] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use(apiKeyAuth);

app.use('/auth', authRoutes);
app.use('/returns', returnsRoutes);
app.use('/public', publicRoutes);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await sessionManager.destroyAll(); } catch (_) { /* best-effort */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[API] listening on http://127.0.0.1:${PORT}`);
});
