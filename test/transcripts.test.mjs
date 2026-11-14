import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createIndexer, parseLine, newCtx, PARSER_VERSION } from '../bridge/transcripts.mjs';
import { SECRET_PATTERNS } from '../bridge/redact.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const S = 'aaaaaaaa-0000-4000-8000-000000000001';
const P = 'bbbbbbbb-0000-4000-8000-000000000002';
const quiet = { warn() {}, log() {} };
const FAST = { log: quiet, pollMs: 200, debounceMs: 20, maxWaitMs: 100 };

const EXPECTED = [
  ['t:u-1', 'prompt', 'Prompt: Fix the build please'],
  ['t:u-cmd', 'skill', '/review PR 12'],
  ['t:u-cmd2', 'skill', '/clear'],
  ['t:u-img', 'prompt', 'Prompt: Look at this [2 images]'],
  ['t:toolu_bash', 'tool', 'Bash · Run tests'],
  ['t:toolu_edit', 'tool', 'Edit · app.js'],
  ['t:toolu_edit:err', 'error', 'Edit failed: String to replace not found'],
  ['t:toolu_skill', 'skill', 'frontend-design hero'],
  ['t:toolu_agent', 'subagent', 'Find callers'],
  ['t:toolu_agent:err', 'error', 'Agent failed: Agent crashed'],
  ['t:toolu_deny', 'tool', 'Bash · Delete things'],
  ['t:toolu_unknown:err', 'error', 'Tool failed: boom'],
];

const ts = (sec) => new Date(Date.UTC(2026, 10, 14, 3, 0, sec)).toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const prompt = (uuid, content, sec = 0) => line({ type: 'user', sessionId: S, uuid, timestamp: ts(sec), cwd: '/w', message: { role: 'user', content } });
const toolUse = (id, name, input, sec = 0) => line({ type: 'assistant', sessionId: S, uuid: `a-${id}`, timestamp: ts(sec), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolError = (id, content, sec = 0) => line({ type: 'user', sessionId: S, uuid: `r-${id}`, timestamp: ts(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] } });
const filler = (sec = 0) => line({ type: 'attachment', sessionId: S, timestamp: ts(sec), attachment: { type: 'async_hook_response', content: 'x'.repeat(200) } });

async function tmpRoot(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'trail-indexer-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.mkdir(path.join(dir, 'proj'));
  return dir;
}

function record(ix) {
  const ev = { meta: [], entries: [], reset: [], gone: [], health: [], order: [] };
  ix.on('meta', (m) => { ev.meta.push(m); ev.order.push('meta'); });
  ix.on('entries', (id, entries, cursor) => { ev.entries.push({ id, entries, cursor }); ev.order.push('entries'); });
  ix.on('reset', (id) => { ev.reset.push(id); ev.order.push('reset'); });
  ix.on('gone', (id) => { ev.gone.push(id); ev.order.push('gone'); });
  ix.on('health', (h) => { ev.health.push(h); });
  return ev;
}
const allEntries = (ev) => ev.entries.flatMap((b) => b.entries);
const lastCursor = (ev) => ev.entries.at(-1)?.cursor ?? null;

async function waitFor(cond, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for indexer');
    await new Promise((r) => setTimeout(r, 15));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withFixture(t, name = 'basic.jsonl', id = S) {
  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${id}.jsonl`);
  await fsp.copyFile(path.join(FIXTURES, name), file);
  return { root, file };
}

// ─── Parser ──────────────────────────────────────────────────────────────────

test('parser maps every fixture row to the five transcript kinds and skips injected text', async () => {
  const ctx = newCtx();
  const out = [];
  let bad = 0;
  const unknown = [];
  const meta = {};
  for (const l of (await fsp.readFile(path.join(FIXTURES, 'basic.jsonl'), 'utf8')).split('\n')) {
    if (!l) continue;
    let obj;
    try { obj = JSON.parse(l); } catch { bad++; continue; }
    const r = parseLine(obj, ctx, S);
    out.push(...r.entries);
    if (r.unknown) unknown.push(r.unknown);
    Object.assign(meta, r.meta);
  }
  assert.deepEqual(out.map((e) => [e.id, e.kind, e.text]), EXPECTED);
  for (const e of out) {
    assert.equal(e.src, 'transcript');
    assert.ok(Number.isFinite(e.t) && e.t > 0);
    assert.deepEqual(Object.keys(e).filter((k) => !['id', 't', 'kind', 'src', 'text', 'tool', 'agent', 'bg'].includes(k)), []);
  }
  const byId = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.equal(byId['t:toolu_bash'].bg, true);
  assert.equal(byId['t:toolu_bash'].tool, 'Bash');
  assert.equal(byId['t:toolu_edit'].bg, undefined);
  assert.equal(byId['t:toolu_skill'].tool, 'Skill');
  assert.equal(byId['t:toolu_agent'].agent, 'Explore');
  assert.equal(bad, 1);
  assert.deepEqual(unknown, ['mystery-type']);
  assert.equal(ctx.prompts, 2);
  assert.equal(ctx.cwd, '/work/alpha-moved');
  assert.equal(ctx.gitBranch, 'feature-x');
  assert.equal(ctx.model, 'claude-opus-5-5');
  assert.deepEqual(ctx.pending, { toolu_skill: 'Skill' }, 'finished and denied tools leave the pending map');
  assert.equal(meta.forkedFrom, P);
});

test('pending tool map is capped at 256 and still names errors across chunks', () => {
  const ctx = newCtx();
  for (let i = 0; i < 300; i++) parseLine(JSON.parse(toolUse(`toolu_${i}`, 'Read', { file_path: `/x/${i}.txt` })), ctx, S);
  assert.equal(Object.keys(ctx.pending).length, 256);
  assert.equal(ctx.pending.toolu_0, undefined);
  const r = parseLine(JSON.parse(toolError('toolu_299', 'nope')), JSON.parse(JSON.stringify(ctx)), S);
  assert.equal(r.entries[0].text, 'Read failed: nope');
});

// ─── Redaction ───────────────────────────────────────────────────────────────

test('no SECRET_PATTERNS example leaks through entries or meta', async (t) => {
  // [text placed in the transcript, the part that must never come out]
  const examples = [
    ['sk-test1234567890abcdefXYZ', 'sk-test1234567890abcdefXYZ'],
    ['ghp_A1b2C3d4E5f6G7h8I9j0K1l2', 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
    ['password=Hunter2Secret!', 'Hunter2Secret!'],
    ['Bearer abcdefghijklmnop.qrstuv', 'abcdefghijklmnop.qrstuv'],
  ];
  assert.equal(examples.length, SECRET_PATTERNS.length, 'add an example for every new pattern');
  examples.forEach(([text], i) => {
    SECRET_PATTERNS[i].lastIndex = 0;
    assert.ok(SECRET_PATTERNS[i].test(text), `example ${i} must match its pattern`);
  });

  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${S}.jsonl`);
  let body = '';
  examples.forEach(([secret], i) => {
    body += prompt(`p-${i}`, `please use ${secret} now`, i);
    body += prompt(`pa-${i}`, [{ type: 'text', text: `array ${secret}` }, { type: 'image', source: {} }], i);
    body += toolUse(`b-${i}`, 'Bash', { command: `curl -H "${secret}" x` }, i);
    body += toolUse(`bd-${i}`, 'Bash', { command: 'true', description: `with ${secret}` }, i);
    body += toolUse(`ws-${i}`, 'WebSearch', { query: `find ${secret}` }, i);
    body += toolUse(`gr-${i}`, 'Grep', { pattern: secret }, i);
    body += toolUse(`ag-${i}`, 'Agent', { description: `agent ${secret}`, subagent_type: 'Explore' }, i);
    body += toolUse(`sk-${i}`, 'Skill', { skill: 'deploy', args: secret }, i);
    body += toolError(`b-${i}`, `failed with ${secret}\nmore ${secret}`, i);
    body += line({ type: 'user', sessionId: S, uuid: `c-${i}`, timestamp: ts(i), message: { role: 'user', content: `<command-message>x</command-message><command-name>/run</command-name><command-args>${secret}</command-args>` } });
  });
  body += line({ type: 'custom-title', sessionId: S, customTitle: `title ${examples.map((e) => e[0]).join(' ')}` });
  body += line({ type: 'last-prompt', sessionId: S, lastPrompt: `last ${examples[0][0]}` });
  await fsp.writeFile(file, body);

  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  await ix.build(S);
  const out = JSON.stringify({ entries: allEntries(ev), meta: ev.meta });
  assert.ok(allEntries(ev).length >= examples.length * 9, 'every line produced an entry');
  for (const [, leak] of examples) assert.ok(!out.includes(leak), `leaked: ${leak.slice(0, 6)}…`);
  for (const e of allEntries(ev)) assert.ok(e.text.length <= 200);
});

// ─── Index, build, fast path ─────────────────────────────────────────────────

test('start indexes head + tail into meta; build emits entries with a cursor at EOF', async (t) => {
  const { root, file } = await withFixture(t);
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();

  assert.equal(ev.meta.length, 1);
  const m = ev.meta[0];
  assert.equal(m.id, S);
  assert.equal(m.transcript, file);
  assert.equal(m.title, 'Alpha session');
  assert.equal(m.titleSrc, 'custom-title');
  assert.equal(m.cwd, '/work/alpha-moved');
  assert.equal(m.project, 'alpha-moved');
  assert.equal(m.gitBranch, 'feature-x');
  assert.equal(m.model, 'claude-opus-5-5');
  assert.equal(m.forkedFrom, P);
  assert.equal(m.firstAt, Date.parse('2026-11-14T01:00:00.000Z'));
  assert.equal(m.lastAt, Date.parse('2026-11-14T01:00:25.000Z'));
  assert.equal(m.lastPrompt, 'Fix the build please');
  assert.equal(m.prompts, null, 'unknown until built');
  assert.equal(m.scan.parserVersion, PARSER_VERSION);
  assert.equal(m.scan.size, (await fsp.stat(file)).size);
  assert.match(m.scan.headHash, /^[0-9a-f]{40}$/);
  assert.equal(ev.entries.length, 0, 'index scan never builds');

  await ix.build(S);
  assert.deepEqual(allEntries(ev).map((e) => [e.id, e.kind, e.text]), EXPECTED);
  assert.equal(lastCursor(ev).off, m.scan.size);
  assert.equal(ev.meta.at(-1).prompts, 2);
  const st = ix.stats();
  assert.equal(st.files, 1);
  assert.equal(st.built, 1);
  assert.equal(st.badLines, 1);
  assert.deepEqual(st.unknownTypes, { 'mystery-type': 1 });
  assert.equal(st.versionMax, '2.1.300');
});

test('restart: matching scan skips the file; a stale parserVersion resets then rebuilds', async (t) => {
  const { root } = await withFixture(t);
  const first = createIndexer({ root, ...FAST });
  const ev1 = record(first);
  await first.start();
  await first.build(S);
  await first.stop();
  const scan = ev1.meta.at(-1).scan;
  const cursor = JSON.parse(JSON.stringify(lastCursor(ev1)));

  const again = createIndexer({ root, ...FAST });
  const ev2 = record(again);
  await again.start({ cursorOf: () => cursor, scanOf: () => scan });
  await sleep(150);
  await again.stop();
  assert.deepEqual(ev2.order, [], 'fast path: nothing to emit');

  const upgraded = createIndexer({ root, ...FAST });
  const ev3 = record(upgraded);
  let storeDone = false;
  upgraded.on('reset', () => sleep(50).then(() => { storeDone = true; }));
  upgraded.on('entries', () => assert.ok(storeDone, 'entries waited for the reset rewrite'));
  await upgraded.start({ cursorOf: () => cursor, scanOf: () => ({ ...scan, parserVersion: PARSER_VERSION - 1 }) });
  await upgraded.build(S);
  await upgraded.stop();
  assert.deepEqual(ev3.reset, [S]);
  assert.ok(ev3.order.indexOf('reset') < ev3.order.indexOf('entries'));
  assert.deepEqual(allEntries(ev3).map((e) => e.id), EXPECTED.map((e) => e[0]), 'same ids on rebuild');
});

test('restart: a cursor behind EOF catches up from the cursor only', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${S}.jsonl`);
  await fsp.writeFile(file, prompt('p-1', 'first'));
  const first = createIndexer({ root, ...FAST });
  const ev1 = record(first);
  await first.start();
  await first.build(S);
  await first.stop();
  const cursor = lastCursor(ev1);
  const scan = ev1.meta.at(-1).scan;
  await fsp.appendFile(file, prompt('p-2', 'second'));

  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start({ cursorOf: () => cursor, scanOf: () => scan });
  await waitFor(() => ev.entries.length > 0);
  assert.deepEqual(allEntries(ev).map((e) => e.id), ['t:p-2']);
  assert.equal(ev.reset.length, 0);
  await waitFor(() => ev.meta.at(-1)?.prompts === 2);
});

test('chunked build of a multi-MB file is ordered, deterministic and yields to the event loop', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${S}.jsonl`);
  const parts = [];
  for (let i = 0; i < 3000; i++) {
    parts.push(toolUse(`toolu_${i}`, 'Read', { file_path: `/src/f${i}.js`, pad: 'p'.repeat(600) }, i % 60));
    parts.push(filler(i % 60));
  }
  await fsp.writeFile(file, parts.join(''));
  const size = (await fsp.stat(file)).size;
  assert.ok(size > 2.5 * 1024 * 1024);

  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  await ix.build(S);
  h.disable();
  assert.ok(ev.entries.length >= 3, 'one batch per 1 MB chunk');
  const offs = ev.entries.map((b) => b.cursor.off);
  assert.deepEqual(offs, [...offs].sort((a, b) => a - b));
  assert.equal(offs.at(-1), size);
  const ids = allEntries(ev).map((e) => e.id);
  assert.equal(ids.length, 3000);
  assert.equal(new Set(ids).size, 3000);
  assert.deepEqual(ids.slice(0, 3), ['t:toolu_0', 't:toolu_1', 't:toolu_2']);
  assert.ok(h.max / 1e6 < 250, `event loop blocked ${Math.round(h.max / 1e6)} ms`);

  const twice = createIndexer({ root, ...FAST });
  const ev2 = record(twice);
  await twice.start();
  await twice.build(S);
  await twice.stop();
  assert.deepEqual(allEntries(ev2).map((e) => e.id), ids, 'deterministic ids');
});

test('a chunk with no entries still advances the cursor', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${S}.jsonl`);
  await fsp.writeFile(file, filler(1) + filler(2));
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  await ix.build(S);
  assert.equal(ev.entries.length, 1);
  assert.deepEqual(ev.entries[0].entries, []);
  assert.equal(ev.entries[0].cursor.off, (await fsp.stat(file)).size);
  assert.equal(ev.meta.at(-1).prompts, 0);
});

// ─── Live tailing ────────────────────────────────────────────────────────────

test('tail: a partial line waits, a split multi-byte character survives', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${S}.jsonl`);
  await fsp.writeFile(file, prompt('p-1', 'hello'));
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  await ix.build(S);
  const before = lastCursor(ev).off;

  const thai = 'แก้บั๊กให้หน่อยค่ะ 🐛';
  const buf = Buffer.from(prompt('p-2', thai));
  const cut = buf.indexOf(Buffer.from('บั๊ก')) + 1; // inside a 3-byte UTF-8 character
  await fsp.appendFile(file, buf.subarray(0, cut));
  await sleep(500); // watcher + safety poll had their chance
  assert.equal(allEntries(ev).length, 1, 'no entry for an unfinished line');
  assert.equal(lastCursor(ev).off, before);
  assert.equal(ix.stats().badLines, 0);

  await fsp.appendFile(file, buf.subarray(cut));
  await waitFor(() => allEntries(ev).some((e) => e.id === 't:p-2'));
  const e = allEntries(ev).find((x) => x.id === 't:p-2');
  assert.equal(e.text, `Prompt: ${thai}`);
  assert.equal(lastCursor(ev).off, (await fsp.stat(file)).size);
  assert.equal(lastCursor(ev).ctx.prompts, 2);
});

test('tail: a truncated file resets, and the store finishes before new entries arrive', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${S}.jsonl`);
  await fsp.writeFile(file, prompt('p-1', 'one') + prompt('p-2', 'two') + prompt('p-3', 'three'));
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  await ix.build(S);
  let rewritten = false;
  ix.on('reset', () => sleep(80).then(() => { rewritten = true; }));
  let early = false;
  ix.on('entries', () => { if (ev.reset.length && !rewritten) early = true; });

  await fsp.writeFile(file, prompt('p-9', 'fresh'));
  await waitFor(() => allEntries(ev).some((e) => e.id === 't:p-9'));
  assert.deepEqual(ev.reset, [S]);
  assert.equal(early, false);
  assert.equal(lastCursor(ev).off, (await fsp.stat(file)).size);
  assert.equal(lastCursor(ev).ctx.prompts, 1, 'counting starts over');
});

test('tail: a replaced file that grew (new head) also resets', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${S}.jsonl`);
  await fsp.writeFile(file, prompt('p-1', 'one'));
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  await ix.build(S);
  await fsp.writeFile(file, prompt('q-1', 'other head, much longer than before') + prompt('q-2', 'two'));
  await waitFor(() => allEntries(ev).some((e) => e.id === 't:q-2'));
  assert.deepEqual(ev.reset, [S]);
  assert.deepEqual(allEntries(ev).map((e) => e.id), ['t:p-1', 't:q-1', 't:q-2']);
});

test('a deleted transcript is reported gone', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'proj', `${S}.jsonl`);
  await fsp.writeFile(file, prompt('p-1', 'one'));
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  await ix.build(S);
  await fsp.unlink(file);
  await waitFor(() => ev.gone.length === 1);
  assert.deepEqual(ev.gone, [S]);
  assert.equal(ix.stats().files, 0);
});

test('a new session file seen by the watcher is indexed and built', async (t) => {
  const root = await tmpRoot(t);
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  const id = 'cccccccc-0000-4000-8000-000000000003';
  await fsp.writeFile(path.join(root, 'proj', `${id}.jsonl`), line({ type: 'user', sessionId: id, uuid: 'n-1', timestamp: ts(1), cwd: '/w', message: { role: 'user', content: 'new one' } }));
  await waitFor(() => ev.entries.some((b) => b.id === id));
  assert.equal(ev.meta.at(-1).id, id);
  assert.equal(ev.meta.at(-1).title, 'new one');
  assert.equal(ev.meta.at(-1).titleSrc, 'first-prompt');
});

test('subagent activity bumps the parent lastAt without parsing', async (t) => {
  const root = await tmpRoot(t);
  await fsp.writeFile(path.join(root, 'proj', `${S}.jsonl`), line({ type: 'user', sessionId: S, uuid: 'p-1', timestamp: '2020-01-01T00:00:00.000Z', message: { role: 'user', content: 'one' } }));
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  const lastAt = ev.meta[0].lastAt;
  assert.equal(lastAt, Date.parse('2020-01-01T00:00:00.000Z'));
  const sub = path.join(root, 'proj', S, 'subagents');
  await fsp.mkdir(sub, { recursive: true });
  await sleep(50);
  await fsp.writeFile(path.join(sub, 'agent-1.jsonl'), line({ type: 'user', isSidechain: true, sessionId: S }));
  await waitFor(() => ev.meta.length > 1, 3000);
  assert.ok(ev.meta.at(-1).lastAt > lastAt);
  assert.equal(ev.entries.length, 0);
});

test('track(): ignores paths outside root, picks up a file created after SessionStart', async (t) => {
  const root = await tmpRoot(t);
  const outside = path.join(path.dirname(root), `${S}.jsonl`);
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  ix.track(S, outside);
  ix.track(S, path.join(root, 'proj', 'not-the-id.jsonl'));
  await sleep(100);
  assert.equal(ix.stats().files, 0);

  const file = path.join(root, 'proj', `${S}.jsonl`);
  ix.track(S, file);
  await sleep(100);
  assert.equal(ev.gone.length, 0, 'not created yet is not gone');
  await fsp.writeFile(file, prompt('p-1', 'started'));
  await waitFor(() => allEntries(ev).some((e) => e.id === 't:p-1'));
});

// ─── Health ──────────────────────────────────────────────────────────────────

test('health: untested versions and an apparent format change are reported', async (t) => {
  const root = await tmpRoot(t);
  const ids = ['dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000003'];
  const big = Array.from({ length: 600 }, (_, i) => filler(i % 60)).join('');
  for (const id of ids) await fsp.writeFile(path.join(root, 'proj', `${id}.jsonl`), big);
  await fsp.writeFile(path.join(root, 'proj', `${S}.jsonl`), line({ type: 'user', sessionId: S, uuid: 'v-1', version: '9.0.0', timestamp: ts(1), message: { role: 'user', content: 'hi' } }));
  const ix = createIndexer({ root, ...FAST });
  const ev = record(ix);
  t.after(() => ix.stop());
  await ix.start();
  assert.deepEqual(ev.health.at(-1), { healthy: true, reason: 'untested-version' });
  for (const id of ids) await ix.build(id);
  assert.deepEqual(ev.health.at(-1), { healthy: false, reason: 'format-changed' });
});

test('listener errors never escape the indexer', async (t) => {
  const { root } = await withFixture(t);
  const ix = createIndexer({ root, ...FAST });
  ix.on('meta', () => { throw new Error('store bug'); });
  ix.on('entries', () => Promise.reject(new Error('disk full')));
  t.after(() => ix.stop());
  await ix.start();
  await ix.build(S);
  assert.equal(ix.stats().built, 0, 'a failed write does not advance the cursor');
  assert.ok(fs.existsSync(root));
});
