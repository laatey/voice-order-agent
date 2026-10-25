require('dotenv').config();

const express              = require('express');
const http                 = require('http');
const { WebSocketServer }  = require('ws');
const db                   = require('./db');
const webhookRouter        = require('./routes/webhook');
const apiRouter            = require('./routes/api');
const { handleConnection } = require('./websocket/mediaStream');

// ─── Auto-detect public URL from Replit environment if not set ────────────────
if (!process.env.PUBLIC_URL && process.env.REPLIT_DEV_DOMAIN) {
  process.env.PUBLIC_URL = `https://${process.env.REPLIT_DEV_DOMAIN}`;
}

// ─── Validate required env vars ───────────────────────────────────────────────
const REQUIRED_ENV = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY', 'PUBLIC_URL'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.warn(`[boot] Warning: missing env vars: ${missingEnv.join(', ')}`);
  console.warn('[boot] Voice agent functionality will be limited until these are configured.');
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use('/webhook', webhookRouter);
app.use('/api',     apiRouter);

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (ws, req) => {
  console.log(`[wss] new connection from ${req.socket.remoteAddress}`);
  
  // Keep connection alive on proxy platforms like Railway
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  
  handleConnection(ws);
});

const keepAliveInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(keepAliveInterval);
});

wss.on('error', (err) => console.error('[wss] error', err));

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await db.init();

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║          AI Voice Agent — Online                 ║
╠══════════════════════════════════════════════════╣
║  HTTP   : http://localhost:${PORT}
║  WS     : ws://localhost:${PORT}/media-stream
║  Health : http://localhost:${PORT}/health
║  Public : ${process.env.PUBLIC_URL}
╚══════════════════════════════════════════════════╝
    `);
  });
}

boot().catch(err => { console.error('[boot] fatal', err); process.exit(1); });

process.on('SIGTERM', () => { console.log('[boot] SIGTERM'); server.close(() => process.exit(0)); });
process.on('unhandledRejection', (r) => console.error('[unhandled]', r));
