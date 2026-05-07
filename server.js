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
  const { run_id, input = {} } = req.body;
  const { mode = 'daily', topic, tradition_filter, depth_preference } = input;

  try {
    let userPrompt = '';
    if (mode === 'daily') {
      userPrompt = `Generate a philosophical seed idea for today.${tradition_filter && tradition_filter !== 'Any' ? ` Focus on ${tradition_filter} philosophy.` : ''}`;
    } else if (mode === 'explore') {
      userPrompt = `Explore this idea: "${topic}".`;
    } else {
      userPrompt = `Show a philosophical debate around: "${topic}".`;
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `You are AGORA, a philosophical guide. Respond ONLY with JSON (no backticks):
{
  "seed_idea": "one sentence",
  "philosopher": "name",
  "tradition": "tradition",
  "source": "work and date",
  "exploration": "3-4 paragraphs",
  "question_to_sit_with": "one question",
  "related_ideas": [
    {"philosopher":"name","idea":"connection","tradition":"tradition"}
  ],
  "depth_score": 7,
  "accessibility_score": 6
}`,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const p = JSON.parse(msg.content[0].text.replace(/```json\n?|```\n?/g, '').trim());

    return res.json({
      status: 'completed',
      summary: `${p.philosopher}: "${p.seed_idea.slice(0, 80)}"`,
      output: {
        metrics: [
          { label: 'Depth', value: p.depth_score, suffix: '/10' },
          { label: 'Accessibility', value: p.accessibility_score, suffix: '/10' },
          { label: 'Tradition', value: p.tradition },
        ],
        tables: [],
        sections: [
          { title: 'Source', content: `**${p.philosopher}** — *${p.source}*`, defaultOpen: true },
          { title: 'Question to sit with', content: `> *${p.question_to_sit_with}*`, defaultOpen: true },
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

app.listen(PORT, () => console.log(`AGORA running on port ${PORT}`));
