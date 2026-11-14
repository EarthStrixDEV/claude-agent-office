// Session Trail · Transcript Indexer.
// Reads Claude Code transcripts under ~/.claude/projects and emits session meta plus
// redacted trail entries. Design: docs/design/session-trail-indexer.md; the interface
// follows docs/design/session-trail-store-api.md §7. The store persists everything:
// the cursor lives in trails/<id>.jsonl and the scan cache in index.json.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { clip, summarizeTool } from './redact.mjs';

export const PARSER_VERSION = 1;
export const TESTED_RANGE = ['2.1.160', '2.1.321'];

const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 64 * 1024;
const TAIL_WIDE_BYTES = 512 * 1024;
const HASH_BYTES = 4096;
const CHUNK_BYTES = 1024 * 1024;
const TITLE_OVERLAP = 4096; // title lines are tiny; chunk overlap keeps them whole
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const LINES_PER_SLICE = 2000;
const PENDING_MAX = 256;
const SCAN_CONCURRENCY = 8;
const RECENT_MS = 60 * 60 * 1000;
const BIG_FILE = 100 * 1024;
const TOUCH_THROTTLE_MS = 1000;
const WATCH_BACKOFF_MAX = 30_000;

// Text that Claude Code or a hook injected into a user turn. Never a real prompt.
const SKIP_PREFIXES = [
  '<system-reminder>', '<command-message>', '<local-command-stdout>',
  '<local-command-caveat>', '<task-notification>', '<bash-input>',
  '[Request interrupted by user',
];
// Types seen in real transcripts that carry nothing for the trail.
const IGNORED_TYPES = new Set([
  'system', 'attachment', 'cost-state', 'queue-operation', 'file-history-snapshot',
  'file-history-delta', 'bridge-session', 'atis-latch', 'agent-name', 'mode',
  'api-request', 'api-request-blob', 'api-request-shape', 'dev-mods', 'tools-used',
  'frame-link', 'summary',
]);
const TITLE_NEEDLES = [
  [Buffer.from('"customTitle"'), 'custom-title', 'customTitle'],
  [Buffer.from('"aiTitle"'), 'ai-title', 'aiTitle'],
];

// ─── Parser adapter: the only code that knows the transcript format ─────────

export function newCtx() {
  return { model: null, permissionMode: null, gitBranch: null, cwd: null, pending: {}, prompts: 0, lastT: null };
}

function cloneCtx(c) {
  const base = newCtx();
  if (!c || typeof c !== 'object') return base;
  return { ...base, ...c, pending: { ...(c.pending && typeof c.pending === 'object' ? c.pending : {}) } };
}

const str = (v) => (typeof v === 'string' && v ? v : null);

function entry(id, t, kind, text, extra) {
  const e = { id, t, kind, src: 'transcript', text: clip(text, 200) };
  return extra ? Object.assign(e, extra) : e;
}

function summarize(name, input) {
  try { return summarizeTool(name, input); } catch { return ''; }
}

function remember(ctx, id, name) {
  ctx.pending[id] = name;
  const keys = Object.keys(ctx.pending);
  for (let i = 0; i < keys.length - PENDING_MAX; i++) delete ctx.pending[keys[i]];
}

// A user turn's text: a slash command (skill), injected text (skipped) or a prompt.
function userText(obj, ctx, t, out, text, images) {
  const s = text.trimStart();
  // Slash commands are written as <command-message>…<command-name>/x</command-name><command-args>…
  // so the command check runs before the injected-text prefixes, which include <command-message>.
  if ((s.startsWith('<command-name>') || s.startsWith('<command-message>')) && s.includes('<command-name>')) {
    const name = (s.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1] || '').trim();
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '').trim();
    if (name && str(obj.uuid)) {
      out.entries.push(entry(`t:${obj.uuid}`, t, 'skill', `${name.startsWith('/') ? '' : '/'}${name}${args ? ` ${args}` : ''}`));
    }
    return;
  }
  if (SKIP_PREFIXES.some((p) => s.startsWith(p))) return;
  if (!s.trim() && !images) return;
  if (!str(obj.uuid)) return;
  const prompt = clip(s, 120);
  const img = images ? ` [${images} image${images === 1 ? '' : 's'}]` : '';
  out.entries.push(entry(`t:${obj.uuid}`, t, 'prompt', `Prompt: ${prompt}${img}`));
  out.meta.prompt = prompt || img.trim();
  ctx.prompts += 1;
}

function toolResult(block, ctx, t, out) {
  const id = str(block.tool_use_id);
  if (!id) return;
  const name = ctx.pending[id];
  delete ctx.pending[id];
  if (block.is_error !== true) return;
  const raw = typeof block.content === 'string' ? block.content
    : Array.isArray(block.content) ? block.content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
    : '';
  const first = raw.replace(/<\/?tool_use_error>/g, '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  out.entries.push(entry(`t:${id}:err`, t, 'error', `${clip(name || 'Tool', 80)} failed${first ? `: ${clip(first, 120)}` : ''}`));
}

function parseUser(obj, ctx, t, out) {
  if (obj.isMeta === true || obj.isCompactSummary === true) return;
  const c = obj.message?.content;
  if (typeof c === 'string') return userText(obj, ctx, t, out, c, 0);
  if (!Array.isArray(c)) return;
  if (c.some((b) => b?.type === 'tool_result')) {
    for (const b of c) {
      if (b?.type !== 'tool_result') continue;
      // A denied tool is a permission event, owned by the bridge: forget it, emit nothing.
      if (obj.toolDenialKind) delete ctx.pending[b.tool_use_id];
      else toolResult(b, ctx, t, out);
    }
    return;
  }
  if (obj.toolDenialKind) return;
  const texts = [];
  let images = 0;
  for (const b of c) {
    if (b?.type === 'image') images++;
    else if (b?.type === 'text' && typeof b.text === 'string') {
      const s = b.text.trimStart();
      const command = s.startsWith('<command-') && s.includes('<command-name>');
      if (command || !SKIP_PREFIXES.some((p) => s.startsWith(p))) texts.push(b.text);
    }
  }
  if (!texts.length && !images) return;
  userText(obj, ctx, t, out, texts.join('\n'), images);
}

function parseAssistant(obj, ctx, t, out) {
  if (obj.isApiErrorMessage === true) return; // API errors belong to the StopFailure hook
  const model = str(obj.requestedModel) || str(obj.message?.model);
  if (model && model !== '<synthetic>') ctx.model = model;
  const content = obj.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b?.type !== 'tool_use' || !str(b.id)) continue; // text and thinking are never read (Q1)
    const name = clip(str(b.name) || 'Tool', 80);
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    remember(ctx, b.id, name);
    if (name === 'Skill') {
      out.entries.push(entry(`t:${b.id}`, t, 'skill', summarize('Skill', input) || 'Skill', { tool: 'Skill' }));
    } else if (name === 'Agent' || name === 'Task') {
      const agent = clip(input.subagent_type || 'general-purpose', 60);
      out.entries.push(entry(`t:${b.id}`, t, 'subagent', summarize(name, input) || agent, { agent }));
    } else {
      const sum = summarize(name, input);
      const e = entry(`t:${b.id}`, t, 'tool', sum ? `${name} · ${sum}` : name, { tool: name });
      if (input.run_in_background === true) e.bg = true;
      out.entries.push(e);
    }
  }
}

/**
 * Map one transcript line to trail entries and meta facts. Mutates ctx.
 * Returns { entries, meta, unknown } where meta may hold
 * t, version, customTitle, aiTitle, forkedFrom, prompt, lastPrompt.
 */
export function parseLine(obj, ctx, sessionId) {
  const out = { entries: [], meta: {}, unknown: null };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  // Lines copied from the parent when a session is forked.
  if (sessionId && typeof obj.sessionId === 'string' && obj.sessionId !== sessionId) {
    out.meta.forkedFrom = obj.sessionId;
    return out;
  }
  if (obj.isSidechain === true) return out;

  const ts = Date.parse(obj.timestamp);
  if (Number.isFinite(ts)) { out.meta.t = ts; ctx.lastT = ts; }
  const t = Number.isFinite(ts) ? ts : (ctx.lastT ?? 0);
  if (str(obj.version)) out.meta.version = obj.version;
  if (str(obj.cwd)) ctx.cwd = obj.cwd;
  if (str(obj.gitBranch)) ctx.gitBranch = obj.gitBranch;
  if (str(obj.permissionMode)) ctx.permissionMode = obj.permissionMode;

  switch (obj.type) {
    case 'user': parseUser(obj, ctx, t, out); break;
    case 'assistant': parseAssistant(obj, ctx, t, out); break;
    case 'custom-title': if (str(obj.customTitle)?.trim()) out.meta.customTitle = clip(obj.customTitle, 120); break;
    case 'ai-title': if (str(obj.aiTitle)?.trim()) out.meta.aiTitle = clip(obj.aiTitle, 120); break;
    case 'relocated': if (str(obj.relocatedCwd)) ctx.cwd = obj.relocatedCwd; break;
    case 'last-prompt': {
      const s = str(obj.lastPrompt)?.trimStart();
      if (s && !s.startsWith('<') && !SKIP_PREFIXES.some((p) => s.startsWith(p))) out.meta.lastPrompt = clip(s, 80);
      break;
    }
    default:
      if (!IGNORED_TYPES.has(obj.type)) out.unknown = clip(String(obj.type), 40);
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function readAt(fh, pos, len) {
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

function makeScan(head, st) {
  return { size: st.size, mtimeMs: st.mtimeMs, headHash: sha1(head.subarray(0, Math.min(HASH_BYTES, st.size))), parserVersion: PARSER_VERSION };
}

// Same file as when `scan` was taken? Compares the first min(4 KB, scan.size) bytes,
// so a file that was still smaller than 4 KB can keep growing without a false reset.
function headMatches(head, scan) {
  if (!scan || typeof scan.headHash !== 'string') return true;
  const n = Math.min(HASH_BYTES, Number(scan.size) || 0);
  return head.length >= n && sha1(head.subarray(0, n)) === scan.headHash;
}

function versionCmp(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function* lines(buf) {
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(0x0a, start);
    if (nl < 0) nl = buf.length;
    let end = nl;
    if (end > start && buf[end - 1] === 0x0d) end--;
    if (end > start) yield buf.toString('utf8', start, end);
    start = nl + 1;
  }
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function defer() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function emptyMeta() {
  return { cwd: null, gitBranch: null, model: null, firstAt: null, lastAt: null, customTitle: null, aiTitle: null, firstPrompt: null, lastPrompt: null, forkedFrom: null };
}

// ─── Indexer ─────────────────────────────────────────────────────────────────

export function createIndexer({
  root = path.join(os.homedir(), '.claude', 'projects'),
  log = console,
  pollMs = 30_000,
  debounceMs = 150,
  maxWaitMs = 1000,
} = {}) {
  root = path.resolve(root);
  const em = new EventEmitter();
  const sessions = new Map();
  const counters = { badLines: 0, unknownTypes: {}, oversizeLines: 0, versionMax: null };
  const warned = new Set();
  const hs = { watcher: true, format: true, untested: false };
  const big = { built: 0, empty: 0 };
  let lastHealth = null;
  let cursorOf = () => null;
  let scanOf = () => null;
  let watcher = null;
  let watchTimer = null;
  let watchBackoff = 1000;
  let pollTimer = null;
  let polling = false;
  let stopped = false;
  let queue = Promise.resolve();
  let ready = Promise.resolve();

  const warn = (msg) => { try { (log?.warn || log?.log)?.call(log, `[transcripts] ${msg}`); } catch { /* never throw */ } };
  const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); warn(msg); } };
  const errMsg = (e) => clip(e?.code || e?.message || String(e), 120);

  function safeEmit(evt, ...args) {
    try { em.emit(evt, ...args); } catch (e) { warn(`${evt} listener failed: ${errMsg(e)}`); }
  }
  // For 'entries' and 'reset': wait for each listener's Promise before going on.
  async function emitAwait(evt, ...args) {
    for (const fn of em.listeners(evt)) await fn(...args);
  }

  function updateHealth() {
    const h = !hs.watcher ? { healthy: false, reason: 'watcher' }
      : !hs.format ? { healthy: false, reason: 'format-changed' }
      : hs.untested ? { healthy: true, reason: 'untested-version' }
      : { healthy: true };
    const key = JSON.stringify(h);
    if (key === lastHealth) return;
    lastHealth = key;
    safeEmit('health', h);
  }

  function noteVersion(v) {
    if (!counters.versionMax || versionCmp(v, counters.versionMax) > 0) counters.versionMax = v;
    if (!hs.untested && (versionCmp(v, TESTED_RANGE[0]) < 0 || versionCmp(v, TESTED_RANGE[1]) > 0)) {
      hs.untested = true;
      updateHealth();
    }
  }

  function absorb(m, r, ctx) {
    const x = r.meta;
    if (x.forkedFrom && !m.forkedFrom) m.forkedFrom = x.forkedFrom;
    if (x.t != null) {
      if (m.firstAt == null || x.t < m.firstAt) m.firstAt = x.t;
      if (m.lastAt == null || x.t > m.lastAt) m.lastAt = x.t;
    }
    if (x.customTitle) m.customTitle = x.customTitle;
    if (x.aiTitle) m.aiTitle = x.aiTitle;
    if (x.prompt) { if (!m.firstPrompt) m.firstPrompt = x.prompt; m.lastPrompt = clip(x.prompt, 80); }
    if (x.lastPrompt) m.lastPrompt = x.lastPrompt;
    if (x.version) noteVersion(x.version);
    if (ctx.cwd) m.cwd = ctx.cwd;
    if (ctx.gitBranch) m.gitBranch = ctx.gitBranch;
    if (ctx.model) m.model = ctx.model;
  }

  function metaRecord(s) {
    const m = s.meta || emptyMeta();
    let title = m.customTitle, titleSrc = 'custom-title';
    if (!title && m.aiTitle) { title = m.aiTitle; titleSrc = 'ai-title'; }
    if (!title && m.firstPrompt) { title = clip(m.firstPrompt, 60); titleSrc = 'first-prompt'; }
    if (!title) { title = `${m.cwd ? path.basename(m.cwd) : 'session'} · ${s.id.slice(0, 8)}`; titleSrc = null; }
    return {
      id: s.id,
      transcript: s.file,
      title,
      titleSrc,
      project: m.cwd ? path.basename(m.cwd) : null,
      cwd: m.cwd,
      gitBranch: m.gitBranch,
      model: m.model,
      firstAt: m.firstAt ?? m.lastAt ?? s.mtimeMs,
      lastAt: m.lastAt ?? s.mtimeMs,
      mtime: s.mtimeMs,
      prompts: s.cursor ? (s.cursor.ctx?.prompts ?? 0) : null,
      lastPrompt: m.lastPrompt,
      forkedFrom: m.forkedFrom,
      scan: s.scan,
    };
  }

  function ensure(id, file) {
    let s = sessions.get(id);
    if (s) return s;
    let c = null;
    try { c = cursorOf(id) ?? null; } catch (e) { warn(`cursorOf failed: ${errMsg(e)}`); }
    const valid = !!c && typeof c === 'object' && Number.isFinite(c.off) && c.off >= 0;
    s = {
      id, file,
      cursor: valid ? { ...c, ctx: cloneCtx(c.ctx) } : null,
      needReset: !!c && !valid, // an unreadable cursor: start over cleanly
      scan: null, meta: null, size: -1, mtimeMs: 0,
      everSeen: false, tracked: false, missing: false,
      next: null, running: false, timer: null, firstPoke: 0, lastTouch: 0,
    };
    sessions.set(id, s);
    return s;
  }

  // Head 16 KB + tail 64 KB (wider only when no custom title is near the end).
  async function scanMeta(s, fh, head, st) {
    const m = emptyMeta();
    const ctx = newCtx();
    const eat = (buf) => {
      for (const line of lines(buf)) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; } // window edges cut lines; build counts bad lines
        absorb(m, parseLine(obj, ctx, s.id), ctx);
      }
    };
    eat(head);
    let tailFrom = head.length;
    if (st.size > head.length) {
      tailFrom = Math.max(head.length, st.size - TAIL_BYTES);
      const tail = await readAt(fh, tailFrom - 1, st.size - tailFrom + 1);
      const nl = tail.indexOf(0x0a);
      if (nl >= 0) eat(tail.subarray(nl + 1));
    }
    if (!m.customTitle && tailFrom > head.length) {
      const wideFrom = Math.max(0, st.size - TAIL_WIDE_BYTES);
      let found = await searchTitles(fh, wideFrom, st.size, s.id);
      if (!found.customTitle && wideFrom > 0) {
        const all = await searchTitles(fh, 0, st.size, s.id);
        found = { customTitle: all.customTitle, aiTitle: found.aiTitle || all.aiTitle };
      }
      if (found.customTitle) m.customTitle = clip(found.customTitle, 120);
      if (!m.aiTitle && found.aiTitle) m.aiTitle = clip(found.aiTitle, 120);
    }
    return m;
  }

  // Byte search for title lines without parsing the rest; the last match wins.
  async function searchTitles(fh, from, to, id) {
    const found = { customTitle: null, aiTitle: null };
    for (let pos = from; pos < to; pos += CHUNK_BYTES - TITLE_OVERLAP) {
      const buf = await readAt(fh, pos, Math.min(CHUNK_BYTES, to - pos));
      const atEnd = pos + buf.length >= to;
      for (const [needle, type, key] of TITLE_NEEDLES) {
        for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + needle.length)) {
          const a = buf.lastIndexOf(0x0a, i);
          let b = buf.indexOf(0x0a, i);
          if (a < 0 && pos > 0) continue;
          if (b < 0) { if (!atEnd) continue; b = buf.length; }
          try {
            const o = JSON.parse(buf.toString('utf8', a + 1, b));
            if (o?.type === type && o.sessionId === id && str(o[key])?.trim()) found[key] = o[key];
          } catch { /* not a title line */ }
        }
      }
      if (atEnd || !buf.length) break;
      await yieldLoop();
    }
    return found;
  }

  // Index one file at start(): skipped when the store's scan cache still matches.
  async function indexFile(s, prev) {
    let st;
    try { st = await fsp.stat(s.file); } catch { return; }
    s.everSeen = true;
    s.size = st.size;
    s.mtimeMs = st.mtimeMs;
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.parserVersion === PARSER_VERSION) {
      s.scan = prev;
      if (s.needReset || (s.cursor && s.cursor.off !== st.size)) schedule(s);
      return;
    }
    const fh = await fsp.open(s.file, 'r');
    try {
      const head = await readAt(fh, 0, Math.min(HEAD_BYTES, st.size));
      if (s.cursor && prev && (prev.parserVersion !== PARSER_VERSION || !headMatches(head, prev))) s.needReset = true;
      s.scan = makeScan(head, st);
      s.meta = await scanMeta(s, fh, head, st);
    } finally {
      await fh.close();
    }
    safeEmit('meta', metaRecord(s));
    if (s.needReset || (s.cursor && s.cursor.off !== st.size)) schedule(s);
  }

  function handleMissing(s) {
    if (!s.everSeen) {
      if (s.tracked) s.missing = true; // SessionStart can arrive before the file exists
      else sessions.delete(s.id);
      return;
    }
    clearTimeout(s.timer);
    sessions.delete(s.id);
    safeEmit('gone', s.id);
  }

  // Build or tail: read from the cursor (or 0) to the current size, chunk by chunk.
  async function sync(s) {
    let st;
    try { st = await fsp.stat(s.file); } catch (e) {
      if (e.code === 'ENOENT') return handleMissing(s);
      throw e;
    }
    s.everSeen = true;
    s.missing = false;
    const fh = await fsp.open(s.file, 'r');
    try {
      const head = await readAt(fh, 0, Math.min(HEAD_BYTES, st.size));
      const replaced = !headMatches(head, s.scan) || (!!s.cursor && st.size < s.cursor.off);
      if (s.needReset || (s.cursor && replaced)) {
        await emitAwait('reset', s.id); // the store must finish its rewrite before new entries
        s.cursor = null;
        s.needReset = false;
      }
      if (replaced || !s.meta) s.meta = await scanMeta(s, fh, head, st);
      const from = s.cursor ? s.cursor.off : 0;
      if (from === 0) s.meta.firstPrompt = null; // a full build sees the real first prompt
      let produced = 0;
      if (from < st.size) produced = await readFrom(s, fh, from, st);
      s.size = st.size;
      s.mtimeMs = st.mtimeMs;
      s.scan = makeScan(head, st);
      safeEmit('meta', metaRecord(s));
      if (from === 0 && st.size > BIG_FILE) {
        big.built++;
        if (produced === 0) big.empty++;
        hs.format = !(big.built >= 3 && big.empty * 2 > big.built);
        updateHealth();
      }
    } finally {
      await fh.close();
    }
  }

  async function parseBlock(s, buf, ctx) {
    const out = [];
    let n = 0;
    for (const line of lines(buf)) {
      if (++n % LINES_PER_SLICE === 0) await yieldLoop();
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { counters.badLines++; continue; }
      const r = parseLine(obj, ctx, s.id);
      if (r.unknown) {
        counters.unknownTypes[r.unknown] = (counters.unknownTypes[r.unknown] || 0) + 1;
        warnOnce(`type:${r.unknown}`, `unknown transcript line type "${r.unknown}" skipped`);
      }
      absorb(s.meta, r, ctx);
      for (const e of r.entries) out.push(e);
    }
    return out;
  }

  // Splits on 0x0A before decoding so multi-byte characters are never cut. A trailing
  // partial line is not kept: the next pass rereads it from the cursor.
  async function readFrom(s, fh, from, st) {
    const ctx = s.cursor ? cloneCtx(s.cursor.ctx) : newCtx();
    let pos = from;
    let carry = null;
    let skipping = false;
    let produced = 0;
    while (pos < st.size) {
      const buf = await readAt(fh, pos, Math.min(CHUNK_BYTES, st.size - pos));
      if (!buf.length) break;
      pos += buf.length;
      let data = carry ? Buffer.concat([carry, buf]) : buf;
      let base = pos - data.length;
      carry = null;
      let end = -1; // file offset just past the last fully handled line
      if (skipping) {
        const nl = data.indexOf(0x0a);
        if (nl < 0) continue;
        skipping = false;
        counters.oversizeLines++;
        data = data.subarray(nl + 1);
        base += nl + 1;
        end = base;
      }
      const last = data.lastIndexOf(0x0a);
      let entries = [];
      if (last >= 0) {
        entries = await parseBlock(s, data.subarray(0, last), ctx);
        end = base + last + 1;
        if (last + 1 < data.length) carry = data.subarray(last + 1);
      } else if (data.length > MAX_LINE_BYTES) {
        skipping = true;
      } else {
        carry = data;
      }
      if (end > (s.cursor?.off ?? -1)) {
        const cursor = { off: end, size: st.size, mtime: st.mtimeMs, ctx: cloneCtx(ctx) };
        await emitAwait('entries', s.id, entries, cursor);
        s.cursor = cursor;
        produced += entries.length;
      }
      await yieldLoop();
    }
    return produced;
  }

  // One sync at a time across all files (builds queue one by one); per file, an event
  // that lands mid-sync sets up exactly one more pass.
  function schedule(s) {
    if (stopped) return Promise.resolve();
    if (!s.next) {
      s.next = defer();
      if (!s.running) queue = queue.then(() => run(s));
    }
    return s.next.promise;
  }

  async function run(s) {
    const d = s.next;
    s.next = null;
    s.running = true;
    try {
      if (!stopped) await sync(s);
    } catch (e) {
      warnOnce(`sync:${s.id}:${errMsg(e)}`, `sync of ${s.id.slice(0, 8)} failed: ${errMsg(e)}`);
    } finally {
      s.running = false;
      d.resolve();
      if (s.next) queue = queue.then(() => run(s));
    }
  }

  // Debounce per file: trailing debounceMs, at most maxWaitMs while writes keep coming.
  function poke(s) {
    if (stopped) return;
    const now = Date.now();
    if (!s.firstPoke) s.firstPoke = now;
    clearTimeout(s.timer);
    const wait = Math.max(0, Math.min(debounceMs, s.firstPoke + maxWaitMs - now));
    s.timer = setTimeout(() => { s.timer = null; s.firstPoke = 0; schedule(s); }, wait);
  }

  // Subagent files only signal that the parent session is still working.
  async function touch(s) {
    const now = Date.now();
    if (now - s.lastTouch < TOUCH_THROTTLE_MS) return;
    s.lastTouch = now;
    if (!s.meta) {
      const st = await fsp.stat(s.file);
      const fh = await fsp.open(s.file, 'r');
      try {
        const head = await readAt(fh, 0, Math.min(HEAD_BYTES, st.size));
        if (!s.meta) s.meta = await scanMeta(s, fh, head, st);
      } finally { await fh.close(); }
    }
    s.meta.lastAt = Math.max(s.meta.lastAt ?? 0, now);
    safeEmit('meta', metaRecord(s));
  }

  async function discover() {
    let dirs;
    try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
    const found = [];
    await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
      let files;
      try { files = await fsp.readdir(path.join(root, d.name), { withFileTypes: true }); } catch { return; }
      for (const f of files) {
        if (f.isFile() && f.name.endsWith('.jsonl')) found.push({ id: f.name.slice(0, -6), file: path.join(root, d.name, f.name) });
      }
    }));
    return found;
  }

  // Full rescan: new files, changed files and vanished files.
  async function rescan() {
    const files = await discover();
    const seen = new Set();
    for (const { id, file } of files) {
      seen.add(id);
      const s = sessions.get(id);
      if (!s) poke(ensure(id, file));
    }
    for (const s of [...sessions.values()]) {
      if (!seen.has(s.id) && !s.missing) { poke(s); continue; }
      try {
        const st = await fsp.stat(s.file);
        if (st.size !== s.size || st.mtimeMs !== s.mtimeMs) poke(s);
      } catch { poke(s); }
    }
  }

  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      if (!watcher) return await rescan(); // watcher down: rely on full rescans
      const now = Date.now();
      for (const s of [...sessions.values()]) {
        if (!s.missing && now - s.mtimeMs > RECENT_MS) continue;
        try {
          const st = await fsp.stat(s.file);
          if (st.size !== s.size || st.mtimeMs !== s.mtimeMs) poke(s);
        } catch { if (!s.missing) poke(s); }
      }
    } catch (e) {
      warnOnce(`poll:${errMsg(e)}`, `poll failed: ${errMsg(e)}`);
    } finally {
      polling = false;
    }
  }

  function route(filename) {
    if (stopped) return;
    if (!filename) { rescan().catch((e) => warn(`rescan failed: ${errMsg(e)}`)); return; } // event buffer overflow
    const parts = String(filename).split(/[\\/]/).filter(Boolean);
    if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
      poke(ensure(parts[1].slice(0, -6), path.join(root, parts[0], parts[1])));
    } else if (parts.length >= 4 && parts[2] === 'subagents') {
      const s = sessions.get(parts[1]);
      if (s?.everSeen) touch(s).catch(() => {});
    }
  }

  function startWatcher() {
    if (stopped) return;
    try {
      watcher = fs.watch(root, { recursive: true }, (_evt, name) => {
        try { route(name); } catch (e) { warn(`route failed: ${errMsg(e)}`); }
      });
      watcher.on('error', onWatchError);
      watchBackoff = 1000;
      hs.watcher = true;
      updateHealth();
    } catch (e) {
      onWatchError(e);
    }
  }

  function onWatchError(e) {
    warnOnce(`watch:${errMsg(e)}`, `watcher failed: ${errMsg(e)}`);
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = null;
    hs.watcher = false;
    updateHealth();
    if (stopped) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = null;
      startWatcher();
      if (watcher) rescan().catch(() => {}); // pick up whatever happened while it was down
    }, watchBackoff);
    watchBackoff = Math.min(watchBackoff * 2, WATCH_BACKOFF_MAX);
  }

  async function initialIndex() {
    const files = await discover();
    await pool(files, SCAN_CONCURRENCY, async ({ id, file }) => {
      if (stopped) return;
      const s = ensure(id, file);
      let prev = null;
      try { prev = scanOf(id) ?? null; } catch (e) { warn(`scanOf failed: ${errMsg(e)}`); }
      try { await indexFile(s, prev); } catch (e) { warnOnce(`index:${errMsg(e)}`, `index of ${id.slice(0, 8)} failed: ${errMsg(e)}`); }
    });
  }

  /** Returns a Promise that resolves once every file has been indexed (meta sent). */
  function start({ cursorOf: c, scanOf: sc } = {}) {
    if (typeof c === 'function') cursorOf = c;
    if (typeof sc === 'function') scanOf = sc;
    stopped = false;
    startWatcher();
    pollTimer = setInterval(() => { poll(); }, pollMs);
    pollTimer.unref?.();
    ready = initialIndex().catch((e) => warn(`start failed: ${errMsg(e)}`));
    return ready;
  }

  /** Lazy build of a whole file (or catch-up from its cursor). Never rejects. */
  async function build(sessionId) {
    try {
      await ready;
      const s = sessions.get(sessionId);
      if (s) await schedule(s);
    } catch (e) {
      warn(`build failed: ${errMsg(e)}`);
    }
  }

  /** SessionStart hook: watch this transcript now. Only files under root are accepted. */
  function track(sessionId, transcriptPath) {
    try {
      if (typeof sessionId !== 'string' || typeof transcriptPath !== 'string' || !transcriptPath) return;
      const file = path.resolve(transcriptPath);
      const rel = path.relative(root, file);
      if (rel.startsWith('..') || path.isAbsolute(rel) || path.basename(file) !== `${sessionId}.jsonl`) {
        warnOnce(`track:${sessionId}`, `ignored transcript path outside ${root}`);
        return;
      }
      const s = ensure(sessionId, file);
      s.tracked = true;
      poke(s);
    } catch (e) {
      warn(`track failed: ${errMsg(e)}`);
    }
  }

  function stats() {
    let built = 0;
    for (const s of sessions.values()) if (s.cursor) built++;
    return {
      files: sessions.size,
      built,
      badLines: counters.badLines,
      unknownTypes: { ...counters.unknownTypes },
      oversizeLines: counters.oversizeLines,
      versionMax: counters.versionMax,
      watcher: watcher ? 'ok' : 'polling',
    };
  }

  async function stop() {
    stopped = true;
    clearInterval(pollTimer);
    clearTimeout(watchTimer);
    try { watcher?.close(); } catch { /* ignore */ }
    watcher = null;
    for (const s of sessions.values()) clearTimeout(s.timer);
    await ready;
    await queue;
  }

  return Object.assign(em, { start, build, track, stats, stop });
}
