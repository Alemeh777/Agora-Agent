/**
 * AGORA — Backend Server v2.0
 * Node.js + Express + SQLite
 *
 * Flow:
 *  1. Daily topic generated per member timezone at their preferred hour
 *  2. Email: topic + "12 hours to discuss" + Velanto link
 *  3. Member clicks link → opens Velanto → one-on-one conversation with AGORA
 *  4. Written or voice — AGORA matches the member's mode
 *  5. Conversation auto-ends at 30min (or 60min if extended in settings)
 *  6. AGORA wraps up naturally + asks for consent
 *  7. Audio digest compiled from consenting conversations — podcast tone — max 90min
 *  8. Audio available in member's Velanto account next morning
 *  9. 18 languages — member sets default at signup, changeable anytime
 * 10. Velanto webhook for agent marketplace runs
 */

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import cron from 'node-cron';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT              = process.env.PORT || 4000;
const JWT_SECRET        = process.env.JWT_SECRET || 'agora-secret-change-this';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const SMTP_HOST         = process.env.SMTP_HOST;
const SMTP_USER         = process.env.SMTP_USER;
const SMTP_PASS         = process.env.SMTP_PASS;
const FROM_EMAIL        = process.env.FROM_EMAIL || 'agora@yourdomain.com';
const VELANTO_URL       = process.env.VELANTO_URL || 'https://velanto.com';
const VELANTO_SECRET    = process.env.VELANTO_WEBHOOK_SECRET;
const BASE_URL          = process.env.BASE_URL || 'http://localhost:4000';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── LANGUAGES & TIMEZONES ────────────────────────────────────────────────────
const LANGUAGES = {
  en:'English', fa:'Persian (Farsi)', de:'German', fr:'French',
  es:'Spanish', ar:'Arabic', zh:'Chinese (Simplified)', ja:'Japanese',
  pt:'Portuguese', ru:'Russian', tr:'Turkish', hi:'Hindi',
  nl:'Dutch', sv:'Swedish', ko:'Korean', it:'Italian',
  pl:'Polish', uk:'Ukrainian',
};

const TIMEZONES = [
  'UTC','Europe/London','Europe/Stockholm','Europe/Berlin','Europe/Paris',
  'Europe/Rome','Europe/Madrid','Europe/Athens','Asia/Tehran','Asia/Dubai',
  'Asia/Kolkata','Asia/Bangkok','Asia/Tokyo','Asia/Shanghai','Asia/Seoul',
  'Australia/Sydney','Pacific/Auckland','America/New_York','America/Chicago',
  'America/Denver','America/Los_Angeles','America/Sao_Paulo','Africa/Cairo',
  'Africa/Lagos','Africa/Nairobi',
];

// ─── EMAIL ────────────────────────────────────────────────────────────────────
let emailClient = null;
if (RESEND_API_KEY) emailClient = new Resend(RESEND_API_KEY);

async function sendEmail({ to, subject, html }) {
  if (RESEND_API_KEY && emailClient) {
    return emailClient.emails.send({ from: FROM_EMAIL, to, subject, html });
  }
  if (SMTP_HOST) {
    const t = nodemailer.createTransport({
      host: SMTP_HOST, port: 587, secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return t.sendMail({ from: FROM_EMAIL, to, subject, html });
  }
  console.log(`[EMAIL DEV] To: ${to} | Subject: ${subject}`);
}

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'agora.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id             TEXT PRIMARY KEY,
    email          TEXT UNIQUE NOT NULL,
    name           TEXT UNIQUE NOT NULL,
    password       TEXT NOT NULL,
    language       TEXT NOT NULL DEFAULT 'en',
    timezone       TEXT NOT NULL DEFAULT 'UTC',
    preferred_hour INTEGER NOT NULL DEFAULT 8,
    max_conv_mins  INTEGER NOT NULL DEFAULT 30,
    verified       INTEGER NOT NULL DEFAULT 0,
    verify_token   TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_topics (
    id          TEXT PRIMARY KEY,
    date        TEXT UNIQUE NOT NULL,
    type        TEXT NOT NULL,
    text        TEXT NOT NULL,
    attribution TEXT NOT NULL,
    tradition   TEXT NOT NULL,
    source      TEXT NOT NULL,
    context     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS member_sessions (
    id            TEXT PRIMARY KEY,
    member_id     TEXT NOT NULL,
    topic_date    TEXT NOT NULL,
    topic_id      TEXT NOT NULL,
    started_at    TEXT,
    expires_at    TEXT,
    ended_at      TEXT,
    consent_given INTEGER,
    mode          TEXT DEFAULT 'text',
    status        TEXT DEFAULT 'pending',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (topic_id)  REFERENCES daily_topics(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES member_sessions(id)
  );

  CREATE TABLE IF NOT EXISTS audio_digests (
    id           TEXT PRIMARY KEY,
    topic_date   TEXT NOT NULL,
    script       TEXT NOT NULL,
    duration_s   INTEGER,
    available_at TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_log (
    id         TEXT PRIMARY KEY,
    member_id  TEXT NOT NULL,
    topic_date TEXT NOT NULL,
    sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.member = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalid or expired' }); }
}

function verifyVelantoSig(rawBody, header) {
  if (!VELANTO_SECRET) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', VELANTO_SECRET).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header || '')); }
  catch { return false; }
}

function nowISO() { return new Date().toISOString(); }

function currentHourInTZ(tz) {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date());
    return parseInt(s === '24' ? '0' : s, 10);
  } catch { return new Date().getUTCHours(); }
}

function todayInTZ(tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}

// ─── TRANSLATION ──────────────────────────────────────────────────────────────
async function translateText(text, targetLang) {
  if (!text || targetLang === 'en') return text;
  const langName = LANGUAGES[targetLang] || targetLang;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 800,
      messages: [{ role: 'user', content: `Translate into ${langName}. Preserve philosophical tone exactly. Return ONLY the translation:\n\n${text}` }]
    });
    return msg.content[0].text.trim();
  } catch { return text; }
}

// ─── MODERATION ───────────────────────────────────────────────────────────────
const HARMFUL = [
  /\b(kill|murder)\s+(yourself|others|children|kids)\b/i,
  /\bsuicid[e]?\b/i, /\bself.harm\b/i,
  /\b(child|kid|minor).{0,20}(porn|sex|nude|abuse)\b/i,
];

async function moderate(text) {
  if (HARMFUL.some(p => p.test(text))) return { safe: false, reason: 'Content advocates harm.' };
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 80,
      system: `Moderate a philosophy conversation. Flag ONLY: harm advocacy, suicide encouragement, child exploitation, dehumanizing hate. All genuine philosophical inquiry is allowed. JSON only: {"safe":true} or {"safe":false,"reason":"under 10 words"}`,
      messages: [{ role: 'user', content: `"${text.slice(0, 400)}"` }]
    });
    return JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());
  } catch { return { safe: true }; }
}

// ─── TOPIC GENERATION ─────────────────────────────────────────────────────────
async function generateOrLoadTopic(date) {
  const existing = db.prepare('SELECT * FROM daily_topics WHERE date=?').get(date);
  if (existing) return existing;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 600,
    system: `You are AGORA choosing a daily philosophical prompt for a global community.
Rotate between QUESTION / STATEMENT / QUOTE types. Vary traditions — not always Western.
Connect to world events or seasons when natural. Avoid clichés. Be specific and surprising.
Respond ONLY with JSON (no backticks):
{
  "type": "QUESTION",
  "text": "...",
  "attribution": "philosopher or figure",
  "tradition": "tradition name",
  "source": "work and approximate date",
  "context": "2-3 sentences that open the question, not answer it"
}`,
    messages: [{ role: 'user', content: `Generate the philosophical prompt for ${date}.` }]
  });

  const topic = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());
  const id = uuid();
  db.prepare(`INSERT INTO daily_topics (id,date,type,text,attribution,tradition,source,context) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, date, topic.type, topic.text, topic.attribution, topic.tradition, topic.source, topic.context);
  return db.prepare('SELECT * FROM daily_topics WHERE id=?').get(id);
}

// ─── DAILY EMAIL ──────────────────────────────────────────────────────────────
async function checkAndSendEmails() {
  const members = db.prepare('SELECT * FROM members WHERE verified=1').all();

  for (const member of members) {
    const memberDate = todayInTZ(member.timezone);
    const memberHour = currentHourInTZ(member.timezone);
    if (memberHour !== member.preferred_hour) continue;

    const already = db.prepare('SELECT id FROM email_log WHERE member_id=? AND topic_date=?').get(member.id, memberDate);
    if (already) continue;

    try {
      const topic     = await generateOrLoadTopic(memberDate);
      const topicText = member.language === 'en' ? topic.text : await translateText(topic.text, member.language);

      // Create pending session
      const sessionId   = uuid();
      const sessionLink = `${VELANTO_URL}/agent/agora?session=${sessionId}`;
      db.prepare(`INSERT INTO member_sessions (id,member_id,topic_date,topic_id,status) VALUES (?,?,?,?,'pending')`)
        .run(sessionId, member.id, memberDate, topic.id);

      const warningText = member.language === 'en'
        ? 'You have 12 hours to explore this topic. After that, the conversation closes.'
        : await translateText('You have 12 hours to explore this topic. After that, the conversation closes.', member.language);

      const btnText = member.language === 'en'
        ? 'Begin your conversation →'
        : await translateText('Begin your conversation →', member.language);

      const subject = `${topic.type === 'QUOTE' ? '"' : ''}${topicText.slice(0, 65)}${topicText.length > 65 ? '…' : ''}${topic.type === 'QUOTE' ? '"' : ''}`;

      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#f5f0e8;margin:0;padding:48px 24px;font-family:Georgia,serif;">
<div style="max-width:520px;margin:0 auto;">

  <p style="font-family:monospace;font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:#b8892a;margin:0 0 32px;">
    AGORA · ${new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
  </p>

  <p style="font-family:monospace;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#a89f95;margin:0 0 14px;">
    ${topic.type} · ${topic.tradition}
  </p>

  <h1 style="font-size:26px;font-weight:300;font-style:italic;line-height:1.55;color:#1a1714;margin:0 0 14px;">
    ${topicText}
  </h1>

  <p style="font-size:14px;color:#7a6f65;margin:0 0 32px;">
    — ${topic.attribution} · <em>${topic.source}</em>
  </p>

  <p style="font-size:13px;color:#c4552a;font-family:monospace;letter-spacing:0.03em;margin:0 0 28px;padding:10px 14px;border:1px solid rgba(196,85,42,0.25);display:inline-block;">
    ⏳ ${warningText}
  </p>

  <br><br>
  <a href="${sessionLink}"
     style="display:inline-block;background:#1a1714;color:#f5f0e8;text-decoration:none;
            font-family:monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;
            padding:13px 28px;">
    ${btnText}
  </a>

  <p style="margin-top:48px;font-size:11px;color:#a89f95;line-height:1.6;">
    AGORA · <a href="${BASE_URL}/api/unsubscribe?id=${member.id}" style="color:#b8892a;text-decoration:none;">Unsubscribe</a>
  </p>

</div>
</body></html>`;

      await sendEmail({ to: member.email, subject, html });
      db.prepare('INSERT INTO email_log (id,member_id,topic_date) VALUES (?,?,?)').run(uuid(), member.id, memberDate);
      console.log(`[EMAIL] Sent → ${member.email} for ${memberDate}`);

    } catch(e) {
      console.error(`[EMAIL ERROR] ${member.email}:`, e.message);
    }

    await new Promise(r => setTimeout(r, 300));
  }
}

// ─── CONVERSATION ─────────────────────────────────────────────────────────────
function buildSystemPrompt(topic, langName, memberName, minutesLeft) {
  const isWrapUp = minutesLeft <= 5;
  return `You are AGORA — a philosophical conversation partner in a private dialogue with ${memberName}.

Today's topic: "${topic.text}" — ${topic.attribution} (${topic.tradition}, ${topic.source})

Your character:
- You have genuine philosophical opinions. State them clearly and defend them.
- Mix two modes naturally: share your own view, then ask one sharp question back.
- Cite sources briefly: "As Simone de Beauvoir wrote in The Second Sex..."
- Connect ideas across traditions without forcing it.
- Never just agree. If you agree, say briefly then push further.
- Be curious about this specific person's thinking and life.
- Responses: 3-6 sentences. Dialogue, not lecture.
- Time remaining: approximately ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.
${isWrapUp ? `
WRAP UP MODE: The conversation is ending. Do this in your response:
1. Acknowledge the conversation is nearly over.
2. Offer one sentence summarising the most important insight from your exchange.
3. End with exactly this consent question: "Before we close — may I include highlights of our conversation in today's audio digest? Your name will never be used. Yes or no?"` : ''}

Respond entirely in ${langName}. Write as if you think natively in ${langName}.`;
}

async function getAIResponse(sessionId, userText, memberId) {
  const session = db.prepare('SELECT * FROM member_sessions WHERE id=?').get(sessionId);
  const member  = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const topic   = db.prepare('SELECT * FROM daily_topics WHERE id=?').get(session.topic_id);
  const langName = LANGUAGES[member.language] || 'English';

  const elapsed    = session.started_at ? (Date.now() - new Date(session.started_at).getTime()) / 60000 : 0;
  const minutesLeft = Math.max(0, Math.round((member.max_conv_mins || 30) - elapsed));

  const history = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC LIMIT 40').all(sessionId);
  const claudeMessages = [
    ...history.map(m => ({ role: m.role, content: m.text })),
    { role: 'user', content: userText }
  ];

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: buildSystemPrompt(topic, langName, member.name, minutesLeft),
    messages: claudeMessages,
  });

  return msg.content[0].text.trim();
}

// ─── AUDIO DIGEST ─────────────────────────────────────────────────────────────
async function generateAudioDigest(topicDate) {
  const sessions = db.prepare(`
    SELECT ms.*, m.name as member_name, dt.text as topic_text,
           dt.attribution, dt.tradition, dt.source, dt.context
    FROM member_sessions ms
    JOIN members m  ON ms.member_id = m.id
    JOIN daily_topics dt ON ms.topic_id = dt.id
    WHERE ms.consent_given = 1 AND ms.topic_date = ? AND ms.status = 'ended'
  `).all(topicDate);

  if (sessions.length === 0) { console.log(`[DIGEST] No consenting sessions for ${topicDate}`); return; }

  const topic = sessions[0];
  const conversations = sessions.slice(0, 20).map((s, i) => {
    const msgs = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC').all(s.id);
    return `Conversation ${i + 1}:\n` + msgs.map(m => `${m.role === 'user' ? 'Member' : 'AGORA'}: ${m.text}`).join('\n');
  }).join('\n\n---\n\n');

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: `You are the narrator and host of AGORA — a daily philosophical podcast.
Tone: warm, intelligent, unhurried. Like a thoughtful late-night radio programme about ideas.
Write in English. The script will be converted to audio.

Episode structure:
1. Opening (30 sec): Welcome listeners, introduce today's topic, source, tradition.
2. The topic (1 min): Read it. Give your own brief philosophical framing.
3. Voices (bulk): Weave highlights from member conversations anonymously. Never name anyone. Use "one voice today put it this way..." or "another member asked..."
4. Connecting threads (3-4 min): Find tensions and agreements. Connect other traditions. Add your philosophical synthesis.
5. Closing (1 min): One question to carry into tomorrow.

Keep total script under 9,000 words (roughly 90 minutes at natural speaking pace).
Write the full script ready to be read aloud. No stage directions. No brackets. Just words.`,
    messages: [{
      role: 'user',
      content: `Topic: "${topic.topic_text}" — ${topic.attribution} (${topic.tradition}, ${topic.source})\nContext: ${topic.context}\n\nConversations:\n\n${conversations}`
    }]
  });

  const script    = msg.content[0].text.trim();
  const wordCount = script.split(/\s+/).length;
  const durationS = Math.round((wordCount / 150) * 60);

  // Available next morning at 7am UTC
  const available = new Date();
  available.setUTCDate(available.getUTCDate() + 1);
  available.setUTCHours(7, 0, 0, 0);

  db.prepare(`INSERT INTO audio_digests (id,topic_date,script,duration_s,available_at) VALUES (?,?,?,?,?)`)
    .run(uuid(), topicDate, script, durationS, available.toISOString());

  console.log(`[DIGEST] Generated for ${topicDate} — ~${Math.round(durationS / 60)} min`);
}

// ─── CRON ─────────────────────────────────────────────────────────────────────
cron.schedule('* * * * *', checkAndSendEmails);

cron.schedule('0 0 * * *', async () => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 1);
  await generateOrLoadTopic(d.toISOString().slice(0, 10));
  console.log('[CRON] Tomorrow\'s topic pre-generated.');
});

// Expire active sessions past their time limit
cron.schedule('* * * * *', () => {
  const now = nowISO();
  db.prepare(`UPDATE member_sessions SET status='expired', ended_at=? WHERE status='active' AND expires_at < ?`).run(now, now);
  // Expire pending sessions older than 12 hours
  const cutoff = new Date(Date.now() - 12 * 3600000).toISOString();
  db.prepare(`UPDATE member_sessions SET status='expired' WHERE status='pending' AND created_at < ?`).run(cutoff);
});

// Generate digest at 23:00 UTC each day
cron.schedule('0 23 * * *', async () => {
  const yesterday = new Date(); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  await generateAudioDigest(yesterday.toISOString().slice(0, 10));
});

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api/conversation/message', rateLimit({ windowMs: 60 * 1000, max: 15 }));

// ── REGISTRATION ──────────────────────────────────────────────────────────────
app.get('/api/auth/check-name', (req, res) => {
  const { name } = req.query;
  if (!name || name.length < 2) return res.json({ available: false });
  const exists = db.prepare('SELECT id FROM members WHERE lower(name)=lower(?)').get(name);
  res.json({ available: !exists });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, name, password, language = 'en', timezone = 'UTC', preferred_hour = 8 } = req.body;
  if (!email || !name || !password) return res.status(400).json({ error: 'All fields required.' });
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Name must be 2-40 characters.' });
  if (!LANGUAGES[language]) return res.status(400).json({ error: 'Invalid language.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const nameTaken  = db.prepare('SELECT id FROM members WHERE lower(name)=lower(?)').get(name);
  if (nameTaken)  return res.status(409).json({ error: 'This name is taken. Try adding a letter or number.' });
  const emailTaken = db.prepare('SELECT id FROM members WHERE lower(email)=lower(?)').get(email);
  if (emailTaken) return res.status(409).json({ error: 'This email is already registered.' });

  const hashed      = await bcrypt.hash(password, 12);
  const id          = uuid();
  const verifyToken = crypto.randomBytes(32).toString('hex');

  db.prepare(`INSERT INTO members (id,email,name,password,language,timezone,preferred_hour,verified,verify_token)
    VALUES (?,?,?,?,?,?,?,0,?)`).run(id, email.toLowerCase(), name, hashed, language, timezone, preferred_hour, verifyToken);

  await sendEmail({
    to: email,
    subject: 'Welcome to AGORA — verify your email',
    html: `<body style="background:#f5f0e8;font-family:Georgia,serif;padding:48px 24px;">
<div style="max-width:480px;margin:0 auto;">
  <p style="font-family:monospace;font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:#b8892a;">AGORA</p>
  <h1 style="font-size:24px;font-weight:300;font-style:italic;color:#1a1714;">Welcome, ${name}.</h1>
  <p style="font-size:15px;color:#3d3830;line-height:1.7;">A daily philosophical question awaits you. Please verify your email to begin.</p>
  <a href="${BASE_URL}/api/auth/verify?token=${verifyToken}"
     style="display:inline-block;margin-top:24px;background:#1a1714;color:#f5f0e8;text-decoration:none;
            font-family:monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;padding:11px 26px;">
    Verify email →
  </a>
</div></body>`
  });

  res.json({ message: 'Check your email to verify your account.' });
});

app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  const member = db.prepare('SELECT * FROM members WHERE verify_token=?').get(token);
  if (!member) return res.status(404).json({ error: 'Invalid or expired token.' });
  db.prepare('UPDATE members SET verified=1, verify_token=NULL WHERE id=?').run(member.id);
  res.send('<html><body style="font-family:Georgia;text-align:center;padding:80px;background:#f5f0e8;"><h1 style="font-weight:300;font-style:italic;">Email verified.</h1><p>Your first question arrives tomorrow. Welcome to AGORA.</p></body></html>');
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const member = db.prepare('SELECT * FROM members WHERE lower(email)=lower(?)').get(email);
  if (!member)           return res.status(401).json({ error: 'No account with this email.' });
  if (!member.verified)  return res.status(401).json({ error: 'Please verify your email first.' });
  const match = await bcrypt.compare(password, member.password);
  if (!match)            return res.status(401).json({ error: 'Incorrect password.' });
  const token = jwt.sign({ id: member.id, name: member.name, language: member.language }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, member: { id: member.id, name: member.name, language: member.language, timezone: member.timezone, preferred_hour: member.preferred_hour, max_conv_mins: member.max_conv_mins } });
});

app.patch('/api/member/settings', requireAuth, (req, res) => {
  const { language, timezone, preferred_hour, max_conv_mins } = req.body;
  if (language && !LANGUAGES[language]) return res.status(400).json({ error: 'Invalid language.' });
  if (max_conv_mins && ![30, 60].includes(Number(max_conv_mins))) return res.status(400).json({ error: 'max_conv_mins must be 30 or 60.' });
  const fields = [], values = [];
  if (language)       { fields.push('language=?');       values.push(language); }
  if (timezone)       { fields.push('timezone=?');       values.push(timezone); }
  if (preferred_hour !== undefined) { fields.push('preferred_hour=?'); values.push(Number(preferred_hour)); }
  if (max_conv_mins)  { fields.push('max_conv_mins=?');  values.push(Number(max_conv_mins)); }
  if (!fields.length) return res.json({ ok: true });
  values.push(req.member.id);
  db.prepare(`UPDATE members SET ${fields.join(',')} WHERE id=?`).run(...values);
  res.json({ ok: true });
});

// ── SESSION ───────────────────────────────────────────────────────────────────
app.post('/api/session/open', requireAuth, async (req, res) => {
  const { session_id, mode = 'text' } = req.body;
  const session = db.prepare('SELECT * FROM member_sessions WHERE id=? AND member_id=?').get(session_id, req.member.id);

  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const createdAge = (Date.now() - new Date(session.created_at).getTime()) / 3600000;
  if (createdAge > 12 || session.status === 'expired') {
    db.prepare(`UPDATE member_sessions SET status='expired' WHERE id=?`).run(session_id);
    return res.status(410).json({ error: 'This topic has expired. Your next question arrives tomorrow at your preferred time.' });
  }
  if (session.status === 'ended') return res.status(410).json({ error: 'This conversation has already ended.' });

  const member = db.prepare('SELECT * FROM members WHERE id=?').get(req.member.id);

  if (session.status === 'pending') {
    const startedAt  = nowISO();
    const expiresAt  = new Date(Date.now() + (member.max_conv_mins || 30) * 60000).toISOString();
    db.prepare(`UPDATE member_sessions SET status='active', started_at=?, expires_at=?, mode=? WHERE id=?`)
      .run(startedAt, expiresAt, mode, session_id);
  }

  const topic    = db.prepare('SELECT * FROM daily_topics WHERE id=?').get(session.topic_id);
  const topicTxt = member.language === 'en' ? topic.text : await translateText(topic.text, member.language);
  const messages = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC').all(session_id);
  const updated  = db.prepare('SELECT * FROM member_sessions WHERE id=?').get(session_id);

  res.json({ session_id, topic: { ...topic, text: topicTxt }, messages, expires_at: updated.expires_at, max_conv_mins: member.max_conv_mins || 30 });
});

// ── CONVERSATION ──────────────────────────────────────────────────────────────
app.post('/api/conversation/message', requireAuth, async (req, res) => {
  const { session_id, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Empty message.' });

  const session = db.prepare('SELECT * FROM member_sessions WHERE id=? AND member_id=?').get(session_id, req.member.id);
  if (!session || session.status !== 'active') return res.status(400).json({ error: 'Session not active.' });
  if (session.expires_at && new Date() > new Date(session.expires_at)) {
    db.prepare(`UPDATE member_sessions SET status='expired', ended_at=? WHERE id=?`).run(nowISO(), session_id);
    return res.status(410).json({ error: 'Conversation time has ended.' });
  }

  const mod = await moderate(text);
  if (!mod.safe) return res.status(422).json({ error: mod.reason });

  db.prepare('INSERT INTO messages (id,session_id,role,text) VALUES (?,?,?,?)').run(uuid(), session_id, 'user', text.trim());

  try {
    const aiText    = await getAIResponse(session_id, text.trim(), req.member.id);
    const wrappingUp = /audio digest|highlights of our conversation|yes or no\?/i.test(aiText);
    db.prepare('INSERT INTO messages (id,session_id,role,text) VALUES (?,?,?,?)').run(uuid(), session_id, 'assistant', aiText);
    res.json({ text: aiText, wrapping_up: wrappingUp });
  } catch(e) {
    res.status(500).json({ error: 'AGORA could not respond. Please try again.' });
  }
});

app.post('/api/conversation/consent', requireAuth, (req, res) => {
  const { session_id, consent } = req.body;
  const session = db.prepare('SELECT * FROM member_sessions WHERE id=? AND member_id=?').get(session_id, req.member.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  db.prepare(`UPDATE member_sessions SET consent_given=?, status='ended', ended_at=? WHERE id=?`).run(consent ? 1 : 0, nowISO(), session_id);
  res.json({ ok: true, message: consent ? 'Thank you. Your voice joins today\'s digest.' : 'Understood. Your conversation remains entirely private.' });
});

// ── AUDIO DIGEST ──────────────────────────────────────────────────────────────
app.get('/api/digest/latest', requireAuth, (req, res) => {
  const digest = db.prepare(`SELECT * FROM audio_digests WHERE available_at <= ? ORDER BY created_at DESC LIMIT 1`).get(nowISO());
  if (!digest) return res.json({ available: false, message: 'No digest available yet. Check back tomorrow morning.' });
  res.json({ available: true, topic_date: digest.topic_date, script: digest.script, duration_s: digest.duration_s, available_at: digest.available_at });
});

// ── MISC ──────────────────────────────────────────────────────────────────────
app.get('/api/languages', (_req, res) => res.json(LANGUAGES));
app.get('/api/timezones',  (_req, res) => res.json(TIMEZONES));
app.get('/api/unsubscribe', (req, res) => {
  const { id } = req.query;
  if (id) db.prepare('UPDATE members SET verified=0 WHERE id=?').run(id);
  res.send('<html><body style="font-family:Georgia;text-align:center;padding:80px;background:#f5f0e8;"><h1 style="font-weight:300;font-style:italic;">You have unsubscribed.</h1><p style="color:#7a6f65;">We\'re sorry to see you go.</p></body></html>');
});

// ── VELANTO WEBHOOK ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['x-velanto-signature'];
  if (!verifyVelantoSig(req.rawBody, sig)) return res.status(401).json({ error: 'Invalid signature' });

  const { run_id, input = {} } = req.body;
  const { mode = 'daily', topic, tradition_filter, depth_preference } = input;

  try {
    const date       = new Date().toISOString().slice(0, 10);
    const dailyTopic = await generateOrLoadTopic(date);

    let userPrompt = '';
    if (mode === 'daily') {
      userPrompt = `Generate today's philosophical seed idea for ${date}.${tradition_filter && tradition_filter !== 'Any' ? ` Focus on ${tradition_filter} philosophy.` : ''}`;
    } else if (mode === 'explore') {
      userPrompt = `The member wants to explore: "${topic}".${tradition_filter && tradition_filter !== 'Any' ? ` Draw from ${tradition_filter} philosophy.` : ''}${depth_preference === 'beginner' ? ' Keep it accessible.' : depth_preference === 'deep' ? ' Go technically deep.' : ''}`;
    } else if (mode === 'debate') {
      userPrompt = `Show a genuine philosophical debate around: "${topic}". Show how traditions disagree and why each position has merit.`;
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      system: `You are AGORA, a philosophical guide drawing from the entire history of human thought.
Always cite sources. Connect traditions. Have genuine opinions. Be surprising, not clichéd.
Respond ONLY with JSON (no backticks):
{
  "seed_idea": "one sentence — the core idea",
  "philosopher": "name(s)",
  "tradition": "tradition name",
  "source": "work and approximate date",
  "exploration": "3-4 paragraphs of rich exploration",
  "question_to_sit_with": "one question for the member to carry",
  "related_ideas": [
    {"philosopher":"name","idea":"brief connection","tradition":"tradition"},
    {"philosopher":"name","idea":"brief connection","tradition":"tradition"}
  ],
  "depth_score": 7,
  "accessibility_score": 6
}`,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const p = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());

    return res.json({
      status: 'completed',
      summary: `${p.philosopher}: "${p.seed_idea.slice(0, 80)}…"`,
      output: {
        metrics: [
          { label: 'Depth',         value: p.depth_score,         suffix: '/10' },
          { label: 'Accessibility', value: p.accessibility_score, suffix: '/10' },
          { label: 'Tradition',     value: p.tradition },
        ],
        tables: p.related_ideas?.length ? [{
          title: 'Connected ideas across traditions',
          headers: ['Philosopher', 'Tradition', 'Connection'],
          rows: p.related_ideas.map(r => [r.philosopher, r.tradition, r.idea]),
        }] : [],
        sections: [
          { title: 'Source',                  content: `**${p.philosopher}** — *${p.source}*`,    defaultOpen: true },
          { title: 'Question to sit with',    content: `> *${p.question_to_sit_with}*`,           defaultOpen: true },
        ],
        content: `## ${p.seed_idea}\n\n${p.exploration}`,
      },
      model_used: 'Claude Sonnet 4',
    });

  } catch(e) {
    console.error(`[WEBHOOK ${run_id}]`, e.message);
    return res.status(200).json({ status: 'failed', error: e.message });
  }
});

app.get('/', (_req, res) => res.json({ name: 'AGORA', version: '2.0', status: 'ok' }));

app.listen(PORT, () => console.log(`AGORA v2.0 running on port ${PORT}`));
export default app;
