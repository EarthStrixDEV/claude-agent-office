import { createOffice, STATUS_LABEL, progressOf, periodOf, isNightHour, shortModel, MODE_TAG } from './scene.js';
import { initWorkspace } from './workspace.js';

// ------------------------------------------------------------------ token
function readToken() {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) {
    const t = decodeURIComponent(m[1]);
    try { sessionStorage.setItem('office-token', t); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return t;
  }
  try { return sessionStorage.getItem('office-token'); } catch { return null; }
}
let TOKEN = readToken();

// ------------------------------------------------------------------ state
const state = {
  limits: null,
  external: [],
  sessions: new Map(),
  approvals: [],
  feed: [],
  selectedId: null,
  detailTab: 'progress',
  dockTab: 'assign',
  connected: false,
};

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only re-touch the DOM when the markup really changed, so buttons aren't swapped out mid-click.
const lastHTML = new WeakMap();
function setHTML(el, html) {
  if (lastHTML.get(el) === html) return;
  lastHTML.set(el, html);
  el.innerHTML = html;
}
const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const chip = (status) => `<span class="chip${status === 'waiting' || status === 'working' ? ' pulse' : ''}" style="--c:var(--st-${STATUS_LABEL[status] ? status : 'idle'})">${esc(STATUS_LABEL[status] || status)}</span>`;
const modeChip = (m) => {
  if (!m) return '';
  const t = MODE_TAG[m];
  return t ? `<span class="tag" style="--c:${t[1]}">${esc(t[0])}</span>` : `<span class="tag plain">Default</span>`;
};
const skillChip = (s) => (s.skill?.active ? `<span class="tag skill" title="Skill in use">🧩 ${esc(s.skill.name)}</span>` : '');
const modelChips = (s) => `${skillChip(s)}${s.model ? `<span class="tag plain" title="${esc(s.model)}">${esc(shortModel(s.model))}</span>` : ''}${s.effort ? `<span class="tag plain">${esc(s.effort)}</span>` : ''}${modeChip(s.permissionMode)}`;
const isActive = (s) => s.status !== 'ended' && s.status !== 'stale';

// Cards that need you float to the top; everything else keeps a stable order (by start time),
// so the list doesn't reshuffle every time an agent switches between thinking and working.
function sortedSessions() {
  const rank = (st) => (st === 'waiting' || st === 'error' ? 0 : st === 'ended' || st === 'stale' ? 2 : 1);
  return [...state.sessions.values()].sort((a, b) => rank(a.status) - rank(b.status) || a.startedAt - b.startedAt);
}

// ------------------------------------------------------------ atmosphere
// Scene time of day, panel colours and render quality: remembered per browser.
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const realHour = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };
const pick = (v, list, d) => (list.includes(v) ? v : d);
const atmo = {
  mode: pick(store.get('office-time-mode'), ['real', 'manual', 'lapse'], 'real'),
  hour: parseFloat(store.get('office-hour', 'NaN')),
  panels: pick(store.get('office-panels'), ['auto', 'light', 'dark'], 'auto'),
  quality: pick(store.get('office-quality'), ['standard', 'ultra'], matchMedia('(pointer: coarse)').matches || innerWidth < 860 ? 'standard' : 'ultra'),
};
if (atmo.mode === 'real' || Number.isNaN(atmo.hour)) atmo.hour = realHour(); // manual and time-lapse resume where they were
const panelTheme = () => (atmo.panels === 'auto' ? (isNightHour(atmo.hour) ? 'dark' : 'light') : atmo.panels);

// ------------------------------------------------------------------ scene
const office = createOffice($('#scene'), {
  hour: atmo.hour,
  uiTheme: panelTheme(),
  quality: atmo.quality,
  onSelect: (id) => {
    if (id === 'minju') { setDockTab(state.approvals.length ? 'ask' : 'assign'); office.focus('minju'); expandDock(); return; }
    if (id === 'grok') { setDockTab('grok'); office.focus('grok'); expandDock(); return; }
    if (id === 'library') { workspace.open(state.selectedId || sortedSessions().find(isActive)?.id || null, 'skills'); office.focus('library'); return; }
    select(id);
  },
});

// ------------------------------------------------------------ workspace
async function dispatchTask(sessionId, text, skill = '') {
  try {
    const r = await api('/api/dispatch', { sessionId, text, skill });
    office.pulse(sessionId, 'out');
    toast(r.delivered ? '📨 Delivered: the agent is on it' : `📥 Queued (${r.queued}): delivered when the current turn ends`);
    return true;
  } catch (err) { toast(`⚠️ ${err.message}`); return false; }
}
const workspace = initWorkspace({
  api, toast, state, esc, setHTML, ago,
  dispatch: dispatchTask,
  assignWithSkill(sessionId, skill) {
    if (sessionId && state.sessions.get(sessionId) && isActive(state.sessions.get(sessionId))) $('#assign-target').value = sessionId;
    renderAssignTargets();
    pendingSkill = skill;
    loadAssignSkills().then(() => { $('#assign-text').focus(); });
    workspace.close();
    setDockTab('assign');
    expandDock();
  },
});

// Skill picker on Minju's desk: the target session's skills, with a compact Skill Guide Block.
let pendingSkill = '';
let assignSkills = [];
let assignSkillsFor = null;
async function loadAssignSkills() {
  const sessionId = $('#assign-target').value;
  const sel = $('#assign-skill');
  if (!sessionId) { sel.innerHTML = '<option value="">No skill</option>'; assignSkills = []; renderAssignGuide(); return; }
  try {
    const r = await workspace.loadSkills(sessionId);
    assignSkills = r.skills.filter((x) => x.userInvocable || x.modelInvocable);
    const want = pendingSkill || sel.value;
    sel.innerHTML = `<option value="">No skill</option>${assignSkills.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}`;
    if (assignSkills.some((x) => x.name === want)) sel.value = want;
    pendingSkill = '';
  } catch { /* skills are optional */ }
  renderAssignGuide();
}
function renderAssignGuide() {
  const sk = assignSkills.find((x) => x.name === $('#assign-skill').value);
  setHTML($('#assign-guide'), sk ? workspace.guideBlock(sk, { compact: true }) : '');
  $('#assign-text').placeholder = sk ? `What should ${sk.name} do?${sk.argumentHint ? ` (arguments: ${sk.argumentHint})` : ''}` : 'e.g. Run the test suite and fix anything that fails';
}

function select(id, fly = true) {
  state.selectedId = id;
  if (fly) office.focus(id);
  if (id && state.sessions.get(id) && isActive(state.sessions.get(id))) $('#assign-target').value = id;
  document.body.classList.add('show-right');
  document.body.classList.remove('show-left');
  renderAll();
}

// ------------------------------------------------------------------ api
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ------------------------------------------------------------------ render
function renderStats() {
  const all = [...state.sessions.values()];
  const active = all.filter(isActive);
  const working = active.filter((s) => ['working', 'thinking', 'compacting'].includes(s.status)).length;
  const waiting = Math.max(state.approvals.length, active.filter((s) => s.status === 'waiting').length);
  const bg = active.reduce((n, s) => n + Object.keys(s.background || {}).length, 0);
  const subs = active.reduce((n, s) => n + Object.values(s.subagents || {}).filter((a) => a.status !== 'done').length, 0);
  setHTML($('#stats'), [
    `<div class="stat"><b>${active.length}</b><span>sessions</span></div>`,
    `<div class="stat"><b>${working}</b><span>working</span></div>`,
    `<div class="stat${waiting ? ' alert' : ''}"><b>${waiting}</b><span>need you</span></div>`,
    `<div class="stat"><b>${subs}</b><span>subagents</span></div>`,
    `<div class="stat"><b>${bg}</b><span>background</span></div>`,
  ].join(''));
  document.title = waiting ? `(${waiting}) Agent Office` : 'Agent Office';
}

// Each card is a long-lived <button>: only its contents change, so a click never lands on a node
// that was just replaced.
const cardEls = new Map();
function renderSessions() {
  const list = sortedSessions();
  const host = $('#session-list');
  $('#session-count').textContent = list.length ? `${list.filter(isActive).length} active` : '';
  if (!list.length) {
    cardEls.clear();
    setHTML(host, `<div class="empty"><span class="big">🪑</span>The office is empty.<br>Start a Claude Code session with the hooks installed, or run <code>npm run mock</code>.</div>`);
    return;
  }
  let wrap = host.querySelector(':scope > .session-list');
  if (!wrap) {
    host.innerHTML = '<div class="session-list"></div>';
    lastHTML.delete(host);
    wrap = host.firstElementChild;
  }
  const seen = new Set();
  list.forEach((s, i) => {
    let el = cardEls.get(s.id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.dataset.id = s.id;
      cardEls.set(s.id, el);
    }
    el.className = `s-card${s.id === state.selectedId ? ' selected' : ''}${isActive(s) ? '' : ' ended'}`;
    const p = progressOf(s);
    const bg = Object.keys(s.background || {}).length;
    const subs = Object.values(s.subagents || {}).filter((a) => a.status !== 'done').length;
    setHTML(el, `
      <div class="s-row"><span class="s-name">${esc(s.project)}</span>${chip(s.status)}</div>
      <div class="s-act">${esc(s.activity || '—')}</div>
      <div class="s-tags">${modelChips(s)}</div>
      ${p.total ? `<div class="bar"><i style="width:${(p.done / p.total) * 100}%"></i></div>` : ''}
      <div class="s-meta">
        ${p.total ? `<span>${p.done}/${p.total} tasks</span>` : ''}
        ${subs ? `<span>👥 ${subs}</span>` : ''}
        ${bg ? `<span>⚙︎ ${bg} bg</span>` : ''}
        ${s.queued ? `<span>📥 ${s.queued}</span>` : ''}
        <span style="margin-left:auto">${ago(s.lastAt)}</span>
      </div>`);
    if (wrap.children[i] !== el) wrap.insertBefore(el, wrap.children[i] || null);
    seen.add(s.id);
  });
  for (const [id, el] of cardEls) if (!seen.has(id)) { el.remove(); cardEls.delete(id); }
}

function renderDetail() {
  const s = state.sessions.get(state.selectedId);
  const el = $('#detail');
  if (!s) {
    setHTML(el, `<div class="panel-head"><h2>Session detail</h2></div>
      <div class="empty"><span class="big">💜</span>Click a desk in the office, or a session in the list.</div>`);
    return;
  }
  const p = progressOf(s);
  const tabs = [['progress', 'Progress'], ['background', 'Background'], ['trail', 'Env trail'], ['status', 'Status']];
  let body = '';

  if (state.detailTab === 'progress') {
    body = p.total
      ? `<div class="s-row"><b>${p.done} of ${p.total} done</b><span class="muted small" style="margin-left:auto">${Math.round((p.done / p.total) * 100)}%</span></div>
         <div class="bar big"><i style="width:${(p.done / p.total) * 100}%"></i></div>
         <ul class="list" style="margin-top:10px">${p.items.map((t) => `<li><span class="check ${t.done ? 'done' : t.active ? 'active' : ''}">${t.done ? '✓' : ''}</span><div class="li-main">${esc(t.subject)}</div></li>`).join('')}</ul>`
      : `<div class="empty"><span class="big">📋</span>No task list yet.<br>Progress appears when Claude creates tasks or todos.</div>`;
  } else if (state.detailTab === 'background') {
    const bg = Object.values(s.background || {});
    const subs = Object.values(s.subagents || {});
    body = (bg.length ? `<div class="section-title">Background jobs</div><ul class="list">${bg.map((b) => `<li><span class="kind">${esc(b.type)}</span><div class="li-main">${esc(b.description || b.id)}<div class="li-sub">${esc(b.status)} · ${ago(b.since)}</div></div></li>`).join('')}</ul>` : '')
      + (subs.length ? `<div class="section-title">Subagents</div><ul class="list">${subs.map((a) => `<li><span class="check ${a.status === 'done' ? 'done' : 'active'}">${a.status === 'done' ? '✓' : ''}</span><div class="li-main"><b>${esc(a.type)}</b><div class="li-sub">${esc(a.activity)}</div></div></li>`).join('')}</ul>` : '')
      || `<div class="empty"><span class="big">⚙︎</span>No background jobs or subagents.</div>`;
  } else if (state.detailTab === 'trail') {
    const trail = [...(s.trail || [])].reverse();
    body = `<ul class="list">${trail.map((e) => `<li><span class="trail-time">${clock(e.t).slice(0, 5)}</span><span class="kind ${esc(e.kind)}">${esc(e.kind)}</span><div class="li-main">${esc(e.text)}</div></li>`).join('')}</ul>`;
  } else {
    body = `<dl class="kv">
        <dt>Status</dt><dd>${esc(STATUS_LABEL[s.status] || s.status)}</dd>
        <dt>Doing</dt><dd title="${esc(s.activity)}">${esc(s.activity || '—')}</dd>
        <dt>Tool calls</dt><dd>${s.toolCount}</dd>
        <dt>Errors</dt><dd>${s.errorCount}</dd>
        <dt>Skills</dt><dd>${Object.keys(s.skillsUsed || {}).length ? Object.entries(s.skillsUsed).map(([n, c]) => `${esc(n)}${c > 1 ? ` ×${c}` : ''}`).join(', ') : '—'}</dd>
        <dt>Files</dt><dd>${(s.touched || []).filter((t) => t.op !== 'read').length} changed · ${(s.touched || []).filter((t) => t.op === 'read').length} read</dd>
        <dt>Queued</dt><dd>${s.queued || 0} task(s)</dd>
        <dt>Standby</dt><dd>${s.standby ? (s.waitingForTask ? 'on · waiting at desk' : 'on') : 'off'}</dd>
        <dt>Started</dt><dd>${clock(s.startedAt)}</dd>
        <dt>Last event</dt><dd>${ago(s.lastAt)} ago</dd>
        <dt>Session</dt><dd title="${esc(s.id)}">${esc(s.id)}</dd>
      </dl>
      ${s.lastMessage ? `<div class="section-title">Last reply</div><div class="quote">${esc(s.lastMessage)}</div>` : ''}
      <div class="detail-actions">
        <button class="btn primary" data-act="workspace">Open workspace</button>
        ${isActive(s) ? `<button class="btn" data-act="assign">Assign a task</button>` : ''}
        ${s.queued ? `<button class="btn" data-act="clear-queue">Clear queue</button>` : ''}
        <button class="btn ghost" data-act="forget">Remove from office</button>
      </div>`;
  }

  setHTML(el, `
    <div class="detail-head" style="--c:var(--st-${STATUS_LABEL[s.status] ? s.status : 'idle'})">
      <div class="detail-title"><h3 title="${esc(s.project)}">${esc(s.project)}</h3>${chip(s.status)}<button class="icon-btn" data-act="workspace" title="Open workspace: files, changes, skills" aria-label="Open workspace">🗂</button><button class="icon-btn" data-act="close" aria-label="Close detail">✕</button></div>
      <dl class="kv">
        <dt>cwd</dt><dd title="${esc(s.cwd)}">${esc(s.cwd || '—')}</dd>
        <dt>model</dt><dd title="${esc(s.model || '')}">${esc(shortModel(s.model) || '—')}${s.effort ? ` · effort ${esc(s.effort)}` : ''}</dd>
        <dt>mode</dt><dd>${modeChip(s.permissionMode) || '—'}${s.permissionMode === 'bypassPermissions' ? ' <span class="warn">no prompts at all</span>' : ''}</dd>
        ${s.context != null || s.cost != null ? `<dt>usage</dt><dd>${s.context != null ? `context ${s.context}%` : ''}${s.context != null && s.cost != null ? ' · ' : ''}${s.cost != null ? `$${Number(s.cost).toFixed(2)}` : ''}</dd>` : ''}
      </dl>
    </div>
    <div class="tabs detail-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab${state.detailTab === k ? ' active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="scroll"><div class="detail-body">${body}</div></div>`);
}

function renderAsk() {
  const n = state.approvals.length;
  const badge = $('#ask-count');
  badge.hidden = !n;
  badge.textContent = n;
  $('#dock').classList.toggle('alerting', n > 0);
  if (!n) {
    setHTML($('#ask-pane'), `<div class="empty"><span class="big">🙆‍♀️</span>Nobody needs you right now.<br><span class="small">Permission requests show up here while this page is open; otherwise Claude asks in its own window.</span></div>`);
    return;
  }
  setHTML($('#ask-pane'), state.approvals.map((a) => `
    <div class="ask-card" data-id="${esc(a.id)}">
      <div class="ask-top">${chip('waiting')}<b>${esc(a.project)}${a.agentType ? ` › ${esc(a.agentType)}` : ''}</b><span class="muted small">wants to use <b>${esc(a.tool)}</b></span></div>
      <div class="ask-cmd">${esc(a.detail || a.summary || a.tool)}</div>
      ${a.always ? `<p class="ask-always">Always allow will ${esc(a.always)}</p>` : ''}
      <div class="ask-actions">
        <button class="btn allow" data-decide="allow">Allow</button>
        ${a.always ? `<button class="btn" data-decide="always" title="${esc(a.always)}">Always allow</button>` : ''}
        <button class="btn deny" data-decide="deny">Deny</button>
        <button class="btn ghost" data-decide="terminal">Answer in Claude</button>
        <span class="timer" data-expires="${a.expiresAt}"></span>
      </div>
    </div>`).join(''));
  tickTimers();
}

function tickTimers() {
  for (const el of document.querySelectorAll('.timer[data-expires]')) {
    const s = Math.max(0, Math.round((Number(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = `hands back to Claude in ${s}s`;
  }
}

function renderFeed() {
  const items = state.feed.slice(-80).reverse();
  setHTML($('#feed-pane'), items.length
    ? items.map((e) => `<div class="feed-item"><span class="trail-time">${clock(e.t)}</span><span class="who">${esc(e.project)}</span><span class="kind ${esc(e.kind)}">${esc(e.kind)}</span><span class="what" title="${esc(e.text)}">${esc(e.text)}</span></div>`).join('')
    : `<div class="empty">Quiet office. Events stream in here.</div>`);
}

function renderAssignTargets() {
  const sel = $('#assign-target');
  const current = sel.value;
  const active = sortedSessions().filter(isActive);
  setHTML(sel, active.length
    ? active.map((s) => `<option value="${esc(s.id)}">${esc(s.project)} · ${esc(STATUS_LABEL[s.status])}</option>`).join('')
    : `<option value="">No active sessions</option>`);
  if (active.some((s) => s.id === current)) sel.value = current;
  else if (active.some((s) => s.id === state.selectedId)) sel.value = state.selectedId;
  const s = state.sessions.get(sel.value);
  $('#assign-standby').checked = !!s?.standby;
  $('#assign-standby').disabled = !s;
  if (sel.value !== assignSkillsFor) { assignSkillsFor = sel.value; loadAssignSkills(); }
  setHTML($('#assign-hint'), s?.waitingForTask
    ? `<b>${esc(s.project)}</b> is waiting at its desk: a task you send now starts right away.`
    : `A task reaches the session when its current turn finishes. Turn on <b>Standby</b> to have an idle session wait at its desk for the next task.`);
}

// ------------------------------------------------------------ limits
const until = (ms) => {
  if (!ms) return '';
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const limitLevel = (pct) => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok');
function limitBar(label, w) {
  if (!w) return '';
  const pct = Math.max(0, Math.min(100, w.pct));
  return `<div class="lim ${limitLevel(pct)}" title="${label}: ${pct.toFixed(1)}% used${w.resetsAt ? ` · resets in ${until(w.resetsAt)}` : ''}">
    <span class="lim-name">${label}</span>
    <span class="lim-bar"><i style="width:${pct}%"></i></span>
    <b>${Math.round(pct)}%</b>
    ${w.resetsAt ? `<span class="lim-reset">${until(w.resetsAt)}</span>` : ''}
  </div>`;
}
function renderLimits() {
  const L = state.limits;
  const live = (w) => (w && (!w.resetsAt || w.resetsAt > Date.now()) ? w : null);
  const five = live(L?.fiveHour), week = live(L?.sevenDay);
  let html = limitBar('5h', five) + limitBar('Week', week);
  if (!html && L?.spend?.pct != null) html = limitBar('Spend', { pct: L.spend.pct, resetsAt: L.spend.resetsAt });
  if (!html) html = `<span class="lim-empty" title="Run npm run hooks:install to add the Agent Office statusline. Limits appear for claude.ai Pro, Max and Ultra plans after the first reply in a session.">Limits: no data yet</span>`;
  if (L?.hitAt && Date.now() - L.hitAt < 15 * 60_000) html += `<span class="lim-hit">Rate limited</span>`;
  setHTML($('#limits'), html);
}

// ------------------------------------------------------------ Grok Bots
const BOT_STATUS = { working: 'working', idle: 'idle', waiting: 'waiting', error: 'error', done: 'standby' };
function renderGrok() {
  const g = state.external.find((x) => x.source === 'grok') || { name: 'Grok Bot', bots: [], routines: [] };
  const need = g.bots.filter((b) => b.status === 'waiting').length;
  $('#grok-count').hidden = !need;
  $('#grok-count').textContent = need;
  const bots = g.bots.length
    ? `<ul class="list">${g.bots.map((b) => `<li>
        <span class="bot-dot ${esc(b.shape)}" style="--c:${esc(b.color || '#8A7CF0')}"></span>
        <div class="li-main"><b>${esc(b.name)}</b> ${chip(BOT_STATUS[b.status] || 'idle').replace(/>[^<]*<\/span>$/, `>${esc(b.status === 'waiting' ? 'Needs you' : b.status[0].toUpperCase() + b.status.slice(1))}</span>`)}
          <div class="li-sub">${esc(b.activity || '—')}</div>
          ${b.progress?.total ? `<div class="bar"><i style="width:${(b.progress.done / b.progress.total) * 100}%"></i></div>` : ''}
        </div>
        <span class="trail-time">${ago(b.updatedAt)}</span>
      </li>`).join('')}</ul>`
    : `<div class="empty"><span class="big">◇</span>No Grok Bots are reporting yet.</div>`;
  const routines = g.routines?.length
    ? `<div class="section-title">Run a routine</div>
       <form class="grok-run" id="grok-run">
         <select id="grok-routine">${g.routines.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select>
         <input id="grok-text" placeholder="Optional note for the Bot" maxlength="4000">
         <button class="btn primary" type="submit">Run</button>
       </form>`
    : '';
  const help = `<details class="help"><summary>How Grok Bots get here</summary>
      <p>Grok Bot has no status API, so the office can't read it on its own. Anything that can make an HTTP request can report: <code>POST /api/external/grok</code> with the <code>X-Office-Token</code> header and <code>{"bots":[{"id","name","color","shape","status","activity","progress"}]}</code>. Status is one of working, idle, waiting, error or done.</p>
      <p>To start routines from here, put each routine's webhook URL and key in <code>~/.agent-office/external.json</code>. Keys stay in the bridge and never reach this page.</p>
    </details>`;
  const pane = $('#grok-pane');
  if (pane.contains(document.activeElement)) return; // don't clobber what you're typing
  setHTML(pane, bots + routines + help);
}

function renderConn() {
  $('#conn').classList.toggle('ok', state.connected);
  $('.conn-text').textContent = state.connected ? 'Live' : 'Reconnecting…';
}

let raf = 0;
function renderAll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderStats();
    renderSessions();
    renderDetail();
    renderAsk();
    renderFeed();
    renderConn();
    renderLimits();
    renderGrok();
    if (document.activeElement !== $('#assign-target')) renderAssignTargets();
    office.update([...state.sessions.values()], state.approvals, state.selectedId);
  });
}

// ------------------------------------------------------------------ dock
function setDockTab(tab) {
  state.dockTab = tab;
  document.querySelectorAll('[data-dock]').forEach((b) => b.classList.toggle('active', b.dataset.dock === tab));
  document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
}
function expandDock() { $('#dock').classList.remove('collapsed'); }
document.querySelectorAll('[data-dock]').forEach((b) => b.addEventListener('click', () => {
  setDockTab(b.dataset.dock);
  expandDock();
  if (b.dataset.dock === 'grok') office.focus('grok');
}));
$('#dock-collapse').addEventListener('click', () => $('#dock').classList.toggle('collapsed'));
setDockTab('assign');

// ------------------------------------------------------------------ events
$('#session-list').addEventListener('click', (e) => {
  const card = e.target.closest('.s-card');
  if (card) select(card.dataset.id);
});

$('#detail').addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { state.detailTab = tab.dataset.tab; renderAll(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const id = state.selectedId;
  if (act === 'close') { state.selectedId = null; document.body.classList.remove('show-right'); office.overview(); renderAll(); return; }
  if (act === 'workspace') { workspace.open(id, 'files'); return; }
  if (act === 'assign') { $('#assign-target').value = id; renderAssignTargets(); setDockTab('assign'); expandDock(); $('#assign-text').focus(); return; }
  try {
    if (act === 'forget') { await api('/api/forget', { sessionId: id }); state.selectedId = null; toast('Removed from the office'); }
    if (act === 'clear-queue') { await api('/api/clear-queue', { sessionId: id }); toast('Queue cleared'); }
  } catch (err) { toast(`⚠️ ${err.message}`); }
});

$('#ask-pane').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-decide]');
  if (!btn) return;
  const card = btn.closest('.ask-card');
  card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    await api('/api/approval', { id: card.dataset.id, behavior: btn.dataset.decide });
    toast(btn.dataset.decide === 'always' ? '✅ Allowed, and the rule is saved' : btn.dataset.decide === 'allow' ? '✅ Allowed' : btn.dataset.decide === 'deny' ? '⛔ Denied' : '↩︎ Handed back to Claude');
  } catch (err) {
    toast(`⚠️ ${err.message}`);
    card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
});

$('#grok-pane').addEventListener('submit', async (e) => {
  if (e.target.id !== 'grok-run') return;
  e.preventDefault();
  try {
    const r = await api('/api/external/grok/trigger', { routine: $('#grok-routine').value, text: $('#grok-text').value });
    $('#grok-text').value = '';
    toast(`🚀 Routine started (HTTP ${r.status})`);
  } catch (err) { toast(`⚠️ ${err.message}`); }
});
$('#assign-target').addEventListener('change', renderAssignTargets);
$('#assign-skill').addEventListener('change', renderAssignGuide);
$('#assign-standby').addEventListener('change', async (e) => {
  try {
    await api('/api/standby', { sessionId: $('#assign-target').value, on: e.target.checked });
    toast(e.target.checked ? '🪑 Standby on: the session waits at its desk after each turn' : 'Standby off');
  } catch (err) { toast(`⚠️ ${err.message}`); e.target.checked = !e.target.checked; }
});
$('#assign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sessionId = $('#assign-target').value;
  const text = $('#assign-text').value.trim();
  const skill = $('#assign-skill').value;
  if (!sessionId) return;
  if (!text && !skill) { toast('Write a task, or pick a skill'); $('#assign-text').focus(); return; }
  if (await dispatchTask(sessionId, text, skill)) $('#assign-text').value = '';
});
$('#assign-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#assign-form').requestSubmit();
});

const fmtHour = (h) => {
  const m = Math.floor((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const MODE_NOTE = {
  real: "Following this computer's clock.",
  manual: 'Holding the time you picked. Choose Real time to follow the clock again.',
  lapse: 'A whole day passes every 2 minutes.',
};
let appliedTheme = null;
function applyAtmo(save = true) {
  office.setTime(atmo.hour);
  const theme = panelTheme();
  if (theme !== appliedTheme) {
    appliedTheme = theme;
    document.documentElement.dataset.theme = theme;
    office.setUiTheme(theme);
  }
  const p = periodOf(atmo.hour);
  $('#time-clock').textContent = fmtHour(atmo.hour);
  $('#time-ic').textContent = p.icon;
  $('#tp-clock').textContent = fmtHour(atmo.hour);
  $('#tp-period').textContent = p.name;
  if (document.activeElement !== $('#tp-hour')) $('#tp-hour').value = atmo.hour;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === atmo.mode)));
  document.querySelectorAll('[data-panels]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.panels === atmo.panels)));
  document.querySelectorAll('[data-quality]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.quality === atmo.quality)));
  document.querySelectorAll('[data-hour]').forEach((b) => b.setAttribute('aria-pressed', String(atmo.mode === 'manual' && Math.abs(Number(b.dataset.hour) - atmo.hour) < 0.05)));
  $('#tp-note').textContent = MODE_NOTE[atmo.mode];
  if (save) {
    store.set('office-time-mode', atmo.mode);
    store.set('office-hour', String(atmo.hour));
    store.set('office-panels', atmo.panels);
    store.set('office-quality', atmo.quality);
  }
}
function setManualHour(h) { atmo.mode = 'manual'; atmo.hour = h; applyAtmo(); }
$('#tp-hour').addEventListener('input', (e) => setManualHour(Number(e.target.value)));
$('#time-panel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.hour) setManualHour(Number(b.dataset.hour));
  else if (b.dataset.mode) { atmo.mode = b.dataset.mode; if (atmo.mode === 'real') atmo.hour = realHour(); applyAtmo(); }
  else if (b.dataset.panels) { atmo.panels = b.dataset.panels; applyAtmo(); }
  else if (b.dataset.quality) { atmo.quality = b.dataset.quality; office.setQuality(atmo.quality); applyAtmo(); }
});
function setTimePanel(open) {
  $('#time-panel').hidden = !open;
  $('#time-btn').setAttribute('aria-expanded', String(open));
  if (open) document.querySelector('#tp-mode [aria-pressed="true"]')?.focus({ preventScroll: true });
}
$('#time-btn').addEventListener('click', () => setTimePanel($('#time-panel').hidden));
$('#tp-close').addEventListener('click', () => { setTimePanel(false); $('#time-btn').focus(); });
document.addEventListener('pointerdown', (e) => {
  if (!$('#time-panel').hidden && !e.target.closest('#time-panel, #time-btn')) setTimePanel(false);
});
let lapseSaved = 0;
setInterval(() => {
  if (atmo.mode === 'lapse') {
    atmo.hour = (atmo.hour + 24 / 120 / 10) % 24;
    applyAtmo(++lapseSaved % 50 === 0);
  } else if (atmo.mode === 'real' && Math.abs(realHour() - atmo.hour) > 1 / 120) {
    atmo.hour = realHour();
    applyAtmo(false);
  }
}, 100);
applyAtmo();

$('#toggle-left').addEventListener('click', () => { document.body.classList.toggle('show-left'); document.body.classList.remove('show-right'); });
$('#toggle-right').addEventListener('click', () => { document.body.classList.toggle('show-right'); document.body.classList.remove('show-left'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && workspace.isOpen() && !e.target.closest('input, textarea, select')) { workspace.close(); return; }
  if (e.key === 'Escape' && !$('#time-panel').hidden) { setTimePanel(false); $('#time-btn').focus(); return; }
  if (e.key === 'Escape' && !e.target.closest('input, textarea, select')) { state.selectedId = null; document.body.classList.remove('show-left', 'show-right'); office.overview(); renderAll(); }
});

// ------------------------------------------------------------------ stream
let es;
let retry = 0;
function connect() {
  if (!TOKEN) { $('#gate').hidden = false; return; }
  es?.close();
  es = new EventSource(`/events?token=${encodeURIComponent(TOKEN)}`);
  es.onopen = () => { state.connected = true; retry = 0; renderAll(); };
  es.onerror = async () => {
    state.connected = false;
    renderConn();
    if (es.readyState === EventSource.CLOSED) {
      // Either the bridge is down or the token is wrong.
      const up = await fetch('/health').then((r) => r.ok).catch(() => false);
      if (up && retry > 1) { $('#gate').hidden = false; return; }
      retry++;
      setTimeout(connect, Math.min(10_000, 1000 * 2 ** retry));
    }
  };
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      state.sessions = new Map(msg.sessions.map((s) => [s.id, s]));
      state.approvals = msg.approvals;
      state.feed = msg.feed;
      state.limits = msg.limits || null;
      state.external = msg.external || [];
      office.setExternal(state.external);
      if (state.approvals.length) setDockTab('ask');
    } else if (msg.type === 'session') {
      state.sessions.set(msg.session.id, msg.session);
      workspace.onSessionUpdate(msg.session.id);
    } else if (msg.type === 'limits') {
      state.limits = msg.limits;
    } else if (msg.type === 'external') {
      const i = state.external.findIndex((x) => x.source === msg.data.source);
      if (i >= 0) state.external[i] = msg.data; else state.external.push(msg.data);
      office.setExternal(state.external);
    } else if (msg.type === 'removed') {
      state.sessions.delete(msg.id);
      if (state.selectedId === msg.id) state.selectedId = null;
    } else if (msg.type === 'approvals') {
      const grew = msg.list.length > state.approvals.length;
      state.approvals = msg.list;
      if (grew) { setDockTab('ask'); expandDock(); }
    } else if (msg.type === 'feed') {
      state.feed.push(msg.entry);
      if (state.feed.length > 300) state.feed.splice(0, state.feed.length - 300);
      const k = msg.entry.kind;
      if (k === 'tool' || k === 'task' || k === 'subagent') office.pulse(msg.entry.sessionId, 'in');
      else if (k === 'permission') office.pulse(msg.entry.sessionId, 'in', '#fbbf24');
      else if (k === 'dispatch') office.pulse(msg.entry.sessionId, 'out');
      else if (k === 'error') office.pulse(msg.entry.sessionId, 'in', '#f87171');
    }
    renderAll();
  };
}

$('#gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  TOKEN = $('#gate-token').value.trim();
  try { sessionStorage.setItem('office-token', TOKEN); } catch {}
  $('#gate').hidden = true;
  retry = 0;
  connect();
});

setInterval(tickTimers, 1000);
setInterval(renderLimits, 30_000);
setInterval(() => { if (state.sessions.size) renderSessions(); }, 30_000);
renderAll();
connect();
