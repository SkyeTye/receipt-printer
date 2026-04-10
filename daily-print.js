// ============================================================
// Daily Print — schedule building and content generation
// ============================================================

const { google } = require('googleapis');
const db = require('./db');

// ============================================================
// Time helpers
// ============================================================

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTimeStr(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Get the local hour and minute for a given timezone
function getLocalTime(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  return {
    hour:   parseInt(parts.find(p => p.type === 'hour').value),
    minute: parseInt(parts.find(p => p.type === 'minute').value),
  };
}

// Convert an ISO date string to local minutes-since-midnight
function isoToLocalMinutes(isoStr, timezone) {
  const date = new Date(isoStr);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

function formatDayLabel(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(now);

  const get = type => parts.find(p => p.type === type)?.value || '';
  return `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')}`;
}

// ============================================================
// Settings helper
// ============================================================

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ============================================================
// Google Calendar
// ============================================================

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.APP_URL || '') + '/auth/google/callback'
  );
}

async function fetchCalendarEvents(timezone) {
  const tokenRow = db.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get();
  if (!tokenRow?.access_token) return [];

  const client = getOAuthClient();
  client.setCredentials({
    access_token:  tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    token_type:    tokenRow.token_type,
    expiry_date:   tokenRow.expiry_date,
  });

  // Persist refreshed tokens automatically
  client.on('tokens', tokens => {
    db.prepare(`
      UPDATE oauth_tokens
      SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expiry_date = ?
      WHERE id = 1
    `).run(
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expiry_date
    );
  });

  const calendar = google.calendar({ version: 'v3', auth: client });

  // Fetch today's events in the user's timezone
  const now = new Date();
  const startOfDay = new Date(now.toLocaleDateString('en-US', { timeZone: timezone }));
  const endOfDay   = new Date(startOfDay.getTime() + 86400000);

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin:       startOfDay.toISOString(),
    timeMax:       endOfDay.toISOString(),
    singleEvents:  true,
    orderBy:       'startTime',
    timeZone:      timezone,
  });

  return (response.data.items || [])
    .filter(e => e.start.dateTime) // skip all-day events
    .map(e => ({
      summary: e.summary || 'Event',
      start:   e.start.dateTime,
      end:     e.end.dateTime,
    }));
}

// ============================================================
// Schedule builder
// ============================================================

function buildDaySchedule(startTime, endTime, slotMins, timeBlocks, calEvents, timezone) {
  const dayStart = timeToMinutes(startTime);
  const dayEnd   = timeToMinutes(endTime);

  // Calendar slots
  const calSlots = calEvents
    .map(e => ({
      label:     '[Cal] ' + e.summary,
      startMins: isoToLocalMinutes(e.start, timezone),
      endMins:   isoToLocalMinutes(e.end,   timezone),
      type:      'calendar',
    }))
    .filter(s => s.endMins > dayStart && s.startMins < dayEnd);

  // Custom time blocks — suppress any that overlap a calendar event
  const customSlots = timeBlocks
    .map(b => ({
      label:     b.label,
      startMins: timeToMinutes(b.start_time),
      endMins:   timeToMinutes(b.start_time) + b.duration_minutes,
      type:      'custom',
    }))
    .filter(s => s.endMins > dayStart && s.startMins < dayEnd)
    .filter(s => !calSlots.some(c => s.startMins < c.endMins && s.endMins > c.startMins));

  // Merge and sort
  const named = [...calSlots, ...customSlots].sort((a, b) => a.startMins - b.startMins);

  const slots = [];
  let cursor = dayStart;

  for (const block of named) {
    const bStart = Math.max(block.startMins, dayStart);
    const bEnd   = Math.min(block.endMins,   dayEnd);
    if (bEnd <= bStart) continue;

    // Fill gap before this block with blank slots
    while (cursor + slotMins <= bStart) {
      slots.push({ type: 'blank', startMins: cursor });
      cursor += slotMins;
    }
    if (cursor < bStart) cursor = bStart;

    slots.push({ ...block, startMins: bStart, endMins: bEnd });
    cursor = bEnd;
  }

  // Fill remaining time
  while (cursor + slotMins <= dayEnd) {
    slots.push({ type: 'blank', startMins: cursor });
    cursor += slotMins;
  }

  return slots;
}

// ============================================================
// Print content formatter
// ============================================================
// Receipt is 30 chars wide. Layout per line:
//   "HH:MM  <label or blanks>"
//   time = 5, sep = 2, remaining = 23

const LINE_WIDTH  = 30;
const LABEL_WIDTH = LINE_WIDTH - 7; // 5 (time) + 2 (sep)

function truncate(str, max) {
  return str.length > max ? str.substring(0, max - 1) + '~' : str;
}

function formatDailyPrint(slots, todos, dayLabel) {
  const lines = [];

  lines.push(`=== ${dayLabel} ===`);
  lines.push('');

  for (const slot of slots) {
    const t = minutesToTimeStr(slot.startMins);
    if (slot.type === 'blank') {
      lines.push(`${t}  ${'_'.repeat(LABEL_WIDTH)}`);
    } else {
      lines.push(`${t}  ${truncate(slot.label, LABEL_WIDTH)}`);
    }
  }

  if (todos.length > 0) {
    lines.push('');
    lines.push('--- TO-DO ---');
    for (const todo of todos) {
      lines.push(`[ ] ${truncate(todo.text, LABEL_WIDTH)}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Main entry point
// ============================================================

async function generateDailyPrintContent() {
  const s = getAllSettings();

  const timezone  = s.timezone || 'America/Los_Angeles';
  const startTime = s.daily_print_time || '08:00';
  const endTime   = s.day_end || '21:00';
  const slotMins  = parseInt(s.slot_size_minutes || '60', 10);

  const timeBlocks = db.prepare('SELECT * FROM time_blocks ORDER BY start_time').all();
  const todos      = db.prepare('SELECT * FROM todos WHERE completed = 0 ORDER BY created_at ASC').all();
  const calEvents  = await fetchCalendarEvents(timezone);

  const slots   = buildDaySchedule(startTime, endTime, slotMins, timeBlocks, calEvents, timezone);
  const dayLabel = formatDayLabel(timezone);

  return formatDailyPrint(slots, todos, dayLabel);
}

module.exports = { generateDailyPrintContent, getOAuthClient, getLocalTime, getAllSettings };
