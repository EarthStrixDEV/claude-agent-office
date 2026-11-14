// Boots the real bridge on a spare port with a temp AGENT_OFFICE_DIR (indexer off → degraded mode)
// and drives it over HTTP: hooks, the Session Trail API, the auth guard, SSE, migration and the lock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-server-'));
const children = [];

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

function run(dir, port) {
  const env = { ...process.env, AGENT_OFFICE_DIR: dir, AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_TRANSCRIPTS: '0' };
  const child = spawn(process.execPath, ['bridge/server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (out.includes('listening')) resolve(); });
    exited.then((code) => reject(new Error(`bridge exited (${code}): ${out}`)));
  });
  return { child, ready, exited, out: () => out };
}

let dir, port, token, base;
before(async () => {
  dir = fs.mkdtempSync(path.join(TMP, 'main-'));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await run(dir, port).ready;
  token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
});
after(async () => {
  await Promise.all(children.map((c) => (c.exitCode == null ? new Promise((r) => { c.on('exit', r); c.kill(); }) : null)));
  fs.rmSync(TMP, { recursive: true, force: true });
});

const hook = (ev) => fetch(`${base}/hook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) }).then((r) => r.json());
async function api(p, body, headers = { 'X-Office-Token': token }) {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const SID = 'sess-1';

test('hooks feed the store; list and trail pages come back oldest-first and redacted', async () => {
  await hook({ session_id: SID, hook_event_name: 'SessionStart', source: 'startup', cwd: dir, transcript_path: path.join(dir, 'none.jsonl') });
  await hook({ session_id: SID, hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'deploy with token=abc123secretvalue please' });
  await hook({ session_id: SID, hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: 'git checkout main' } });
  await hook({ session_id: SID, hook_event_name: 'Notification', cwd: dir, notification_type: 'permission_prompt', message: 'Claude needs your input' });

  const list = await api('/api/sessions/list', {});
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  const rec = list.body.items[0];
  assert.equal(rec.id, SID);
  assert.equal(rec.presence, 'live');
  assert.equal(rec.status, 'waiting');
  assert.equal(rec.waiting, true);
  assert.equal(rec.counts.prompts, 1);
  assert.match(rec.lastPrompt, /token=••••/);
  assert.ok(!('transcript' in rec) && !('scan' in rec));

  const first = await api('/api/sessions/trail', { sessionId: SID, limit: 2 });
  assert.equal(first.status, 200);
  assert.equal(first.body.building, false);
  assert.deepEqual(first.body.entries.map((e) => e.kind), ['env', 'notify']);
  assert.ok(first.body.before);
  const rest = await api('/api/sessions/trail', { sessionId: SID, before: first.body.before });
  assert.deepEqual(rest.body.entries.map((e) => e.kind), ['session', 'prompt']);
  assert.equal(rest.body.before, null);
  const all = [...rest.body.entries, ...first.body.entries];
  assert.ok(all.every((e) => /^h:/.test(e.id) && e.src === 'hook'));
  assert.ok(!JSON.stringify(all).includes('abc123secretvalue'));

  const prompts = await api('/api/sessions/trail', { sessionId: SID, kinds: ['prompt'] });
  assert.deepEqual(prompts.body.entries.map((e) => e.text), ['Prompt: deploy with token=•••• please']);
});

test('API guard: missing token 401, foreign Origin 403, foreign Host 421; bad input 404/400', async () => {
  assert.equal((await api('/api/sessions/list', {}, {})).status, 401);
  assert.equal((await api('/api/sessions/list', {}, { 'X-Office-Token': 'nope' })).status, 401);
  assert.equal((await api('/api/sessions/trail', { sessionId: SID }, { 'X-Office-Token': token, Origin: 'http://evil.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/sessions/list', method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json', 'X-Office-Token': token } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(hostStatus, 421);
  assert.equal((await api('/api/sessions/trail', { sessionId: 'nobody' })).status, 404);
  assert.equal((await api('/api/sessions/trail', { sessionId: SID, before: 'xx' })).status, 400);
  assert.equal((await api('/api/sessions/list', { cursor: 'xx' })).status, 400);
});

test('SSE: snapshot without trail but with presence/desk/indexTotal, then batched trail events', async () => {
  const messages = [];
  const res = await new Promise((resolve, reject) => {
    http.get(`${base}/events?token=${token}`, resolve).on('error', reject);
  });
  let buf = '';
  const waitFor = (pred) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; got ${messages.map((m) => m.type)}`)), 3000);
    const check = () => { const m = messages.find(pred); if (m) { clearTimeout(timer); resolve(m); } };
    res.on('data', check);
    check();
  });
  res.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith('data: ')) messages.push(JSON.parse(chunk.slice(6)));
    }
  });
  try {
    const snap = await waitFor((m) => m.type === 'snapshot');
    const s = snap.sessions.find((x) => x.id === SID);
    assert.equal(s.presence, 'live');
    assert.equal(s.desk, true);
    assert.ok(!('trail' in s));
    assert.equal(snap.indexTotal, 1);

    await hook({ session_id: SID, hook_event_name: 'CwdChanged', cwd: dir, new_cwd: dir });
    const trail = await waitFor((m) => m.type === 'trail' && m.sessionId === SID && m.entries.some((e) => e.text.startsWith('cwd →')));
    assert.ok(trail.entries.every((e) => e.id && e.src === 'hook'));
    const session = messages.find((m) => m.type === 'session' && m.session.id === SID);
    assert.ok(session && !('trail' in session.session) && 'title' in session.session);
    const index = await waitFor((m) => m.type === 'index' && m.op === 'upsert' && m.record.id === SID);
    assert.equal(index.record.presence, 'live');

    // Forget = leave the office; the record stays in History.
    assert.equal((await api('/api/forget', { sessionId: SID })).status, 200);
    await waitFor((m) => m.type === 'removed' && m.id === SID);
    const list = await api('/api/sessions/list', {});
    assert.equal(list.body.items[0].presence, 'history');
  } finally { res.destroy(); }
});

test('a second bridge on the same data dir refuses to start (bridge.lock)', async () => {
  const second = run(dir, await freePort());
  second.ready.catch(() => {}); // it is expected never to become ready
  const code = await second.exited;
  assert.equal(code, 1);
  assert.match(second.out(), /Another bridge \(pid \d+\) is already using/);
});

test('v1 state.json is migrated on boot: .bak, legacy trail, v2 state without trails', async () => {
  const d = fs.mkdtempSync(path.join(TMP, 'migrate-'));
  const t = Date.now() - 60_000;
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({
    sessions: [{ id: 'old-1', cwd: d, project: 'p', status: 'working', startedAt: t, lastAt: t, skillsUsed: {}, touched: [], mcpUsed: {}, subagents: {}, background: {}, tasks: {}, queue: [],
      trail: [{ t, kind: 'session', text: 'Session startup' }, { t, kind: 'prompt', text: 'Prompt: x' }] }],
    feed: [],
  }));
  const p = await freePort();
  await run(d, p).ready;
  assert.ok(fs.existsSync(path.join(d, 'state.v1.json.bak')));
  const state = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
  assert.equal(state.v, 2);
  assert.equal(state.sessions[0].status, 'stale');
  assert.ok(!('trail' in state.sessions[0]));
  const lines = fs.readFileSync(path.join(d, 'trails', 'old-1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.id, e.kind, e.src]), [['l:0', 'session', 'legacy']]);
  const tok = fs.readFileSync(path.join(d, 'token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${p}/api/sessions/list`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': tok }, body: JSON.stringify({ includeEmpty: true }) });
  const body = await r.json();
  assert.deepEqual(body.items.map((x) => [x.id, x.presence, x.status]), [['old-1', 'idle', 'stale']]);
});
