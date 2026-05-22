import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');

let currentQR = null;
let isConnected = false;
let sock = null;
let clientName = null;
let clientPhone = null;
const activeCronJobs = {};
const activeTimeouts = {};

function loadSchedules() {
  if (!fs.existsSync(SCHEDULES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')); }
  catch { return []; }
}

function saveSchedules(s) {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(s, null, 2));
}

function formatPhone(phone) {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('972')) return d + '@s.whatsapp.net';
  if (d.startsWith('0')) return '972' + d.slice(1) + '@s.whatsapp.net';
  return '972' + d + '@s.whatsapp.net';
}

async function sendMessage(phone, message) {
  if (!isConnected || !sock) throw new Error('Not connected');
  await sock.sendMessage(formatPhone(phone), { text: message });
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = await qrcode.toDataURL(qr); isConnected = false; console.log('QR generated'); }
    if (connection === 'open') {
      currentQR = null; isConnected = true;
      clientPhone = sock.user?.id?.split(':')[0] || null;
      clientName = sock.user?.name || null;
      console.log('WhatsApp connected:', clientPhone);
      restoreSchedules();
    }
    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(startWhatsApp, 3000);
    }
  });
}

function restoreSchedules() {
  for (const s of loadSchedules()) {
    if (!s.active) continue;
    if (s.type === 'once' && new Date(s.sendAt) > new Date()) scheduleOnce(s);
    else if (s.type !== 'once' && cron.validate(s.cronExpression)) startCronJob(s);
  }
}

function startCronJob(schedule) {
  if (activeCronJobs[schedule.id]) activeCronJobs[schedule.id].stop();
  activeCronJobs[schedule.id] = cron.schedule(schedule.cronExpression, async () => {
    try {
      await sendMessage(schedule.phone, schedule.message);
      const schedules = loadSchedules();
      const s = schedules.find(x => x.id === schedule.id);
      if (s) { s.lastSent = new Date().toISOString(); s.sentCount = (s.sentCount||0)+1; saveSchedules(schedules); }
    } catch(err) { console.error('Send error:', err.message); }
  });
}

function scheduleOnce(schedule) {
  const delay = new Date(schedule.sendAt) - Date.now();
  if (delay <= 0) return;
  activeTimeouts[schedule.id] = setTimeout(async () => {
    try {
      await sendMessage(schedule.phone, schedule.message);
      const schedules = loadSchedules();
      const s = schedules.find(x => x.id === schedule.id);
      if (s) { s.active = false; s.lastSent = new Date().toISOString(); s.sentCount = 1; saveSchedules(schedules); }
      delete activeTimeouts[schedule.id];
    } catch(err) { console.error('Send error:', err.message); }
  }, delay);
}

app.get('/api/status', (req, res) => res.json({ connected: isConnected, hasQR: !!currentQR, phone: clientPhone, name: clientName, activeJobs: Object.keys(activeCronJobs).length + Object.keys(activeTimeouts).length }));
app.get('/api/qr', (req, res) => { if (!currentQR) return res.status(404).json({ error: 'No QR' }); res.json({ qr: currentQR }); });
app.post('/api/send', async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'Missing fields' });
  try { await sendMessage(phone, message); res.json({ success: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/schedule', (req, res) => {
  const { id, phone, message, cronExpression } = req.body;
  if (!id||!phone||!message||!cronExpression) return res.status(400).json({ error: 'Missing fields' });
  if (!cron.validate(cronExpression)) return res.status(400).json({ error: 'Invalid cron' });
  const schedules = loadSchedules();
  const s = { id, phone: phone.replace(/\D/g,''), message, cronExpression, type: 'recurring', active: true, sentCount: 0, lastSent: null, createdAt: new Date().toISOString() };
  schedules.push(s); saveSchedules(schedules);
  if (isConnected) startCronJob(s);
  res.json({ success: true, schedule: s });
});
app.post('/api/schedule-once', (req, res) => {
  const { id, phone, message, sendAt } = req.body;
  if (!id||!phone||!message||!sendAt) return res.status(400).json({ error: 'Missing fields' });
  const date = new Date(sendAt);
  if (isNaN(date.getTime())||date<=new Date()) return res.status(400).json({ error: 'Invalid date' });
  const schedules = loadSchedules();
  const s = { id, phone: phone.replace(/\D/g,''), message, sendAt: date.toISOString(), type: 'once', active: true, sentCount: 0, lastSent: null, createdAt: new Date().toISOString() };
  schedules.push(s); saveSchedules(schedules);
  if (isConnected) scheduleOnce(s);
  res.json({ success: true, schedule: s });
});
app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (activeCronJobs[id]) { activeCronJobs[id].stop(); delete activeCronJobs[id]; }
  if (activeTimeouts[id]) { clearTimeout(activeTimeouts[id]); delete activeTimeouts[id]; }
  schedules.splice(idx, 1); saveSchedules(schedules);
  res.json({ success: true });
});
app.get('/api/schedules', (req, res) => res.json(loadSchedules().map(s => ({ ...s, isRunning: !!(activeCronJobs[s.id]||activeTimeouts[s.id]) }))));

app.listen(PORT, () => { console.log('Server on port', PORT); startWhatsApp(); });
