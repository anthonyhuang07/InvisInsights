// CREDIT TO CODEX & CHATGPT FOR WRITING 99% OF THIS FILE. ALL I DID IS LEAD DIRECTION AND PROMPT ENGINEERING.

// backend/server.js (ESM)
import express from 'express';
import fetch from 'node-fetch';
import pg from 'pg';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FRONTEND_DIR = // Default to 'frontend' folder next to server.js
  process.env.FRONTEND_DIR ||
  path.join(__dirname, '..', 'frontend');

const app = express();

app.use((req, res, next) => { // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Invis-Project-Key');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

/* -------------------- DB -------------------- */

/*
WHAT IS STORED IN THE DB?

- project_key: unique key for each project
- allowed_domains: array of domains allowed to use this project
- surveymonkey_access_token: token to access SurveyMonkey API
- survey_id: connected survey ID
- survey_config: JSON config mapping intents to survey questions
- setup_complete: boolean indicating if setup is complete
- created_at, updated_at: timestamps
*/

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL missing');
}

const pool = new Pool({ // Postgres connection
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDb() { // Create tables if not exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      project_key TEXT PRIMARY KEY,
      allowed_domains TEXT[],
      surveymonkey_access_token TEXT,
      survey_id TEXT,
      survey_config JSONB,
      setup_complete BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

/* -------------------- HELPERS -------------------- */

// Intents are a pre-defined set of UX metrics that can be used to normalize
// survey questions into a common format for AI analysis.
// Ex. How easy was it to find what you needed? (maps to EASE_OF_USE intent)

const INTENTS = new Set([ // supported intents for AI analysis
  'OVERALL_SATISFACTION',
  'EASE_OF_USE',
  'CONFUSION_LEVEL',
  'FRUSTRATION_LEVEL',
  'TRUST_CONFIDENCE',
  'LIKELIHOOD_TO_CONTINUE',
  'OPEN_FEEDBACK'
]);

function generateProjectKey() { // generate a unique project key
  return crypto.randomUUID();
}

async function getProject(projectKey) { // fetch project by key
  const { rows } = await pool.query('SELECT * FROM projects WHERE project_key = $1', [projectKey]);
  return rows[0] || null;
}

async function upsertProject(data) { // insert or update project
  await pool.query(
    `
    INSERT INTO projects (
      project_key, allowed_domain, surveymonkey_access_token, survey_id, survey_config, setup_complete
    ) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (project_key) DO UPDATE SET
      allowed_domain = EXCLUDED.allowed_domain,
      surveymonkey_access_token = EXCLUDED.surveymonkey_access_token,
      survey_id = EXCLUDED.survey_id,
      survey_config = EXCLUDED.survey_config,
      setup_complete = EXCLUDED.setup_complete,
      updated_at = now()
  `,
    [
      data.project_key,
      data.allowed_domain ?? null,
      data.surveymonkey_access_token ?? null,
      data.survey_id ?? null,
      data.survey_config ?? null,
      !!data.setup_complete
    ]
  );
}

function extractIntents(config) { // extract unique intents from survey config
  if (!config || !Array.isArray(config.questions)) return [];
  const intents = new Set();
  for (const q of config.questions) {
    if (q?.inferred_intent && INTENTS.has(q.inferred_intent)) intents.add(q.inferred_intent);
  }
  return [...intents];
}

function safeJsonParse(text) { // robust JSON parse with fallback
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/* -------------------- AUTH MIDDLEWARE -------------------- */

async function requireProject(req, res, next) { // middleware to validate project key
  try {
    const key = req.header('X-Invis-Project-Key');
    if (!key) return res.status(401).json({ error: 'missing_project_key' });

    const project = await getProject(key);
    if (!project) return res.status(401).json({ error: 'invalid_project_key' });

    const origin = req.headers.origin || req.headers.referer;
    if (project.allowed_domains?.length && origin) {
      const host = new URL(origin).hostname;
      if (!project.allowed_domains.includes(host)) {
        return res.status(403).json({ error: 'domain_not_allowed' });
      }
    }

    req.project = project;
    return next();
  } catch (e) {
    return res.status(500).json({ error: 'project_lookup_failed' });
  }
}

/* -------------------- CONNECT SURVEYMONKEY ENDPOINT -------------------- */

app.get('/connect', (req, res) => { // connect endpoint: UI for connecting SurveyMonkey
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect SurveyMonkey</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f4efe7;
      --ink: #1c1c1c;
      --muted: #4b4b4b;
      --accent: #0f7c76;
      --card: #ffffff;
      --stroke: rgba(0, 0, 0, 0.08);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background: radial-gradient(900px 500px at 15% -10%, #ffe7c2 0%, transparent 60%),
        radial-gradient(800px 600px at 90% 0%, #d9f1ee 0%, transparent 55%),
        var(--bg);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 40px 20px;
    }

    .card {
      width: min(720px, 100%);
      background: var(--card);
      border: 1px solid var(--stroke);
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 18px 34px rgba(0, 0, 0, 0.08);
    }

    h1 {
      margin: 0 0 6px;
      font-size: 28px;
    }

    p {
      margin: 0 0 18px;
      color: var(--muted);
      line-height: 1.6;
    }

    label {
      display: block;
      font-weight: 600;
      margin: 14px 0 6px;
    }

    input,
    select {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--stroke);
      font-size: 14px;
      font-family: inherit;
    }

    .row {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      margin-top: 14px;
    }

    button {
      border: 0;
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      padding: 12px 16px;
      border-radius: 12px;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      box-shadow: 0 10px 22px rgba(15, 124, 118, 0.2);
    }

    button:hover { transform: translateY(-1px); }

    #out {
      margin-top: 18px;
      background: #f6f6f6;
      border-radius: 12px;
      padding: 12px;
      min-height: 44px;
      white-space: pre-wrap;
    }

    .hint {
      font-size: 12px;
      color: var(--muted);
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect SurveyMonkey</h1>
    <p>Paste a SurveyMonkey access token, select a survey, and lock it to your domains.</p>

    <label for="token">Access token</label>
    <input id="token" autocomplete="off">

    <div class="row">
      <button id="load">Load surveys</button>
    </div>

    <label for="survey">Survey</label>
    <select id="survey"></select>

    <label for="domains">Allowed domains</label>
    <input id="domains" placeholder="example.com, app.example.com">
    <div class="hint">Comma-separated. Leave empty to allow any domain.</div>

    <div class="row">
      <button id="connect">Connect</button>
    </div>

    <pre id="out"></pre>
  </div>

<script>
const pk = new URLSearchParams(window.location.search).get('project_key') || '';
const out = document.getElementById('out');
const token = document.getElementById('token');
const survey = document.getElementById('survey');

document.getElementById('load').onclick = async function () {
  out.textContent = 'Loading...';

  const r = await fetch('/surveymonkey/surveys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: token.value })
  });

  const d = await r.json();
  if (!r.ok) {
    out.textContent = JSON.stringify(d, null, 2);
    return;
  }

  survey.innerHTML = '';
  (d.surveys || []).forEach(function (s) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title || s.id;
    survey.appendChild(opt);
  });

  out.textContent = 'Loaded ' + (d.surveys || []).length + ' surveys.';
};

document.getElementById('connect').onclick = async function () {
  out.textContent = 'Connecting...';

  const r = await fetch('/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_key: pk,
      access_token: token.value,
      survey_id: survey.value,
      allowed_domains: document
        .getElementById('domains')
        .value
        .split(',')
        .map(d => d.trim())
        .filter(Boolean)
    })
  });

  const d = await r.json();
  if (!r.ok) {
    out.textContent = JSON.stringify(d, null, 2);
    return;
  }

  out.innerHTML = '';

  const msg = document.createElement('div');
  msg.textContent = '✅ Setup complete. Paste this into your site:';
  msg.style.marginBottom = '8px';

  const pre = document.createElement('pre');
  pre.textContent = d.embed_code;
  pre.style.background = '#111';
  pre.style.color = '#0f0';
  pre.style.padding = '12px';
  pre.style.borderRadius = '6px';
  pre.style.overflow = 'auto';

  out.appendChild(msg);
  out.appendChild(pre);
};
</script>
</body>
</html>`);
});

/* -------------------- CONNECT SURVEYMONKEY PT2 -------------------- */

app.post('/surveymonkey/surveys', async (req, res) => { // list surveys for given access token
  const token = req.body?.access_token;
  if (!token) return res.status(400).json({ error: 'missing_access_token' });
  try {
    const surveys = await fetchSurveyList(token);
    return res.json({ surveys });
  } catch (e) {
    return res.status(500).json({ error: 'survey_list_failed', detail: e.message });
  }
});

app.post('/connect', async (req, res) => { // connect endpoint: create or update project with SurveyMonkey config
  const { project_key, access_token, survey_id, allowed_domains } = req.body || {};

  if (!access_token || !survey_id || !Array.isArray(allowed_domains)) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  try {
    const surveys = await fetchSurveyList(access_token);
    if (!surveys.find((s) => String(s.id) === String(survey_id))) {
      return res.status(400).json({ error: 'survey_not_found' });
    }

    const details = await fetchSurveyDetails(survey_id, access_token);
    const collectors = await fetchSurveyCollectors(survey_id, access_token);
    if (!collectors.length) {
      return res.status(400).json({ error: 'no_collectors' });
    }

    const config = autoMapSurveyToConfig(survey_id, collectors[0].id, details);
    const finalKey = project_key || generateProjectKey();

    // DELETE any existing project using this survey_id
    await pool.query(
      `DELETE FROM projects WHERE survey_id = $1`,
      [survey_id]
    );

    // Insert fresh project
    await upsertProject({
      project_key: finalKey,
      allowed_domains,
      surveymonkey_access_token: access_token,
      survey_id,
      survey_config: config,
      setup_complete: true
    });

    const embedCode =
      `<script src="https://invisinsights.tech/app.js" data-project-key="${finalKey}"></script>`;

    return res.json({
      ok: true,
      project_key: finalKey,
      survey_id,
      embed_code: embedCode
    });

  } catch (e) {
    return res.status(500).json({ error: 'connect_failed', detail: e.message });
  }
});

/* -------------------- COLLECT -------------------- */

app.post('/collect', requireProject, async (req, res) => { // data collection endpoint - hit every session end (tab close, reload)
  try {
    if (!req.project.setup_complete || !req.project.survey_config) {
      return res.json({ ok: true, survey_status: { needs_setup: true } });
    }

    const config = req.project.survey_config;
    const intents = extractIntents(config);
    if (!intents.length) return res.json({ ok: true, error: 'no_intents_mapped' });

    const analysis = await runAI(req.body, intents);

    await submitSurveyMonkey({
      analysis,
      config,
      token: req.project.surveymonkey_access_token
    });

    return res.json({ ok: true, survey_status: { needs_setup: false } });
  } catch (e) {
    return res.status(500).json({ error: 'collect_failed', detail: e.message });
  }
});

/* -------------------- AI (Gemini API) -------------------- */

function buildPrompt(session, intents) {
  const hasOpenFeedback = intents.includes('OPEN_FEEDBACK');

  return (
    `You are a UX analytics assistant.\n` +
    `Your task is to infer survey-style responses from behavioral session data.\n` +
    `Return ONLY valid JSON. No explanations, no markdown, no prose.\n\n` +

    `Core rules:\n` +
    `- All intent scores must be normalized between 0.0 and 1.0.\n` +
    `- If evidence is weak, ambiguous, or mixed, default near neutral (~0.5).\n` +
    `- Do NOT assume negative intent without strong supporting signals.\n` +
    `- Base conclusions strictly on the provided session data.\n` +
    (hasOpenFeedback
      ? `- OPEN_FEEDBACK is REQUIRED and must contain at least one realistic comment.\n`
      : ``) +
    `\n` +

    `Important interpretation rules:\n` +
    `- Long time on page, steady scrolling, and rereading WITHOUT rage clicks,\n` +
    `  navigation loops, or disabled clicks should be treated as ENGAGEMENT,\n` +
    `  not confusion.\n` +
    `- Rereading behavior can indicate interest or careful reading.\n` +
    `- Idle time can indicate thinking or reading, not hesitation, unless paired\n` +
    `  with repeated failed interactions or abandonment.\n` +
    `- Only infer CONFUSION or FRUSTRATION when multiple negative signals align\n` +
    `  (e.g., rage clicks, disabled clicks, navigation loops, CTA hesitation).\n\n` +

    `INTENTS:\n` +
    intents.map((i) => `- ${i}`).join('\n') +
    `\n\n` +

    `Intent-specific guidance:\n` +
    `- OVERALL_SATISFACTION:\n` +
    `  Reflect the overall experience quality. Do NOT assume dissatisfaction\n` +
    `  from long reading sessions alone.\n` +
    `- EASE_OF_USE:\n` +
    `  Lower only if the user shows repeated failed interactions or confusion signals.\n` +
    `- CONFUSION_LEVEL:\n` +
    `  Score low ONLY if the session shows clear disorientation or repeated correction.\n` +
    `- TRUST_CONFIDENCE:\n` +
    `  Lower primarily due to disabled clicks, broken interactions, or hesitation near CTAs.\n` +
    `- LIKELIHOOD_TO_CONTINUE / RECOMMEND:\n` +
    `  • Do NOT score low unless strong negative evidence exists.\n` +
    `  • If engagement is present and abandonment is unclear, default to neutral-positive (~0.6).\n` +
    `  • Only score very low when frustration and abandonment signals are strong.\n\n` +

    `OPEN_FEEDBACK guidance:\n` +
    `- Write from the perspective of a normal user.\n` +
    `- Be concise, neutral, and realistic.\n` +
    `- Do NOT speculate about confusion unless evidence is strong.\n` +
    `- If behavior appears engaged but imperfect, suggest minor or optional improvements.\n\n` +

    `Session data:\n` +
    `${JSON.stringify(session, null, 2)}\n\n` +

    `Output JSON schema (follow exactly):\n` +
    `{\n` +
    `  "intent_scores": {\n` +
    intents.map((i) => `    "${i}": 0.0`).join(',\n') +
    `\n  },\n` +
    `  "confidence": {\n` +
    intents.map((i) => `    "${i}": 0.0`).join(',\n') +
    `\n  },\n` +
    (hasOpenFeedback
      ? `  "open_feedback": [\n` +
        `    "Short, realistic user-style feedback based on observed behavior."\n` +
        `  ]\n`
      : `  "open_feedback": []\n`) +
    `}\n`
  );
}

async function runAI(session, intents) { // call Gemini API to analyze session
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(session, intents) }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`gemini_error: ${t}`);
  }

  const j = await r.json();
  const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const parsed = safeJsonParse(raw);
  if (!parsed) throw new Error('ai_returned_non_json');
  return parsed;
}

/* -------------------- SURVEYMONKEY API -------------------- */

async function fetchSurveyList(token) { // fetch list of surveys for given access token
  const r = await fetch('https://api.surveymonkey.com/v3/surveys', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j?.data || [];
}

async function fetchSurveyDetails(id, token) { // fetch survey details by ID
  const r = await fetch(`https://api.surveymonkey.com/v3/surveys/${id}/details`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function fetchSurveyCollectors(id, token) { // fetch survey collectors by survey ID
  const r = await fetch(`https://api.surveymonkey.com/v3/surveys/${id}/collectors`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j?.data || [];
}

/* ---- CREATE CONFIG FROM SURVEY DETAILS ---- */

function extractQuestionText(question) {  // extract question text from survey question object
  if (question?.headings?.[0]?.heading) return String(question.headings[0].heading);
  if (question?.heading) return String(question.heading);
  return '';
}

function inferIntentFromText(text, type) { // infer intent from question text
  const v = String(text || '').toLowerCase();
  if (type === 'text') return 'OPEN_FEEDBACK';
  if (v.includes('confus') || v.includes('unclear')) return 'CONFUSION_LEVEL';
  if (v.includes('frustrat') || v.includes('annoy') || v.includes('angry')) return 'FRUSTRATION_LEVEL';
  if (v.includes('trust') || v.includes('secure') || v.includes('safe')) return 'TRUST_CONFIDENCE';
  if (v.includes('easy') || v.includes('ease') || v.includes('simple') || v.includes('usable')) return 'EASE_OF_USE';
  if (v.includes('recommend') || v.includes('likely') || v.includes('continue') || v.includes('return')) return 'LIKELIHOOD_TO_CONTINUE';
  if (v.includes('satisf') || v.includes('overall') || v.includes('experience')) return 'OVERALL_SATISFACTION';
  return 'OVERALL_SATISFACTION';
}

function buildChoiceMap(choices) { // build mapping of choice values to IDs for scale questions
  const map = {};
  // try parse numeric labels
  const nums = choices
    .map((c) => {
      const m = String(c?.text || '').match(/-?\d+/);
      return m ? Number(m[0]) : null;
    })
    .filter((n) => Number.isFinite(n));

  if (nums.length === choices.length && choices.length > 0) {
    for (const c of choices) {
      const m = String(c?.text || '').match(/-?\d+/);
      const val = m ? String(Number(m[0])) : null;
      if (val != null) map[val] = c.id;
    }
    return { map, min: Math.min(...nums), max: Math.max(...nums) };
  }

  // fallback 1..N
  choices.forEach((c, i) => (map[String(i + 1)] = c.id));
  return { map, min: 1, max: choices.length };
}

function resolveBooleanChoices(choices) { // resolve true/false choice IDs for boolean questions
  if (!choices || choices.length !== 2) return null;
  const a = String(choices[0]?.text || '').toLowerCase();
  const b = String(choices[1]?.text || '').toLowerCase();
  const aFalse = a.includes('no') || a.includes('false');
  const bFalse = b.includes('no') || b.includes('false');
  if (aFalse && !bFalse) return { true_choice_id: choices[1].id, false_choice_id: choices[0].id };
  if (bFalse && !aFalse) return { true_choice_id: choices[0].id, false_choice_id: choices[1].id };
  // default: first=true second=false
  return { true_choice_id: choices[0].id, false_choice_id: choices[1].id };
}

function autoMapSurveyToConfig(surveyId, collectorId, details) { // auto-map survey questions to config
  const pages = details?.pages || [];
  if (!pages.length) throw new Error('survey_details_missing_pages');

  const questions = [];

  for (const page of pages) {
    for (const q of page?.questions || []) {
      const family = String(q?.family || '').toLowerCase();
      const text = extractQuestionText(q);

      if (family === 'open_ended') {
        questions.push({
          page_id: page.id,
          question_id: q.id,
          type: 'text',
          inferred_intent: 'OPEN_FEEDBACK',
          question_text: text
        });
        continue;
      }

      if (family === 'single_choice') {
        const choices = q?.answers?.choices || [];
        if (choices.length === 2) {
          const bc = resolveBooleanChoices(choices);
          questions.push({
            page_id: page.id,
            question_id: q.id,
            type: 'boolean',
            inferred_intent: inferIntentFromText(text, 'boolean'),
            true_choice_id: bc.true_choice_id,
            false_choice_id: bc.false_choice_id,
            question_text: text
          });
        } else if (choices.length > 2) {
          const cm = buildChoiceMap(choices);
          questions.push({
            page_id: page.id,
            question_id: q.id,
            type: 'scale',
            inferred_intent: inferIntentFromText(text, 'scale'),
            scale_min: cm.min,
            scale_max: cm.max,
            choice_ids: cm.map,
            question_text: text
          });
        }
        continue;
      }

      if (family === 'matrix') {
        const choices = q?.answers?.choices || [];
        const rows = q?.answers?.rows || [];
        if (choices.length && rows.length) {
          const cm = buildChoiceMap(choices);
          questions.push({
            page_id: page.id,
            question_id: q.id,
            type: 'scale',
            inferred_intent: inferIntentFromText(text, 'scale'),
            scale_min: cm.min,
            scale_max: cm.max,
            choice_ids: cm.map,
            row_id: rows[0].id,
            question_text: text
          });
        }
      }
    }
  }

  return {
    survey_id: surveyId,
    collector_id: collectorId,
    // default page fallback if needed
    page_id: pages[0].id,
    questions
  };
}
/* ---- map analysis -> survey answers + submit ---- */

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function scoreToScale(score01, min, max) {
  const raw = min + (max - min) * score01;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function openFeedbackText(analysis) {
  const arr = Array.isArray(analysis?.open_feedback) ? analysis.open_feedback : [];
  return arr.map((s) => String(s || '').trim()).filter(Boolean).join('\n');
}

function buildSurveyPagesPayload(analysis, config) {
  const pageMap = new Map();

  for (const q of config.questions || []) {
    const type = q.type;
    const intent = q.inferred_intent;
    const score = clamp01(analysis?.intent_scores?.[intent]);
    let questionPayload = null;

    if (type === 'text') {
      let text = openFeedbackText(analysis);

      if (!text) {
        text = 'No major issues encountered, but minor UX improvements could help.';
      }

      questionPayload = {
        id: q.question_id,
        answers: [{ text }]
      };
    } else if (type === 'boolean') {
      if (score != null) {
        const choiceId = score >= 0.5 ? q.true_choice_id : q.false_choice_id;
        if (choiceId) questionPayload = { id: q.question_id, answers: [{ choice_id: choiceId }] };
      }
    } else if (type === 'scale') {
      if (score != null) {
        const min = Number(q.scale_min);
        const max = Number(q.scale_max);
        const value = scoreToScale(score, min, max);
        const choiceId = q.choice_ids?.[String(value)];
        if (choiceId) {
          const ans = { choice_id: choiceId };
          if (q.row_id) ans.row_id = q.row_id;
          questionPayload = { id: q.question_id, answers: [ans] };
        }
      }
    }

    // optional: skip low confidence answers (except scale/boolean; keep it simple)
    if (!questionPayload) continue;

    const pid = q.page_id || config.page_id;
    if (!pageMap.has(pid)) pageMap.set(pid, []);
    pageMap.get(pid).push(questionPayload);
  }

  return [...pageMap.entries()].map(([id, questions]) => ({ id, questions }));
}

async function submitSurveyMonkey({ analysis, config, token }) {
  const pages = buildSurveyPagesPayload(analysis, config);
  if (!pages.length) return;

  const body = { response_status: 'completed', pages };

  const r = await fetch(`https://api.surveymonkey.com/v3/collectors/${config.collector_id}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`surveymonkey_submit_failed: ${t}`);
  }
}

/* -------------------- START -------------------- */

const port = process.env.PORT || 3000;

(async () => {
  try {
    await initDb();
    console.log('DB ready');
    app.listen(port, () => console.log('InvisInsights running on', port));
  } catch (e) {
    console.error('FATAL boot error:', e);
    process.exit(1);
  }
})();
