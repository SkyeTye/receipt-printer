const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

// GET /api/next-job
// Returns the oldest pending job as { id, content }, or {} if none.
app.get('/api/next-job', (req, res) => {
  const job = db.prepare(
    'SELECT id, content FROM print_queue WHERE status = ? ORDER BY created_at ASC LIMIT 1'
  ).get('pending');
  res.json(job || {});
});

// POST /api/job-done/:id
// Marks a job as done after the printer confirms it was printed.
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
  'day_start',
  'day_end',
  'slot_size_minutes',
  'daily_print_time',
  'week_wrapped_day',
  'week_wrapped_time',
];

app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.post('/api/settings', (req, res) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of ALLOWED_SETTINGS) {
    if (req.body[key] !== undefined) {
      stmt.run(key, String(req.body[key]));
    }
  }
  res.json({ success: true });
});

// ============================================================
// Page routes (served by public/ for index, explicit for others)
// ============================================================

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// ============================================================
// Start
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Receipt printer server running on port ${PORT}`));
