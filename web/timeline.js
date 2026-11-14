// Timeline tab of the session detail (docs/design/session-trail-ui.md §5).
// Newest first. Pages come from POST /api/sessions/trail (oldest→newest inside a page, `before` is an opaque
// cursor); live entries come from SSE `trail`. The DOM is patched row by row, never rebuilt, and holds at most
// CAP rows; rows rely on `content-visibility` instead of a virtual scroller.
import { h, dayLabel, hhmm, fullTime, startOfDay, daysAgo, reducedMotion, isGone } from './dom.js';

const KINDS = {
  prompt: ['›', 'Prompt', '--accent'],
  tool: ['⌘', 'Tool', '--st-working'],
  error: ['⚠', 'Error', '--st-error'],
  permission: ['?', 'Permission', '--st-waiting'],
  dispatch: ['↧', 'Dispatch', '--accent'],
  subagent: ['👥', 'Subagent', '--st-thinking'],
  skill: ['🧩', 'Skill', '--st-compacting'],
  env: ['⚙', 'Env', '--st-idle'],
  mode: ['⚙', 'Mode', '--st-idle'],
  session: ['◆', 'Session', '--st-standby'],
  background: ['•', 'Background', '--muted'],
  notify: ['•', 'Notify', '--muted'],
  git: ['•', 'Git', '--muted'],
  other: ['•', 'Other', '--muted'],
};
const FILTERS = [
  ['all', 'All', null],
  ['prompts', 'Prompts', ['prompt']],
  ['tools', 'Tools', ['tool', 'error']], // errors too, or the ✕ marks could never appear
  ['errors', 'Errors', ['error']],
  ['permissions', 'Permissions', ['permission']],
  ['env', 'Env', ['env', 'mode', 'session']],
];
const MORE = ['subagent', 'skill', 'dispatch', 'background', 'notify', 'git', 'other'];
const PAGE = 200;
const CAP = 1000;
const TOP_PX = 24;
const BUILD_RETRY_MS = 30_000;
const FILTER_KEY = 'office-timeline-filter';

const kindsOf = (f) => (f.startsWith('more:') ? [f.slice(5)] : FILTERS.find(([k]) => k === f)?.[2] ?? null);
const validFilter = (f) => (FILTERS.some(([k]) => k === f) || (f?.startsWith('more:') && MORE.includes(f.slice(5))) ? f : 'all');
// Newest first; equal times keep arrival order.
const newer = (a, b) => b.t - a.t || b._seq - a._seq;

export function initTimeline({ api, store, toast, host }) {
  let filter = validFilter(store.get(FILTER_KEY, 'all'));
  let tl = null;
  let incoming = [];
  const rowEls = new Map();
  let tabRow = null;

  // ------------------------------------------------------------ skeleton
  const radios = FILTERS.map(([k, label]) => h('button', { type: 'button', role: 'radio', class: 'tl-filter', 'data-tl-filter': k }, label));
  const more = h('select', { class: 'tl-more', 'aria-label': 'More filters' },
    h('option', { value: '' }, 'More ▾'), MORE.map((k) => h('option', { value: k }, KINDS[k][1])));
  const filters = h('div', { class: 'tl-filters', role: 'radiogroup', 'aria-label': 'Filter the timeline' }, radios, more);
  const pill = h('button', { type: 'button', class: 'tl-pill', hidden: true });
  const status = h('div', { class: 'tl-status' });
  const feed = h('div', { class: 'tl-feed', role: 'feed', 'aria-label': 'Timeline, newest first' });
  const foot = h('div', { class: 'tl-foot' });
  const sentinel = h('div', { class: 'tl-sentinel', 'aria-hidden': 'true' });
  // Zero-height sticky wrapper: showing the pill must not push the rows down.
  const scroller = h('div', { class: 'tl-scroll' }, h('div', { class: 'tl-pill-wrap' }, pill), status, feed, foot, sentinel);
  host.replaceChildren(filters, scroller);

  const io = new IntersectionObserver((list) => {
    if (list.some((x) => x.isIntersecting)) loadOlder();
  }, { root: scroller, rootMargin: '0px 0px 240px 0px' });
  io.observe(sentinel);
  const recheckSentinel = () => { io.unobserve(sentinel); io.observe(sentinel); };

  function paintFilters() {
    radios.forEach((b) => {
      const on = b.dataset.tlFilter === filter;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('active', on);
    });
    const tabbable = radios.find((b) => b.dataset.tlFilter === filter) || radios[0];
    radios.forEach((b) => { b.tabIndex = b === tabbable ? 0 : -1; });
    more.value = filter.startsWith('more:') ? filter.slice(5) : '';
    more.classList.toggle('active', filter.startsWith('more:'));
  }
  paintFilters();

  // ------------------------------------------------------------ state
  function reset(id) {
    if (tl) clearTimeout(tl.buildTimer);
    tl = {
      id, kinds: kindsOf(filter), byId: new Map(), order: [], before: null, gen: (tl?.gen || 0) + 1,
      loading: false, loadingOlder: false, building: false, buildSlow: false, buildTimer: 0,
      error: null, olderError: null, gone: false, pendingNew: [], pendingIds: new Set(),
      trimmedTop: false, trimmedBottom: false, seqHi: 0, seqLo: 0, queued: [],
    };
    incoming = [];
    for (const el of rowEls.values()) el.remove();
    rowEls.clear();
    tabRow = null;
    paintKey = '';
    scroller.scrollTop = 0;
    loadFirst();
  }

  const matches = (e) => !tl.kinds || tl.kinds.includes(e.kind);

  function insert(e, older = false) {
    e._seq = older ? --tl.seqLo : ++tl.seqHi;
    const o = tl.order;
    let lo = 0, hi = o.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (newer(e, o[mid]) < 0) hi = mid; else lo = mid + 1; }
    o.splice(lo, 0, e);
    tl.byId.set(e.id, e);
  }

  function drop(entries) {
    for (const e of entries) {
      tl.byId.delete(e.id);
      const el = rowEls.get(e.id);
      if (el) { if (el === tabRow) tabRow = null; el.remove(); rowEls.delete(e.id); }
    }
  }

  // ------------------------------------------------------------ loading
  async function fetchPage(before) {
    const body = { sessionId: tl.id, before, limit: PAGE };
    if (tl.kinds) body.kinds = tl.kinds;
    return api('/api/sessions/trail', body);
  }

  async function loadFirst() {
    const t = tl, gen = t.gen;
    clearTimeout(t.buildTimer);
    Object.assign(t, { loading: true, building: false, buildSlow: false, error: null });
    paint();
    try {
      const r = await fetchPage(null);
      if (tl !== t || t.gen !== gen) return;
      t.loading = false;
      if (r.building) {
        t.building = true;
        t.buildTimer = setTimeout(() => { if (tl === t && t.building) { t.buildSlow = true; paint(); } }, BUILD_RETRY_MS);
        paint();
        return;
      }
      for (let i = (r.entries || []).length - 1; i >= 0; i--) {
        const e = r.entries[i];
        if (e?.id && !t.byId.has(e.id)) insert(e, true);
      }
      t.before = r.before ?? null;
      sync();
      const queued = t.queued; t.queued = [];
      if (queued.length) ingestLive(queued);
    } catch (err) {
      if (tl !== t || t.gen !== gen) return;
      t.loading = false;
      if (isGone(err)) t.gone = true; else t.error = err.message || 'network error';
    }
    paint();
    recheckSentinel();
  }

  async function loadOlder() {
    const t = tl;
    if (!t || t.loading || t.loadingOlder || t.building || t.gone || t.olderError || t.trimmedBottom || !t.before || host.hidden) return;
    const gen = t.gen;
    t.loadingOlder = true;
    paint();
    try {
      const r = await fetchPage(t.before);
      if (tl !== t || t.gen !== gen) return;
      for (let i = (r.entries || []).length - 1; i >= 0; i--) {
        const e = r.entries[i];
        if (e?.id && !t.byId.has(e.id)) insert(e, true);
      }
      t.before = r.before ?? null;
      // Over the cap while reading old history: drop the newest rows; "Jump to latest" reloads them.
      const excess = t.order.length - CAP;
      if (excess > 0) {
        drop(t.order.splice(0, excess));
        t.trimmedTop = true;
        t.pendingNew = []; t.pendingIds.clear();
      }
      sync();
    } catch (err) {
      if (tl !== t || t.gen !== gen) return;
      if (isGone(err)) t.gone = true; else t.olderError = err.message || 'network error';
    } finally {
      if (tl === t && t.gen === gen) t.loadingOlder = false;
    }
    paint();
    recheckSentinel();
  }

  // After an SSE reconnect: fetch the newest page again and merge by id.
  async function refetchFirst() {
    const t = tl, gen = t.gen;
    t.error = null;
    paint();
    try {
      const r = await fetchPage(null);
      if (tl !== t || t.gen !== gen) return;
      if (r.building) return;
      ingestLive(r.entries || []);
    } catch (err) {
      if (tl !== t || t.gen !== gen) return;
      if (isGone(err)) t.gone = true; else t.error = err.message || 'network error';
    }
    paint();
  }

  // Live and late entries (§5.2).
  function ingestLive(entries) {
    const t = tl;
    if (t.loading || t.building) { t.queued.push(...entries); return; }
    if (t.gone) return;
    const atTop = scroller.scrollTop < TOP_PX;
    if (atTop && t.pendingNew.length) flushPending();
    let changed = false;
    const hadPending = t.pendingNew.length > 0;
    for (const e of entries) {
      if (!e?.id || t.byId.has(e.id) || t.pendingIds.has(e.id) || !matches(e)) continue;
      const top = t.order[0], bottom = t.order[t.order.length - 1];
      if (!top || e.t >= top.t) {
        if (t.trimmedTop) continue; // the reload behind "Jump to latest" brings it
        if (atTop) { insert(e); changed = true; } else { t.pendingNew.push(e); t.pendingIds.add(e.id); }
      } else if (e.t >= bottom.t || t.before === null) {
        insert(e); changed = true; // arrived late, inside the loaded range
      } // older than everything loaded while more pages exist: that page brings it
    }
    if (changed) {
      const excess = t.order.length - CAP;
      if (excess > 0) {
        if (atTop) { drop(t.order.splice(CAP)); t.trimmedBottom = true; } else { drop(t.order.splice(0, excess)); t.trimmedTop = true; }
      }
      sync();
    }
    if (!hadPending && t.pendingNew.length) toast(`${t.pendingNew.length} new ${t.pendingNew.length === 1 ? 'entry' : 'entries'}`);
    paint();
  }

  function flushPending() {
    const list = tl.pendingNew;
    tl.pendingNew = []; tl.pendingIds.clear();
    for (const e of list) if (!tl.byId.has(e.id)) insert(e);
    const excess = tl.order.length - CAP;
    if (excess > 0) { drop(tl.order.splice(CAP)); tl.trimmedBottom = true; }
  }

  // ------------------------------------------------------------ DOM
  function buildRow(e) {
    const [ic, label, color] = KINDS[e.kind] || KINDS.other;
    const kind = KINDS[e.kind] ? e.kind : 'other';
    const text = String(e.text ?? '');
    const el = h('div', { class: `tl-row k-${kind}`, role: 'article', tabindex: '-1', style: `--k:var(${color})` },
      h('div', { class: 'tl-line' },
        h('time', { class: 'tl-time', datetime: new Date(e.t).toISOString(), title: fullTime(e.t) }, hhmm(e.t)),
        h('span', { class: 'tl-ic', 'aria-hidden': 'true' }, ic),
        h('span', { class: 'tl-kind' }, label),
        h('span', { class: 'tl-text', title: text }, text)));
    el._id = e.id;
    el._day = null;
    el._err = null;
    return el;
  }

  function setDay(el, label) {
    if (el._day === label) return;
    el._day = label;
    el.querySelector(':scope > .tl-day')?.remove();
    if (label) el.prepend(h('div', { class: 'tl-day' }, label));
  }

  function setErr(el, err) {
    const id = err?.id || null;
    if (el._err === id) return;
    el._err = id;
    const line = el.querySelector(':scope > .tl-line');
    line.querySelector('.tl-err')?.remove();
    if (err) {
      const text = String(err.text ?? 'Failed');
      const b = h('button', { type: 'button', class: 'tl-err', title: text, 'aria-label': `Failed: ${text}. Show the error` }, '✕');
      b._target = err.id;
      line.append(b);
    }
  }

  // The first row that is still visible, so inserts above it don't move what you are reading.
  function anchor() {
    const st = scroller.scrollTop;
    if (st < TOP_PX) return null;
    const rows = feed.children;
    let lo = 0, hi = rows.length - 1, hit = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const el = rows[mid];
      if (el.offsetTop + el.offsetHeight > st) { hit = el; hi = mid - 1; } else lo = mid + 1;
    }
    return hit && { el: hit, top: hit.offsetTop };
  }

  function sync() {
    const a = anchor();
    const today = startOfDay(Date.now());
    let cur = feed.firstElementChild;
    let prevDay = null;
    tl.order.forEach((e, i) => {
      let el = rowEls.get(e.id);
      if (!el) { el = buildRow(e); rowEls.set(e.id, el); }
      if (el !== cur) feed.insertBefore(el, cur); else cur = cur.nextElementSibling;
      const day = e._day ??= startOfDay(e.t);
      setDay(el, (i === 0 ? day !== today : day !== prevDay) ? dayLabel(e.t) : null);
      prevDay = day;
      if (e.kind === 'tool') setErr(el, tl.byId.get(`${e.id}:err`));
    });
    if (!tabRow || !tabRow.isConnected) {
      tabRow = feed.firstElementChild;
      if (tabRow) tabRow.tabIndex = 0;
    }
    if (a && a.el.isConnected) scroller.scrollTop += a.el.offsetTop - a.top;
  }

  let paintKey = '';
  function paint() {
    if (!tl) return;
    const t = tl;
    const n = t.order.length;
    filters.hidden = t.gone;
    feed.hidden = t.gone;
    feed.setAttribute('aria-busy', String(t.loading || t.loadingOlder));
    const pillText = t.gone ? '' : t.trimmedTop ? '▲ Jump to latest' : t.pendingNew.length ? `▲ ${t.pendingNew.length} new` : '';
    pill.hidden = !pillText;
    pill.textContent = pillText;

    // Top status
    let top = '';
    if (t.gone) top = 'gone';
    else if (t.loading && !n) top = 'loading';
    else if (t.building) top = t.buildSlow ? 'building-slow' : 'building';
    else if (t.error) top = n ? 'error-kept' : 'error';
    else if (!t.loading && !n && t.before === null) top = filter === 'all' ? 'empty-all' : filter === 'env' ? 'empty-env' : 'empty-filter';
    // Bottom status
    let bottom = '';
    if (!t.gone && n) {
      if (t.loadingOlder) bottom = 'older';
      else if (t.olderError) bottom = 'older-error';
      else if (t.trimmedBottom) bottom = 'trimmed';
      else if (t.before === null) bottom = `start:${t.order[n - 1].t}`;
    }
    const key = `${top}|${bottom}|${t.error}|${t.olderError}`;
    if (key === paintKey) return;
    paintKey = key;

    const msg = (text, ...actions) => h('div', { class: 'tl-msg' }, h('p', null, text), actions);
    const btn = (label, act) => h('button', { type: 'button', class: 'btn', 'data-tl-act': act }, label);
    status.setAttribute('role', top.startsWith('error') ? 'alert' : 'status');
    status.replaceChildren(...({
      gone: [msg('This session is no longer available. Claude Code has removed its transcript.')],
      loading: Array.from({ length: 6 }, () => h('div', { class: 'tl-skel', 'aria-hidden': 'true' }, h('i'), h('i'))),
      building: [msg('Building the timeline from the transcript…')],
      'building-slow': [msg('Building the timeline from the transcript…', btn('Retry', 'retry'))],
      error: [msg("Couldn't load the timeline.", btn('Retry', 'retry'))],
      'error-kept': [msg("Couldn't load the timeline.", btn('Retry', 'retry'))],
      'empty-all': [msg('No activity recorded yet.')],
      'empty-env': [msg('No environment changes recorded. The office only records these for sessions it saw live.')],
      'empty-filter': [msg('Nothing matches this filter.', btn('Show all', 'show-all'))],
    }[top] || []));
    status.classList.toggle('banner', top === 'error-kept');
    if (top === 'loading') status.setAttribute('aria-label', 'Loading the timeline');
    else status.removeAttribute('aria-label');

    foot.replaceChildren(...(
      bottom === 'older' ? [h('p', { class: 'tl-loading' }, '⟳ Loading older…')]
        : bottom === 'older-error' ? [h('p', null, "Couldn't load older entries. "), btn('Retry', 'retry-older')]
          : bottom === 'trimmed' ? [h('p', null, 'Older entries were unloaded to keep the list fast. '), btn('Reload', 'reload')]
            : bottom.startsWith('start:') ? [h('p', null, `Start of session · ${dayLabel(t.order[n - 1].t)} ${hhmm(t.order[n - 1].t)}`)]
              : []));
  }

  // ------------------------------------------------------------ events
  function setFilter(f) {
    filter = validFilter(f);
    store.set(FILTER_KEY, filter);
    paintFilters();
    if (tl) reset(tl.id);
  }
  filters.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tl-filter]');
    if (b && b.dataset.tlFilter !== filter) setFilter(b.dataset.tlFilter);
  });
  filters.addEventListener('keydown', (e) => {
    const i = radios.indexOf(e.target);
    if (i < 0) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = radios[(i + step + radios.length) % radios.length];
    next.focus();
    setFilter(next.dataset.tlFilter);
  });
  more.addEventListener('change', () => setFilter(more.value ? `more:${more.value}` : 'all'));

  function toTop() { scroller.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); }
  pill.addEventListener('click', () => {
    if (!tl) return;
    if (tl.trimmedTop) { reset(tl.id); return; }
    flushPending();
    sync();
    paint();
    toTop();
  });

  scroller.addEventListener('click', (e) => {
    const act = e.target.closest('[data-tl-act]')?.dataset.tlAct;
    if (act && tl) {
      if (act === 'retry') { if (tl.order.length && !tl.building) refetchFirst(); else reset(tl.id); }
      else if (act === 'retry-older') { tl.olderError = null; loadOlder(); }
      else if (act === 'reload') reset(tl.id);
      else if (act === 'show-all') setFilter('all');
      return;
    }
    const err = e.target.closest('.tl-err');
    if (err) { const row = rowEls.get(err._target); if (row) { row.scrollIntoView({ block: 'center' }); focusRow(row); } return; }
    const row = e.target.closest('.tl-row');
    if (row) { row.classList.toggle('open'); focusRow(row, false); }
  });

  function focusRow(el, move = true) {
    if (tabRow && tabRow !== el) tabRow.tabIndex = -1;
    tabRow = el;
    el.tabIndex = 0;
    if (move) el.focus({ preventScroll: false });
  }
  // Feed pattern: Page Down / Page Up move between articles; Enter expands the text.
  feed.addEventListener('keydown', (e) => {
    const row = e.target.closest('.tl-row');
    if (!row || e.target !== row) return;
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      const next = e.key === 'PageDown' ? row.nextElementSibling : row.previousElementSibling;
      e.preventDefault();
      if (next) focusRow(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      row.classList.toggle('open');
    }
  });

  // ------------------------------------------------------------ API for app.js
  return {
    // Show the timeline of `id` (keeps the current one, and its scroll position, if it is the same session).
    show(id) {
      host.hidden = false;
      if (!tl || tl.id !== id) reset(id);
    },
    // Hide; forget the timeline if the selection moved on (only one timeline lives in memory).
    hide(id) {
      host.hidden = true;
      if (tl && tl.id !== id) { clearTimeout(tl.buildTimer); tl = null; incoming = []; for (const el of rowEls.values()) el.remove(); rowEls.clear(); tabRow = null; }
    },
    onTrail(msg) {
      if (tl && msg?.sessionId === tl.id && Array.isArray(msg.entries)) incoming.push(...msg.entries);
    },
    // Called once per animation frame from renderAll, so SSE batches share the frame with the rest of the UI.
    flush() {
      if (!tl || !incoming.length) return;
      const batch = incoming; incoming = [];
      ingestLive(batch);
    },
    onReady(id) { if (tl && tl.id === id && tl.building) loadFirst(); },
    onReset(id) { if (tl && tl.id === id) reset(id); },
    onReconnect() {
      if (!tl || tl.gone || tl.loading) return;
      if (tl.order.length && !tl.building) refetchFirst(); else loadFirst();
    },
    markGone(id) { if (tl && tl.id === id) { tl.gone = true; paint(); } },
  };
}
