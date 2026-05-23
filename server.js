import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import express from 'express';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import P from 'pino';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT   = process.env.PORT     || 8080;
const DATA   = process.env.DATA_DIR || '/data';
const SCHED  = path.join(DATA, 'schedules.json');
const AUTH   = path.join(DATA, 'auth');

fs.mkdirSync(AUTH, { recursive: true });
console.log('[boot] data dir:', DATA);

let qrData      = null;
let connected   = false;
let sock        = null;
let waName      = null;
let waPhone     = null;
const cronJobs  = {};
const timers    = {};

/* ── persistence ─────────────────────────────────────────────── */
function load() {
  try { return JSON.parse(fs.readFileSync(SCHED, 'utf8')); } catch { return []; }
}
function save(list) {
  fs.writeFileSync(SCHED, JSON.stringify(list, null, 2));
}

/* ── phone format ─────────────────────────────────────────────── */
function jid(phone) {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('972')) return d + '@s.whatsapp.net';
  if (d.startsWith('0'))   return '972' + d.slice(1) + '@s.whatsapp.net';
  return '972' + d + '@s.whatsapp.net';
}

/* ── send ─────────────────────────────────────────────────────── */
async function send(phone, message) {
  if (!connected || !sock) throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid(phone), { text: message });
}

/* ── WhatsApp init ────────────────────────────────────────────── */
async function startWA() {
  console.log('[wa] initializing...');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);

  sock = makeWASocket({
    auth:               state,
    printQRInTerminal:  false,
    logger:             P({ level: 'warn' }),
    browser:            ['WhatsApp Scheduler', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('[wa] QR ready');
      qrData    = await qrcode.toDataURL(qr);
      connected = false;
    }
    if (connection === 'open') {
      console.log('[wa] connected:', sock.user?.id);
      qrData    = null;
      connected = true;
      waPhone   = sock.user?.id?.split(':')[0] || null;
      waName    = sock.user?.name || null;
      restore();
    }
    if (connection === 'close') {
      connected = false;
      qrData    = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('[wa] closed, code:', code);
      if (code !== DisconnectReason.loggedOut) {
        console.log('[wa] reconnecting in 4s...');
        setTimeout(startWA, 4000);
      }
    }
  });
}

/* ── scheduler restore ───────────────────────────────────────── */
function restore() {
  for (const s of load()) {
    if (!s.active) continue;
    if (s.type === 'once' && new Date(s.sendAt) > new Date()) schedOnce(s);
    else if (s.type !== 'once' && cron.validate(s.cronExpr)) schedCron(s);
  }
  console.log('[sched] restored', load().filter(s => s.active).length, 'jobs');
}

function schedCron(s) {
  if (cronJobs[s.id]) cronJobs[s.id].stop();
  cronJobs[s.id] = cron.schedule(s.cronExpr, async () => {
    try {
      await send(s.phone, s.message);
      const list = load(), item = list.find(x => x.id === s.id);
      if (item) { item.lastSent = new Date().toISOString(); item.sentCount = (item.sentCount || 0) + 1; save(list); }
    } catch (e) { console.error('[cron] send error:', e.message); }
  });
}

function schedOnce(s) {
  const delay = new Date(s.sendAt) - Date.now();
  if (delay <= 0) return;
  timers[s.id] = setTimeout(async () => {
    try {
      await send(s.phone, s.message);
      const list = load(), item = list.find(x => x.id === s.id);
      if (item) { item.active = false; item.lastSent = new Date().toISOString(); item.sentCount = 1; save(list); }
    } catch (e) { console.error('[once] send error:', e.message); }
    delete timers[s.id];
  }, delay);
}

/* ── API ─────────────────────────────────────────────────────── */
app.get('/api/status', (_, res) => res.json({
  connected, hasQR: !!qrData, phone: waPhone, name: waName,
  activeJobs: Object.keys(cronJobs).length + Object.keys(timers).length,
}));

app.get('/api/qr', (_, res) => {
  if (!qrData) return res.status(404).json({ error: 'no QR' });
  res.json({ qr: qrData });
});

app.post('/api/send', async (req, res) => {
  if (!connected) return res.status(503).json({ error: 'not connected' });
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'missing fields' });
  try { await send(phone, message); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/schedule', (req, res) => {
  const { id, phone, message, cronExpression: cronExpr } = req.body;
  if (!id || !phone || !message || !cronExpr) return res.status(400).json({ error: 'missing fields' });
  if (!cron.validate(cronExpr)) return res.status(400).json({ error: 'invalid cron' });
  const list = load();
  const s = { id, phone: phone.replace(/\D/g,''), message, cronExpr, type: 'recurring', active: true, sentCount: 0, lastSent: null, createdAt: new Date().toISOString() };
  list.push(s); save(list);
  if (connected) schedCron(s);
  res.json({ success: true, schedule: s });
});

app.post('/api/schedule-once', (req, res) => {
  const { id, phone, message, sendAt } = req.body;
  if (!id || !phone || !message || !sendAt) return res.status(400).json({ error: 'missing fields' });
  const date = new Date(sendAt);
  if (isNaN(date) || date <= new Date()) return res.status(400).json({ error: 'invalid date' });
  const list = load();
  const s = { id, phone: phone.replace(/\D/g,''), message, sendAt: date.toISOString(), type: 'once', active: true, sentCount: 0, lastSent: null, createdAt: new Date().toISOString() };
  list.push(s); save(list);
  if (connected) schedOnce(s);
  res.json({ success: true, schedule: s });
});

app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const list = load(), idx = list.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (cronJobs[id]) { cronJobs[id].stop(); delete cronJobs[id]; }
  if (timers[id])   { clearTimeout(timers[id]); delete timers[id]; }
  list.splice(idx, 1); save(list);
  res.json({ success: true });
});

app.get('/api/schedules', (_, res) =>
  res.json(load().map(s => ({ ...s, isRunning: !!(cronJobs[s.id] || timers[s.id]) })))
);

/* ── start ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('[boot] server on port', PORT);
  startWA().catch(e => console.error('[boot] WA init failed:', e.message, e.stack));
});
