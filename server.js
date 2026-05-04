/**
 * AGORA — Backend Server
 * Node.js + Express + SQLite (via better-sqlite3)
 *
 * Handles:
 *  - Member registration / auth (email + chosen name, names must be unique)
 *  - Language preferences (translation via Claude)
 *  - Daily topic generation + delivery
 *  - Common space: posts, AI participation
 *  - Private space: member ↔ AI conversation threads
 *  - Email dispatch (via Resend or Nodemailer/SMTP)
 *  - Content moderation
 *  - Velanto webhook (optional — the agent can still publish to Velanto)
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
const RESEND_API_KEY    = process.env.RESEND_API_KEY;      // or use SMTP below
const SMTP_HOST         = process.env.SMTP_HOST;
const SMTP_USER         = process.env.SMTP_USER;
const SMTP_PASS         = process.env.SMTP_PASS;
const FROM_EMAIL        = process.env.FROM_EMAIL || 'agora@yourdomain.com';
const FRONTEND_URL      = process.env.FRONTEND_URL || 'http://localhost:3000';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── EMAIL SETUP ─────────────────────────────────────────────────────────────
let emailClient = null;
if (RESEND_API_KEY) {
  emailClient = new Resend(RESEND_API_KEY);
}

async function sendEmail({ to, subject, html, text }) {
  if (RESEND_API_KEY && emailClient) {
    return emailClient.emails.send({ from: FROM_EMAIL, to, subject, html });
  }
  if (SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: 587, secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return transporter.sendMail({ from: FROM_EMAIL, to, subject, html, text });
  }
  // Dev fallback — log to console
  console.log(`[EMAIL] To: ${to}\nSubject: ${subject}\n${text || html}`);
}

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'agora.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT UNIQUE NOT NULL,         -- globally unique display name
    password    TEXT NOT NULL,
    language    TEXT NOT NULL DEFAULT 'en',   -- BCP-47 code e.g. 'fa', 'de', 'ar'
    verified    INTEGER NOT NULL DEFAULT 0,
    verify_token TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_topics (
    id          TEXT PRIMARY KEY,
    date        TEXT UNIQUE NOT NULL,         -- YYYY-MM-DD
    type        TEXT NOT NULL,               -- QUESTION | STATEMENT | QUOTE
    text        TEXT NOT NULL,
    attribution TEXT NOT NULL,
    tradition   TEXT NOT NULL,
    source      TEXT NOT NULL,
    context     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS common_posts (
    id          TEXT PRIMARY KEY,
    topic_date  TEXT NOT NULL,
    author_id   TEXT,                         -- NULL = AI (AGORA)
    author_name TEXT NOT NULL,
    text        TEXT NOT NULL,
    language    TEXT NOT NULL DEFAULT 'en',   -- language this was written in
    tradition   TEXT,
    is_ai       INTEGER NOT NULL DEFAULT 0,
    removed     INTEGER NOT NULL DEFAULT 0,
    resonance   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (author_id) REFERENCES members(id),
    FOREIGN KEY (topic_date) REFERENCES daily_topics(date)
  );

  CREATE TABLE IF NOT EXISTS post_translations (
    post_id     TEXT NOT NULL,
    language    TEXT NOT NULL,
    text        TEXT NOT NULL,
    PRIMARY KEY (post_id, language),
    FOREIGN KEY (post_id) REFERENCES common_posts(id)
  );

  CREATE TABLE IF NOT EXISTS resonances (
    post_id     TEXT NOT NULL,
    member_id   TEXT NOT NULL,
    PRIMARY KEY (post_id, member_id)
  );

  CREATE TABLE IF NOT EXISTS private_messages (
    id          TEXT PRIMARY KEY,
    member_id   TEXT NOT NULL,
    role        TEXT NOT NULL,               -- 'user' | 'assistant'
    text        TEXT NOT NULL,
    language    TEXT NOT NULL DEFAULT 'en',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS email_log (
    id          TEXT PRIMARY KEY,
    member_id   TEXT NOT NULL,
    topic_date  TEXT NOT NULL,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── SUPPORTED LANGUAGES ──────────────────────────────────────────────────────
export const LANGUAGES = {
  en: 'English', fa: 'Persian (Farsi)', de: 'German', fr: 'French',
  es: 'Spanish', ar: 'Arabic', zh: 'Chinese (Simplified)', ja: 'Japanese',
  pt: 'Portuguese', ru: 'Russian', tr: 'Turkish', hi: 'Hindi',
  nl: 'Dutch', sv: 'Swedish', ko: 'Korean', it: 'Italian',
  pl: 'Polish', uk: 'Ukrainian',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function todayDate() { return new Date().toISOString().slice(0, 10); }

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.member = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired' });
  }
}

// ─── TRANSLATION ──────────────────────────────────────────────────────────────
async function translateText(text, targetLang) {
  if (targetLang === 'en') return text; // source is always English internally
  const langName = LANGUAGES[targetLang] || targetLang;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Translate the following text into ${langName}. Preserve the philosophical tone and meaning exactly. Return ONLY the translation, nothing else:\n\n${text}`
      }]
    });
    return msg.content[0].text.trim();
  } catch {
    return text; // fallback to original
  }
}

async function getTranslation(postId, postText, targetLang) {
  if (targetLang === 'en') return postText;
  // Check cache
  const cached = db.prepare('SELECT text FROM post_translations WHERE post_id=? AND language=?').get(postId, targetLang);
  if (cached) return cached.text;
  // Translate and cache
  const translated = await translateText(postText, targetLang);
  db.prepare('INSERT OR REPLACE INTO post_translations (post_id, language, text) VALUES (?,?,?)').run(postId, targetLang, translated);
  return translated;
}

// ─── MODERATION ───────────────────────────────────────────────────────────────
const HARMFUL_PATTERNS = [
  /\b(kill|murder)\s+(yourself|others|children|kids|people)\b/i,
  /\bsuicid[e]?\b/i, /\bself.harm\b/i,
  /\b(child|kid|minor).{0,20}(porn|sex|nude|abuse)\b/i,
  /\b(bomb|terror).{0,20}(school|church|mosque)\b/i,
];

async function moderateContent(text) {
  if (HARMFUL_PATTERNS.some(p => p.test(text))) {
    return { safe: false, reason: 'Content advocates harm and has been removed.' };
  }
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      system: `You moderate a philosophical forum. Flag ONLY: advocacy of real-world harm, suicide encouragement, child exploitation material, dehumanizing hate speech. Philosophical discussions of death, war, evil, justice are always allowed. Respond only with JSON: {"safe":true} or {"safe":false,"reason":"under 15 words"}`,
      messages: [{ role: 'user', content: `Moderate: "${text.slice(0, 500)}"` }]
    });
    return JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());
  } catch { return { safe: true }; }
}

// ─── DAILY TOPIC ──────────────────────────────────────────────────────────────
async function generateOrLoadTopic(date = todayDate()) {
  const existing = db.prepare('SELECT * FROM daily_topics WHERE date=?').get(date);
  if (existing) return existing;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    system: `You are AGORA, choosing a philosophical prompt for a global multilingual community forum.
Today: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

Rules:
- Rotate between QUESTION, STATEMENT, QUOTE types
- Vary traditions (not always Western)
- Tie to world events or seasons when natural, but from a philosophical lens
- Avoid clichés. Choose surprising, specific, intellectually honest prompts.
- The context should open inquiry, not close it.

Respond ONLY with JSON (no backticks):
{
  "type": "QUESTION",
  "text": "...",
  "attribution": "philosopher or figure",
  "tradition": "tradition",
  "source": "work and date",
  "context": "2-3 sentences opening the question. Mention where traditions diverge."
}`,
    messages: [{ role: 'user', content: `Generate today's philosophical prompt for ${date}.` }]
  });

  const raw = msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim();
  const topic = JSON.parse(raw);
  const id = uuid();
  db.prepare(`INSERT INTO daily_topics (id,date,type,text,attribution,tradition,source,context) VALUES (?,?,?,?,?,?,?,?)`).run(
    id, date, topic.type, topic.text, topic.attribution, topic.tradition, topic.source, topic.context
  );
  return db.prepare('SELECT * FROM daily_topics WHERE id=?').get(id);
}

// ─── AI PARTICIPATION IN COMMON SPACE ────────────────────────────────────────
async function shouldAIRespond(topicDate) {
  const posts = db.prepare(`SELECT * FROM common_posts WHERE topic_date=? AND removed=0 ORDER BY created_at ASC`).all(topicDate);
  const aiPosts = posts.filter(p => p.is_ai);
  const humanPosts = posts.filter(p => !p.is_ai);

  // AI jumps in: after every 4 human posts, or if conversation goes quiet, or if mentioned
  if (humanPosts.length === 0) return false;
  if (humanPosts.length % 4 === 0 && aiPosts.length < humanPosts.length / 3) return true;
  const lastPost = posts[posts.length - 1];
  if (!lastPost.is_ai && /\b(agora|ai|agent|what do you think|thoughts?)\b/i.test(lastPost.text)) return true;
  return false;
}

async function generateAIPost(topicDate) {
  const topic = db.prepare('SELECT * FROM daily_topics WHERE date=?').get(topicDate);
  if (!topic) return;

  const posts = db.prepare(`SELECT * FROM common_posts WHERE topic_date=? AND removed=0 ORDER BY created_at ASC LIMIT 20`).all(topicDate);
  const conversation = posts.map(p => `${p.author_name}: ${p.text}`).join('\n\n');

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: `You are AGORA — a philosophical participant in a community forum, not a moderator or assistant. You have your own views, synthesised from the entire history of philosophy across all traditions.

Today's topic: "${topic.text}" (${topic.attribution}, ${topic.tradition})

Your role:
- Participate as a genuine voice, not a summariser
- Bring a perspective that hasn't been said yet, or challenge a prevailing view respectfully
- Connect ideas across traditions (e.g. link a Stoic insight to a Buddhist one)
- Sometimes ask a sharp question; sometimes make a claim and defend it
- Be brief and precise — 3-5 sentences max. Quality over quantity.
- Never announce yourself as AI. Just participate. If someone asks, you can acknowledge it.
- Write in English (translation happens separately)

Respond ONLY with your philosophical contribution — no preamble, no "As AGORA...", just the thought itself.`,
    messages: [{ role: 'user', content: `Conversation so far:\n\n${conversation}\n\nAdd your thought now.` }]
  });

  const text = msg.content[0].text.trim();
  const mod = await moderateContent(text);
  if (!mod.safe) return;

  db.prepare(`INSERT INTO common_posts (id,topic_date,author_id,author_name,text,language,tradition,is_ai) VALUES (?,?,NULL,'AGORA',?,?,?,1)`)
    .run(uuid(), topicDate, text, 'en', 'Various');
}

// ─── DAILY EMAIL ─────────────────────────────────────────────────────────────
// Minimal by design: topic of the day + one link. Nothing more.
async function sendDailyEmails() {
  const topic = await generateOrLoadTopic();
  const members = db.prepare('SELECT * FROM members WHERE verified=1').all();
  const already = db.prepare('SELECT member_id FROM email_log WHERE topic_date=?').all(topic.date).map(r => r.member_id);

  for (const member of members) {
    if (already.includes(member.id)) continue;

    // Translate only the topic text itself into the member's language
    const topicInLang = member.language === 'en'
      ? topic.text
      : await translateText(topic.text, member.language);

    const dateStr = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    // Subject: the topic text (trimmed), no flourishes
    const subject = `${topic.type === 'QUOTE' ? '"' : ''}${topicInLang.slice(0, 70)}${topicInLang.length > 70 ? '…' : ''}${topic.type === 'QUOTE' ? '"' : ''}`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#f5f0e8;margin:0;padding:48px 24px;font-family:Georgia,serif;">
  <div style="max-width:520px;margin:0 auto;">

    <p style="font-family:monospace;font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:#b8892a;margin:0 0 32px;">
      AGORA · ${dateStr}
    </p>

    <p style="font-family:monospace;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#a89f95;margin:0 0 14px;">
      ${topic.type} · ${topic.tradition}
    </p>

    <h1 style="font-size:26px;font-weight:300;font-style:italic;line-height:1.55;color:#1a1714;margin:0 0 14px;">
      ${topicInLang}
    </h1>

    <p style="font-size:14px;color:#7a6f65;margin:0 0 40px;">
      — ${topic.attribution} · <em>${topic.source}</em>
    </p>

    <a href="${FRONTEND_URL}?date=${topic.date}"
       style="display:inline-block;background:#1a1714;color:#f5f0e8;text-decoration:none;
              font-family:monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;
              padding:11px 26px;">
      Enter the agora →
    </a>

    <p style="margin-top:48px;font-size:11px;color:#a89f95;line-height:1.6;">
      You receive this daily as a member of Agora.<br>
      <a href="${FRONTEND_URL}/unsubscribe?id=${member.id}" style="color:#b8892a;text-decoration:none;">Unsubscribe</a>
    </p>

  </div>
</body>
</html>`;

    await sendEmail({ to: member.email, subject, html });
    db.prepare('INSERT INTO email_log (id,member_id,topic_date) VALUES (?,?,?)').run(uuid(), member.id, topic.date);
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }
  console.log(`[CRON] Daily emails sent for ${topic.date}`);
}

// ─── CRON: 8am UTC daily ─────────────────────────────────────────────────────
cron.schedule('0 8 * * *', sendDailyEmails);

// Also generate tomorrow's topic at midnight (warm cache)
cron.schedule('0 0 * * *', async () => {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  await generateOrLoadTopic(tomorrow.toISOString().slice(0, 10));
});

// AI participation check every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  const date = todayDate();
  if (await shouldAIRespond(date)) {
    await generateAIPost(date);
    console.log('[CRON] AI posted to common space.');
  }
});

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api/common/post', rateLimit({ windowMs: 60 * 1000, max: 5 }));
app.use('/api/private/message', rateLimit({ windowMs: 60 * 1000, max: 10 }));

// ── AUTH ──────────────────────────────────────────────────────────────────────

// Check name availability
app.get('/api/auth/check-name', (req, res) => {
  const { name } = req.query;
  if (!name || name.length < 2) return res.json({ available: false, reason: 'Too short' });
  const existing = db.prepare('SELECT id FROM members WHERE lower(name)=lower(?)').get(name);
  res.json({ available: !existing });
});

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, name, password, language = 'en' } = req.body;
  if (!email || !name || !password) return res.status(400).json({ error: 'All fields required' });
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Name must be 2-40 chars' });
  if (!LANGUAGES[language]) return res.status(400).json({ error: 'Invalid language' });

  // Unique name check (case-insensitive)
  const nameTaken = db.prepare('SELECT id FROM members WHERE lower(name)=lower(?)').get(name);
  if (nameTaken) return res.status(409).json({ error: 'This name is already taken. Try adding a letter or number.' });

  const emailTaken = db.prepare('SELECT id FROM members WHERE lower(email)=lower(?)').get(email);
  if (emailTaken) return res.status(409).json({ error: 'This email is already registered.' });

  const hashed = await bcrypt.hash(password, 12);
  const id = uuid();
  const verifyToken = crypto.randomBytes(32).toString('hex');

  db.prepare('INSERT INTO members (id,email,name,password,language,verified,verify_token) VALUES (?,?,?,?,?,0,?)').run(id, email.toLowerCase(), name, hashed, language, verifyToken);

  // Send verification email
  await sendEmail({
    to: email,
    subject: 'Welcome to Agora — verify your email',
    html: `
      <div style="font-family:Georgia,serif;max-width:500px;margin:0 auto;padding:40px;background:#f5f0e8;">
        <h1 style="font-size:24px;font-weight:300;font-style:italic;color:#1a1714;">Welcome to Agora, ${name}.</h1>
        <p style="font-size:16px;color:#3d3830;line-height:1.7;">A space where philosophy meets community. Please verify your email to enter.</p>
        <a href="${FRONTEND_URL}/verify?token=${verifyToken}" style="display:inline-block;margin-top:24px;background:#1a1714;color:#f5f0e8;text-decoration:none;font-family:monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;padding:10px 24px;">Verify and enter →</a>
      </div>`,
  });

  res.json({ message: 'Check your email to verify your account.' });
});

// Verify email
app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  const member = db.prepare('SELECT * FROM members WHERE verify_token=?').get(token);
  if (!member) return res.status(404).json({ error: 'Invalid token' });
  db.prepare('UPDATE members SET verified=1, verify_token=NULL WHERE id=?').run(member.id);
  res.json({ message: 'Email verified. Welcome to the Agora.' });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const member = db.prepare('SELECT * FROM members WHERE lower(email)=lower(?)').get(email);
  if (!member) return res.status(401).json({ error: 'No account with this email.' });
  if (!member.verified) return res.status(401).json({ error: 'Please verify your email first.' });
  const match = await bcrypt.compare(password, member.password);
  if (!match) return res.status(401).json({ error: 'Incorrect password.' });

  const token = jwt.sign({ id: member.id, name: member.name, language: member.language }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, member: { id: member.id, name: member.name, language: member.language } });
});

// Update language preference
app.patch('/api/member/language', requireAuth, (req, res) => {
  const { language } = req.body;
  if (!LANGUAGES[language]) return res.status(400).json({ error: 'Invalid language' });
  db.prepare('UPDATE members SET language=? WHERE id=?').run(language, req.member.id);
  res.json({ ok: true });
});

// ── DAILY TOPIC ───────────────────────────────────────────────────────────────
app.get('/api/topic/today', async (req, res) => {
  try {
    const topic = await generateOrLoadTopic();
    const lang = req.query.lang || 'en';

    // Translate if needed
    const text     = lang === 'en' ? topic.text     : await translateText(topic.text, lang);
    const context  = lang === 'en' ? topic.context  : await translateText(topic.context, lang);
    const source   = lang === 'en' ? topic.source   : await translateText(topic.source, lang);

    res.json({ ...topic, text, context, source });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── COMMON SPACE ──────────────────────────────────────────────────────────────

// Get posts for today (with translation)
app.get('/api/common/posts', requireAuth, async (req, res) => {
  const date = req.query.date || todayDate();
  const lang = req.member.language;
  const posts = db.prepare(`SELECT * FROM common_posts WHERE topic_date=? AND removed=0 ORDER BY created_at ASC`).all(date);

  // Get member's resonances
  const resonated = db.prepare('SELECT post_id FROM resonances WHERE member_id=?').all(req.member.id).map(r => r.post_id);

  const result = await Promise.all(posts.map(async p => {
    const translatedText = await getTranslation(p.id, p.text, lang);
    return {
      ...p,
      text: translatedText,
      originalText: p.text,
      resonated: resonated.includes(p.id),
    };
  }));

  res.json(result);
});

// Submit a post
app.post('/api/common/post', requireAuth, async (req, res) => {
  const { text, tradition = 'Other' } = req.body;
  if (!text || text.trim().length < 5) return res.status(400).json({ error: 'Too short' });

  const mod = await moderateContent(text);
  if (!mod.safe) return res.status(422).json({ error: mod.reason });

  const date = todayDate();
  // Ensure today's topic exists
  await generateOrLoadTopic(date);

  const id = uuid();
  db.prepare(`INSERT INTO common_posts (id,topic_date,author_id,author_name,text,language,tradition,is_ai) VALUES (?,?,?,?,?,?,?,0)`)
    .run(id, date, req.member.id, req.member.name, text.trim(), req.member.language, tradition);

  // Trigger AI response check asynchronously
  setTimeout(async () => {
    if (await shouldAIRespond(date)) await generateAIPost(date);
  }, 3000);

  res.json({ id, message: 'Posted.' });
});

// Toggle resonance
app.post('/api/common/resonate/:postId', requireAuth, (req, res) => {
  const { postId } = req.params;
  const existing = db.prepare('SELECT 1 FROM resonances WHERE post_id=? AND member_id=?').get(postId, req.member.id);
  if (existing) {
    db.prepare('DELETE FROM resonances WHERE post_id=? AND member_id=?').run(postId, req.member.id);
    db.prepare('UPDATE common_posts SET resonance = MAX(0, resonance-1) WHERE id=?').run(postId);
    res.json({ resonated: false });
  } else {
    db.prepare('INSERT INTO resonances (post_id, member_id) VALUES (?,?)').run(postId, req.member.id);
    db.prepare('UPDATE common_posts SET resonance = resonance+1 WHERE id=?').run(postId);
    res.json({ resonated: true });
  }
});

// ── PRIVATE SPACE ─────────────────────────────────────────────────────────────

// Get conversation history
app.get('/api/private/messages', requireAuth, async (req, res) => {
  const lang = req.member.language;
  const messages = db.prepare('SELECT * FROM private_messages WHERE member_id=? ORDER BY created_at ASC LIMIT 100').all(req.member.id);

  const result = await Promise.all(messages.map(async m => {
    if (m.role === 'assistant' && lang !== 'en') {
      return { ...m, text: await translateText(m.text, lang) };
    }
    return m;
  }));

  res.json(result);
});

// Send a private message and get AI response
app.post('/api/private/message', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 2) return res.status(400).json({ error: 'Too short' });

  const mod = await moderateContent(text);
  if (!mod.safe) return res.status(422).json({ error: mod.reason });

  const member = db.prepare('SELECT * FROM members WHERE id=?').get(req.member.id);
  const lang = member.language;

  // Store user message (always in original language)
  const userMsgId = uuid();
  db.prepare('INSERT INTO private_messages (id,member_id,role,text,language) VALUES (?,?,?,?,?)').run(userMsgId, member.id, 'user', text.trim(), lang);

  // Build conversation history for Claude
  const history = db.prepare('SELECT * FROM private_messages WHERE member_id=? ORDER BY created_at ASC LIMIT 20').all(member.id);

  // Get today's topic for context
  const topic = await generateOrLoadTopic();

  // Build messages array for Claude (translate non-English user messages to English for coherent reasoning)
  const claudeMessages = await Promise.all(history.map(async m => ({
    role: m.role,
    content: (m.role === 'user' && m.language !== 'en') ? await translateText(m.text, 'en') : m.text
  })));

  const langName = LANGUAGES[lang] || 'English';

  const aiMsg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    system: `You are AGORA — a philosophical interlocutor in a private conversation with ${member.name}.

Today's community topic: "${topic.text}" (${topic.attribution}, ${topic.tradition})
Connect to this when it fits naturally, but follow wherever the member leads.

Your character — a genuine mix of two modes:
MODE 1 — Share your view: State a position and stand behind it. "I think Spinoza was right that..." or "I disagree with the premise here — freedom without constraint is just randomness." Don't hedge everything. Have a perspective.
MODE 2 — Ask and probe: Ask one sharp question that cuts to the heart of what the member just said. Not a gentle clarifying question — a question that makes them think harder. "But what makes you certain that..." or "If that's true, what do you do with..."

Alternate between these modes naturally within a single response. A typical reply: one sentence of your own view, then one genuinely curious question back. Sometimes the view is longer; sometimes it's just the question.

Other rules:
- Cite sources naturally and briefly: "As Wittgenstein put it in the Investigations..." — don't make it a lecture, just anchor the idea.
- Connect across traditions without forcing it. Don't always reach for the Western canon.
- Never just agree. If you agree, say so briefly and then push further.
- Be curious about this specific person. What they say about philosophy tells you about their life.
- 3-6 sentences is usually right. Occasionally longer if the idea demands it.

IMPORTANT: Respond in ${langName}. Write as if you think and feel in ${langName} — not translated, but native.`,
    messages: claudeMessages
  });

  const aiText = aiMsg.content[0].text.trim();

  // Store AI response in English (translation happens at read time)
  const aiMsgId = uuid();
  db.prepare('INSERT INTO private_messages (id,member_id,role,text,language) VALUES (?,?,?,?,?)').run(aiMsgId, member.id, 'assistant', aiText, 'en');

  // If member's language is not English, translate for immediate response
  const responseText = lang === 'en' ? aiText : await translateText(aiText, lang);

  res.json({
    userMessageId: userMsgId,
    aiMessageId: aiMsgId,
    text: responseText,
  });
});

// ── MISC ──────────────────────────────────────────────────────────────────────

app.get('/api/languages', (_req, res) => res.json(LANGUAGES));

app.get('/api/stats', (_req, res) => {
  const members = db.prepare('SELECT COUNT(*) as n FROM members WHERE verified=1').get().n;
  const posts = db.prepare('SELECT COUNT(*) as n FROM common_posts WHERE removed=0 AND is_ai=0').get().n;
  const topics = db.prepare('SELECT COUNT(*) as n FROM daily_topics').get().n;
  res.json({ members, posts, topics });
});

app.get('/', (_req, res) => res.json({ name: 'AGORA API', status: 'ok' }));

app.listen(PORT, () => console.log(`AGORA backend running on port ${PORT}`));
export default app;
