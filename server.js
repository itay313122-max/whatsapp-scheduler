const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SCHEDULES_FILE = path.join('/data', 'schedules.json');

// ─── State ─────────────────────────────────────────────────────────────────
let currentQR = null;
let isConnected = false;
let clientInfo = null;
const activeCronJobs = {};   // id → cron task  (recurring)
const activeTimeouts  = {};  // id → timeout handle (one-time)

// ─── Schedules Store ───────────────────────────────────────────────────────
function loadSchedules() {
  if (!fs.existsSync(SCHEDULES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')); }
  catch { return []; }
}

function saveSchedules(schedules) {
  const dir = path.dirname(SCHEDULES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972')) return `${digits}@c.us`;
  if (digits.startsWith('0'))   return `972${digits.slice(1)}@c.us`;
  return `972${digits}@c.us`;
}

// ─── WhatsApp Client ───────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/data/.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

client.on('qr', async (qr) => {
  console.log('📱 QR generated');
  currentQR = await qrcode.toDataURL(qr);
  isConnected = false;
});

client.on('ready', () => {
  console.log('✅ WhatsApp connected');
  currentQR = null;
  isConnected = true;
  clientInfo = client.info;
  restoreSchedules();
});

client.on('auth_failure', () => {
  console.error('❌ Auth failed');
  isConnected = false;
});

client.on('disconnected', () => {
  console.log('⚠️  Disconnected');
  isConnected = false;
  clientInfo = null;
});

// ─── Recurring cron job ────────────────────────────────────────────────────
function startCronJob(schedule) {
  if (activeCronJobs[schedule.id]) activeCronJobs[schedule.id].stop();

  activeCronJobs[schedule.id] = cron.schedule(schedule.cronExpression, async () => {
    if (!isConnected) return;
    try {
      await client.sendMessage(formatPhone(schedule.phone), schedule.message);
      console.log(`📤 [${schedule.id}] Sent to ${schedule.phone}`);
      const all = loadSchedules();
      const s = all.find(x => x.id === schedule.id);
      if (s) { s.lastSent = new Date().toISOString(); s.sentCount = (s.sentCount || 0) + 1; saveSchedules(all); }
    } catch (err) {
      console.error(`❌ [${schedule.id}] Failed:`, err.message);
    }
  });
}

// ─── One-time job ─────────────────────────────────────────────────────────
function scheduleOnce(schedule) {
  const delay = new Date(schedule.sendAt).getTime() - Date.now();
  if (delay <= 0) return; // already passed

  if (activeTimeouts[schedule.id]) {
    clearTimeout(activeTimeouts[schedule.id]);
    delete activeTimeouts[schedule.id];
  }

  activeTimeouts[schedule.id] = setTimeout(async () => {
    delete activeTimeouts[schedule.id];

    if (!isConnected) {
      console.error(`❌ [${schedule.id}] One-time skipped — not connected`);
    } else {
      try {
        await client.sendMessage(formatPhone(schedule.phone), schedule.message);
        console.log(`📤 [${schedule.id}] One-time sent to ${schedule.phone}`);
      } catch (err) {
        console.error(`❌ [${schedule.id}] One-time failed:`, err.message);
      }
    }

    const all = loadSchedules();
    const s = all.find(x => x.id === schedule.id);
    if (s) {
      s.active    = false;
      s.lastSent  = new Date().toISOString();
      s.sentCount = (s.sentCount || 0) + 1;
      saveSchedules(all);
    }
  }, delay);
}

// ─── Restore after restart ─────────────────────────────────────────────────
function restoreSchedules() {
  const schedules = loadSchedules();
  let restored = 0;
  const now = Date.now();

  for (const s of schedules) {
    if (s.type === 'once') {
      if (!s.active || !s.sendAt) continue;
      if (new Date(s.sendAt).getTime() <= now) {
        console.log(`⏩ [${s.id}] one-time sendAt already passed, skipping`);
        continue;
      }
      scheduleOnce(s);
      restored++;
    } else {
      if (s.active && cron.validate(s.cronExpression)) {
        startCronJob(s);
        restored++;
      }
    }
  }
  console.log(`🔄 Restored ${restored} scheduled jobs`);
}

// ─── API Routes ────────────────────────────────────────────────────────────

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    connected:  isConnected,
    hasQR:      !!currentQR,
    phone:      clientInfo?.wid?.user || null,
    name:       clientInfo?.pushname  || null,
    activeJobs: Object.keys(activeCronJobs).length + Object.keys(activeTimeouts).length,
  });
});

// GET /api/qr
app.get('/api/qr', (req, res) => {
  if (!currentQR) {
    return res.status(404).json({ error: isConnected ? 'Already connected' : 'QR not ready yet' });
  }
  res.json({ qr: currentQR });
});

// POST /api/send
app.post('/api/send', async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp not connected' });
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'Missing phone or message' });
  try {
    const chatId = formatPhone(phone);
    await client.sendMessage(chatId, message);
    res.json({ success: true, sentTo: chatId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedule  (recurring cron)
app.post('/api/schedule', (req, res) => {
  const { id, phone, message, cronExpression } = req.body;
  if (!id || !phone || !message || !cronExpression)
    return res.status(400).json({ error: 'Missing: id, phone, message, cronExpression' });
  if (!cron.validate(cronExpression))
    return res.status(400).json({ error: `Invalid cron expression: "${cronExpression}"` });

  const schedules = loadSchedules();
  const existing  = schedules.find(s => s.id === id);

  if (existing) {
    Object.assign(existing, { phone: phone.replace(/\D/g, ''), message, cronExpression, active: true, updatedAt: new Date().toISOString() });
    saveSchedules(schedules);
    startCronJob(existing);
    return res.json({ success: true, schedule: existing, action: 'updated' });
  }

  const newSchedule = { id, phone: phone.replace(/\D/g, ''), message, cronExpression, active: true, sentCount: 0, lastSent: null, createdAt: new Date().toISOString() };
  schedules.push(newSchedule);
  saveSchedules(schedules);
  startCronJob(newSchedule);
  res.json({ success: true, schedule: newSchedule, action: 'created' });
});

// POST /api/schedule-once  (single future message)
app.post('/api/schedule-once', (req, res) => {
  const { id, phone, message, sendAt } = req.body;
  if (!id || !phone || !message || !sendAt)
    return res.status(400).json({ error: 'Missing: id, phone, message, sendAt' });

  const fireAt = new Date(sendAt);
  if (isNaN(fireAt.getTime()))
    return res.status(400).json({ error: `Invalid sendAt: "${sendAt}" — use ISO 8601 (e.g. "2025-05-22T15:30:00")` });
  if (fireAt.getTime() <= Date.now())
    return res.status(400).json({ error: 'sendAt must be in the future' });

  const schedules = loadSchedules();
  const existing  = schedules.find(s => s.id === id);

  if (existing) {
    if (activeTimeouts[id]) { clearTimeout(activeTimeouts[id]); delete activeTimeouts[id]; }
    Object.assign(existing, { phone: phone.replace(/\D/g, ''), message, sendAt: fireAt.toISOString(), active: true, type: 'once', updatedAt: new Date().toISOString() });
    saveSchedules(schedules);
    scheduleOnce(existing);
    return res.json({ success: true, schedule: existing, action: 'updated' });
  }

  const newSchedule = { id, type: 'once', phone: phone.replace(/\D/g, ''), message, sendAt: fireAt.toISOString(), active: true, sentCount: 0, lastSent: null, createdAt: new Date().toISOString() };
  schedules.push(newSchedule);
  saveSchedules(schedules);
  scheduleOnce(newSchedule);
  res.json({ success: true, schedule: newSchedule, action: 'created' });
});

// DELETE /api/schedule/:id
app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: `Schedule "${id}" not found` });

  if (activeCronJobs[id]) { activeCronJobs[id].stop(); delete activeCronJobs[id]; }
  if (activeTimeouts[id])  { clearTimeout(activeTimeouts[id]); delete activeTimeouts[id]; }

  schedules.splice(idx, 1);
  saveSchedules(schedules);
  res.json({ success: true, deleted: id });
});

// GET /api/schedules
app.get('/api/schedules', (req, res) => {
  const schedules = loadSchedules();
  const visible = schedules.filter(s => s.type !== 'once' || s.active);
  res.json(visible.map(s => ({
    ...s,
    isRunning: !!(activeCronJobs[s.id] || activeTimeouts[s.id]),
  })));
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  client.initialize();
});
