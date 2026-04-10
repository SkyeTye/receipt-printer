const express = require('express');
const path    = require('path');
const cron    = require('node-cron');
const db      = require('./db');
const { generateDailyPrintContent, getOAuthClient, getLocalTime, getAllSettings } = require('./daily-print');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Pages
// ============================================================

app.get('/settings', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'settings.html')));

app.get('/daily', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'daily.html')));

// ============================================================
// Instant Print
// ============================================================

app.post('/print', (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is required' });
  db.prepare('INSERT INTO print_queue (content) VALUES (?)').run(message);
  res.json({ success: true });
});

// ============================================================
// ESP8266 Polling API
// ============================================================

app.get('/api/next-job', (req, res) => {
  const job = db.prepare(
    'SELECT id, content FROM print_queue WHERE status = ? ORDER BY created_at ASC LIMIT 1'
  ).get('pending');
  res.json(job || {});
});

app.post('/api/job-done/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  db.prepare(
    'UPDATE print_queue SET status = ?, done_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run('done', id);
  res.json({ success: true });
});

// ============================================================
// Settings API
// ============================================================

const ALLOWED_SETTINGS = [
  'day_start', 'day_end', 'slot_size_minutes',
  'daily_print_time', 'week_wrapped_day', 'week_wrapped_time', 'timezone',
];

app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.post('/api/settings', (req, res) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of ALLOWED_SETTINGS) {
    if (req.body[key] !== undefined) stmt.run(key, String(req.body[key]));
  }
  res.json({ success: true });
});

// ============================================================
// Time Blocks API
// ============================================================

app.get('/api/time-blocks', (req, res) => {
  const blocks = db.prepare('SELECT * FROM time_blocks ORDER BY start_time').all();
  res.json(blocks);
});

app.post('/api/time-blocks', (req, res) => {
  const { label, start_time, duration_minutes } = req.body;
  if (!label || !start_time || !duration_minutes)
    return res.status(400).json({ error: 'label, start_time, and duration_minutes are required' });

  const result = db.prepare(
    'INSERT INTO time_blocks (label, start_time, duration_minutes) VALUES (?, ?, ?)'
  ).run(label.trim(), start_time, parseInt(duration_minutes, 10));

  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/time-blocks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM time_blocks WHERE id = ?').run(id);
  res.json({ success: true });
});

// ============================================================
// Todos API
// ============================================================

app.get('/api/todos', (req, res) => {
  const todos = db.prepare(
    'SELECT * FROM todos ORDER BY completed ASC, created_at ASC'
  ).all();
  res.json(todos);
});

app.post('/api/todos', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });

  const result = db.prepare('INSERT INTO todos (text) VALUES (?)').run(text);
  res.json({ id: result.lastInsertRowid });
});

app.post('/api/todos/:id/complete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const todo = db.prepare('SELECT completed FROM todos WHERE id = ?').get(id);
  if (!todo) return res.status(404).json({ error: 'Not found' });

  const nowCompleted = todo.completed ? 0 : 1;
  db.prepare(
    'UPDATE todos SET completed = ?, completed_at = ? WHERE id = ?'
  ).run(nowCompleted, nowCompleted ? new Date().toISOString() : null, id);
  res.json({ success: true, completed: !!nowCompleted });
});

app.delete('/api/todos/:id', (req, res) => {
  db.prepare('DELETE FROM todos WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ============================================================
// Google Calendar OAuth
// ============================================================

app.get('/api/calendar/status', (req, res) => {
  const token = db.prepare('SELECT id FROM oauth_tokens WHERE id = 1').get();
  res.json({ connected: !!token });
});

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).send('GOOGLE_CLIENT_ID is not configured.');
  }
  const client = getOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt:       'consent',
    scope:        ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/daily?error=auth_failed');

  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);

    db.prepare(`
      INSERT OR REPLACE INTO oauth_tokens
        (id, access_token, refresh_token, token_type, expiry_date, scope)
      VALUES (1, ?, ?, ?, ?, ?)
    `).run(
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.token_type,
      tokens.expiry_date,
      tokens.scope
    );

    res.redirect('/daily?connected=1');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/daily?error=auth_failed');
  }
});

app.post('/auth/google/disconnect', (req, res) => {
  db.prepare('DELETE FROM oauth_tokens WHERE id = 1').run();
  res.json({ success: true });
});

// ============================================================
// Daily Print — manual trigger
// ============================================================

app.post('/api/daily-print/trigger', async (req, res) => {
  try {
    const content = await generateDailyPrintContent();
    db.prepare('INSERT INTO print_queue (content) VALUES (?)').run(content);
    res.json({ success: true });
  } catch (err) {
    console.error('Daily print trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Cron — daily print scheduler (runs every minute)
// ============================================================

cron.schedule('* * * * *', async () => {
  try {
    const s = getAllSettings();
    const timezone  = s.timezone || 'America/Los_Angeles';
    const printTime = s.daily_print_time || '08:00';
    const [targetHour, targetMinute] = printTime.split(':').map(Number);

    const { hour, minute } = getLocalTime(timezone);
    if (hour !== targetHour || minute !== targetMinute) return;

    // Prevent printing more than once per day
    const today = new Date().toISOString().split('T')[0];
    if (s.last_daily_print_date === today) return;

    console.log(`[cron] Generating daily print for ${today}`);
    const content = await generateDailyPrintContent();
    db.prepare('INSERT INTO print_queue (content) VALUES (?)').run(content);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('last_daily_print_date', today);
    console.log('[cron] Daily print queued');
  } catch (err) {
    console.error('[cron] Daily print error:', err.message);
  }
});

// ============================================================
// Start
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Receipt printer server running on port ${PORT}`));
