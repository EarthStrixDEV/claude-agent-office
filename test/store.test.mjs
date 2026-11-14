// Store, presence and desk rules (docs/design/session-trail-store-api.md). Run: node --test test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  Store, acquireLock, assignDesks, computePresence, decodeBefore, readJsonFile, writeAtomic, CHUNK,
} from '../bridge/store.mjs';

const quiet = { warn() {} };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-store-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
function tmpDir() { return fs.mkdtempSync(path.join(TMP, 'case-')); }
function mkStore(dir, liveOf) { return new Store({ dir, log: quiet, liveOf }); }
const entry = (id, kind = 'tool', src = 'transcript', t = 1000, text = `${kind} ${id}`) => ({ id, t, kind, src, text });
const trailFile = (dir, id) => path.join(dir, 'trails', `${id}.jsonl`);

// Stand-in for bridge/transcripts.mjs: awaits listener Promises like the real one must (§7 rule 6).
class FakeIndexer extends EventEmitter {
  constructor() { super(); this.built = []; this.tracked = []; }
  start(opts) { this.opts = opts; }
  async fire(name, ...args) { await Promise.all(this.listeners(name).map((f) => f(...args))); }
  async build(id) { this.built.push(id); await this.fire('entries', id, [entry('t:b1', 'prompt')], { off: 10 }); }
  track(id, p) { this.tracked.push([id, p]); }
}

test('append writes entries and the cursor together; a new process finds the cursor', async () => {
  const dir = tmpDir();
  const a = mkStore(dir);
  await a.append('s1', [entry('t:1', 'prompt'), entry('t:2')], { off: 42, ctx: { model: 'x' } });
  const text = fs.readFileSync(trailFile(dir, 's1'), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 3);
  assert.match(text, /\{"cursor":\{"off":42,"ctx":\{"model":"x"\}\}\}\n$/);
  assert.deepEqual(a.get('s1').counts, { prompts: 1, tools: 1, errors: 0 });

  const b = mkStore(dir);
  assert.deepEqual(b.cursorOf('s1'), { off: 42, ctx: { model: 'x' } });
  assert.equal(b.cursorOf('missing'), null);
  const page = b.readPage('s1');
  assert.deepEqual(page.entries.map((e) => e.id), ['t:1', 't:2']);
  assert.equal(page.before, null);
});

test('duplicate ids from the indexer are dropped (recent-id set)', async () => {
  const s = mkStore(tmpDir());
  await s.append('s1', [entry('t:1')], { off: 1 });
  const fresh = await s.append('s1', [entry('t:1'), entry('t:2')], { off: 2 });
  assert.deepEqual(fresh.map((e) => e.id), ['t:2']);
  assert.deepEqual(s.readPage('s1').entries.map((e) => e.id), ['t:1', 't:2']);
});

test('torn last line is cut back to the last newline on first open', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'trails'), { recursive: true });
  const good = `${JSON.stringify(entry('t:1'))}\n${JSON.stringify({ cursor: { off: 7 } })}\n`;
  fs.writeFileSync(trailFile(dir, 's1'), `${good}{"id":"t:2","t":1,"ki`);
  const s = mkStore(dir);
  assert.deepEqual(s.cursorOf('s1'), { off: 7 });
  assert.equal(fs.readFileSync(trailFile(dir, 's1'), 'utf8'), good);
  await s.append('s1', [entry('t:3')]);
  assert.deepEqual(s.readPage('s1').entries.map((e) => e.id), ['t:1', 't:3']);
});

test('cursor search walks back past more than one 64 KB chunk of hook entries (D12)', async () => {
  const dir = tmpDir();
  const a = mkStore(dir);
  await a.append('s1', [entry('t:1')], { off: 99 });
  const hooks = [];
  for (let i = 0; hooks.length * 120 < CHUNK * 3; i++) hooks.push(entry(`h:${i}`, 'notify', 'hook', 2000 + i, 'x'.repeat(80)));
  await a.append('s1', hooks);
  assert.ok(fs.statSync(trailFile(dir, 's1')).size > CHUNK * 3);
  assert.deepEqual(mkStore(dir).cursorOf('s1'), { off: 99 });
});

test('trail pages walk backwards across chunks without gaps or overlaps; kinds filter', async () => {
  const dir = tmpDir();
  const s = mkStore(dir);
  const all = [];
  for (let i = 0; i < 1500; i++) all.push(entry(`t:${i}`, i % 3 ? 'tool' : 'prompt', 'transcript', i, `ข้อความ ${i} ${'y'.repeat(i % 50)}`));
  for (let i = 0; i < all.length; i += 100) await s.append('s1', all.slice(i, i + 100), { off: i });
  const seen = [];
  let before = null;
  do {
    const page = s.readPage('s1', { before: before == null ? null : decodeBefore(before), limit: 400 });
    assert.ok(page.entries.length <= 400);
    seen.unshift(...page.entries.map((e) => e.id));
    before = page.before;
  } while (before);
  assert.deepEqual(seen, all.map((e) => e.id));

  const prompts = s.readPage('s1', { limit: 500, kinds: new Set(['prompt']) });
  assert.equal(prompts.entries.length, 500);
  assert.ok(prompts.entries.every((e) => e.kind === 'prompt'));
  assert.equal(prompts.entries.at(-1).id, 't:1497');
  assert.equal(decodeBefore('not-a-cursor'), null);
});

test('reset keeps hook/bridge/legacy entries, drops transcript entries and cursors (D11)', async () => {
  const dir = tmpDir();
  const s = mkStore(dir);
  const resets = [];
  s.on('trail-reset', (id) => resets.push(id));
  await s.append('s1', [entry('l:0', 'session', 'legacy'), entry('t:1', 'prompt'), entry('t:2:err', 'error')], { off: 5 });
  await s.append('s1', [entry('h:a', 'error', 'hook', 3000, 'API error: overloaded'), entry('b:a', 'permission', 'bridge')]);
  // An append queued before the reset must land before the rewrite reads the file.
  const pending = s.append('s1', [entry('t:3')], { off: 6 });
  await s.reset('s1');
  await pending;
  assert.deepEqual(s.readPage('s1').entries.map((e) => e.id), ['l:0', 'h:a', 'b:a']);
  assert.equal(s.cursorOf('s1'), null);
  assert.equal(mkStore(dir).cursorOf('s1'), null);
  assert.deepEqual(s.get('s1').counts, { prompts: 0, tools: 0, errors: 1 });
  assert.deepEqual(resets, ['s1']);
  // Ids seen before the reset may come back in the rebuild.
  assert.equal((await s.append('s1', [entry('t:1', 'prompt')], { off: 1 })).length, 1);
});

test('writeAtomic retries EPERM, then leaves the .tmp; loading falls back to the .tmp', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'index.json');
  let calls = 0;
  const flaky = async (a, b) => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return fs.promises.rename(a, b); };
  assert.equal(await writeAtomic(file, '{"v":1}', flaky), true);
  assert.equal(calls, 3);
  assert.deepEqual(readJsonFile(file), { v: 1 });

  const locked = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  assert.equal(await writeAtomic(file, '{"v":2}', locked), false);
  assert.ok(fs.existsSync(`${file}.tmp`));
  fs.writeFileSync(file, '{"v":1, broken');
  assert.deepEqual(readJsonFile(file), { v: 2 });
});

test('index round-trips; transcript path and scan never reach the API', async () => {
  const dir = tmpDir();
  const a = mkStore(dir);
  a.noteLive('s1', { cwd: 'C:\\work\\office', model: 'm', transcript: 'C:\\Users\\me\\s1.jsonl', at: 500 });
  a.patch('s1', { scan: { size: 1 } });
  await a.flush();
  const b = mkStore(dir);
  b.load();
  assert.equal(b.get('s1').project, 'office');
  assert.equal(b.get('s1').transcript, 'C:\\Users\\me\\s1.jsonl');
  const pub = b.publicRecord(b.get('s1'));
  assert.equal(pub.presence, 'history');
  assert.ok(!('transcript' in pub) && !('scan' in pub));
});

test('list: keyset paging, empty filter, unknown prompt count, NFC search, presence filter', async () => {
  const s = mkStore(tmpDir(), (id) => (id === 'live1' ? { presence: 'live', status: 'working' } : undefined));
  for (let i = 0; i < 7; i++) {
    s.noteLive(`s${i}`, { cwd: `/p/proj${i}`, at: 1000 + (i % 3) * 10 });
    await s.append(`s${i}`, [entry(`h:${i}`, 'prompt', 'hook')]);
  }
  s.noteLive('empty', { cwd: '/p/empty', at: 5000 });
  s.applyMeta({ id: 'unknown', cwd: '/p/unk', lastAt: 4000, prompts: null });
  s.applyMeta({ id: 'zero', cwd: '/p/zero', lastAt: 4500, prompts: 0 });
  s.noteLive('live1', { cwd: '/p/งานไทย', at: 3000 });
  await s.append('live1', [entry('h:l', 'prompt', 'hook')]);

  const ids = [];
  let cursor = null;
  do {
    const page = s.list({ cursor, limit: 3 });
    assert.equal(page.total, 9);
    ids.push(...page.items.map((r) => r.id));
    cursor = page.next;
  } while (cursor);
  assert.deepEqual(ids, ['unknown', 'live1', 's2', 's5', 's1', 's4', 's0', 's3', 's6']);
  assert.equal(new Set(ids).size, ids.length);

  assert.equal(s.list({ includeEmpty: true }).total, 11);
  assert.deepEqual(s.list({ q: 'งานไทย' }).items.map((r) => r.id), ['live1']);
  // A decomposed accent (NFD) matches the composed form, case-insensitively.
  s.noteLive('cafe', { cwd: '/p/Café', at: 10 });
  await s.append('cafe', [entry('h:c', 'prompt', 'hook', 10)]);
  assert.deepEqual(s.list({ q: 'CAFÉ' }).items.map((r) => r.id), ['cafe']);
  assert.deepEqual(s.list({ q: 'PROJ5' }).items.map((r) => r.id), ['s5']);
  const live = s.list({ presence: ['live'] });
  assert.deepEqual(live.items.map((r) => [r.id, r.presence, r.status]), [['live1', 'live', 'working']]);
  assert.throws(() => s.list({ cursor: 'garbage' }), /bad cursor/);
});

test('fake indexer: meta, entries, degraded health, lazy build, gone', async () => {
  const dir = tmpDir();
  const live = new Map();
  const s = mkStore(dir, (id) => live.get(id));
  const ix = new FakeIndexer();
  const activity = [];
  s.on('activity', (id, at) => activity.push([id, at]));
  assert.equal(s.degraded, true);
  s.attachIndexer(ix);
  assert.equal(s.degraded, false);

  await s.append('a', [entry('t:0')], { off: 3 });
  assert.deepEqual(ix.opts.cursorOf('a'), { off: 3 });
  s.patch('a', { scan: { size: 9 } });
  assert.deepEqual(ix.opts.scanOf('a'), { size: 9 });

  await ix.fire('meta', { id: 'a', title: 'Title A', titleSrc: 'ai-title', cwd: 'E:\\code\\proj-a', lastAt: 2000, firstAt: 100, prompts: 4, transcript: 'E:\\x.jsonl' });
  assert.equal(s.get('a').title, 'Title A');
  assert.equal(s.get('a').project, 'proj-a');
  assert.deepEqual(activity, [['a', 2000]]);

  await ix.fire('entries', 'a', [entry('t:1', 'prompt', 'transcript', 2500), entry('h:bad', 'notify')], { off: 50 });
  assert.equal(s.get('a').trailBuilt, true);
  assert.deepEqual(s.readPage('a').entries.map((e) => e.id), ['t:0', 't:1']);
  assert.deepEqual(s.cursorOf('a'), { off: 50 });

  await ix.fire('health', { healthy: false, reason: 'format-changed' });
  assert.equal(s.degraded, true);
  await ix.fire('entries', 'a', [entry('t:9', 'prompt')], { off: 99 });
  assert.deepEqual(s.cursorOf('a'), { off: 50 });
  await ix.fire('health', { healthy: true });

  await ix.fire('meta', { id: 'old', lastAt: 10, prompts: null });
  assert.equal(await s.buildFor('old', 1000), true);
  assert.deepEqual(ix.built, ['old']);
  assert.equal(s.get('old').trailBuilt, true);

  // Slow build: caller is told 'building', trail-ready follows.
  const ready = new Promise((r) => s.once('trail-ready', r));
  ix.build = (id) => new Promise((r) => setTimeout(r, 80));
  await ix.fire('meta', { id: 'slow', lastAt: 10 });
  assert.equal(await s.buildFor('slow', 10), false);
  assert.equal(await ready, 'slow');

  // gone: removed at once when out of the office, deferred while still in it.
  live.set('a', { presence: 'live' });
  await ix.fire('gone', 'a');
  assert.ok(s.get('a'));
  live.delete('a');
  await s.retired('a');
  assert.equal(s.get('a'), undefined);
  assert.equal(fs.existsSync(trailFile(dir, 'a')), false);
  await ix.fire('gone', 'old');
  assert.equal(s.get('old'), undefined);
});

test('v1 state migration writes legacy trails for hook/bridge kinds only, once', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'state.json');
  const v1 = {
    sessions: [{
      id: 'm1', cwd: '/w/app', project: 'app', model: 'opus', startedAt: 100, lastAt: 900, status: 'idle',
      trail: [
        { t: 101, kind: 'session', text: 'Session startup' },
        { t: 102, kind: 'prompt', text: 'Prompt: hi' },
        { t: 103, kind: 'error', text: 'Bash failed' },
        { t: 104, kind: 'error', text: 'API error: overloaded' },
        { t: 105, kind: 'permission', text: 'Allowed: Bash' },
        { t: 106, kind: 'skill', text: 'Using skill x' },
      ],
    }],
    feed: [],
  };
  fs.writeFileSync(stateFile, JSON.stringify(v1));
  const s = mkStore(dir);
  await s.migrateV1(stateFile, v1);
  assert.ok(fs.existsSync(path.join(dir, 'state.v1.json.bak')));
  const page = s.readPage('m1');
  assert.deepEqual(page.entries.map((e) => [e.id, e.kind, e.src]), [['l:0', 'session', 'legacy'], ['l:3', 'error', 'legacy'], ['l:4', 'permission', 'legacy']]);
  assert.deepEqual(readJsonFile(path.join(dir, 'index.json')).sessions.m1.counts, { prompts: 0, tools: 0, errors: 1 });

  await mkStore(dir).migrateV1(stateFile, v1);
  assert.equal(mkStore(dir).readPage('m1').entries.length, 3);
});

test('bridge.lock: held by a live pid refuses, a dead pid is taken over', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bridge.lock');
  fs.writeFileSync(file, String(process.ppid));
  assert.throws(() => acquireLock(dir), (e) => e.code === 'ELOCKED' && e.pid === process.ppid);
  fs.writeFileSync(file, '2147483646');
  const lock = acquireLock(dir);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  lock.release();
  assert.equal(fs.existsSync(file), false);
});

test('unsafe session ids never become file names', async () => {
  const dir = tmpDir();
  const s = mkStore(dir);
  await s.append('../../evil', [entry('h:1', 'notify', 'hook')]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'trails')), []);
  assert.deepEqual(s.readPage('../../evil').entries, []);
});

// ------------------------------------------------------------- presence ----
const T = { LIVE_HOOK_MS: 600_000, LIVE_TRANSCRIPT_MS: 120_000, IDLE_WINDOW_MS: 3_600_000, ENDED_DESK_MS: 900_000 };
const MIN = 60_000;

test('presence transitions (§4.2)', () => {
  const t = 100 * 60 * MIN;
  const at = (ago) => t - ago * MIN;
  const p = (s, pinned = false) => computePresence(s, t, pinned, T);
  assert.equal(p({ status: 'working', hookAt: at(1), lastAt: at(1) }), 'live');
  assert.equal(p({ status: 'idle', hookAt: at(11), lastAt: at(11) }), 'idle');
  assert.equal(p({ status: 'waiting', hookAt: at(300), lastAt: at(300) }, true), 'live');
  assert.equal(p({ status: 'idle', hookAt: at(61), lastAt: at(61) }), 'history');
  // Transcript growth without hooks.
  assert.equal(p({ status: 'idle', hookAt: 0, transcriptAt: at(1), lastAt: at(1) }), 'live');
  assert.equal(p({ status: 'idle', hookAt: 0, transcriptAt: at(3), lastAt: at(3) }), 'idle');
  // Restored after a restart: idle until it moves.
  assert.equal(p({ status: 'stale', hookAt: 0, transcriptAt: 0, lastAt: at(2) }), 'idle');
  // Ended: keeps the desk 15 minutes, even if pinned.
  assert.equal(p({ status: 'ended', endedAt: at(14), lastAt: at(14) }, true), 'ended');
  assert.equal(p({ status: 'ended', endedAt: at(16), lastAt: at(16) }), 'history');
});

test('desks: seated sessions stay, live newcomer evicts the longest-quiet idle, overflow gets none', () => {
  const cap = 3;
  let holders = assignDesks(new Set(), [
    { id: 'i1', presence: 'idle', lastAt: 10 },
    { id: 'i2', presence: 'idle', lastAt: 5 },
    { id: 'e1', presence: 'ended', lastAt: 1 },
    { id: 'h1', presence: 'history', lastAt: 99 },
  ], cap);
  assert.deepEqual([...holders].sort(), ['e1', 'i1', 'i2']);

  const list = [
    { id: 'i1', presence: 'idle', lastAt: 10 },
    { id: 'i2', presence: 'idle', lastAt: 5 },
    { id: 'e1', presence: 'ended', lastAt: 1 },
    { id: 'L1', presence: 'live', lastAt: 50 },
    { id: 'e2', presence: 'ended', lastAt: 60 },
  ];
  holders = assignDesks(holders, list, cap);
  assert.deepEqual([...holders].sort(), ['L1', 'e1', 'i1']); // i2 was quietest; ended newcomer cannot evict

  holders = assignDesks(holders, [
    { id: 'L1', presence: 'live', lastAt: 50 },
    { id: 'e1', presence: 'ended', lastAt: 1 },
    { id: 'i1', presence: 'idle', lastAt: 10, urgent: true },
    { id: 'L2', presence: 'live', lastAt: 70 },
  ], cap);
  assert.deepEqual([...holders].sort(), ['L1', 'e1', 'i1']); // no non-urgent idle to evict → L2 has no desk
});
