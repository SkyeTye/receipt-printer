// ============================================================
// Week, Wrapped — Claude summary generation
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ============================================================
// Week label — "Apr 7 - Apr 14, 2026"
// ============================================================

function getWeekLabel(timezone, sinceDate) {
  const now = new Date();

  const fmt = (date, opts) =>
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts }).format(date);

  const startDate = sinceDate ? new Date(sinceDate) : new Date(now.getTime() - 7 * 86400000);

  const start = fmt(startDate, { month: 'short', day: 'numeric' });
  const end   = fmt(now,       { month: 'short', day: 'numeric' });
  const year  = fmt(now,       { year: 'numeric' });

  return `${start} - ${end}, ${year}`;
}

// ============================================================
// Claude summary
// ============================================================

async function generateSummary(accomplishments, goals) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return '(Add ANTHROPIC_API_KEY to Railway variables to enable AI summaries.)';
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const list = accomplishments.map(a => `- ${a.text}`).join('\n');

  const prompt = [
    'Write a warm, encouraging weekly summary for a personal receipt printer.',
    'Keep it to 2-3 short paragraphs (~100 words total). Plain prose only — no bullet points, headers, or markdown.',
    '',
    'Accomplishments this week:',
    list,
    goals ? `\nGoals:\n${goals}` : '',
    '',
    'Celebrate the wins, find patterns, and connect them to the goals if provided.',
  ].join('\n');

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 350,
    messages:   [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text.trim();
}

// ============================================================
// Daily summary — one sentence overview of a day's completed work
// ============================================================

async function generateDailySummary(completed, pending) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const client       = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const completedList = completed.map(t => `- ${t.text}`).join('\n');
  const pendingList   = pending.map(t => `- ${t.text}`).join('\n');

  const prompt = [
    'Write exactly TWO short sentences — no labels, no preamble, no quotes:',
    '1. One sentence on what was worked on today (from completed tasks). Focus on the category of work, not specific details.',
    '2. One sentence on what is coming up next (from pending tasks). Focus on the general theme.',
    'Return only the two sentences, each on its own line.',
    '',
    'Completed today:',
    completedList,
    '',
    'Pending tasks:',
    pendingList || '(none)',
  ].join('\n');

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 120,
    messages:   [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text.trim();
}

// ============================================================
// Main entry point
// ============================================================

async function generateWeekWrappedContent() {
  const s        = getAllSettings();
  const timezone = s.timezone || 'America/Los_Angeles';
  const lastWrap = s.last_week_wrapped_date || '';

  // Fetch completed todos since last wrap (or last 7 days on first run)
  const accomplishments = lastWrap
    ? db.prepare("SELECT * FROM todos WHERE completed = 1 AND completed_at > ? ORDER BY completed_at ASC").all(lastWrap)
    : db.prepare("SELECT * FROM todos WHERE completed = 1 AND completed_at > datetime('now','-7 days') ORDER BY completed_at ASC").all();

  if (accomplishments.length === 0) return null; // nothing to wrap

  // Load goals from goals table
  const goalRows = db.prepare('SELECT text FROM goals ORDER BY created_at ASC').all();
  const goalsText = goalRows.map((g, i) => `${i + 1}. ${g.text}`).join('\n');

  const weekLabel = getWeekLabel(timezone, lastWrap);
  const summary   = await generateSummary(accomplishments, goalsText);

  const lines = [];
  lines.push('=== WEEK, WRAPPED ===');
  lines.push(weekLabel);
  lines.push('');

  for (const a of accomplishments) {
    lines.push('* ' + a.text);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(summary);

  return lines.join('\n');
}

module.exports = { generateWeekWrappedContent, generateDailySummary };
