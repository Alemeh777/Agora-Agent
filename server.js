/**
 * AGORA v5.0 — Single $5/month tier
 *
 * Features:
 *  - Weekly philosophical question (Saturdays)
 *  - Daily on-demand conversation available any day
 *  - Weekly podcast audio digest via OpenAI TTS
 *  - Text digest for all subscribers
 *  - Claude Opus 4 for philosophy generation
 *  - OpenAI TTS for audio
 */

import express from 'express';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
const WEBHOOK_SECRET = process.env.VELANTO_WEBHOOK_SECRET || '';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CLAUDE_MODEL = 'claude-opus-4-7';
const TTS_MODEL = 'tts-1'; // OpenAI standard TTS — good quality, lowest cost
const TTS_VOICE = 'nova';  // Warm, clear voice — good for philosophy podcast
const AUDIO_DIR = path.join(__dirname, 'audio');

// Create audio directory if it doesn't exist
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ─── RAW BODY + JSON ──────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
}));

// ─── SERVE AUDIO FILES ────────────────────────────────────────────────────────
// Velanto needs a public URL to serve the audio file to subscribers
app.use('/audio', express.static(AUDIO_DIR));

// ─── SIGNATURE VERIFICATION ───────────────────────────────────────────────────
function verifySignature(rawBody, header) {
  if (!WEBHOOK_SECRET) return true;
  try {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(header || '')
    );
  } catch { return false; }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ name: 'AGORA', version: '5.0', status: 'ok' });
});

// ─── GENERATE AUDIO ───────────────────────────────────────────────────────────
async function generateAudio(script, filename) {
  try {
    const response = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: script.slice(0, 4000), // OpenAI TTS limit per request
      response_format: 'mp3',
    });

    const audioPath = path.join(AUDIO_DIR, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(audioPath, buffer);

    // Return the public URL for this audio file
    const baseUrl = process.env.AUDIO_STORAGE_URL || 'https://agora-agent-production.up.railway.app';
    return baseUrl + '/audio/' + filename;

  } catch(e) {
    console.error('[AGORA] Audio generation error: ' + e.message);
    return null;
  }
}

// ─── MAIN WEBHOOK ─────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['x-velanto-signature'];
  if (!verifySignature(req.rawBody, sig)) {
    return res.status(401).json({ status: 'failed', error: 'Invalid signature' });
  }

  const { phase, responses, response_count, no_response_count, context_for_aggregate, metadata } = req.body;
  const runType = metadata && metadata.run_type ? metadata.run_type : 'on_demand';

  console.log('[AGORA] Phase: ' + (phase || 'fallback') + ' | RunType: ' + runType);

  // ── PHASE 1: INITIATE (weekly question broadcast) ──────────────────────────
  if (phase === 'initiate') {
    try {
      const date = (metadata && metadata.triggered_at
        ? metadata.triggered_at
        : new Date().toISOString()).slice(0, 10);

      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        system: 'You are AGORA choosing a weekly philosophical prompt for a global community. Choose something universally resonant — accessible to anyone regardless of philosophical background, but deep enough to sit with all week. Vary traditions each week. Be surprising, not clichéd. Respond ONLY with JSON (no backticks): {"type":"QUESTION","text":"...","attribution":"...","tradition":"...","source":"...","context":"2 sentences that open the question"}',
        messages: [{
          role: 'user',
          content: 'Generate this week\'s philosophical prompt for the week of ' + date + '.'
        }]
      });

      const topic = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());
      console.log('[AGORA] Weekly question: "' + topic.text.slice(0, 50) + '"');

      return res.status(200).json({
        type: 'broadcast_question',
        question: topic.text + ' — ' + topic.attribution + ' (' + topic.tradition + ', ' + topic.source + ')',
        input_schema: [
          {
            id: 'reflection',
            name: 'reflection',
            label: 'Your reflection',
            type: 'textarea',
            required: true,
            placeholder: 'What does this stir in you? There is no correct answer — only honest reflection.',
            description: 'Your response is anonymous in the weekly digest. Write as freely as you like.'
          },
          {
            id: 'tradition',
            name: 'tradition',
            label: 'Thinking from which tradition?',
            type: 'select',
            required: false,
            options: [
              'No particular tradition',
              'Stoic',
              'Buddhist',
              'Existentialist',
              'Taoist',
              'Ubuntu / African',
              'Confucian',
              'Analytic',
              'Other'
            ]
          }
        ],
        response_deadline_hours: 48,
        context_for_aggregate: {
          topic_text: topic.text,
          attribution: topic.attribution,
          tradition: topic.tradition,
          source: topic.source,
          context: topic.context,
          date: date
        }
      });

    } catch(e) {
      console.error('[AGORA] Initiate error: ' + e.message);
      return res.status(200).json({ status: 'failed', error: e.message });
    }
  }

  // ── PHASE 2: AGGREGATE (compile digest + generate audio) ──────────────────
  if (phase === 'aggregate') {
    try {
      const ctx = context_for_aggregate || {};
      const topicText = ctx.topic_text || 'This week\'s philosophical question';
      const responded = response_count || 0;

      const responseList = (responses || []).map(function(r, i) {
        const reflection = r.response && r.response.reflection ? r.response.reflection : '';
        const trad = r.response && r.response.tradition ? r.response.tradition : 'Various';
        return 'Voice ' + (i + 1) + ' [' + trad + ']: ' + reflection;
      }).join('\n\n');

      // Generate podcast script via Claude
      const scriptMsg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        system: 'You are AGORA, host of a weekly philosophical podcast. Warm, intelligent, unhurried tone — like a thoughtful late-night radio programme about ideas. Write a 400-500 word script ready to be read aloud. Structure: opening (welcome listeners, name the topic and tradition) → the question (brief philosophical framing — your own view) → voices from this week (anonymously woven in, never "Voice 1", use "one member this week..." or "someone thinking from a Stoic angle...") → connecting threads (find tensions and agreements, add your synthesis) → closing question to carry into next week. No stage directions. No brackets. Just words.',
        messages: [{
          role: 'user',
          content: responded === 0
            ? 'Topic: "' + topicText + '" — ' + ctx.attribution + ' (' + ctx.tradition + ')\nContext: ' + ctx.context + '\n\nNo responses this week. Write AGORA\'s solo reflection. 250 words.'
            : 'Topic: "' + topicText + '" — ' + ctx.attribution + ' (' + ctx.tradition + ')\nContext: ' + ctx.context + '\n\n' + responded + ' responses this week:\n\n' + responseList
        }]
      });

      const script = scriptMsg.content[0].text.trim();
      const wordCount = script.split(/\s+/).length;
      const durationMin = Math.round(wordCount / 150);

      console.log('[AGORA] Script generated — ' + wordCount + ' words, ~' + durationMin + ' min');

      // Generate audio via OpenAI TTS
      const audioFilename = 'agora-digest-' + (ctx.date || new Date().toISOString().slice(0, 10)) + '.mp3';
      const audioUrl = await generateAudio(script, audioFilename);

      console.log('[AGORA] Audio: ' + (audioUrl ? 'ok — ' + audioUrl : 'failed'));

      // Build output
      const output = {
        metrics: [
          { label: 'Voices this week', value: responded },
          { label: 'Listen time', value: '~' + durationMin + ' min' },
          { label: 'Tradition', value: ctx.tradition || 'Various' }
        ],
        sections: [
          {
            title: 'This week\'s question',
            content: '**' + topicText + '**\n\n— ' + ctx.attribution + ' · *' + ctx.source + '*\n\n' + ctx.context,
            defaultOpen: true
          },
          {
            title: 'AGORA\'s weekly digest',
            content: script,
            defaultOpen: true
          }
        ],
        content: '## ' + topicText + '\n\n*— ' + ctx.attribution + ', ' + ctx.tradition + '*\n\n---\n\n' + script
      };

      // Add audio attachment if generation succeeded
      if (audioUrl) {
        output.attachments = [
          {
            type: 'audio',
            filename: audioFilename,
            url: audioUrl,
            description: 'AGORA weekly digest — ' + (ctx.date || 'this week')
          }
        ];
      } else {
        output.sections.push({
          title: 'Audio digest',
          content: 'Audio generation is currently unavailable. The written digest above contains the full content.',
          defaultOpen: false
        });
      }

      return res.status(200).json({
        status: 'completed',
        summary: 'Weekly digest — ' + responded + ' voice' + (responded !== 1 ? 's' : '') + ' on "' + topicText.slice(0, 50) + '"',
        output: output,
        compute_cost_usd: 0.005,
        model_used: 'Claude Opus 4 + OpenAI TTS'
      });

    } catch(e) {
      console.error('[AGORA] Aggregate error: ' + e.message);
      return res.status(200).json({ status: 'failed', error: e.message });
    }
  }

  // ── FALLBACK: on-demand daily question ────────────────────────────────────
  // This handles when a subscriber asks their own question any day of the week
  try {
    const userQuestion = req.body.input && req.body.input.question ? req.body.input.question : '';

    const prompt = userQuestion
      ? 'The member wants to explore this philosophical question: "' + userQuestion + '". Give a rich, engaging philosophical response — share your own view, connect to 2-3 traditions, cite sources briefly, and end with one sharp question back to them.'
      : 'Generate a philosophical seed idea for today. Something surprising and worth sitting with.';

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system: 'You are AGORA, a philosophical conversation partner. You have genuine opinions. You cite sources naturally. You connect traditions. You never just agree — you always push further. Respond ONLY with JSON (no backticks): {"seed_idea":"one sentence core idea","philosopher":"name(s)","tradition":"tradition","source":"work and date","exploration":"2-3 paragraphs","question_to_sit_with":"one sharp question","depth_score":7,"accessibility_score":6}',
      messages: [{ role: 'user', content: prompt }]
    });

    const p = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());

    return res.status(200).json({
      status: 'completed',
      summary: p.philosopher + ': "' + p.seed_idea.slice(0, 80) + '"',
      output: {
        metrics: [
          { label: 'Depth', value: p.depth_score, suffix: '/10' },
          { label: 'Accessibility', value: p.accessibility_score, suffix: '/10' },
          { label: 'Tradition', value: p.tradition }
        ],
        sections: [
          {
            title: 'Source',
            content: '**' + p.philosopher + '** — *' + p.source + '*',
            defaultOpen: true
          },
          {
            title: 'Question to sit with',
            content: '> *' + p.question_to_sit_with + '*',
            defaultOpen: true
          }
        ],
        content: '## ' + p.seed_idea + '\n\n' + p.exploration
      },
      compute_cost_usd: 0.002,
      model_used: 'Claude Opus 4'
    });

  } catch(e) {
    console.error('[AGORA] Fallback error: ' + e.message);
    return res.status(200).json({ status: 'failed', error: e.message });
  }
});

app.listen(PORT, () => console.log('AGORA v5.0 running on port ' + PORT));
