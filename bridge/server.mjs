#!/usr/bin/env node
// Agent Office Bridge
// Receives Claude Code HTTP hook events, keeps a live picture of every session,
// and streams it to the 3D dashboard over Server-Sent Events.
// Zero runtime dependencies: Node built-ins only (three.js is served as a static file).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as WS from './workspace.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = path.join(ROOT, 'web');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');

const PORT = Number(process.env.AGENT_OFFICE_PORT || 7777);
const HOST = '127.0.0.1';
const DATA_DIR = process.env.AGENT_OFFICE_DIR || path.join(os.homedir(), '.agent-office');
// How long a permission request waits for the dashboard before falling back to the terminal prompt.
const APPROVAL_HOLD_MS = Number(process.env.AGENT_OFFICE_APPROVAL_SECONDS || 120) * 1000;
// How long a session on "standby" keeps its Stop hook open waiting for a task (hook timeout is 600s).
const STANDBY_HOLD_MS = Number(process.env.AGENT_OFFICE_STANDBY_SECONDS || 540) * 1000;
const ENDED_TTL_MS = 24 * 60 * 60 * 1000;
const TRAIL_MAX = 200;
const FEED_MAX = 300;

// ---------------------------------------------------------------- token ----
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const TOKEN_FILE = path.join(DATA_DIR, 'token');
let TOKEN;
try {
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  TOKEN = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, TOKEN + '\n', { mode: 0o600 });
}
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// ---------------------------------------------------------------- state ----
/** @type {Map<string, any>} */
const sessions = new Map();
const feed = [];
/** @type {Map<string, any>} approval id -> { ..., res, timer } */
const approvals = new Map();
/** @type {Map<string, any>} session id -> { res, timer } */
const standbyWaiters = new Map();
/** @type {Set<http.ServerResponse>} */
const clients = new Set();
let dirty = false;

const now = () => Date.now();

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const s of saved.sessions || []) {
      if (s.endedAt && now() - s.endedAt > ENDED_TTL_MS) continue;
      // Bridge was down: we no longer know what these sessions are doing.
      if (s.status !== 'ended') s.status = 'stale';
      s.standby = false;
      s.skillsUsed ??= {};
      s.touched ??= [];
      s.mcpUsed ??= {};
      sessions.set(s.id, s);
    }
    feed.push(...(saved.feed || []).slice(-FEED_MAX));
    if (saved.limits) limits = saved.limits;
  } catch { /* first run */ }
}

function saveState() {
  if (!dirty) return;
  dirty = false;
  const data = { sessions: [...sessions.values()], feed: feed.slice(-FEED_MAX), limits };
  fs.writeFile(STATE_FILE, JSON.stringify(data), { mode: 0o600 }, () => {});
}
setInterval(saveState, 5000).unref();

// ------------------------------------------------------------ redaction ----
const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g,
  /((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)(\S+)/gi,
  /(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/g,
];
function redact(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, a, b) => (b !== undefined ? a + '••••' : '••••'));
  }
  return out;
}
const clip = (t, n = 140) => {
  const s = redact(t).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Only a short, redacted summary of tool input ever leaves this function.
function summarizeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash': return clip(input.description || input.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return base(input.file_path || input.notebook_path);
    case 'Grep': return clip(`/${input.pattern ?? ''}/`, 60);
    case 'Glob': return clip(input.pattern, 60);
    case 'WebFetch': try { return new URL(input.url).host; } catch { return ''; }
    case 'WebSearch': return clip(input.query, 80);
    case 'Agent': case 'Task': return clip(input.description || input.subagent_type, 80);
    case 'TodoWrite': return `${(input.todos || []).length} todos`;
    case 'Skill': return clip(`${input.skill || input.command || input.name || ''}${input.args ? ` ${input.args}` : ''}`, 80);
    case 'TaskCreate': return clip(input.subject || input.title, 80);
    default:
      if (name?.startsWith('mcp__')) return name.split('__').slice(1).join(' › ');
      return '';
  }
}

// ------------------------------------------------------------- sessions ----
function getSession(ev) {
  const id = ev.session_id || 'unknown';
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      cwd: ev.cwd || '',
      project: ev.cwd ? path.basename(ev.cwd) : id.slice(0, 8),
      model: null,
      effort: null,
      permissionMode: ev.permission_mode || null,
      context: null,      // context window used %, from the statusline
      cost: null,         // session cost in USD, from the statusline
      skill: null,        // { name, at, active, by } — the skill in use this turn
      skillsUsed: {},     // name -> count
      touched: [],        // [{ p, op, at }] files the agent read or changed (newest last)
      mcpUsed: {},        // MCP server / connector -> tool calls this session
      status: 'idle',
      activity: '',
      startedAt: now(),
      lastAt: now(),
      endedAt: null,
      tasks: {},          // TaskCreated / TaskCompleted
      todos: null,        // TodoWrite fallback
      subagents: {},
      background: {},
      trail: [],
      queue: [],
      standby: false,
      lastMessage: '',
      toolCount: 0,
      errorCount: 0,
    };
    sessions.set(id, s);
    addTrail(s, 'session', `Session joined · ${s.cwd || 'unknown dir'}`);
  }
  s.lastAt = now();
  const effort = ev.effort?.level;
  if (effort && effort !== s.effort) {
    if (s.effort) addTrail(s, 'env', `Effort → ${effort}`);
    s.effort = effort;
  }
  if (ev.permission_mode && ev.permission_mode !== s.permissionMode) {
    if (s.permissionMode) addTrail(s, 'mode', `Permission mode → ${ev.permission_mode}`);
    s.permissionMode = ev.permission_mode;
  }
  if (s.status === 'stale' || s.status === 'ended') {
    if (ev.hook_event_name !== 'SessionEnd') { s.status = 'idle'; s.endedAt = null; }
  }
  return s;
}

function useSkill(s, name, by) {
  if (!name) return;
  name = String(name).replace(/^\//, '').slice(0, 80);
  s.skill = { name, at: now(), active: true, by };
  s.skillsUsed[name] = (s.skillsUsed[name] || 0) + 1;
  addTrail(s, 'skill', `${by === 'user' ? 'Ran' : 'Using'} skill ${name}`);
  pushFeed(s, 'skill', `🧩 ${name}`);
}
const FILE_OPS = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'write', NotebookEdit: 'edit' };
function touchFile(s, tool, input) {
  const op = FILE_OPS[tool];
  const f = input?.file_path || input?.notebook_path;
  if (!op || !f || !s.cwd) return;
  const rel = path.relative(s.cwd, path.resolve(s.cwd, f));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  s.touched = s.touched.filter((t) => t.p !== rel);
  s.touched.push({ p: rel, op, at: now() });
  if (s.touched.length > 80) s.touched.splice(0, s.touched.length - 80);
}

function addTrail(s, kind, text) {
  s.trail.push({ t: now(), kind, text: clip(text, 200) });
  if (s.trail.length > TRAIL_MAX) s.trail.splice(0, s.trail.length - TRAIL_MAX);
}

function pushFeed(s, kind, text) {
  const entry = { t: now(), sessionId: s.id, project: s.project, kind, text: clip(text, 160) };
  feed.push(entry);
  if (feed.length > FEED_MAX) feed.splice(0, feed.length - FEED_MAX);
  broadcast({ type: 'feed', entry });
}

function publicSession(s) {
  const { queue, ...rest } = s;
  return { ...rest, queued: queue.length, waitingForTask: standbyWaiters.has(s.id) };
}

function publicApproval(a) {
  const { res, timer, resolve, suggestions, ...rest } = a;
  return rest;
}

// Human-readable summary of Claude Code's permission_suggestions ("always allow" options).
function describeSuggestions(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const where = { session: 'this session', localSettings: 'this project (local)', projectSettings: 'this project', userSettings: 'all projects' };
  const parts = list.map((u) => {
    const dest = where[u.destination] || u.destination || 'this session';
    if (u.type === 'setMode') return `switch to ${u.mode} mode (${dest})`;
    if (u.type === 'addDirectories') return `allow ${(u.directories || []).join(', ')} (${dest})`;
    const rules = (u.rules || []).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
    return `${u.behavior || 'allow'} ${rules} in ${dest}`;
  });
  return clip(parts.join(' · '), 200);
}

// Fallback for the model name: the newest assistant entry in the transcript says which model answered.
function modelFromTranscript(file) {
  if (!file) return null;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      const m = line.match(/"model"\s*:\s*"(claude-[^"]+)"/);
      if (m) return m[1];
    }
  } catch { /* transcript format is internal; ignore */ }
  return null;
}

function touch(s) {
  dirty = true;
  broadcast({ type: 'session', session: publicSession(s) });
}

function broadcastApprovals() {
  broadcast({ type: 'approvals', list: [...approvals.values()].map(publicApproval) });
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

// ------------------------------------------------ statusline + limits ------
// Claude Code passes the statusline command a JSON snapshot: model, effort, context, cost, and
// (for claude.ai subscribers) the 5-hour and 7-day rate-limit windows. scripts/statusline.mjs forwards it here.
let limits = { fiveHour: null, sevenDay: null, spend: null, at: null, hitAt: null };
const windowOf = (w, prev) => {
  if (w && typeof w.used_percentage === 'number') return { pct: w.used_percentage, resetsAt: w.resets_at ? w.resets_at * 1000 : null };
  return prev && prev.resetsAt && prev.resetsAt > now() ? prev : null;
};
function handleStatusline(d) {
  if (d.session_id) {
    const s = getSession({ session_id: d.session_id, cwd: d.workspace?.current_dir || d.cwd, hook_event_name: 'Statusline' });
    const before = JSON.stringify([s.model, s.effort, s.context, s.cost]);
    if (d.model?.display_name || d.model?.id) {
      const m = d.model.display_name || d.model.id;
      if (s.model && m !== s.model) addTrail(s, 'env', `Model → ${m}`);
      s.model = m;
    }
    if (d.effort?.level) s.effort = d.effort.level;
    if (typeof d.context_window?.used_percentage === 'number') s.context = Math.round(d.context_window.used_percentage);
    if (typeof d.cost?.total_cost_usd === 'number') s.cost = Math.round(d.cost.total_cost_usd * 100) / 100;
    if (JSON.stringify([s.model, s.effort, s.context, s.cost]) !== before) touch(s);
  }
  const r = d.rate_limits;
  if (r) {
    const next = {
      fiveHour: windowOf(r.five_hour, limits.fiveHour),
      sevenDay: windowOf(r.seven_day, limits.sevenDay),
      spend: r.spend_limit ? { pct: r.spend_limit.used_percentage, resetsAt: r.spend_limit.resets_at ? r.spend_limit.resets_at * 1000 : null, usedUsd: r.spend_limit.used_usd ?? null, limitUsd: r.spend_limit.limit_usd ?? null, period: r.spend_limit.period ?? null } : null,
      at: now(),
      hitAt: limits.hitAt,
    };
    if (JSON.stringify({ ...next, at: 0 }) !== JSON.stringify({ ...limits, at: 0 })) {
      limits = next;
      dirty = true;
      broadcast({ type: 'limits', limits });
    } else limits.at = next.at;
  }
}

// ---------------------------------------------- external agents (Grok Bot) --
// Grok Bot has no status API. Anything that can POST (a script on this machine, or a Bot's
// routine via a tunnel you set up) reports bots here with the dashboard token. Routine triggers
// are configured in <data dir>/external.json and called from this bridge, so keys never reach the browser.
const external = new Map();
const EXT_FILE = path.join(DATA_DIR, 'external.json');
function externalConfig() {
  try { return JSON.parse(fs.readFileSync(EXT_FILE, 'utf8')); } catch { return {}; }
}
const BOT_STATUS = new Set(['working', 'idle', 'waiting', 'error', 'done']);
function publicExternal(source) {
  const cfg = externalConfig()[source] || {};
  const data = external.get(source) || { bots: [], updatedAt: null };
  return {
    source,
    name: cfg.name || data.name || source,
    updatedAt: data.updatedAt,
    bots: data.bots,
    routines: (cfg.routines || []).map((r, i) => ({ id: r.id || String(i), name: clip(r.name || `Routine ${i + 1}`, 60) })),
  };
}
function allExternal() {
  const names = new Set([...external.keys(), ...Object.keys(externalConfig())]);
  return [...names].map(publicExternal);
}
function ingestExternal(source, body) {
  const bots = (Array.isArray(body.bots) ? body.bots : []).slice(0, 24).map((b, i) => ({
    id: clip(b.id || b.name || `bot-${i}`, 60),
    name: clip(b.name || `Bot ${i + 1}`, 40),
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : null,
    shape: ['circle', 'square', 'triangle', 'diamond', 'star', 'hexagon'].includes(b.shape) ? b.shape : 'circle',
    status: BOT_STATUS.has(b.status) ? b.status : 'idle',
    activity: clip(b.activity || '', 140),
    progress: b.progress && Number.isFinite(b.progress.done) && Number.isFinite(b.progress.total) ? { done: Math.max(0, b.progress.done), total: Math.max(0, b.progress.total) } : null,
    updatedAt: now(),
  }));
  external.set(source, { name: body.name ? clip(body.name, 40) : undefined, bots, updatedAt: now() });
  broadcast({ type: 'external', data: publicExternal(source) });
}
async function triggerRoutine(source, routineId, text) {
  const r = (externalConfig()[source]?.routines || []).find((x, i) => (x.id || String(i)) === routineId);
  if (!r?.url) return { ok: false, error: 'Routine not configured' };
  const headers = { 'Content-Type': 'application/json' };
  if (r.key) headers[r.keyHeader || 'Authorization'] = `${r.keyPrefix ?? 'Bearer '}${r.key}`;
  try {
    const res = await fetch(r.url, { method: 'POST', headers, body: JSON.stringify({ text: String(text || '').slice(0, 4000) }), signal: AbortSignal.timeout(10_000) });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : clip(await res.text(), 200) };
  } catch (e) {
    return { ok: false, error: clip(e.message, 200) };
  }
}

// ---------------------------------------------------------- hook events ----
// Returns the JSON body to send back to Claude Code, or a Promise of it.
function handleHook(ev, req) {
  const name = ev.hook_event_name;
  const s = getSession(ev);
  const sub = ev.agent_id && s.subagents[ev.agent_id];
  const who = sub ? `${sub.type || 'subagent'}` : null;

  switch (name) {
    case 'SessionStart': {
      if (ev.model) s.model = typeof ev.model === 'string' ? ev.model : ev.model.display_name || ev.model.id;
      if (!s.model) s.model = modelFromTranscript(ev.transcript_path);
      s.status = 'idle';
      s.activity = `Session ${ev.source || 'start'}`;
      addTrail(s, 'session', `Session ${ev.source || 'start'}${s.model ? ` · ${s.model}` : ''} · ${ev.cwd || ''}`);
      pushFeed(s, 'session', `Session ${ev.source || 'started'}`);
      break;
    }
    case 'SessionEnd': {
      s.status = 'ended';
      s.endedAt = now();
      s.activity = `Ended (${ev.reason || 'exit'})`;
      s.background = {};
      releaseStandby(s.id);
      addTrail(s, 'session', `Session ended · ${ev.reason || 'exit'}`);
      pushFeed(s, 'session', 'Session ended');
      break;
    }
    case 'UserPromptSubmit': {
      s.status = 'thinking';
      s.activity = 'Thinking…';
      resetFinishedTasks(s);
      addTrail(s, 'prompt', `Prompt: ${clip(ev.prompt, 120)}`);
      { const m = String(ev.prompt || '').match(/^\/([\w:.-]+)/); if (m) useSkill(s, m[1], 'user'); }
      pushFeed(s, 'prompt', 'New prompt');
      break;
    }
    case 'PreToolUse': {
      const summary = summarizeTool(ev.tool_name, ev.tool_input);
      const label = `${ev.tool_name}${summary ? ` · ${summary}` : ''}`;
      if (sub) { sub.activity = label; sub.lastAt = now(); }
      else { s.status = 'working'; s.activity = label; }
      s.toolCount++;
      if (ev.tool_name === 'Skill') useSkill(s, ev.tool_input?.skill || ev.tool_input?.command || ev.tool_input?.name, 'agent');
      touchFile(s, ev.tool_name, ev.tool_input);
      if (ev.tool_name?.startsWith('mcp__')) { const srv = ev.tool_name.split('__')[1]; s.mcpUsed[srv] = (s.mcpUsed[srv] || 0) + 1; }
      const bg = ev.tool_input?.run_in_background;
      if (bg && (ev.tool_name === 'Bash' || ev.tool_name === 'Agent' || ev.tool_name === 'Task')) {
        const id = ev.tool_use_id || crypto.randomUUID();
        s.background[id] = {
          id, type: ev.tool_name === 'Bash' ? 'shell' : 'subagent',
          description: summary, status: 'running', since: now(),
        };
        addTrail(s, 'background', `Background ${ev.tool_name}: ${summary}`);
      }
      if (ev.tool_name === 'Bash' && /^\s*(git\s+(checkout|switch)|cd)\b/.test(ev.tool_input?.command || '')) {
        addTrail(s, 'env', clip(ev.tool_input.command, 120));
      }
      pushFeed(s, 'tool', who ? `${who} › ${label}` : label);
      break;
    }
    case 'PostToolUse': {
      if (ev.tool_name === 'TodoWrite' && Array.isArray(ev.tool_input?.todos)) {
        s.todos = ev.tool_input.todos.map((t) => ({ subject: clip(t.content || t.subject, 100), done: t.status === 'completed', active: t.status === 'in_progress' }));
      }
      if (!sub && s.status === 'working') { s.status = 'thinking'; }
      break;
    }
    case 'PostToolUseFailure': {
      s.errorCount++;
      addTrail(s, 'error', `${ev.tool_name} failed${ev.error ? `: ${clip(ev.error, 120)}` : ''}`);
      pushFeed(s, 'error', `${ev.tool_name} failed`);
      break;
    }
    case 'PermissionRequest':
      return holdForApproval(s, ev, req);
    case 'Notification': {
      const type = ev.notification_type;
      if (type === 'permission_prompt' || type === 'agent_needs_input' || type === 'elicitation_dialog') {
        s.status = 'waiting';
        s.activity = clip(ev.message || 'Needs your input', 100);
      } else if (type === 'idle_prompt') {
        s.status = 'idle';
      }
      addTrail(s, 'notify', ev.message || type || 'notification');
      pushFeed(s, 'notify', ev.message || type);
      break;
    }
    case 'Stop':
      return handleStop(s, ev, req);
    case 'StopFailure': {
      if (ev.error === 'rate_limit') { limits.hitAt = now(); broadcast({ type: 'limits', limits }); }
      s.status = 'error';
      s.activity = `API error: ${ev.error || 'unknown'}`;
      s.errorCount++;
      addTrail(s, 'error', s.activity);
      pushFeed(s, 'error', s.activity);
      break;
    }
    case 'SubagentStart': {
      s.subagents[ev.agent_id] = { id: ev.agent_id, type: ev.agent_type || 'subagent', status: 'working', activity: 'Starting…', startedAt: now(), lastAt: now() };
      addTrail(s, 'subagent', `Subagent started: ${ev.agent_type || ev.agent_id}`);
      pushFeed(s, 'subagent', `Hired ${ev.agent_type || 'subagent'}`);
      break;
    }
    case 'SubagentStop': {
      const a = s.subagents[ev.agent_id];
      if (!a) return {}; // internal agents (prompt suggestions, /btw) — not a desk
      a.status = 'done';
      a.endedAt = now();
      a.activity = clip(ev.last_assistant_message || 'Done', 120);
      addTrail(s, 'subagent', `Subagent finished: ${a.type}`);
      pushFeed(s, 'subagent', `${a.type} finished`);
      setTimeout(() => { delete s.subagents[ev.agent_id]; touch(s); }, 90_000).unref();
      break;
    }
    case 'TaskCreated': {
      s.tasks[ev.task_id] = { subject: clip(ev.task_subject, 100), done: false, createdAt: now() };
      pushFeed(s, 'task', `Task: ${ev.task_subject}`);
      break;
    }
    case 'TaskCompleted': {
      const t = s.tasks[ev.task_id] || (s.tasks[ev.task_id] = { subject: clip(ev.task_subject, 100) });
      t.done = true;
      t.doneAt = now();
      pushFeed(s, 'task', `Done: ${ev.task_subject}`);
      break;
    }
    case 'CwdChanged': {
      s.cwd = ev.new_cwd || s.cwd;
      addTrail(s, 'env', `cwd → ${ev.new_cwd}`);
      break;
    }
    case 'PreCompact': {
      s.status = 'compacting';
      s.activity = 'Compacting context…';
      addTrail(s, 'env', `Context compaction (${ev.trigger || 'auto'})`);
      break;
    }
    case 'PostCompact': {
      s.status = 'thinking';
      addTrail(s, 'env', 'Compaction finished');
      break;
    }
    case 'PostModelSwitch': {
      s.model = ev.to_model || s.model;
      addTrail(s, 'env', `Model → ${ev.to_model}`);
      break;
    }
    default:
      addTrail(s, 'other', name || 'unknown event');
  }
  touch(s);
  return {};
}

// --------------------------------------------------------- Ask Input ------
function holdForApproval(s, ev, req) {
  const summary = summarizeTool(ev.tool_name, ev.tool_input);
  addTrail(s, 'permission', `Permission asked: ${ev.tool_name}${summary ? ` · ${summary}` : ''}`);

  // Nobody is watching the dashboard: let Claude Code show its normal prompt right away.
  if (clients.size === 0) {
    s.status = 'waiting';
    s.activity = `Waiting in terminal: ${ev.tool_name}`;
    touch(s);
    return {};
  }

  s.status = 'waiting';
  s.activity = `Needs approval: ${ev.tool_name}`;
  pushFeed(s, 'permission', `Asks to run ${ev.tool_name}${summary ? ` · ${summary}` : ''}`);
  touch(s);

  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const a = {
      id,
      sessionId: s.id,
      project: s.project,
      agentType: ev.agent_type || null,
      tool: ev.tool_name,
      summary,
      detail: ev.tool_name === 'Bash' ? clip(ev.tool_input?.command, 400) : summary,
      always: describeSuggestions(ev.permission_suggestions),
      suggestions: Array.isArray(ev.permission_suggestions) ? ev.permission_suggestions : [],
      createdAt: now(),
      expiresAt: now() + APPROVAL_HOLD_MS,
      resolve,
    };
    a.timer = setTimeout(() => settleApproval(id, 'terminal', 'timeout'), APPROVAL_HOLD_MS);
    approvals.set(id, a);
    // Claude Code gave up on the hook (it timed out, or the session was interrupted).
    req.on('close', () => { if (approvals.has(id)) settleApproval(id, 'terminal', 'closed'); });
    broadcastApprovals();
  });
}

function settleApproval(id, behavior, message) {
  const a = approvals.get(id);
  if (!a) return false;
  approvals.delete(id);
  clearTimeout(a.timer);
  const s = sessions.get(a.sessionId);
  let body = {};
  if (behavior === 'allow') {
    body = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  } else if (behavior === 'always') {
    body = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: a.suggestions } } };
  } else if (behavior === 'deny') {
    body = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: message || 'Denied from Agent Office dashboard' } } };
  }
  a.resolve(body);
  if (s) {
    const label = behavior === 'terminal' ? `Passed to terminal (${message || 'manual'})` : behavior === 'allow' ? 'Allowed' : behavior === 'always' ? `Always allowed (${a.always || 'suggested rule'})` : 'Denied';
    addTrail(s, 'permission', `${label}: ${a.tool}`);
    pushFeed(s, 'permission', `${label} · ${a.tool}`);
    s.status = behavior === 'terminal' ? 'waiting' : behavior === 'deny' ? 'thinking' : 'working';
    touch(s);
  }
  broadcastApprovals();
  return true;
}

// --------------------------------------------- Minju's desk: dispatch ------
// A finished checklist belongs to the previous request: start the progress bar fresh.
function resetFinishedTasks(s) {
  const tasks = Object.values(s.tasks);
  if (tasks.length && tasks.every((t) => t.done)) s.tasks = {};
  if (s.todos?.every((t) => t.done)) s.todos = null;
}

function taskMessage(text) {
  return `New task assigned from Minju's desk (Agent Office dashboard, sent by the user):\n\n${text}`;
}
function stopBody(text) {
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: taskMessage(text) } };
}

function handleStop(s, ev, req) {
  s.lastMessage = clip(ev.last_assistant_message || '', 280);
  if (s.skill) s.skill.active = false;
  if (Array.isArray(ev.background_tasks)) {
    s.background = {};
    for (const t of ev.background_tasks) {
      s.background[t.id] = {
        id: t.id, type: t.type, status: t.status,
        description: clip(t.description || t.command || t.name || t.agent_type || '', 120),
        since: s.background[t.id]?.since || now(),
      };
    }
  }
  const bgCount = Object.keys(s.background).length;

  if (s.queue.length) {
    const task = s.queue.shift();
    resetFinishedTasks(s);
    s.status = 'thinking';
    s.activity = 'Picked up a task from Minju';
    addTrail(s, 'dispatch', `Delivered task: ${task.text}`);
    pushFeed(s, 'dispatch', `Picked up: ${task.text}`);
    touch(s);
    return stopBody(task.text);
  }

  s.status = 'idle';
  s.activity = bgCount ? `Idle · ${bgCount} background job${bgCount > 1 ? 's' : ''}` : 'Turn finished';
  pushFeed(s, 'stop', 'Turn finished');

  if (!s.standby) { touch(s); return {}; }

  // Standby: keep the turn open so Minju can hand over the next task.
  s.status = 'standby';
  s.activity = 'On standby for a task';
  touch(s);
  return new Promise((resolve) => {
    const timer = setTimeout(() => releaseStandby(s.id), STANDBY_HOLD_MS);
    standbyWaiters.set(s.id, { resolve, timer });
    req.on('close', () => releaseStandby(s.id, true));
  });
}

function releaseStandby(sessionId, closed = false) {
  const w = standbyWaiters.get(sessionId);
  if (!w) return;
  standbyWaiters.delete(sessionId);
  clearTimeout(w.timer);
  if (!closed) w.resolve({});
  const s = sessions.get(sessionId);
  if (s && s.status === 'standby') { s.status = 'idle'; s.activity = 'Standby ended'; touch(s); }
}

function dispatch(sessionId, text, skill) {
  const s = sessions.get(sessionId);
  if (!s || s.status === 'ended') return { ok: false, error: 'Session not active' };
  text = String(text || '').trim().slice(0, 4000);
  if (skill != null && skill !== '') {
    if (!/^[\w:.-]{1,80}$/.test(skill)) return { ok: false, error: 'Bad skill name' };
    text = `Use the "${skill}" skill (load it with the Skill tool) for this task.${text ? `\n\n${text}` : ''}`;
  }
  if (!text) return { ok: false, error: 'Empty task' };
  const w = standbyWaiters.get(sessionId);
  if (w) {
    standbyWaiters.delete(sessionId);
    clearTimeout(w.timer);
    w.resolve(stopBody(text));
    resetFinishedTasks(s);
    s.status = 'thinking';
    s.activity = 'Picked up a task from Minju';
    addTrail(s, 'dispatch', `Delivered task: ${text}`);
    pushFeed(s, 'dispatch', `Picked up: ${text}`);
    touch(s);
    return { ok: true, delivered: true };
  }
  s.queue.push({ text, at: now() });
  addTrail(s, 'dispatch', `Queued task: ${text}`);
  pushFeed(s, 'dispatch', `Queued: ${text}`);
  touch(s);
  return { ok: true, delivered: false, queued: s.queue.length };
}

// ------------------------------------------------------------------ HTTP ----
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function serveFile(res, baseDir, rel) {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  // DNS-rebinding guard: only answer requests addressed to loopback.
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, { error: 'bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- Claude Code hooks ------------------------------------------------
    if (p === '/hook' && req.method === 'POST') {
      // application/json can't be sent cross-site without a CORS preflight, which we never grant.
      if (!(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'json only' });
      const ev = await readJson(req);
      const out = await handleHook(ev, req);
      if (!res.writableEnded && !res.destroyed) send(res, 200, out || {});
      return;
    }

    if (p === '/statusline' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'json only' });
      handleStatusline(await readJson(req));
      return send(res, 200, {});
    }

    if (p === '/health') return send(res, 200, { ok: true, sessions: sessions.size, viewers: clients.size });

    // ---- Dashboard (token required) ---------------------------------------
    if (p === '/events' && req.method === 'GET') {
      if (!safeEqual(url.searchParams.get('token'), TOKEN)) return send(res, 401, { error: 'bad token' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({
        type: 'snapshot',
        sessions: [...sessions.values()].map(publicSession),
        approvals: [...approvals.values()].map(publicApproval),
        feed: feed.slice(-60),
        limits,
        external: allExternal(),
      })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
        // Last viewer left: hand every pending question back to the terminal.
        if (clients.size === 0) for (const id of [...approvals.keys()]) settleApproval(id, 'terminal', 'dashboard closed');
      });
      return;
    }

    if (p.startsWith('/api/') && req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'bad origin' });
      if (!safeEqual(req.headers['x-office-token'], TOKEN)) return send(res, 401, { error: 'bad token' });
      const body = await readJson(req, 100_000);

      const ext = p.match(/^\/api\/external\/([a-z0-9-]{1,32})(\/trigger)?$/);
      if (ext && !ext[2]) { ingestExternal(ext[1], body); return send(res, 200, { ok: true }); }
      if (ext && ext[2]) {
        const r = await triggerRoutine(ext[1], String(body.routine || ''), body.text);
        return send(res, r.ok ? 200 : 502, r);
      }
      if (p.startsWith('/api/ws/')) {
        const sess = sessions.get(body.sessionId);
        const cwd = sess?.cwd;
        if (p === '/api/ws/skills') return send(res, 200, { skills: WS.listSkills(cwd && fs.existsSync(cwd) ? cwd : null), used: sess?.skillsUsed || {} });
        if (p === '/api/ws/market') {
          const repos = WS.marketplaceRepos(DATA_DIR, cwd);
          const enabled = WS.enabledPlugins(cwd && fs.existsSync(cwd) ? cwd : null);
          const markets = await Promise.all(repos.map(async (repo) => {
            try { const c = await WS.fetchCatalog(repo); return { repo, name: c.name, description: c.description, plugins: c.plugins.map((pl) => ({ ...pl, installed: enabled[`${pl.name}@${c.name}`] || null })) }; }
            catch (e) { return { repo, name: repo, error: e.message, plugins: [] }; }
          }));
          return send(res, 200, { markets, cli: !!(await WS.claudeCli()), official: 'anthropics/claude-plugins-official' });
        }
        if (p === '/api/ws/market/add') { try { return send(res, 200, { repo: WS.addMarketplace(DATA_DIR, body.repo) }); } catch (e) { return send(res, 400, { error: e.message }); } }
        if (p === '/api/ws/market/remove') { WS.removeMarketplace(DATA_DIR, String(body.repo || '')); return send(res, 200, { ok: true }); }
        if (p === '/api/ws/market/install') {
          try {
            const out = await WS.installPlugin(String(body.id || ''));
            if (sess) { addTrail(sess, 'env', `Installed plugin ${body.id}`); touch(sess); }
            return send(res, 200, { ok: true, output: clip(out, 300) });
          } catch (e) { return send(res, 400, { error: clip(e.message, 300) }); }
        }
        if (p === '/api/ws/mcp') return send(res, 200, { servers: WS.mcpServers(cwd && fs.existsSync(cwd) ? cwd : null), used: sess?.mcpUsed || {} });
        if (p === '/api/ws/skill') { const g = WS.skillGuide(String(body.id || '')); return send(res, g ? 200 : 404, g || { error: 'Unknown skill' }); }
        if (!cwd || !fs.existsSync(cwd)) return send(res, 404, { error: "This session's folder isn't on this computer" });
        try {
          if (p === '/api/ws/files') return send(res, 200, WS.listDir(cwd, body.path));
          if (p === '/api/ws/file') return send(res, 200, WS.readFileSafe(cwd, body.path));
          if (p === '/api/ws/git/status') return send(res, 200, await WS.gitStatus(cwd));
          if (p === '/api/ws/git/diff') return send(res, 200, await WS.gitDiff(cwd, body.path, !!body.staged));
          if (p === '/api/ws/git/stage') { await WS.gitStage(cwd, body.paths); return send(res, 200, { ok: true }); }
          if (p === '/api/ws/git/branches') return send(res, 200, await WS.gitBranches(cwd));
          if (p === '/api/ws/git/switch' || p === '/api/ws/git/branch') {
            const name = String(body.name || '');
            if (p.endsWith('switch')) await WS.gitSwitch(cwd, name); else await WS.gitCreateBranch(cwd, name);
            addTrail(sess, 'git', `${p.endsWith('switch') ? 'Switched to' : 'Created'} branch ${name} from the dashboard`);
            touch(sess);
            return send(res, 200, { ok: true });
          }
          if (p === '/api/ws/git/unstage') { await WS.gitUnstage(cwd, body.paths); return send(res, 200, { ok: true }); }
          if (p === '/api/ws/git/commit') {
            const summary = await WS.gitCommit(cwd, body.message);
            addTrail(sess, 'git', `Committed from the dashboard: ${summary}`);
            pushFeed(sess, 'git', `Committed: ${clip(body.message, 80)}`);
            touch(sess);
            return send(res, 200, { ok: true, summary });
          }
        } catch (e) { return send(res, 400, { error: clip(e.message, 300) }); }
        return send(res, 404, { error: 'unknown workspace api' });
      }
      if (p === '/api/approval') {
        const behavior = ['allow', 'always', 'deny', 'terminal'].includes(body.behavior) ? body.behavior : null;
        if (!behavior) return send(res, 400, { error: 'behavior must be allow|always|deny|terminal' });
        if (behavior === 'always' && !approvals.get(body.id)?.suggestions?.length) return send(res, 400, { error: 'no suggested rule to apply' });
        return send(res, settleApproval(body.id, behavior, body.message) ? 200 : 404, { ok: true });
      }
      if (p === '/api/dispatch') {
        const r = dispatch(body.sessionId, body.text, body.skill);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (p === '/api/standby') {
        const s = sessions.get(body.sessionId);
        if (!s) return send(res, 404, { error: 'no session' });
        s.standby = !!body.on;
        addTrail(s, 'dispatch', s.standby ? 'Standby on' : 'Standby off');
        if (!s.standby) releaseStandby(s.id);
        touch(s);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/forget') {
        const s = sessions.get(body.sessionId);
        if (s) { releaseStandby(s.id); sessions.delete(s.id); dirty = true; broadcast({ type: 'removed', id: s.id }); }
        return send(res, 200, { ok: true });
      }
      if (p === '/api/clear-queue') {
        const s = sessions.get(body.sessionId);
        if (s) { s.queue = []; addTrail(s, 'dispatch', 'Queue cleared'); touch(s); }
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'unknown api' });
    }

    // ---- Static -----------------------------------------------------------
    if (req.method === 'GET') {
      if (p.startsWith('/vendor/three/')) return serveFile(res, THREE_DIR, p.slice('/vendor/three/'.length));
      return serveFile(res, WEB_DIR, p === '/' ? 'index.html' : p.slice(1));
    }
    send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: String(err.message || err) });
  }
});

// Long-held hook requests must not be cut by Node's default timeouts.
server.requestTimeout = 0;
server.headersTimeout = 30_000;

// Sweep long-ended sessions.
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.endedAt && now() - s.endedAt > ENDED_TTL_MS) { sessions.delete(s.id); broadcast({ type: 'removed', id: s.id }); dirty = true; }
  }
}, 60_000).unref();

loadState();
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Is the bridge already running? Set AGENT_OFFICE_PORT to use another port.\n`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`\n  🏢 Agent Office bridge listening on http://${HOST}:${PORT}`);
  console.log(`  🔑 Open the dashboard:  http://${HOST}:${PORT}/#token=${TOKEN}\n`);
  console.log(`  Hooks POST to http://${HOST}:${PORT}/hook  ·  data dir ${DATA_DIR}`);
});

function shutdown() {
  for (const id of [...approvals.keys()]) settleApproval(id, 'terminal', 'bridge stopping');
  for (const id of [...standbyWaiters.keys()]) releaseStandby(id);
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sessions: [...sessions.values()], feed: feed.slice(-FEED_MAX), limits }), { mode: 0o600 });
  } catch {}
  setTimeout(() => process.exit(0), 100);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
