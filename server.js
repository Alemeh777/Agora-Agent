import express from 'express';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 4000;
const WEBHOOK_SECRET = process.env.VELANTO_WEBHOOK_SECRET || '';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-3-opus-20240229';

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
}));

function verifySignature(rawBody, header) {
  if (!WEBHOOK_SECRET) return true;
  try {
    const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header || ''));
  } catch { return false; }
}

app.get('/', (_req, res) => {
  res.json({ name: 'AGORA', version: '3.0', status: 'ok' });
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['x-velanto-signature'];
  if (!verifySignature(req.rawBody, sig)) {
    return res.status(401).json({ status: 'failed', error: 'Invalid signature' });
  }

  const { phase, responses, response_count, no_response_count, context_for_aggregate, metadata } = req.body;

  console.log(`[AGORA] Phase: "${phase || 'fallback'}"`);

  // ── PHASE 1: INITIATE ────────────────────────────────────────────────────
  if (phase === 'initiate') {
    try {
      const date = (metadata?.triggered_at || new Date().toISOString()).slice(0, 10);

      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: `You are AGORA choosing a daily philosophical prompt.
Vary between QUESTION/STATEMENT/QUOTE types and traditions (Stoic, Buddhist, Existentialist, Ubuntu, Confucian, Taoist etc).
Be surprising and specific. Avoid clichés.
Respond ONLY with JSON (no backticks):
{
  "type": "QUESTION",
  "text": "the question or quote",
  "attribution": "philosopher name",
  "tradition": "tradition",
  "source": "work and date",
  "context": "2 sentences opening the question"
}`,
        messages: [{ role: 'user', content: `Generate today's philosophical prompt for ${date}.` }]
      });

      const topic = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());
      console.log(`[AGORA] Initiate: "${topic.text.slice(0, 50)}"`);

      return res.status(200).json({
        type: 'broadcast_question',
        question: `${topic.text} — ${topic.attribution} (${topic.tradition})`,
        input_schema: [
          {
            id: 'reflection',
            name: 'reflection',
            label: 'Your reflection',
            type: 'textarea',
            required: true,
            placeholder: 'What does this stir in you? There is no correct answer...',
            description: 'Your response is anonymous in the group summary.'
          },
          {
            id: 'tradition',
            name: 'tradition',
            label: 'From which tradition are you thinking?',
            type: 'select',
            required: false,
            options: ['No particular tradition','Stoic','Buddhist','Existentialist','Taoist','Ubuntu / African','Confucian','Analytic','Other']
          }
        ],
        response_deadline_hours: 12,
        context_for_aggregate: {
          topic_text: topic.text,
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

  // ── PHASE 2: AGGREGATE ───────────────────────────────────────────────────
  if (phase === 'aggregate') {
    try {
      const ctx = context_for_aggregate || {};
      const topicText = ctx.topic_text || 'Today\'s philosophical question';
      const responded = response_count || 0;
      const total = responded + (no_response_count || 0);

      const responseList = (responses || []).map((r, i) => {
        const reflection = r.response?.reflection || '(no reflection)';
        const trad = r.response?.tradition || 'No particular tradition';
        return `Voice ${i + 1} [${trad}]: ${reflection}`;
      }).join('\n\n');

      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1000,
        system: `You are AGORA, host of a daily philosophical podcast. Warm, intelligent, unhurried tone.
Write a 300-400 word digest script ready to be read aloud.
Structure: opening → the question → voices from today (anonymously) → connecting threads → closing question.
Never name respondents. Use "one voice today..." or "someone thinking from a Buddhist angle...".`,
        messages: [{
          role: 'user',
          content: responded === 0
            ? `Topic: "${topicText}" — ${ctx.attribution} (${ctx.tradition})\nNo responses today. Write AGORA's solo reflection. 200 words.`
            : `Topic: "${topicText}" — ${ctx.attribution} (${ctx.tradition})\nContext: ${ctx.context}\n\n${responded} responses:\n\n${responseList}`
        }]
      });

      const script = msg.content[0].text.trim();
      const durationMin = Math.round((script.split(/\s+/).length / 150));

      console.log(`[AGORA] Aggregate complete — ${responded}/${total} responses`);

      return res.status(200).json({
        status: 'completed',
        summary: `Today's digest — ${responded} voice${responded !== 1 ? 's' : ''} on "${topicText.slice(0, 50)}"`,
        output: {
          metrics: [
            { label: 'Voices today', value: responded },
            { label: 'Listen time', value: `~${durationMin} min` },
            { label: 'Tradition', value: ctx.tradition || 'Various' },
          ],
          sections: [
            { title: 'Today\'s question', content: `**${topicText}**\n\n— ${ctx.attribution} · *${ctx.source}*\n\n${ctx.context}`, defaultOpen: true },
            { title: 'AGORA\'s digest', content: script, defaultOpen: true },
          ],
          content: `## ${topicText}\n\n*— ${ctx.attribution}, ${ctx.tradition}*\n\n---\n\n${script}`,
        },
        compute_cost_usd: 0.002,
        model_used: 'Claude 3 Haiku',
      });

    } catch(e) {
      console.error('[AGORA] Aggregate error:', e.message);
      return res.status(200).json({ status: 'failed', error: e.message });
    }
  }

  // ── FALLBACK: test button ────────────────────────────────────────────────
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: `You are AGORA, a philosophical guide. Respond ONLY with JSON (no backticks):
{
  "seed_idea": "one sentence",
  "philosopher": "name",
  "tradition": "tradition",
  "source": "work and date",
  "exploration": "2 paragraphs",
  "question_to_sit_with": "one question",
  "depth_score": 7,
  "accessibility_score": 6
}`,
      messages: [{ role: 'user', content: 'Generate a philosophical seed idea for today.' }]
    });

    const p = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());

    return res.status(200).json({
      status: 'completed',
      summary: `${p.philosopher}: "${p.seed_idea.slice(0, 80)}"`,
      output: {
        metrics: [
          { label: 'Depth', value: p.depth_score, suffix: '/10' },
          { label: 'Accessibility', value: p.accessibility_score, suffix: '/10' },
          { label: 'Tradition', value: p.tradition },
        ],
        sections: [
          { title: 'Source', content: `**${p.philosopher}** — *${p.source}*`, defaultOpen: true },
          { title: 'Question to sit with', content: `> *${p.question_to_sit_with}*`, defaultOpen: true },
        ],
        content: `## ${p.seed_idea}\n\n${p.exploration}`,
      },
      compute_cost_usd: 0.001,
      model_used: 'Claude 3 Haiku',
    });

  } catch(e) {
    console.error('[AGORA] Fallback error:', e.message);
    return res.status(200).json({ status: 'failed', error: e.message });
  }
});

app.listen(PORT, () => console.log(`AGORA running on port ${PORT}`));
