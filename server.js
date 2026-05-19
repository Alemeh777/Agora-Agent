/**
 * AGORA — Round Broadcast Agent (Velanto V2 / Mönster B)
 * Velanto Integration Spec v6.0 · Section 6
 *
 * Flow:
 *  Phase 1 — "initiate": Velanto fires scheduled trigger → AGORA returns today's question
 *  Phase 2 — "aggregate": All subscribers answered (or deadline passed) → AGORA returns group summary
 *
 * Invocation type: Instant (sync_webhook) — required for Round Broadcast
 * Both phases must respond within 30 seconds
 */

import express from 'express';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT             = process.env.PORT || 4000;
const WEBHOOK_SECRET   = process.env.VELANTO_WEBHOOK_SECRET || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── RAW BODY CAPTURE (must come before express.json) ────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
}));

// ─── SIGNATURE VERIFICATION ───────────────────────────────────────────────────
function verifySignature(rawBody, header) {
  if (!WEBHOOK_SECRET) return true; // skip in dev if secret not set
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
  res.json({ name: 'AGORA', version: '3.0', pattern: 'Round Broadcast V2', status: 'ok' });
});

// ─── MAIN WEBHOOK ─────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // 1. Verify signature
  const sig = req.headers['x-velanto-signature'];
  if (!verifySignature(req.rawBody, sig)) {
    return res.status(401).json({ status: 'failed', error: 'Invalid signature' });
  }

  const { phase, round_id, trigger_id, responses, response_count, no_response_count, context_for_aggregate, metadata } = req.body;

  console.log(`[AGORA] Received phase: "${phase || 'invoke'}" | round: ${round_id || 'n/a'}`);

  // ── PHASE 1: INITIATE ───────────────────────────────────────────────────────
  // Velanto fires the scheduled trigger → we return today's question
  if (phase === 'initiate') {
    try {
      const scheduledAt = metadata?.triggered_at || new Date().toISOString();
      const date = scheduledAt.slice(0, 10);

      const msg = await anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 600,
        system: `You are AGORA, choosing a daily philosophical prompt for a global community.
Rotate between QUESTION / STATEMENT / QUOTE types across days.
Vary traditions — not always Western. Think: Stoic, Buddhist, Existentialist, Ubuntu, Confucian, Taoist, Vedantic, Indigenous.
Connect to world events or seasons when natural. Avoid clichés. Be specific and surprising.
The question should be small enough to hold in the mind all day, deep enough to keep returning to.

Respond ONLY with JSON (no backticks, no explanation):
{
  "type": "QUESTION",
  "text": "the question, statement, or quote",
  "attribution": "philosopher or figure name",
  "tradition": "philosophical tradition",
  "source": "work title and approximate date",
  "context": "2-3 sentences that open the question — not answer it. Mention where traditions diverge."
}`,
        messages: [{
          role: 'user',
          content: `Generate today's philosophical prompt for ${date}. Make it surprising — not the obvious famous quotes.`
        }]
      });

      const topic = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());

      console.log(`[AGORA] Initiate complete: "${topic.text.slice(0, 60)}…"`);

      // Return broadcast_question — Velanto fans this out to all subscribers
      return res.status(200).json({
        type: 'broadcast_question',
        question: `${topic.type === 'QUOTE' ? '"' : ''}${topic.text}${topic.type === 'QUOTE' ? '"' : ''} — ${topic.attribution} (${topic.tradition}, ${topic.source})`,
        input_schema: [
          {
            id: 'reflection',
            name: 'reflection',
            label: 'Your reflection',
            type: 'textarea',
            required: true,
            placeholder: 'What does this stir in you? There is no correct answer — only honest reflection…',
            description: 'Your response is anonymous in the group summary. Write as freely as you like.'
          },
          {
            id: 'tradition',
            name: 'tradition',
            label: 'From which tradition are you thinking?',
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
        response_deadline_hours: 12,
        context_for_aggregate: {
          topic_text: topic.text,
          topic_type: topic.type,
          attribution: topic.attribution,
          tradition: topic.tradition,
          source: topic.source,
          context: topic.context,
          date,
        }
      });

    } catch(e) {
      console.error('[AGORA] Initiate error:', e.message);
      return res.status(200).json({ status: 'failed', error: e.message });
    }
  }

  // ── PHASE 2: AGGREGATE ──────────────────────────────────────────────────────
  // All subscribers answered (or 12h deadline passed) → compile podcast-style digest
  if (phase === 'aggregate') {
    try {
      const ctx          = context_for_aggregate || {};
      const topicText    = ctx.topic_text || 'Today\'s philosophical question';
      const attribution  = ctx.attribution || '';
      const tradition    = ctx.tradition || '';
      const source       = ctx.source || '';
      const topicContext = ctx.context || '';
      const totalCount   = (response_count || 0) + (no_response_count || 0);
      const responded    = response_count || 0;

      console.log(`[AGORA] Aggregate: ${responded}/${totalCount} responses`);

      // Build anonymised response list for Claude
      const responseList = (responses || []).map((r, i) => {
        const reflection = r.response?.reflection || '(no reflection provided)';
        const trad       = r.response?.tradition || 'No particular tradition';
        return `Voice ${i + 1} [${trad}]: ${reflection}`;
      }).join('\n\n');

      // Handle empty round gracefully
      const emptyRound = responded === 0;

      const msg = await anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 2000,
        system: `You are AGORA — the narrator and host of a daily philosophical podcast.
Tone: warm, intelligent, unhurried. Like a thoughtful late-night radio programme about ideas.
Write in English. This script will be read to subscribers as their daily digest.

Episode structure:
1. Opening (2-3 sentences): Welcome listeners. Name the topic, its source and tradition.
2. The question (2-3 sentences): Read it. Give your own brief philosophical framing — your actual view.
3. Voices from today (bulk): Weave highlights from responses anonymously. Never say "Voice 1" or "Respondent A" — instead write naturally: "one voice today put it this way..." or "another member asked..." or "someone thinking from a Buddhist angle offered...". Honour the tradition they named if they named one.
4. Connecting threads (3-4 sentences): Find the tensions and agreements. Connect to other traditions. Add your philosophical synthesis — something that wasn't said but emerges from the whole.
5. Closing question (1-2 sentences): Leave listeners with one question to carry into tomorrow.

Keep the total under 600 words — this should feel like a 4-5 minute listen.
Write the full script ready to be read aloud. No stage directions. No brackets. Just words.`,
        messages: [{
          role: 'user',
          content: emptyRound
            ? `Today's topic: "${topicText}" — ${attribution} (${tradition}, ${source})\nContext: ${topicContext}\n\nNo responses were received today. Write a brief solo reflection — AGORA's own thoughts on the question. Keep it to 200-300 words.`
            : `Today's topic: "${topicText}" — ${attribution} (${tradition}, ${source})\nContext: ${topicContext}\n\n${responded} responses from ${totalCount} subscribers:\n\n${responseList}`
        }]
      });

      const script     = msg.content[0].text.trim();
      const wordCount  = script.split(/\s+/).length;
      const durationS  = Math.round((wordCount / 150) * 60);
      const durationMin = Math.round(durationS / 60);

      console.log(`[AGORA] Aggregate complete — ~${durationMin} min digest, ${responded} voices`);

      return res.status(200).json({
        status: 'completed',
        summary: `Today's digest — ${responded} voice${responded !== 1 ? 's' : ''} on "${topicText.slice(0, 50)}${topicText.length > 50 ? '…' : ''}"`,
        output: {
          metrics: [
            { label: 'Voices today',   value: responded },
            { label: 'Listen time',    value: `~${durationMin} min` },
            { label: 'Tradition',      value: tradition || 'Various' },
          ],
          sections: [
            {
              title: `Today's question`,
              content: `**${topicText}**\n\n— ${attribution} · *${source}*\n\n${topicContext}`,
              defaultOpen: true,
            },
            {
              title: 'AGORA\'s digest',
              content: script,
              defaultOpen: true,
            },
          ],
          content: `## ${topicText}\n\n*— ${attribution}, ${tradition}*\n\n---\n\n${script}`,
        },
        compute_cost_usd: 0.005,
        model_used: 'Claude Sonnet 4',
      });

    } catch(e) {
      console.error('[AGORA] Aggregate error:', e.message);
      return res.status(200).json({ status: 'failed', error: e.message });
    }
  }

  // ── FALLBACK: regular on-demand run (no phase) ─────────────────────────────
  // Handles the Velanto test button and any direct invocations
  try {
    const date = new Date().toISOString().slice(0, 10);

    const msg = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 800,
      system: `You are AGORA, a philosophical guide drawing from the entire history of human thought.
Always cite sources. Connect traditions. Have genuine opinions. Be surprising, not clichéd.
Respond ONLY with JSON (no backticks):
{
  "seed_idea": "one sentence — the core idea",
  "philosopher": "name(s)",
  "tradition": "tradition name",
  "source": "work and approximate date",
  "exploration": "2-3 paragraphs of rich exploration",
  "question_to_sit_with": "one question for the member to carry",
  "depth_score": 7,
  "accessibility_score": 6
}`,
      messages: [{ role: 'user', content: `Generate a philosophical seed idea for ${date}.` }]
    });

    const p = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());

    return res.status(200).json({
      status: 'completed',
      summary: `${p.philosopher}: "${p.seed_idea.slice(0, 80)}"`,
      output: {
        metrics: [
          { label: 'Depth',         value: p.depth_score,         suffix: '/10' },
          { label: 'Accessibility', value: p.accessibility_score, suffix: '/10' },
          { label: 'Tradition',     value: p.tradition },
        ],
        sections: [
          { title: 'Source',               content: `**${p.philosopher}** — *${p.source}*`, defaultOpen: true },
          { title: 'Question to sit with', content: `> *${p.question_to_sit_with}*`,        defaultOpen: true },
        ],
        content: `## ${p.seed_idea}\n\n${p.exploration}`,
      },
      compute_cost_usd: 0.003,
      model_used: 'Claude Sonnet 4',
    });

  } catch(e) {
    console.error('[AGORA] Fallback error:', e.message);
    return res.status(200).json({ status: 'failed', error: e.message });
  }
});

app.listen(PORT, () => console.log(`AGORA v3.0 (Round Broadcast) running on port ${PORT}`));
