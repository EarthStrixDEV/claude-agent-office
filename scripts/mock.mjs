#!/usr/bin/env node
// Simulates several Claude Code sessions by POSTing realistic hook events to the bridge.
// Useful for designing the office without running real sessions.
//
//   node scripts/mock.mjs            # 5 agents, normal speed
//   node scripts/mock.mjs --fast     # 3x faster
//
// Permission requests really wait for your Allow / Deny on the dashboard, and a
// task sent from Minju's desk is picked up when the simulated turn ends.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.AGENT_OFFICE_PORT || 7777);
const URL = `http://127.0.0.1:${PORT}/hook`;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.AGENT_OFFICE_DIR || path.join(os.homedir(), '.agent-office');
let TOKEN = '';
try { TOKEN = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim(); } catch {}
const SPEED = process.argv.includes('--fast') ? 3 : 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => a + Math.random() * (b - a);

async function post(ev) {
  try {
    const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (e) {
    console.error(`bridge unreachable (${e.cause?.code || e.message}); is \`npm start\` running?`);
    await sleep(3000);
    return {};
  }
}

const TOOLS = [
  ['Read', () => ({ file_path: pick(['src/App.tsx', 'src/lib/api.ts', 'package.json', 'README.md', 'src/scene/Desk.ts']) })],
  ['Grep', () => ({ pattern: pick(['useEffect', 'TODO', 'fetchSessions', 'export default']) })],
  ['Edit', () => ({ file_path: pick(['src/App.tsx', 'src/hud/Panel.tsx', 'server/index.ts', 'src/styles.css']) })],
  ['Bash', () => ({ command: pick(['npm test', 'npx tsc --noEmit', 'git status', 'npm run lint']), description: pick(['Run tests', 'Type-check', 'Check git status', 'Lint']) })],
  ['Glob', () => ({ pattern: pick(['src/**/*.tsx', '**/*.test.ts']) })],
  ['WebFetch', () => ({ url: pick(['https://threejs.org/docs/', 'https://code.claude.com/docs/en/hooks']) })],
];

const AGENTS = [
  {
    cwd: '/Users/earth/projects/earth-portfolio', model: 'claude-opus-5-5', effort: 'high', mode: 'default',
    prompts: ['Add a dark-mode toggle to the portfolio', 'Fix the hero animation jank on Safari'],
    tasks: ['Audit current theme tokens', 'Add theme toggle component', 'Wire toggle to localStorage', 'Update screenshots'],
    perm: { tool_name: 'Bash', tool_input: { command: 'npm install @fontsource/inter', description: 'Install font package' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }], behavior: 'allow', destination: 'localSettings' }] },
    bg: 'npm run dev', sub: 'Explore',
  },
  {
    cwd: '/Users/earth/projects/minju-memory-api', model: 'claude-sonnet-5-5', effort: 'medium', mode: 'acceptEdits',
    prompts: ['Add pagination to /memories', 'Write tests for the search endpoint'],
    tasks: ['Design cursor pagination', 'Implement in repository layer', 'Add tests', 'Update API docs', 'Run full test suite'],
    perm: { tool_name: 'Bash', tool_input: { command: 'git push -u origin feat/pagination', description: 'Push branch' }, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
    sub: 'code-reviewer',
  },
  {
    cwd: '/Users/earth/work/gps-report-bot', model: 'claude-sonnet-5-5', effort: 'low', mode: 'default',
    prompts: ['Summarise this week\'s GPS tickets into a report'],
    tasks: ['Collect tickets', 'Group by customer', 'Draft report'],
    compact: true,
  },
  {
    cwd: '/Users/earth/music/playlist-gen', model: 'claude-haiku-5-5', effort: 'low', mode: 'auto',
    prompts: ['Generate a city-pop playlist JSON from my likes'],
    tasks: ['Load liked tracks', 'Cluster by mood', 'Export playlist.json'],
    endAfter: 2,
  },
  {
    cwd: '/Users/earth/finance/liberator-suite', model: 'claude-opus-5-5', effort: 'xhigh', mode: 'plan',
    prompts: ['Plan the monthly budget import feature'],
    tasks: ['Read existing importers', 'Draft plan'],
    bg: 'python watch_statements.py', sub: 'Plan',
  },
];

async function runAgent(def, delay) {
  await sleep(delay);
  const sid = crypto.randomUUID();
  const base = { session_id: sid, cwd: def.cwd, permission_mode: def.mode, transcript_path: `/Users/earth/.claude/projects/x/${sid}.jsonl` };
  const effort = { level: def.effort };
  const send = (name, extra = {}) => post({ ...base, hook_event_name: name, ...(name.includes('Tool') ? { effort } : {}), ...extra });
  const display = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' }[def.model] || def.model;
  let ctx = 4 + Math.random() * 10, cost = 0;
  const statusline = async () => {
    ctx = Math.min(96, ctx + Math.random() * 3); cost += Math.random() * 0.08;
    LIMITS.five += Math.random() * 0.6; LIMITS.week += Math.random() * 0.08;
    await fetch(`${BASE}/statusline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      session_id: sid, cwd: def.cwd, model: { id: def.model, display_name: display }, effort,
      context_window: { used_percentage: ctx }, cost: { total_cost_usd: cost },
      rate_limits: { five_hour: { used_percentage: Math.min(100, LIMITS.five), resets_at: LIMITS.fiveReset }, seven_day: { used_percentage: Math.min(100, LIMITS.week), resets_at: LIMITS.weekReset } },
    }) }).catch(() => {});
  };
  const slTimer = setInterval(statusline, 4000 / SPEED);
  const bgTasks = [];

  const tool = async (agentId) => {
    const [name, mk] = pick(TOOLS);
    const id = 'toolu_' + crypto.randomBytes(6).toString('hex');
    const extra = { tool_name: name, tool_input: mk(), tool_use_id: id, ...(agentId ? { agent_id: agentId } : {}) };
    await send('PreToolUse', extra);
    await sleep(rand(700, 2200));
    if (Math.random() < 0.06) await send('PostToolUseFailure', { ...extra, error: 'Command exited with code 1' });
    else await send('PostToolUse', extra);
  };

  const work = async (round, tasks, prompt) => {
    await send('UserPromptSubmit', { prompt });
    await sleep(rand(800, 1600));
    const ids = tasks.map((subject, i) => ({ id: `task-${round}-${i}`, subject }));
    for (const t of ids) { await send('TaskCreated', { task_id: t.id, task_subject: t.subject }); await sleep(250); }

    for (const [i, t] of ids.entries()) {
      for (let k = 0, n = Math.ceil(rand(2, 5)); k < n; k++) await tool();

      if (i === 0 && def.bg && round === 0) {
        const id = 'toolu_' + crypto.randomBytes(6).toString('hex');
        await send('PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: def.bg, description: `Start ${def.bg}`, run_in_background: true } });
        await send('PostToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: def.bg } });
        bgTasks.push({ id: 'bg-' + id.slice(-6), type: 'shell', status: 'running', description: def.bg, command: def.bg });
      }
      if (i === 1 && def.sub) {
        const agentId = 'agent-' + crypto.randomBytes(4).toString('hex');
        await send('PreToolUse', { tool_name: 'Agent', tool_input: { description: `${def.sub}: investigate`, subagent_type: def.sub } });
        await send('SubagentStart', { agent_id: agentId, agent_type: def.sub });
        for (let k = 0; k < 4; k++) await tool(agentId);
        await send('SubagentStop', { agent_id: agentId, agent_type: def.sub, stop_hook_active: false, last_assistant_message: 'Found 3 relevant files and summarised them.' });
      }
      if (i === 2 && def.perm && Math.random() < 0.8) {
        console.log(`[${def.cwd.split('/').pop()}] asking permission: ${def.perm.tool_input.command}`);
        const r = await send('PermissionRequest', def.perm);
        const b = r?.hookSpecificOutput?.decision?.behavior;
        console.log(`[${def.cwd.split('/').pop()}] → ${b || 'terminal prompt (no decision)'}`);
        if (b === 'allow') { await send('PreToolUse', { ...def.perm, tool_use_id: 'toolu_p' }); await sleep(1500); await send('PostToolUse', { ...def.perm, tool_use_id: 'toolu_p' }); }
      }
      if (i === 1 && def.compact && round === 0) {
        await send('PreCompact', { trigger: 'auto' }); await sleep(3000); await send('PostCompact', { trigger: 'auto' });
      }
      await send('TaskCompleted', { task_id: t.id, task_subject: t.subject });
      await sleep(rand(400, 900));
    }
  };

  await send('SessionStart', { source: 'startup', model: def.model });
  let pending = null;
  for (let round = 0; ; round++) {
    if (pending) await work(round, ['Understand the request', 'Make the change', 'Verify'], pending);
    else await work(round, def.tasks, pick(def.prompts));

    const r = await send('Stop', { stop_hook_active: !!pending, last_assistant_message: pending ? `Done: ${pending.slice(0, 60)}` : 'All tasks finished. Summary posted.', background_tasks: bgTasks, session_crons: [] });
    const ctx = r?.hookSpecificOutput?.additionalContext;
    pending = ctx ? ctx.split('\n').filter(Boolean).pop() : null;
    if (pending) { console.log(`[${def.cwd.split('/').pop()}] picked up task: ${pending}`); continue; }

    if (def.endAfter && round + 1 >= def.endAfter) { clearInterval(slTimer); await send('SessionEnd', { reason: 'prompt_input_exit' }); return; }
    await send('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    await sleep(rand(8000, 16000));
  }
}

const nowS = () => Math.floor(Date.now() / 1000);
const LIMITS = { five: 31, week: 46, fiveReset: nowS() + 2.4 * 3600, weekReset: nowS() + 3.2 * 86400 };

// Simulated Grok Bots, reported the way an external reporter would (POST with the dashboard token).
const GROK = [
  { id: 'sales', name: 'Sales Outbound', color: '#FF8FB8', shape: 'circle', jobs: ['Drafting 36 outreach emails', 'Signing in to Salesforce', 'Queueing follow-ups'] },
  { id: 'research', name: 'Research', color: '#7CC4F5', shape: 'diamond', jobs: ['Reading 12 product pages', 'Summarising competitor pricing', 'Building a comparison table'] },
  { id: 'finance', name: 'Bookkeeper', color: '#FFD86B', shape: 'square', jobs: ['Matching receipts', 'Waiting for card verification'] },
  { id: 'social', name: 'Social', color: '#B9A8F0', shape: 'star', jobs: ['Scheduling 5 posts', 'Replying to mentions'] },
];
async function grokLoop() {
  if (!TOKEN) return;
  let tick = 0;
  for (;;) {
    tick++;
    const bots = GROK.map((b, i) => {
      const phase = (tick + i * 3) % 12;
      const status = b.id === 'finance' && phase > 8 ? 'waiting' : phase < 7 ? 'working' : phase < 10 ? 'idle' : 'done';
      return { id: b.id, name: b.name, color: b.color, shape: b.shape, status, activity: status === 'waiting' ? 'Needs you: verify the card in Take control' : b.jobs[phase % b.jobs.length], progress: { done: Math.min(phase, 6), total: 6 } };
    });
    await fetch(`${BASE}/api/external/grok`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': TOKEN }, body: JSON.stringify({ name: 'Grok Bot', bots }) }).catch(() => {});
    await sleep(3000);
  }
}
grokLoop();

console.log(`Mock office: ${AGENTS.length} agents → ${URL}${SPEED > 1 ? ' (fast)' : ''}. Ctrl+C to stop.`);
AGENTS.forEach((a, i) => runAgent(a, i * 1500));
