#!/usr/bin/env node
// Adds (or removes) Agent Office HTTP hooks in a Claude Code settings file.
//
//   node scripts/install-hooks.mjs                 # ~/.claude/settings.json (all sessions)
//   node scripts/install-hooks.mjs --settings .claude/settings.local.json
//   node scripts/install-hooks.mjs --dry-run       # print the result, write nothing
//   node scripts/install-hooks.mjs --uninstall
//   node scripts/install-hooks.mjs --no-statusline   # hooks only
//
// The statusline (model, effort, 5-hour / weekly limits) is chained: if you already have a
// statusLine command it is saved and still prints; --uninstall puts it back.
//
// A backup of the settings file is written next to it before any change.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const PORT = Number(opt('--port') || process.env.AGENT_OFFICE_PORT || 7777);
const SETTINGS = path.resolve(opt('--settings') || path.join(os.homedir(), '.claude', 'settings.json'));
const URL = `http://127.0.0.1:${PORT}/hook`;
const MARK = '/hook'; // every Agent Office hook points at 127.0.0.1:<port>/hook

// Event -> timeout (seconds). PermissionRequest and Stop may be held open by the
// bridge (Ask Input / standby), so they get the long default; the rest must be quick.
const EVENTS = {
  SessionStart: 5,
  SessionEnd: undefined, // SessionEnd hooks share a short budget; keep the default
  UserPromptSubmit: 5,
  PreToolUse: 5,
  PostToolUse: 5,
  PostToolUseFailure: 5,
  PermissionRequest: 600,
  Notification: 5,
  Stop: 600,
  StopFailure: 5,
  SubagentStart: 5,
  SubagentStop: 5,
  TaskCreated: 5,
  TaskCompleted: 5,
  CwdChanged: 5,
  PreCompact: 5,
  PostCompact: 5,
  PostModelSwitch: 5,
};

const isOurs = (h) => h?.type === 'http' && typeof h.url === 'string'
  && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/hook$/.test(h.url) && h.url.endsWith(MARK);

let settings = {};
let raw = null;
try {
  raw = fs.readFileSync(SETTINGS, 'utf8');
  settings = JSON.parse(raw);
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`Cannot parse ${SETTINGS}: ${e.message}`); process.exit(1); }
}
settings.hooks ??= {};

// Remove any previous Agent Office hooks (makes install idempotent, and is the uninstall).
for (const [event, groups] of Object.entries(settings.hooks)) {
  if (!Array.isArray(groups)) continue;
  const kept = groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
}

if (!flag('--uninstall')) {
  for (const [event, timeout] of Object.entries(EVENTS)) {
    const hook = { type: 'http', url: URL };
    if (timeout) hook.timeout = timeout;
    (settings.hooks[event] ??= []).push({ hooks: [hook] });
  }
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

// ---- statusline (chained)
const DATA_DIR = process.env.AGENT_OFFICE_DIR || path.join(os.homedir(), '.agent-office');
const PREV_FILE = path.join(DATA_DIR, 'statusline-prev.json');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline.mjs');
const OUR_COMMAND = `node "${SCRIPT}"`;
const isOurStatusline = (sl) => typeof sl?.command === 'string' && /scripts[\\/]statusline\.mjs/.test(sl.command);
let statuslineNote = '';
const pendingWrites = [];
if (flag('--uninstall')) {
  if (isOurStatusline(settings.statusLine)) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(PREV_FILE, 'utf8')); } catch {}
    if (prev?.statusLine) settings.statusLine = prev.statusLine; else delete settings.statusLine;
    pendingWrites.push(() => fs.rmSync(PREV_FILE, { force: true }));
    statuslineNote = prev?.statusLine ? '\nRestored your previous statusline.' : '\nRemoved the Agent Office statusline.';
  }
} else if (!flag('--no-statusline')) {
  if (settings.statusLine && !isOurStatusline(settings.statusLine)) {
    const prevSl = settings.statusLine;
    pendingWrites.push(() => {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(PREV_FILE, JSON.stringify({ statusLine: prevSl, command: prevSl.command || null }, null, 2));
    });
    statuslineNote = '\nYour existing statusline is kept: Agent Office runs it and prints its output.';
  }
  settings.statusLine = { type: 'command', command: OUR_COMMAND, refreshInterval: 30 };
  statuslineNote = `\nStatusline → ${OUR_COMMAND} (model, effort, 5-hour and weekly limits)${statuslineNote}`;
}

const out = JSON.stringify(settings, null, 2) + '\n';
if (flag('--dry-run')) { console.log(out); process.exit(0); }

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
if (raw !== null) {
  const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(backup, raw);
  console.log(`Backup: ${backup}`);
}
fs.writeFileSync(SETTINGS, out);
for (const w of pendingWrites) w();
console.log(flag('--uninstall')
  ? `Removed Agent Office hooks from ${SETTINGS}${statuslineNote}`
  : `Installed ${Object.keys(EVENTS).length} Agent Office hooks → ${URL}\nin ${SETTINGS}${statuslineNote}\nNew Claude Code sessions will report to the office. Run /hooks inside a session to review them.`);
