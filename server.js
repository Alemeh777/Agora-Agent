import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 4000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
}));

app.get('/', (_req, res) => res.json({ name: 'AGORA', version: '2.0', status: 'ok' }));

app.post('/webhook', async (req, res) => {
  const { run_id, input = {}, metadata = {} } = req.body;
  const { mode = 'daily', topic, tradition_filter, depth_preference } = input;
  const callbackUrl = metadata.callback_url;

  // Step 1: Reply immediately with 202
  res.status(202).json({ status: 'accepted' });

  // Step 2: Run Claude and POST result back to Velanto callback URL
  try {
    let userPrompt = '';
    if (mode === 'daily') {
      userPrompt = `Generate a philosophical seed idea for today.${tradition_filter && tradition_filter !== 'Any' ? ` Focus on ${tradition_filter} philosophy.` : ''}`;
    } else if (mode === 'explore') {
      userPrompt = `Explore this philosophical idea: "${topic}".${depth_preference === 'beginner' ? ' Keep it accessible.' : depth_preference === 'deep' ? ' Go technically deep.' : ''}`;
    } else {
      userPrompt = `Show a genuine philosophical debate around: "${topic}". Show how traditions disagree and why each has merit.`;
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
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
    {"philosopher":"name","idea":"brief connection","tradition":"tradition"}
  ],
  "depth_score": 7,
  "accessibility_score": 6
}`,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const p = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());

    const result = {
      run_id,
      status: 'completed',
      summary: `${p.philosopher}: "${p.seed_idea.slice(0, 80)}"`,
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
          { title: 'Source',               content: `**${p.philosopher}** — *${p.source}*`, defaultOpen: true },
          { title: 'Question to sit with', content: `> *${p.question_to_sit_with}*`,        defaultOpen: true },
        ],
        content: `## ${p.seed_idea}\n\n${p.exploration}`,
      },
      compute_cost_usd: 0.003,
    };

    // POST result back to Velanto
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });

    console.log(`[WEBHOOK ${run_id}] Completed and sent to callback.`);

  } catch(e) {
    console.error(`[WEBHOOK ${run_id}] Error:`, e.message);
    if (callbackUrl) {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id, status: 'failed', error: e.message }),
      }).catch(() => {});
    }
  }
});

app.listen(PORT, () => console.log(`AGORA running on port ${PORT}`));
