const express = require('express');
const path    = require('path');
const cron    = require('node-cron');
const crypto  = require('crypto');
const db      = require('./db');
const { generateWeekWrappedContent, generateDailySummary } = require('./week-wrapped');

// Ensure a share token exists (generated once, persisted in settings)
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get('share_token')) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'share_token', crypto.randomBytes(16).toString('hex')
  );
}
const { generateDailyPrintContent, getOAuthClient, getLocalTime, getAllSettings, getTomorrowDateStr, getLocalDayUTCBounds } = require('./daily-print');

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

app.get('/week-wrapped', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'week-wrapped.html')));

app.get('/archive', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'archive.html')));

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

  // Mark in_progress immediately so it is never re-delivered if confirmation fails
  if (job) {
    db.prepare('UPDATE print_queue SET status = ? WHERE id = ?').run('in_progress', job.id);
  }

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
  'daily_print_time', 'week_wrapped_day', 'week_wrapped_time', 'timezone', 'daily_print_enabled',
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
    'SELECT * FROM todos ORDER BY completed ASC, pinned DESC, position ASC, created_at ASC'
  ).all();
  res.json(todos);
});

app.post('/api/todos', (req, res) => {
  const text      = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });

  const completed = req.body.completed ? 1 : 0;
  const now       = new Date().toISOString();
  const maxPos    = db.prepare('SELECT COALESCE(MAX(position), 0) as m FROM todos WHERE completed = 0').get().m;
  const result    = db.prepare(
    'INSERT INTO todos (text, completed, completed_at, position) VALUES (?, ?, ?, ?)'
  ).run(text, completed, completed ? now : null, completed ? 0 : maxPos + 1);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/todos/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
  const update = db.prepare('UPDATE todos SET position = ? WHERE id = ?');
  const tx = db.transaction(() => ids.forEach((id, i) => update.run(i, id)));
  tx();
  res.json({ success: true });
});

app.post('/api/todos/:id/complete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const todo = db.prepare('SELECT completed FROM todos WHERE id = ?').get(id);
  if (!todo) return res.status(404).json({ error: 'Not found' });

  const nowCompleted = todo.completed ? 0 : 1;
  if (nowCompleted) {
    db.prepare('UPDATE todos SET completed = 1, completed_at = ?, pinned = 0 WHERE id = ?').run(new Date().toISOString(), id);
  } else {
    db.prepare('UPDATE todos SET completed = 0, completed_at = NULL WHERE id = ?').run(id);
  }
  res.json({ success: true, completed: !!nowCompleted });
});

app.post('/api/todos/:id/pin', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const todo = db.prepare('SELECT pinned FROM todos WHERE id = ?').get(id);
  if (!todo) return res.status(404).json({ error: 'Not found' });
  const newPinned = todo.pinned ? 0 : 1;
  db.prepare('UPDATE todos SET pinned = ? WHERE id = ?').run(newPinned, id);
  res.json({ success: true, pinned: !!newPinned });
});

app.delete('/api/todos/:id', (req, res) => {
  db.prepare('DELETE FROM todos WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ============================================================
// Accomplishments API
// ============================================================

app.get('/api/accomplishments', (req, res) => {
  // Return accomplishments since last week wrapped (or last 7 days on first run)
  const lastWrap = db.prepare("SELECT value FROM settings WHERE key = 'last_week_wrapped_date'").get()?.value || '';
  const rows = lastWrap
    ? db.prepare('SELECT * FROM accomplishments WHERE created_at > ? ORDER BY created_at ASC').all(lastWrap)
    : db.prepare("SELECT * FROM accomplishments WHERE created_at > datetime('now','-7 days') ORDER BY created_at ASC").all();
  res.json(rows);
});

app.post('/api/accomplishments', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const result = db.prepare('INSERT INTO accomplishments (text) VALUES (?)').run(text);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/accomplishments/:id', (req, res) => {
  db.prepare('DELETE FROM accomplishments WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ============================================================
// Daily Summaries API
// ============================================================

app.get('/api/daily-summaries', (req, res) => {
  const lastWrap     = db.prepare("SELECT value FROM settings WHERE key = 'last_week_wrapped_date'").get()?.value || '';
  const lastWrapDate = lastWrap ? lastWrap.split('T')[0] : null;
  const rows = lastWrapDate
    ? db.prepare('SELECT * FROM daily_summaries WHERE date > ? ORDER BY date DESC').all(lastWrapDate)
    : db.prepare("SELECT * FROM daily_summaries WHERE date > date('now','-7 days') ORDER BY date DESC").all();
  res.json(rows);
});

// ============================================================
// Goals API
// ============================================================

app.get('/api/goals', (req, res) => {
  res.json(db.prepare('SELECT * FROM goals ORDER BY created_at ASC').all());
});

app.post('/api/goals', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const result = db.prepare('INSERT INTO goals (text) VALUES (?)').run(text);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/goals/:id', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  db.prepare('UPDATE goals SET text = ? WHERE id = ?').run(text, parseInt(req.params.id, 10));
  res.json({ success: true });
});

app.delete('/api/goals/:id', (req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ============================================================
// Week Wrapped — manual trigger
// ============================================================

app.post('/api/week-wrapped/trigger', async (req, res) => {
  try {
    const content = await generateWeekWrappedContent();
    if (!content) return res.status(400).json({ error: 'No accomplishments logged this week yet.' });

    db.prepare('INSERT INTO print_queue (content) VALUES (?)').run(content);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_week_wrapped_date', ?)").run(new Date().toISOString());
    res.json({ success: true });
  } catch (err) {
    console.error('Week wrapped trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Share link
// ============================================================

app.get('/api/share-token', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('share_token');
  res.json({ token: row.value });
});

// Public share form — anyone with the token URL can add a todo
app.get('/share/:token', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('share_token');
  if (!row || req.params.token !== row.value) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.post('/share/:token', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('share_token');
  if (!row || req.params.token !== row.value) return res.status(404).json({ error: 'Not found' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  db.prepare('INSERT INTO todos (text) VALUES (?)').run(text);
  res.json({ success: true });
});

app.post('/share/:token/message', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('share_token');
  if (!row || req.params.token !== row.value) return res.status(404).json({ error: 'Not found' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  db.prepare('INSERT INTO print_queue (content) VALUES (?)').run(text);
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
// Daily Print — preview (tomorrow's schedule)
// ============================================================

app.get('/api/daily-print/preview', async (req, res) => {
  try {
    const s        = getAllSettings();
    const timezone = s.timezone || 'America/Los_Angeles';
    const tomorrow = getTomorrowDateStr(timezone);
    const content  = await generateDailyPrintContent(tomorrow);
    res.json({ content });
  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// Helper — get local day of week (0=Sun…6=Sat) in a given timezone
function getLocalDayOfWeek(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).formatToParts(new Date());
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.find(p => p.type === 'weekday').value);
}

cron.schedule('* * * * *', async () => {
  try {
    const s        = getAllSettings();
    const timezone = s.timezone || 'America/Los_Angeles';
    const { hour, minute } = getLocalTime(timezone);
    const today    = new Date().toISOString().split('T')[0];

    const dayOfWeek = getLocalDayOfWeek(timezone);

    // ── Daily print (skip on wrap day) ───────────────────
    const wrapDay  = parseInt(s.week_wrapped_day || '0', 10);
    const enabled  = s.daily_print_enabled !== 'false';
    const [dailyHour, dailyMin] = (s.daily_print_time || '08:00').split(':').map(Number);
    if (enabled && dayOfWeek !== wrapDay && hour === dailyHour && minute === dailyMin && s.last_daily_print_date !== today) {
      console.log(`[cron] Generating daily print for ${today}`);
      const content = await generateDailyPrintContent();
      db.prepare('INSERT INTO print_queue (content) VALUES (?)').run(content);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('last_daily_print_date', today);
      console.log('[cron] Daily print queued');
    }

    // ── Daily summary (10 PM) ────────────────────────────
    if (hour === 22 && minute === 0 && s.last_daily_summary_date !== today) {
      const { start, end } = getLocalDayUTCBounds(today, timezone);
      const completed = db.prepare(
        'SELECT * FROM todos WHERE completed = 1 AND completed_at >= ? AND completed_at < ? ORDER BY completed_at ASC'
      ).all(start, end);
      if (completed.length > 0) {
        const summary = await generateDailySummary(completed);
        if (summary) {
          db.prepare('INSERT OR REPLACE INTO daily_summaries (date, summary) VALUES (?, ?)').run(today, summary);
          console.log(`[cron] Daily summary saved for ${today}`);
        }
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_daily_summary_date', ?)").run(today);
    }

    // ── Week Wrapped ─────────────────────────────────────
    const [wrapHour, wrapMin] = (s.week_wrapped_time || '09:00').split(':').map(Number);

    if (dayOfWeek === wrapDay && hour === wrapHour && minute === wrapMin && s.last_week_wrapped_date?.split('T')[0] !== today) {
      console.log('[cron] Generating Week Wrapped...');
      const content = await generateWeekWrappedContent();
      if (content) {
        db.prepare('INSERT INTO print_queue (content) VALUES (?)').run(content);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('last_week_wrapped_date', new Date().toISOString());
        console.log('[cron] Week Wrapped queued');
      } else {
        console.log('[cron] Week Wrapped skipped — no accomplishments');
      }
    }
  } catch (err) {
    console.error('[cron] Error:', err.message);
  }
});

// ============================================================
// Start
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Receipt printer server running on port ${PORT}`));
