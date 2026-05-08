require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const META_BASE = 'https://graph.facebook.com/v19.0';

let META_TOKEN = process.env.META_ACCESS_TOKEN || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';
const AUTH_SECRET = process.env.AUTH_SECRET || 'default-secret-change-me';

const VALID_TOKEN = crypto
  .createHmac('sha256', AUTH_SECRET)
  .update(DASHBOARD_PASSWORD)
  .digest('hex');

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token === VALID_TOKEN) return next();
  res.status(401).json({ error: 'Niet ingelogd' });
}

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    res.json({ token: VALID_TOKEN });
  } else {
    res.status(401).json({ error: 'Verkeerd wachtwoord' });
  }
});

async function metaFetch(urlPath, method = 'GET', body = null) {
  const url = `${META_BASE}${urlPath}${urlPath.includes('?') ? '&' : '?'}access_token=${META_TOKEN}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function claudeFetch(prompt, systemPrompt = '', maxTokens = 1500) {
  const body = {
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  };
  if (systemPrompt) body.system = systemPrompt;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || '';
}

// ── Admin: update Meta token ──────────────────────────────────────────────
// In serverless environments (Vercel) in-memory changes don't persist —
// update META_ACCESS_TOKEN in the Vercel dashboard environment variables instead.
app.post('/api/admin/update-token', requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token || token.length < 20) {
    return res.status(400).json({ error: 'Ongeldig token' });
  }
  META_TOKEN = token;
  res.json({ ok: true, message: 'Token bijgewerkt voor deze sessie. Vergeet niet ook de omgevingsvariabele META_ACCESS_TOKEN bij te werken in het Vercel dashboard — anders is het token weg na de volgende deploy.' });
});

// ── Meta routes ───────────────────────────────────────────────────────────
app.get('/api/accounts', requireAuth, async (req, res) => {
  try { res.json(await metaFetch('/me/adaccounts?fields=name,account_id,currency,account_status,spend_cap,amount_spent')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/accounts/:id/campaigns', requireAuth, async (req, res) => {
  try { res.json(await metaFetch(`/${req.params.id}/campaigns?fields=name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time&limit=50`)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/campaigns/:id/toggle', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const result = await fetch(`${META_BASE}/${req.params.id}?status=${status}&access_token=${META_TOKEN}`, { method: 'POST' });
    res.json(await result.json());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/accounts/:id/insights', requireAuth, async (req, res) => {
  try {
    const preset = req.query.preset || 'last_30d';
    res.json(await metaFetch(`/${req.params.id}/campaigns?fields=name,insights.date_preset(${preset}){spend,impressions,clicks,cpc,ctr,reach,actions}&limit=20`));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/accounts/:id/stats', requireAuth, async (req, res) => {
  try {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    const [insights, campaigns] = await Promise.all([
      metaFetch(`/${req.params.id}/insights?fields=spend,impressions,clicks,reach&time_range={"since":"${firstDay}","until":"${todayStr}"}`),
      metaFetch(`/${req.params.id}/campaigns?fields=status&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE"]}]`)
    ]);
    res.json({ insights: insights.data?.[0] || {}, activeCampaigns: campaigns.data?.length || 0 });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/accounts/:id/leadforms', requireAuth, async (req, res) => {
  try { res.json(await metaFetch(`/${req.params.id}/leadgen_forms?fields=name,leads_count,created_time,status&limit=20`)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/leadforms/:id/leads', requireAuth, async (req, res) => {
  try { res.json(await metaFetch(`/${req.params.id}/leads?fields=field_data,created_time&limit=25`)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── AI routes ─────────────────────────────────────────────────────────────
app.post('/api/generate-ad', requireAuth, async (req, res) => {
  const { brief, objective, budget, targetAge, tone, platform } = req.body;
  try {
    const result = await claudeFetch(`Schrijf een krachtige Meta advertentietekst op basis van:
Product/dienst: ${brief}
Doelstelling: ${objective}
Dagbudget: €${budget || '?'}
Doelgroep leeftijd: ${targetAge || 'niet opgegeven'}
Toon: ${tone || 'professioneel maar toegankelijk'}
Platform: ${platform || 'Facebook & Instagram'}

Geef PRECIES dit formaat:

**Primaire tekst:**
[max 125 woorden]

**Koptekst:**
[max 40 tekens]

**Beschrijving:**
[max 25 tekens]

**Call-to-action:**
[Meer informatie / Shop nu / Aanmelden / Offerte aanvragen / Downloaden]

**Doelgroep tip:**
[één zin]

**3 koptekst varianten voor A/B test:**
1. [variant]
2. [variant]
3. [variant]`, 'Je bent een senior Meta advertentiespecialist. Schrijf in het Nederlands.');
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyse-performance', requireAuth, async (req, res) => {
  const { campaigns, preset } = req.body;
  try {
    const campData = campaigns.map(c => {
      const ins = c.insights?.data?.[0] || {};
      return `- ${c.name}: spend €${parseFloat(ins.spend||0).toFixed(2)}, impressies ${ins.impressions||0}, klikken ${ins.clicks||0}, CTR ${parseFloat(ins.ctr||0).toFixed(2)}%, CPC €${parseFloat(ins.cpc||0).toFixed(2)}, bereik ${ins.reach||0}`;
    }).join('\n');
    const result = await claudeFetch(`Analyseer deze Meta campagnes (periode: ${preset}):\n\n${campData}\n\nGeef:\n\n**🏆 Beste campagne:**\n[naam + waarom]\n\n**⚠️ Campagne die aandacht nodig heeft:**\n[naam + probleem]\n\n**📊 Belangrijkste inzichten:**\n[3-4 bullets]\n\n**💡 Aanbevelingen:**\n[3-4 concrete acties]\n\n**💰 Budget advies:**\n[waar meer/minder naartoe]`, 'Je bent een Meta advertentie-analist. Schrijf in het Nederlands.');
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-report', requireAuth, async (req, res) => {
  const { stats, campaigns, accountName, month } = req.body;
  try {
    const campSummary = campaigns.slice(0, 10).map(c => {
      const ins = c.insights?.data?.[0] || {};
      return `${c.name}: €${parseFloat(ins.spend||0).toFixed(2)} besteed, ${ins.impressions||0} impressies, ${ins.clicks||0} klikken, CTR ${parseFloat(ins.ctr||0).toFixed(2)}%`;
    }).join('\n');
    const result = await claudeFetch(`Schrijf een professioneel maandrapport voor: ${accountName}\nPeriode: ${month}\n\nTotalen: €${parseFloat(stats.spend||0).toFixed(2)} besteed, ${stats.impressions||0} impressies, ${stats.clicks||0} klikken, bereik ${stats.reach||0}, ${stats.activeCampaigns||0} actieve campagnes\n\nCampagnes:\n${campSummary}\n\nSchrijf rapport met: 1) Samenvatting 2) Hoogtepunten 3) Wat goed ging 4) Verbeterpunten 5) Aanbevelingen volgende maand\n\nProfessioneel, in het Nederlands.`, 'Je schrijft professionele marketingrapportages.', 2000);
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/audience-suggestions', requireAuth, async (req, res) => {
  const { product, currentPerformance } = req.body;
  try {
    const result = await claudeFetch(`Geef doelgroep suggesties voor Meta advertenties voor: ${product}\nHuidige performance: ${currentPerformance || 'geen data'}\n\n**🎯 Primaire doelgroep:**\n[leeftijd, interesses, gedrag]\n\n**🔄 Lookalike suggestie:**\n[op basis van wie]\n\n**📱 Platform advies:**\n[Facebook vs Instagram + waarom]\n\n**⏰ Beste tijden:**\n[dagen en tijden]\n\n**🚫 Uitsluitingen:**\n[wie uitsluiten]\n\n**Interesses om te targeten:**\n[5-8 specifieke interesses]`, 'Je bent een Meta targeting specialist. Schrijf in het Nederlands.');
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/budget-advice', requireAuth, async (req, res) => {
  const { campaigns, totalBudget } = req.body;
  try {
    const campData = campaigns.map(c => {
      const ins = c.insights?.data?.[0] || {};
      return `${c.name}: dagbudget €${c.daily_budget ? parseInt(c.daily_budget)/100 : 0}, CTR ${parseFloat(ins.ctr||0).toFixed(2)}%, CPC €${parseFloat(ins.cpc||0).toFixed(2)}, besteed €${parseFloat(ins.spend||0).toFixed(2)}`;
    }).join('\n');
    const result = await claudeFetch(`Budget optimalisatie advies. Totaal maandbudget: €${totalBudget || 'onbekend'}\n\nCampagnes:\n${campData}\n\n**📊 Budget verdeling advies:**\n[per campagne: verhogen/verlagen/stoppen + waarom]\n\n**🎯 Beste ROI campagne:**\n[welke]\n\n**⚡ Quick wins:**\n[2-3 dingen die je morgen kunt doen]\n\n**📈 Groeistrategie:**\n[hoe schaal je op]`, 'Je bent een Meta budget specialist. Schrijf in het Nederlands.');
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/improve-ad', requireAuth, async (req, res) => {
  const { adText, performance, goal } = req.body;
  try {
    const result = await claudeFetch(`Verbeter deze Meta advertentietekst:\n\nHUIDIGE TEKST:\n${adText}\n\nPERFORMANCE: ${performance || 'niet opgegeven'}\nDOEL: ${goal || 'hogere CTR'}\n\n**❌ Wat niet werkt:**\n[kritiek]\n\n**✅ Verbeterde versie:**\n[herschreven tekst]\n\n**🔑 Waarom beter:**\n[3 redenen]\n\n**🧪 Test ook:**\nVariant A: [andere invalshoek]\nVariant B: [andere invalshoek]`, 'Je bent een copywriter gespecialiseerd in performance marketing. Schrijf in het Nederlands.');
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => {
  try { const me = await metaFetch('/me?fields=name'); res.json({ ok: true, user: me.name }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Local development only — Vercel serves public/ via its own CDN
if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname, 'public')));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Meta Ads Dashboard running on http://localhost:${PORT}`));
}

module.exports = app;
