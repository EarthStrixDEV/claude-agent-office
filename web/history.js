// History tab of the left panel (docs/design/session-trail-ui.md §4): every session the office knows about,
// grouped by day in the browser's locale, searchable. Records live in state.history and never reach the scene.
import { h, groupLabel } from './dom.js';

const PAGE = 200;
const SEARCH_MS = 150;
const norm = (s) => String(s ?? '').normalize('NFC').toLocaleLowerCase();
// The list API hides sessions nobody typed in; do the same for records that arrive over SSE.
const listed = (r) => !(r.counts && r.counts.prompts === 0);
const byLast = (a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const PRESENCE = { live: '●', idle: '○', ended: '✓', history: '' };

export function initHistory({ api, state, host, ago, STATUS_LABEL, onPick, isOpen }) {
  const H = { loaded: false, loading: false, error: null, next: null, query: '', results: null, searching: false, searchError: null };
  let dirty = true;
  let lastSelected;
  let pendingReorder = false;
  let rovingId = null;
  let searchGen = 0;
  let searchTimer = 0;

  // ------------------------------------------------------------ skeleton
  const input = h('input', { type: 'search', class: 'h-search', 'aria-label': 'Search sessions', placeholder: 'Search sessions…', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'h-list' });
  const note = h('div', { class: 'h-note' });
  const sentinel = h('div', { class: 'h-sentinel', 'aria-hidden': 'true' });
  const scroller = h('div', { class: 'scroll h-scroll' }, list, note, sentinel);
  host.replaceChildren(h('div', { class: 'h-search-wrap' }, input), scroller);

  const io = new IntersectionObserver((xs) => {
    if (xs.some((x) => x.isIntersecting) && !H.query.trim() && H.next && !H.loading && !H.error) loadPage(H.next);
  }, { root: scroller, rootMargin: '0px 0px 200px 0px' });
  io.observe(sentinel);
  const recheck = () => { io.unobserve(sentinel); io.observe(sentinel); };

  // ------------------------------------------------------------ data
  async function loadPage(cursor) {
    if (H.loading) return;
    H.loading = true; H.error = null; dirty = true; render();
    try {
      const r = await api('/api/sessions/list', cursor ? { cursor, limit: PAGE } : { limit: PAGE });
      for (const rec of r.items || []) if (rec?.id) state.history.set(rec.id, rec);
      H.next = r.next ?? null;
      H.loaded = true;
    } catch (err) {
      H.error = err.message || 'network error';
    }
    H.loading = false; dirty = true; render(); recheck();
  }

  // After an SSE reconnect: merge the first page again; keep the paging cursor we already have.
  async function refetch() {
    try {
      const r = await api('/api/sessions/list', { limit: PAGE });
      for (const rec of r.items || []) if (rec?.id) state.history.set(rec.id, rec);
      dirty = true; render();
    } catch { /* the next reconnect tries again */ }
  }

  const complete = () => H.loaded && H.next === null;

  async function search(q) {
    const gen = ++searchGen;
    Object.assign(H, { searching: true, searchError: null, results: null });
    dirty = true; render();
    try {
      const r = await api('/api/sessions/list', { q, limit: PAGE });
      if (gen !== searchGen) return;
      H.results = r.items || [];
    } catch (err) {
      if (gen !== searchGen) return;
      H.searchError = err.message || 'network error';
    }
    H.searching = false; dirty = true; render();
  }

  function records() {
    const q = norm(H.query.trim());
    const all = () => [...state.history.values()].filter(listed);
    if (!q) return all().sort(byLast);
    // Everything is loaded: search here. Otherwise show the server's answer, kept apart from the cached list.
    if (complete()) return all().filter((r) => [r.title, r.project, r.cwd, r.gitBranch].some((v) => norm(v).includes(q))).sort(byLast);
    return (H.results || []).map((r) => state.history.get(r.id) || r).filter(listed);
  }

  // ------------------------------------------------------------ rows
  const groupEls = new Map();
  const rowEls = new Map();

  function buildRow(id) {
    const ind = h('span', { class: 'h-ind', 'aria-hidden': 'true' });
    const title = h('span', { class: 'h-title' });
    const sr = h('span', { class: 'sr-only' });
    const wait = h('span', { class: 'h-wait', 'aria-hidden': 'true', title: 'Needs you' }, '!');
    const time = h('span', { class: 'h-time' });
    const sub = h('span', { class: 'h-sub' });
    const btn = h('button', { type: 'button', class: 'h-row', tabindex: '-1' },
      ind, h('span', { class: 'h-main' }, h('span', { class: 'h-top' }, title, sr, wait, time), sub));
    btn.dataset.id = id;
    return { li: h('li', null, btn), btn, ind, title, sr, wait, time, sub, sig: '' };
  }

  function paintRow(row, r) {
    const selected = r.id === state.selectedId;
    const presence = r.presence in PRESENCE ? r.presence : 'history';
    const when = ago(r.lastAt);
    const sig = [r.title, r.project, r.gitBranch, presence, r.status, !!r.waiting, when, selected].join('\u0001');
    if (row.sig === sig) return;
    row.sig = sig;
    const name = r.title || r.project || r.id;
    row.btn.title = name;
    row.btn.classList.toggle('selected', selected);
    if (selected) row.btn.setAttribute('aria-current', 'true'); else row.btn.removeAttribute('aria-current');
    const status = STATUS_LABEL[r.status] ? r.status : 'idle';
    row.ind.className = `h-ind p-${presence}${presence === 'live' && (status === 'working' || status === 'waiting') ? ' pulse' : ''}`;
    row.ind.textContent = PRESENCE[presence];
    row.ind.style.setProperty('--c', presence === 'live' ? `var(--st-${status})` : presence === 'idle' ? 'var(--st-idle)' : 'var(--st-ended)');
    row.title.textContent = name;
    row.sr.textContent = `, ${presence === 'live' ? `Live, ${STATUS_LABEL[status]}` : presence === 'idle' ? 'Open, idle' : presence === 'ended' ? 'Ended' : 'History'}${r.waiting ? ', needs you' : ''},`;
    row.wait.hidden = !r.waiting;
    row.time.textContent = when;
    row.sub.textContent = [r.project, r.gitBranch].filter(Boolean).join(' · ');
  }

  let noteKey = '';
  function paintNote(recs) {
    const q = H.query.trim();
    let key = '';
    if (H.error && !H.loaded) key = 'error';
    else if (q && !complete() && H.searchError) key = 'search-error';
    else if (q && !complete() && H.searching) key = 'searching';
    else if (q && recs.length === 0) key = `nomatch:${q}`;
    else if (!H.loaded && H.loading) key = 'loading';
    else if (H.loaded && !q && recs.length === 0) key = 'empty';
    else if (!q && H.loading) key = 'more';
    else if (!q && H.error) key = 'more-error';
    list.setAttribute('aria-busy', String(H.loading || H.searching));
    if (key === noteKey) return;
    noteKey = key;
    const btn = (label, act) => h('button', { type: 'button', class: 'btn', 'data-h-act': act }, label);
    const p = (text) => h('p', null, text);
    note.setAttribute('role', key.includes('error') ? 'alert' : 'status');
    note.replaceChildren(...(
      key === 'error' ? [p("Couldn't load sessions."), btn('Retry', 'retry')]
        : key === 'search-error' ? [p("Couldn't search sessions."), btn('Retry', 'search')]
          : key === 'searching' ? [p('Searching…')]
            : key.startsWith('nomatch:') ? [p(`No sessions match "${q}"`), btn('Clear', 'clear')]
              : key === 'loading' ? [p('Loading sessions…')]
                : key === 'empty' ? [p('No sessions yet.')]
                  : key === 'more' ? [p('Loading more…')]
                    : key === 'more-error' ? [p("Couldn't load more sessions."), btn('Retry', 'more')]
                      : []));
  }

  function render() {
    if (!isOpen()) { return; }
    if (!dirty && lastSelected === state.selectedId) return;
    dirty = false;
    lastSelected = state.selectedId;
    const recs = records();
    // Don't move rows under the pointer or the keyboard focus; contents still update, order catches up later.
    const frozen = rowEls.size && (list.matches(':hover') || list.contains(document.activeElement));
    if (frozen) {
      for (const r of recs) { const row = rowEls.get(r.id); if (row) paintRow(row, r); }
      pendingReorder = true;
      paintNote(recs);
      return;
    }
    pendingReorder = false;

    const groups = new Map();
    for (const r of recs) {
      const label = groupLabel(r.lastAt || r.firstAt || 0);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(r);
    }
    const wanted = new Set(recs.map((r) => r.id));
    for (const [id, row] of rowEls) if (!wanted.has(id)) { row.li.remove(); rowEls.delete(id); }
    for (const [label, g] of groupEls) if (!groups.has(label)) { g.sec.remove(); groupEls.delete(label); }

    let curSec = list.firstElementChild;
    for (const [label, rs] of groups) {
      let g = groupEls.get(label);
      if (!g) {
        const ul = h('ul', { class: 'h-ul', role: 'list' });
        g = { sec: h('section', { class: 'h-group', 'aria-label': label }, h('h3', { class: 'h-head' }, label), ul), ul };
        groupEls.set(label, g);
      }
      if (g.sec !== curSec) list.insertBefore(g.sec, curSec); else curSec = curSec.nextElementSibling;
      let curLi = g.ul.firstElementChild;
      for (const r of rs) {
        let row = rowEls.get(r.id);
        if (!row) { row = buildRow(r.id); rowEls.set(r.id, row); }
        paintRow(row, r);
        if (row.li !== curLi) g.ul.insertBefore(row.li, curLi); else curLi = curLi.nextElementSibling;
      }
    }

    // Roving tabindex: one row in the tab order (the selected one, else the last focused, else the first).
    const target = rowEls.get(state.selectedId) || rowEls.get(rovingId) || rowEls.get(recs[0]?.id);
    for (const row of rowEls.values()) row.btn.tabIndex = row === target ? 0 : -1;
    paintNote(recs);
  }

  // ------------------------------------------------------------ events
  const unfreeze = () => { if (pendingReorder) { dirty = true; render(); } };
  list.addEventListener('mouseleave', unfreeze);
  list.addEventListener('focusout', (e) => { if (!list.contains(e.relatedTarget)) setTimeout(unfreeze); });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.h-row');
    if (!btn) return;
    rovingId = btn.dataset.id;
    onPick(btn.dataset.id, btn);
  });
  list.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const rows = [...list.querySelectorAll('.h-row')];
    const i = rows.indexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[i].tabIndex = -1;
    rows[j].tabIndex = 0;
    rovingId = rows[j].dataset.id;
    rows[j].focus();
  });

  note.addEventListener('click', (e) => {
    const act = e.target.closest('[data-h-act]')?.dataset.hAct;
    if (act === 'retry') loadPage(null);
    else if (act === 'more') { H.error = null; loadPage(H.next); }
    else if (act === 'search') search(H.query.trim());
    else if (act === 'clear') { input.value = ''; setQuery(''); input.focus(); }
  });

  function setQuery(v) {
    H.query = v;
    searchGen++;
    Object.assign(H, { results: null, searching: false, searchError: null });
    if (v.trim() && !complete()) search(v.trim());
    dirty = true; render();
    if (!v.trim()) recheck();
  }
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setQuery(input.value), SEARCH_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (input.value) { input.value = ''; clearTimeout(searchTimer); setQuery(''); } else input.blur();
  });

  // ------------------------------------------------------------ API for app.js
  return {
    render,
    // First time the tab opens: load the first page (never at dashboard start).
    activate() {
      dirty = true;
      if (!H.loaded && !H.loading && !H.error) loadPage(null);
      else render();
    },
    onIndex(msg) {
      if (msg.op === 'upsert' && msg.record?.id) {
        state.history.set(msg.record.id, msg.record);
        if (H.results) H.results = H.results.map((r) => (r.id === msg.record.id ? msg.record : r));
      } else if (msg.op === 'remove' && msg.id) {
        state.history.delete(msg.id);
        if (H.results) H.results = H.results.filter((r) => r.id !== msg.id);
      }
      dirty = true;
    },
    onReconnect() { if (H.loaded) refetch(); },
    tick() { dirty = true; render(); },
    focusSearch() { input.focus(); input.select(); },
    rowFor(id) { return rowEls.get(id)?.btn || null; },
  };
}
