const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'receipts.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS print_queue (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    done_at    DATETIME
  );

  CREATE TABLE IF NOT EXISTS time_blocks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    label            TEXT NOT NULL,
    start_time       TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS todos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text         TEXT NOT NULL,
    completed    INTEGER NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    access_token  TEXT,
    refresh_token TEXT,
    token_type    TEXT,
    expiry_date   INTEGER,
    scope         TEXT
  );
`);

// Seed defaults (INSERT OR IGNORE — never overwrites existing values)
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const defaults = {
  day_start:              '08:00',
  day_end:                '21:00',
  slot_size_minutes:      '60',
  daily_print_time:       '08:00',
  week_wrapped_day:       '0',
  week_wrapped_time:      '09:00',
  timezone:               'America/Los_Angeles',
  last_daily_print_date:  '',
};

for (const [key, value] of Object.entries(defaults)) {
  seedSetting.run(key, value);
}

module.exports = db;
