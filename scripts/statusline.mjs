#!/usr/bin/env node
// Claude Code statusline command for Agent Office.
// Claude Code pipes a JSON snapshot (model, effort, context, cost, 5-hour / 7-day limits) to stdin.
// We forward it to the bridge, then print a status line: your previous statusline command's
// output if you had one (saved by the installer), or a short default line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.AGENT_OFFICE_PORT || 7777);
const DATA_DIR = process.env.AGENT_OFFICE_DIR || path.join(os.homedir(), '.agent-office');

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString('utf8');

const forward = fetch(`http://127.0.0.1:${PORT}/statusline`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: raw,
  signal: AbortSignal.timeout(400),
}).catch(() => {}); // the office being closed must never break the status line

let prev = null;
try { prev = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'statusline-prev.json'), 'utf8')); } catch {}

function runPrevious(command) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(out); }, 2500);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.stdin.end(raw);
  });
}

function defaultLine() {
  let d = {};
  try { d = JSON.parse(raw); } catch {}
  const parts = [];
  if (d.model?.display_name) parts.push(`[${d.model.display_name}${d.effort?.level ? ` · ${d.effort.level}` : ''}]`);
  if (typeof d.context_window?.used_percentage === 'number') parts.push(`ctx ${Math.round(d.context_window.used_percentage)}%`);
  const r = d.rate_limits || {};
  if (typeof r.five_hour?.used_percentage === 'number') parts.push(`5h ${Math.round(r.five_hour.used_percentage)}%`);
  if (typeof r.seven_day?.used_percentage === 'number') parts.push(`week ${Math.round(r.seven_day.used_percentage)}%`);
  parts.push('🏢 office');
  return parts.join(' · ');
}

const line = prev?.command ? await runPrevious(prev.command) : defaultLine();
process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
await forward;
