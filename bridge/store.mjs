// Session Trail store (docs/design/session-trail-store-api.md).
//   index.json          catalog of every session, written atomically (§2.2)
//   trails/<id>.jsonl   append-only timeline; the indexer's cursor lives in the same file (§2.3, §2.4)
//   bridge.lock         one bridge per data dir (§2.4)
// Also holds the pure presence / desk rules (§4) so they can be tested without booting the bridge.
// Node built-ins only.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const CHUNK = 64 * 1024;
const RECENT_IDS = 512;
const RENAME_RETRY_MS = [50, 150, 400];
const INDEX_SAVE_MS = 2000;
// Session ids become file names: anything else gets a catalog record but no trail file.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const PRESENCES = ['live', 'idle', 'ended', 'history'];
const TRANSCRIPT_KINDS = new Set(['prompt', 'tool', 'skill', 'subagent', 'error']);
const KEEP_ON_RESET = new Set(['hook', 'bridge', 'legacy']);
// v1 trail kinds the hooks/bridge still own; transcript-side kinds are rebuilt by the indexer (§6.2).
const LEGACY_KINDS = new Set(['session', 'env', 'mode', 'notify', 'permission', 'dispatch', 'git', 'other']);
const keepLegacy = (e) => LEGACY_KINDS.has(e.kind) || (e.kind === 'error' && /^API error/.test(e.text || ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || null;
const norm = (v) => String(v ?? '').normalize('NFC').toLocaleLowerCase();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch { return ''; } };

// ------------------------------------------------------------ atomic files --
// tmp + rename. On Windows rename fails with EPERM/EBUSY while antivirus, Search or OneDrive holds
// the target: retry 3 times, then leave the .tmp in place and report false so the caller stays dirty.
export async function writeAtomic(file, text, rename = fsp.rename) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, text, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { await rename(tmp, file); return true; } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      if (i >= RENAME_RETRY_MS.length) return false;
      await sleep(RENAME_RETRY_MS[i]);
    }
  }
}

// The main file, or its .tmp when the main one is missing or unreadable (a rename that never landed).
export function readJsonFile(file) {
  for (const f of [file, `${file}.tmp`]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* try the next */ }
  }
  return null;
}

// ------------------------------------------------------------------- lock ---
export function acquireLock(dir) {
  const file = path.join(dir, 'bridge.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        file,
        release() {
          try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* already gone */ }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = Number(fs.readFileSync(file, 'utf8').trim()); } catch { continue; }
      if (pid && pid !== process.pid && pidAlive(pid)) {
        throw Object.assign(new Error(`bridge.lock is held by pid ${pid}`), { code: 'ELOCKED', pid, file });
      }
      try { fs.unlinkSync(file); } catch { /* raced with another starter; retry */ }
    }
  }
  throw new Error(`could not take ${file}`);
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ------------------------------------------------------- trail file reading -
// Byte offset just after the last '\n' at or before `end` (0 if none).
function lineBoundary(fd, end) {
  let pos = end;
  const buf = Buffer.alloc(CHUNK);
  while (pos > 0) {
    const len = Math.min(CHUNK, pos);
    pos -= len;
    fs.readSync(fd, buf, 0, len, pos);
    const i = buf.subarray(0, len).lastIndexOf(0x0a);
    if (i >= 0) return pos + i + 1;
  }
  return 0;
}

// Complete lines that end at or before `end` (a line boundary), newest first, as [text, startOffset].
// Reads 64 KB chunks backwards and stitches lines that straddle a chunk edge.
function* linesBackward(fd, end) {
  let pos = end;
  let tail = Buffer.alloc(0);
  while (pos > 0) {
    const len = Math.min(CHUNK, pos);
    pos -= len;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    const data = tail.length ? Buffer.concat([buf, tail]) : buf; // covers [pos, pos + data.length)
    let lineEnd = data.length;
    for (;;) {
      const nl = lineEnd >= 2 ? data.lastIndexOf(0x0a, lineEnd - 2) : -1;
      if (nl < 0) {
        if (pos === 0) { if (lineEnd > 1) yield [data.toString('utf8', 0, lineEnd - 1), 0]; tail = Buffer.alloc(0); }
        else tail = data.subarray(0, lineEnd);
        break;
      }
      if (lineEnd - nl > 2) yield [data.toString('utf8', nl + 1, lineEnd - 1), pos + nl + 1];
      lineEnd = nl + 1;
    }
  }
}

export const encodeBefore = (off) => b64(`off:${off}`);
export function decodeBefore(v) {
  const m = /^off:(\d{1,15})$/.exec(unb64(v));
  return m ? Number(m[1]) : null;
}
const encodeListCursor = (r) => b64(JSON.stringify({ lastAt: r.lastAt || 0, id: r.id }));
function decodeListCursor(v) {
  try {
    const c = JSON.parse(unb64(v));
    return typeof c?.id === 'string' && Number.isFinite(c.lastAt) ? c : null;
  } catch { return null; }
}
// History order: newest lastAt first, ties by id.
const byRecent = (a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function tally(counts, e) {
  if (e.kind === 'prompt') counts.prompts++;
  else if (e.kind === 'tool') counts.tools++;
  else if (e.kind === 'error') counts.errors++;
}

// ------------------------------------------------------------------ store ---
// Events: 'append' (id, entries) · 'record' (id) record changed or removed · 'trail-reset' (id)
//         'trail-ready' (id) · 'activity' (id, at) transcript moved · 'health' ({healthy, reason})
export class Store extends EventEmitter {
  constructor({ dir, liveOf = () => undefined, log = console }) {
    super();
    this.dir = dir;
    this.trailDir = path.join(dir, 'trails');
    this.indexFile = path.join(dir, 'index.json');
    this.liveOf = liveOf;          // id -> live session object ({ presence, status }) or undefined
    this.log = log;
    this.records = new Map();
    this.queues = new Map();       // id -> tail of that session's write chain
    this.recent = new Map();       // id -> Set of the last RECENT_IDS entry ids
    this.cursors = new Map();      // id -> newest cursor (cache of the trail file)
    this.opened = new Set();       // trail files checked for a torn last line this run
    this.builds = new Map();       // id -> { promise, late }
    this.indexer = null;
    this.healthy = true;
    this.healthReason = null;
    this.indexDirty = false;
    this.indexTimer = null;
    this.indexSaving = Promise.resolve();
    fs.mkdirSync(this.trailDir, { recursive: true, mode: 0o700 });
  }

  // Hooks write the transcript-side kinds themselves when there is no healthy indexer (§3.2 rule 4).
  get degraded() { return !this.indexer || !this.healthy; }

  // ------------------------------------------------------------- index ----
  load() {
    const saved = readJsonFile(this.indexFile);
    for (const rec of Object.values(saved?.sessions || {})) {
      if (rec?.id) this.records.set(rec.id, { ...newRecord(rec.id), ...rec });
    }
  }

  get(id) { return this.records.get(id); }

  ensure(id) {
    let rec = this.records.get(id);
    if (!rec) { rec = newRecord(id); this.records.set(id, rec); }
    return rec;
  }

  changed(id) {
    this.indexDirty = true;
    this.scheduleSave();
    this.emit('record', id);
  }

  // index.json is written at most every 2 s.
  scheduleSave() {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => { this.indexTimer = null; this.saveIndex(); }, INDEX_SAVE_MS);
    this.indexTimer.unref?.();
  }

  saveIndex() {
    this.indexSaving = this.indexSaving.then(async () => {
      if (!this.indexDirty) return;
      this.indexDirty = false;
      const data = { v: 1, sessions: Object.fromEntries(this.records) };
      let ok = false;
      try { ok = await writeAtomic(this.indexFile, JSON.stringify(data)); } catch (e) { this.log.warn?.(`  index.json not saved: ${e.message}`); }
      if (!ok) { this.indexDirty = true; this.scheduleSave(); }
    });
    return this.indexSaving;
  }

  async flush() {
    clearTimeout(this.indexTimer);
    this.indexTimer = null;
    await Promise.all([...this.queues.values()]);
    await this.saveIndex();
  }

  // A hook saw this session: fill the fields the indexer has not (yet) provided (§2.2).
  noteLive(id, { cwd, model, transcript, at }) {
    const rec = this.ensure(id);
    if (!rec.cwd && cwd) { rec.cwd = cwd; rec.project = baseName(cwd); }
    if (!rec.model && model) rec.model = model;
    if (!rec.transcript && transcript) rec.transcript = transcript;
    if (!rec.firstAt) rec.firstAt = at;
    if (!(rec.lastAt >= at)) rec.lastAt = at;
    this.changed(id);
  }

  patch(id, fields) {
    const rec = this.ensure(id);
    if (Object.entries(fields).every(([k, v]) => rec[k] === v)) return;
    Object.assign(rec, fields);
    this.changed(id);
  }

  publicRecord(rec) {
    const live = this.liveOf(rec.id);
    const counts = { ...rec.counts };
    if (!rec.trailBuilt && rec.promptsHint > counts.prompts) counts.prompts = rec.promptsHint;
    return {
      id: rec.id, title: rec.title, project: rec.project, cwd: rec.cwd, gitBranch: rec.gitBranch, model: rec.model,
      presence: live?.presence || 'history', status: live?.status ?? null, waiting: !!rec.waiting,
      forkedFrom: rec.forkedFrom, titleSrc: rec.titleSrc, lastPrompt: rec.lastPrompt,
      firstAt: rec.firstAt, lastAt: rec.lastAt, endedAt: rec.endedAt, counts,
    };
  }

  // Empty = never got a prompt (D9). An unbuilt record whose prompt count the indexer has not
  // learned yet (promptsHint null) is shown until the build says otherwise.
  isEmpty(rec) {
    if (Math.max(rec.counts.prompts, rec.promptsHint || 0) > 0) return false;
    return !(rec.promptsHint === null && !rec.trailBuilt);
  }

  // POST /api/sessions/list (§5.2): keyset paging on (lastAt desc, id).
  list({ cursor = null, q = '', limit = 50, presence = null, includeEmpty = false } = {}) {
    limit = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 50));
    const want = new Set(Array.isArray(presence) && presence.length ? presence : PRESENCES);
    const needle = norm(q).trim();
    let after = null;
    if (cursor != null) { after = decodeListCursor(cursor); if (!after) throw new Error('bad cursor'); }
    const rows = [];
    for (const rec of this.records.values()) {
      const item = this.publicRecord(rec);
      if (!want.has(item.presence)) continue;
      if (!includeEmpty && this.isEmpty(rec)) continue;
      if (needle && ![item.title, item.project, item.cwd, item.gitBranch].some((v) => v && norm(v).includes(needle))) continue;
      rows.push(item);
    }
    rows.sort(byRecent);
    const start = after ? rows.findIndex((r) => byRecent(r, after) > 0) : 0;
    const page = start < 0 ? [] : rows.slice(start, start + limit);
    const more = start >= 0 && start + limit < rows.length;
    return { items: page, next: more ? encodeListCursor(page[page.length - 1]) : null, total: rows.length };
  }

  // ------------------------------------------------------------ trails ----
  trailPath(id) { return SAFE_ID.test(id) ? path.join(this.trailDir, `${id}.jsonl`) : null; }

  // First touch this run: cut a torn last line (crash mid-append) back to the last '\n' (§2.4).
  openTrail(id) {
    if (this.opened.has(id)) return;
    this.opened.add(id);
    const p = this.trailPath(id);
    if (!p) return;
    let fd;
    try { fd = fs.openSync(p, 'r+'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (!size) return;
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) fs.ftruncateSync(fd, lineBoundary(fd, size));
    } finally { fs.closeSync(fd); }
  }

  // Newest cursor in the trail file: read backwards 64 KB at a time until one turns up (D12).
  cursorOf(id) {
    if (this.cursors.has(id)) return this.cursors.get(id);
    const p = this.trailPath(id);
    let cursor = null;
    if (p) {
      this.openTrail(id);
      let fd;
      try { fd = fs.openSync(p, 'r'); } catch { fd = null; }
      if (fd != null) {
        try {
          for (const [text] of linesBackward(fd, lineBoundary(fd, fs.fstatSync(fd).size))) {
            if (!text.startsWith('{"cursor":')) continue;
            try { cursor = JSON.parse(text).cursor ?? null; break; } catch { /* keep looking */ }
          }
        } finally { fs.closeSync(fd); }
      }
    }
    this.cursors.set(id, cursor);
    return cursor;
  }

  // One page of entries ending before byte offset `before` (null = end of file), oldest first (§5.2).
  readPage(id, { before = null, limit = 200, kinds = null } = {}) {
    const p = this.trailPath(id);
    if (!p) return { entries: [], before: null };
    this.openTrail(id);
    let fd;
    try { fd = fs.openSync(p, 'r'); } catch { return { entries: [], before: null }; }
    try {
      const size = fs.fstatSync(fd).size;
      if (before != null && before > size) throw new Error('bad before');
      // Without `before`, stop at the last complete line: an append may be in flight.
      const end = before ?? lineBoundary(fd, size);
      const out = [];
      let next = null;
      for (const [text, start] of linesBackward(fd, end)) {
        if (text.startsWith('{"cursor":')) continue;
        let e;
        try { e = JSON.parse(text); } catch { continue; }
        if (typeof e?.id !== 'string' || (kinds && !kinds.has(e.kind))) continue;
        out.push(e);
        if (out.length >= limit) { next = start > 0 ? start : null; break; }
      }
      return { entries: out.reverse(), before: next == null ? null : encodeBefore(next) };
    } finally { fs.closeSync(fd); }
  }

  // Every write to one trail goes through one promise chain (§2.4).
  enqueue(id, fn) {
    const run = (this.queues.get(id) || Promise.resolve()).then(fn);
    this.queues.set(id, run.catch(() => {}));
    return run;
  }

  recentOf(id) {
    let set = this.recent.get(id);
    if (!set) { set = new Set(); this.recent.set(id, set); }
    return set;
  }

  // Entries (+ optional opaque cursor) land in a single appendFile, so they survive or vanish together.
  append(id, entries, cursor) {
    return this.enqueue(id, async () => {
      const seen = this.recentOf(id);
      const fresh = (entries || []).filter((e) => e && typeof e.id === 'string' && !seen.has(e.id));
      const withCursor = cursor != null;
      if (!fresh.length && !withCursor) return [];
      const p = this.trailPath(id);
      if (p) {
        this.openTrail(id);
        let buf = '';
        for (const e of fresh) buf += `${JSON.stringify(e)}\n`;
        if (withCursor) buf += `${JSON.stringify({ cursor })}\n`;
        await fsp.appendFile(p, buf, { mode: 0o600 });
      }
      for (const e of fresh) {
        seen.add(e.id);
        if (seen.size > RECENT_IDS) seen.delete(seen.values().next().value);
      }
      if (withCursor) this.cursors.set(id, cursor);
      if (fresh.length) {
        const rec = this.ensure(id);
        for (const e of fresh) {
          tally(rec.counts, e);
          if (e.t > (rec.lastAt || 0)) rec.lastAt = e.t;
        }
        this.changed(id);
        this.emit('append', id, fresh);
      }
      return fresh;
    });
  }

  // Transcript truncated or replaced (D11): keep hook/bridge/legacy entries, drop transcript entries
  // and every cursor, rewrite atomically inside the same write chain, then announce trail-reset.
  reset(id) {
    return this.enqueue(id, async () => {
      const p = this.trailPath(id);
      const kept = [];
      let text = '';
      if (p) { try { text = await fsp.readFile(p, 'utf8'); } catch { /* no trail yet */ } }
      for (const line of text.split('\n')) {
        if (!line || line.startsWith('{"cursor":')) continue;
        try { const e = JSON.parse(line); if (typeof e?.id === 'string' && KEEP_ON_RESET.has(e.src)) kept.push(e); } catch { /* torn line */ }
      }
      if (text && !(await writeAtomic(p, kept.map((e) => `${JSON.stringify(e)}\n`).join('')))) {
        throw new Error(`trail ${id} is locked by another program; reset not written`);
      }
      this.recent.delete(id);
      this.cursors.set(id, null);
      const rec = this.records.get(id);
      if (rec) {
        rec.counts = { prompts: 0, tools: 0, errors: 0 };
        for (const e of kept) tally(rec.counts, e);
        this.changed(id);
      }
      this.emit('trail-reset', id);
    });
  }

  // Drop the trail and the record (transcript gone, §6.1).
  remove(id) {
    return this.enqueue(id, async () => {
      const p = this.trailPath(id);
      if (p) { try { await fsp.unlink(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      this.recent.delete(id);
      this.cursors.delete(id);
      this.opened.delete(id);
      if (this.records.delete(id)) this.changed(id);
    });
  }

  // Indexer saw the transcript disappear. Sessions still in the office are removed once they leave (§6.1).
  gone(id) {
    const rec = this.records.get(id);
    if (!rec) return Promise.resolve();
    const live = this.liveOf(id);
    if (live && live.presence !== 'history') { rec.gone = true; return Promise.resolve(); }
    return this.remove(id);
  }

  // The bridge moved a session to History.
  retired(id) {
    if (this.records.get(id)?.gone) return this.remove(id);
    if (this.records.has(id)) this.emit('record', id);
    return Promise.resolve();
  }

  // Sessions that never had a transcript keep the old 24 h rule (§6.1).
  expireHookOnly(now, ttl) {
    for (const rec of [...this.records.values()]) {
      if (!rec.transcript && rec.endedAt && now - rec.endedAt > ttl && !this.liveOf(rec.id)) this.remove(rec.id).catch(this.warnFor(rec.id));
    }
  }

  // Startup reconcile (§6.3 step 6): records whose transcript file has disappeared.
  reconcile() {
    for (const rec of [...this.records.values()]) {
      if (rec.transcript && !fs.existsSync(rec.transcript)) this.gone(rec.id).catch(this.warnFor(rec.id));
    }
  }

  warnFor(id) { return (e) => this.log.warn?.(`  trail ${id}: ${e.message}`); }

  // ------------------------------------------------------------ indexer ---
  attachIndexer(ix) {
    this.indexer = ix;
    ix.on('meta', (m) => this.applyMeta(m));
    ix.on('entries', (id, entries, cursor) => this.ingest(id, entries, cursor));
    // Listeners return Promises: the indexer awaits them (reset must land before the rebuild's entries).
    ix.on('reset', (id) => this.reset(id).catch(this.warnFor(id)));
    ix.on('gone', (id) => this.gone(id).catch(this.warnFor(id)));
    ix.on('health', (h) => {
      this.healthy = !!h?.healthy;
      this.healthReason = h?.reason || null;
      this.emit('health', { healthy: this.healthy, reason: this.healthReason });
    });
    ix.start({ cursorOf: (id) => this.cursorOf(id), scanOf: (id) => this.records.get(id)?.scan ?? null });
  }

  applyMeta(m) {
    if (!m?.id) return;
    const rec = this.ensure(m.id);
    const isNew = rec.lastAt == null;
    for (const k of ['transcript', 'title', 'titleSrc', 'gitBranch', 'model', 'forkedFrom', 'lastPrompt', 'scan']) {
      if (m[k] !== undefined) rec[k] = m[k];
    }
    if (m.cwd) { rec.cwd = m.cwd; rec.project = baseName(m.cwd); }
    if (m.firstAt && !(rec.firstAt <= m.firstAt)) rec.firstAt = m.firstAt;
    if ('prompts' in m) rec.promptsHint = Number.isFinite(m.prompts) ? m.prompts : null;
    const moved = m.lastAt > (rec.lastAt || 0);
    if (moved) rec.lastAt = m.lastAt;
    this.changed(m.id);
    if (moved || isNew) this.emit('activity', m.id, m.lastAt || 0);
  }

  // Indexer entries. While degraded the hooks own these kinds, so taking them too would duplicate.
  async ingest(id, entries, cursor) {
    if (!this.healthy) return;
    const prevLast = this.records.get(id)?.lastAt || 0;
    try {
      const fresh = await this.append(id, (entries || []).filter((e) => TRANSCRIPT_KINDS.has(e?.kind)), cursor);
      const rec = this.ensure(id);
      if (!rec.trailBuilt) { rec.trailBuilt = true; this.changed(id); }
      const newest = fresh.reduce((m, e) => Math.max(m, e.t || 0), 0);
      if (newest > prevLast) this.emit('activity', id, newest);
    } catch (e) { this.warnFor(id)(e); }
  }

  // Lazy build for a history trail (§5.2): wait up to waitMs; if it is still running, the caller
  // answers building:true and 'trail-ready' fires when it finishes.
  async buildFor(id, waitMs) {
    if (this.degraded || typeof this.indexer.build !== 'function') return true;
    let b = this.builds.get(id);
    if (!b) {
      b = { late: false };
      b.promise = Promise.resolve()
        .then(() => this.indexer.build(id))
        .then(() => { const rec = this.records.get(id); if (rec && !rec.trailBuilt) { rec.trailBuilt = true; this.changed(id); } })
        .catch((e) => this.log.warn?.(`  trail ${id}: build failed: ${e.message}`))
        .then(() => { this.builds.delete(id); if (b.late) this.emit('trail-ready', id); });
      this.builds.set(id, b);
    }
    let timer;
    const done = await Promise.race([
      b.promise.then(() => true),
      new Promise((r) => { timer = setTimeout(() => r(false), waitMs); }),
    ]);
    clearTimeout(timer);
    if (!done) b.late = true;
    return done;
  }

  // ---------------------------------------------------------- migration ---
  // state.json v1 → trails + index (§6.2). Throws on failure; the caller keeps v1 read-only.
  async migrateV1(stateFile, saved) {
    await fsp.copyFile(stateFile, path.join(this.dir, 'state.v1.json.bak'));
    for (const s of saved.sessions || []) {
      if (!s?.id) continue;
      const rec = this.ensure(s.id);
      if (!rec.cwd && s.cwd) { rec.cwd = s.cwd; rec.project = s.project || baseName(s.cwd); }
      rec.model ??= s.model || null;
      rec.firstAt ??= s.startedAt || null;
      if (!(rec.lastAt >= s.lastAt)) rec.lastAt = s.lastAt || rec.lastAt;
      if (s.status === 'ended') { rec.endedAt ??= s.endedAt || null; }
      const p = this.trailPath(s.id);
      const entries = (s.trail || []).map((e, i) => ({ id: `l:${i}`, t: e.t, kind: e.kind, src: 'legacy', text: e.text })).filter(keepLegacy);
      // Written whole and only once, so re-running a half-finished migration cannot duplicate.
      if (p && entries.length && !fs.existsSync(p)) {
        if (!(await writeAtomic(p, entries.map((e) => `${JSON.stringify(e)}\n`).join('')))) throw new Error(`could not write ${p}`);
        for (const e of entries) tally(rec.counts, e);
      }
      this.changed(s.id);
    }
    this.indexDirty = true;
    await this.saveIndex();
    if (this.indexDirty) throw new Error('could not write index.json');
  }
}

function newRecord(id) {
  return {
    id, title: null, titleSrc: null, project: null, cwd: null, gitBranch: null, model: null,
    firstAt: null, lastAt: null, endedAt: null, endReason: null, waiting: false, forkedFrom: null,
    lastPrompt: null, counts: { prompts: 0, tools: 0, errors: 0 }, transcript: null, trailBuilt: false, scan: null,
  };
}

// ---------------------------------------------------- presence + desks (§4) -
// T = { LIVE_HOOK_MS, LIVE_TRANSCRIPT_MS, IDLE_WINDOW_MS, ENDED_DESK_MS }
// s.hookAt / s.transcriptAt are 0 after a restart, so restored sessions sit at idle until they move.
export function computePresence(s, t, pinned, T) {
  if (s.status === 'ended') return t - (s.endedAt || 0) < T.ENDED_DESK_MS ? 'ended' : 'history';
  if (pinned) return 'live';
  if (t - (s.hookAt || 0) < T.LIVE_HOOK_MS || t - (s.transcriptAt || 0) < T.LIVE_TRANSCRIPT_MS) return 'live';
  return t - (s.lastAt || 0) < T.IDLE_WINDOW_MS ? 'idle' : 'history';
}

// holders: ids that sit at a desk now. list: [{ id, presence, urgent, lastAt }].
// Seated sessions keep their desk; a newcomer that is live/urgent evicts the longest-quiet idle one (D5);
// anyone left over gets no desk.
export function assignDesks(holders, list, cap) {
  const byId = new Map(list.map((x) => [x.id, x]));
  const next = new Set([...holders].filter((id) => byId.has(id) && byId.get(id).presence !== 'history'));
  const rank = (x) => (x.urgent ? 0 : x.presence === 'live' ? 1 : x.presence === 'ended' ? 2 : 3);
  const queue = list
    .filter((x) => x.presence !== 'history' && !next.has(x.id))
    .sort((a, b) => rank(a) - rank(b) || (b.lastAt || 0) - (a.lastAt || 0));
  for (const x of queue) {
    if (next.size < cap) { next.add(x.id); continue; }
    if (rank(x) > 1) break;
    let victim = null;
    for (const id of next) {
      const y = byId.get(id);
      if (y.presence === 'idle' && !y.urgent && (!victim || (y.lastAt || 0) < (victim.lastAt || 0))) victim = y;
    }
    if (!victim) break;
    next.delete(victim.id);
    next.add(x.id);
  }
  return next;
}
