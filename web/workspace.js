// Workspace drawer: Files (read-only explorer), Changes (git diff, stage, commit, branches),
// Skills (library + Skill Guide Block), Plugins (marketplace) and MCP (servers + connectors).
// Also feeds the skill picker on Minju's desk.

export function initWorkspace(ctx) {
  const { api, toast, state, esc, setHTML, ago, dispatch } = ctx;
  const $ = (s) => document.querySelector(s);
  const ws = {
    open: false, sessionId: null, tab: 'files',
    tree: new Map(), expanded: new Set(), view: null,
    git: null, branches: null, busy: false,
    skills: null, used: {}, query: '', guideId: null, guides: new Map(),
    market: null, mQuery: '', mCat: '', mSel: null,
    mcp: null, mcpSel: null,
  };
  const skillCache = new Map();

  // ------------------------------------------------------------ helpers
  const session = () => state.sessions.get(ws.sessionId);
  const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const OP = { edit: ['E', 'Edited'], write: ['W', 'Written'], read: ['R', 'Read'] };
  const shq = (v) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${String(v).replace(/'/g, "'\\''")}'`);
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('📋 Copied. Paste it in your terminal'); }
    catch { window.prompt('Copy this command:', text); }
  }
  const cmdLine = (cmd) => `<div class="cmd"><code>${esc(cmd)}</code><button class="btn" data-copy="${esc(cmd)}">Copy</button></div>`;

  // A tiny, safe Markdown renderer for SKILL.md bodies: escape first, then format.
  function md(src) {
    const lines = String(src || '').split('\n');
    let html = '', inCode = false, inList = false;
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    for (const line of lines) {
      if (/^```/.test(line)) { if (inList) { html += '</ul>'; inList = false; } html += inCode ? '</code></pre>' : '<pre class="md-code"><code>'; inCode = !inCode; continue; }
      if (inCode) { html += `${esc(line)}\n`; continue; }
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const n = Math.min(6, h[1].length + 3); html += `<h${n}>${inline(h[2])}</h${n}>`; continue; }
      if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (inList) html += '</ul>';
    if (inCode) html += '</code></pre>';
    return html;
  }

  async function loadSkills(sessionId, force = false) {
    const key = sessionId || '';
    const hit = skillCache.get(key);
    if (!force && hit && Date.now() - hit.at < 60_000) return hit;
    const r = await api('/api/ws/skills', { sessionId });
    const entry = { at: Date.now(), skills: r.skills, used: r.used || {} };
    skillCache.set(key, entry);
    return entry;
  }
  async function loadGuide(id) {
    if (ws.guides.has(id)) return ws.guides.get(id);
    const g = await api('/api/ws/skill', { id });
    ws.guides.set(id, g.body);
    return g.body;
  }

  // The Skill Guide Block: what a skill does, when to use it, how to call it.
  function guideBlock(sk, { body = null, used = 0, compact = false } = {}) {
    if (!sk) return '';
    const invoke = `/${sk.name}${sk.argumentHint ? ` ${sk.argumentHint}` : ''}`;
    return `<article class="guide${compact ? ' compact' : ''}">
      <header>
        <span class="guide-ic" aria-hidden="true">🧩</span>
        <div class="guide-name"><h4>${esc(sk.name)}</h4>
          <div class="guide-tags"><span class="tag plain">${esc(sk.scope)}</span>${sk.command ? '<span class="tag plain">command</span>' : ''}${used ? `<span class="tag" style="--c:var(--accent)">used ${used}×</span>` : ''}</div>
        </div>
      </header>
      <p class="guide-desc">${esc(sk.description || 'No description.')}</p>
      <dl class="guide-kv">
        ${sk.whenToUse ? `<dt>When to use</dt><dd>${esc(sk.whenToUse)}</dd>` : ''}
        <dt>Run it</dt><dd><code>${esc(invoke)}</code> <span class="muted">${sk.modelInvocable ? '· or Claude picks it when the task fits' : '· only when you call it'}</span></dd>
        ${sk.argumentHint ? `<dt>Arguments</dt><dd><code>${esc(sk.argumentHint)}</code></dd>` : ''}
        ${compact ? '' : `<dt>File</dt><dd class="mono">${esc(sk.file)}</dd>`}
      </dl>
      ${compact ? '' : `<div class="guide-actions"><button class="btn primary" data-assign-skill="${esc(sk.name)}" ${ws.sessionId ? '' : 'disabled title="Open a session\'s workspace to assign work"'}>Assign a task with this skill</button></div>
      <div class="guide-body md">${body == null ? '<p class="muted">Loading the skill\'s instructions…</p>' : md(body)}</div>`}
    </article>`;
  }

  // ------------------------------------------------------------ drawer
  const TABS = ['files', 'git', 'skills', 'plugins', 'mcp'];
  const NEEDS_SESSION = new Set(['files', 'git']);
  function open(sessionId, tab = 'files') {
    if (ws.sessionId !== sessionId) {
      ws.tree.clear(); ws.expanded.clear(); ws.view = null; ws.git = null; ws.branches = null; ws.skills = null; ws.mcp = null; ws.market = null;
    }
    ws.sessionId = sessionId;
    ws.open = true;
    $('#workspace').hidden = false;
    document.body.classList.add('ws-open');
    setTab(!sessionId && NEEDS_SESSION.has(tab) ? 'skills' : tab);
  }
  function close() {
    ws.open = false;
    $('#workspace').hidden = true;
    document.body.classList.remove('ws-open');
  }
  function setTab(tab) {
    if (!TABS.includes(tab)) tab = 'files';
    ws.tab = tab;
    ws.view = null;
    document.querySelectorAll('[data-ws]').forEach((b) => {
      b.classList.toggle('active', b.dataset.ws === tab);
      b.disabled = !ws.sessionId && NEEDS_SESSION.has(b.dataset.ws);
    });
    const s = session();
    $('#ws-title').textContent = s ? s.project : 'Workspace';
    $('#ws-sub').textContent = s ? s.cwd : 'Skills, plugins and MCP for this computer';
    const body = $('#ws-body');
    body.dataset.tab = tab;
    const right = '<div class="ws-right scroll" id="ws-view"></div>';
    if (tab === 'files') {
      body.innerHTML = `<div class="ws-left scroll" id="ws-left"></div>${right}`;
      if (!ws.tree.has('')) loadDir(''); else renderTree();
    } else if (tab === 'git') {
      body.innerHTML = `<div class="ws-left scroll">
          <div id="ws-branchbar" class="branch-bar"></div>
          <div class="branch-new"><input id="ws-branch-new" placeholder="new-branch-name" maxlength="120" aria-label="New branch name"><button class="btn" id="ws-branch-create">Create branch</button></div>
          <div id="ws-git-list"></div>
          <div class="commit-box">
            <textarea id="ws-commit-msg" rows="2" maxlength="5000" placeholder="Commit message" aria-label="Commit message"></textarea>
            <div class="commit-actions">
              <button class="btn primary" id="ws-commit-go">Commit staged</button>
              <button class="btn" id="ws-commit-agent" title="Send this session a task to review and commit">Ask the agent to commit</button>
            </div>
            <p class="hint">Commits only what is staged, with your git identity. Pushing stays a manual step.</p>
          </div>
          <div id="ws-log"></div>
        </div>${right}`;
      refreshGit();
    } else if (tab === 'skills') {
      body.innerHTML = `<div class="ws-left" id="ws-left">
          <input class="ws-search" id="ws-skill-q" type="search" placeholder="Search skills" value="${esc(ws.query)}" aria-label="Search skills">
          <div class="scroll" id="ws-skill-items"></div>
        </div>${right}`;
      renderSkills();
      loadSkills(ws.sessionId).then((r) => { ws.skills = r.skills; ws.used = r.used; renderSkills(); if (!ws.guideId && ws.skills.length) showGuide(ws.skills[0].id); else if (ws.guideId) showGuide(ws.guideId); }).catch((e) => toast(`⚠️ ${e.message}`));
    } else if (tab === 'plugins') {
      body.innerHTML = `<div class="ws-left" id="ws-left">
          <div class="filter-row">
            <input class="ws-search" id="ws-market-q" type="search" placeholder="Search plugins" value="${esc(ws.mQuery)}" aria-label="Search plugins">
            <select id="ws-market-cat" aria-label="Category"><option value="">All categories</option></select>
          </div>
          <div class="scroll" id="ws-market-items"></div>
          <form class="add-market" id="ws-market-add"><input id="ws-market-repo" placeholder="Add a marketplace: owner/repo" aria-label="Marketplace GitHub repository"><button class="btn" type="submit">Add</button></form>
        </div>${right}`;
      loadMarket();
    } else {
      body.innerHTML = `<div class="ws-left scroll" id="ws-left"></div>${right}`;
      loadMcp();
    }
    renderView();
  }

  // ------------------------------------------------------------ files
  async function loadDir(path) {
    try {
      const r = await api('/api/ws/files', { sessionId: ws.sessionId, path });
      ws.tree.set(r.path, r.entries);
      if (path) ws.expanded.add(r.path);
      renderTree();
    } catch (e) { toast(`⚠️ ${e.message}`); }
  }
  function renderTree() {
    if (ws.tab !== 'files' || !$('#ws-left')) return;
    const s = session();
    const touched = new Map((s?.touched || []).map((t) => [t.p, t]));
    const recent = [...(s?.touched || [])].reverse().slice(0, 12);
    const row = (e, depth) => {
      const t = touched.get(e.path);
      const pad = `style="padding-left:${8 + depth * 14}px"`;
      if (e.type === 'dir') {
        const isOpen = ws.expanded.has(e.path);
        const kids = isOpen ? (ws.tree.get(e.path) || []).map((k) => row(k, depth + 1)).join('') : '';
        return `<button class="ft-row dir${e.heavy ? ' heavy' : ''}" data-dir="${esc(e.path)}" ${pad}><span class="ft-caret">${isOpen ? '▾' : '▸'}</span>📁 ${esc(e.name)}</button>${kids}`;
      }
      return `<button class="ft-row file${ws.view?.path === e.path ? ' on' : ''}${e.secret ? ' secret' : ''}" data-file="${esc(e.path)}" ${pad}>
        <span class="ft-name">${e.secret ? '🔒' : '📄'} ${esc(e.name)}</span>
        ${t ? `<span class="op op-${t.op}" title="${OP[t.op][1]} by the agent ${ago(t.at)} ago">${OP[t.op][0]}</span>` : ''}
        <span class="ft-size">${bytes(e.size)}</span></button>`;
    };
    setHTML($('#ws-left'), `
      ${recent.length ? `<div class="section-title">Touched by the agent</div>
        <div class="ft-recent">${recent.map((t) => `<button class="ft-row file" data-file="${esc(t.p)}"><span class="op op-${t.op}">${OP[t.op][0]}</span><span class="ft-name">${esc(t.p)}</span><span class="ft-size">${ago(t.at)}</span></button>`).join('')}</div>` : ''}
      <div class="section-title">Files</div>
      <div class="ft">${(ws.tree.get('') || []).map((e) => row(e, 0)).join('') || '<p class="muted small">Loading…</p>'}</div>`);
  }
  async function openFile(path) {
    try {
      ws.view = { kind: 'file', path, loading: true };
      renderView(); renderTree();
      ws.view = { kind: 'file', ...(await api('/api/ws/file', { sessionId: ws.sessionId, path })) };
      renderView();
    } catch (e) { toast(`⚠️ ${e.message}`); }
  }

  // ------------------------------------------------------------ git
  async function refreshGit() {
    try {
      const [g, b] = await Promise.all([api('/api/ws/git/status', { sessionId: ws.sessionId }), api('/api/ws/git/branches', { sessionId: ws.sessionId })]);
      ws.git = g; ws.branches = b;
    } catch (e) { ws.git = { error: e.message }; }
    renderGit();
  }
  const STATUS_WORD = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', N: 'New' };
  function renderGit() {
    if (ws.tab !== 'git' || !$('#ws-git-list')) return;
    const g = ws.git;
    const badge = $('#ws-git-count');
    badge.hidden = !g?.files?.length; badge.textContent = g?.files?.length || '';
    if (!g) { setHTML($('#ws-git-list'), '<p class="muted small pad">Reading git status…</p>'); return; }
    if (g.error) { setHTML($('#ws-git-list'), `<p class="muted small pad">⚠️ ${esc(g.error)}</p>`); return; }
    if (!g.repo) { setHTML($('#ws-git-list'), '<div class="empty"><span class="big">⎇</span>This folder isn\'t a git repository.</div>'); setHTML($('#ws-branchbar'), ''); return; }
    const b = ws.branches;
    setHTML($('#ws-branchbar'), `
      <span class="br-ic" aria-hidden="true">⎇</span>
      <select id="ws-branch" aria-label="Branch">${(b?.branches || []).map((x) => `<option value="${esc(x.name)}"${x.current ? ' selected' : ''}>${esc(x.name)}${x.track ? ` (${esc(x.track)})` : ''}</option>`).join('')}${b?.current ? '' : '<option selected>(detached)</option>'}</select>
      <button class="btn" id="ws-branch-switch">Switch</button>
      <span class="muted small">${g.ahead ? `↑${g.ahead} ` : ''}${g.behind ? `↓${g.behind}` : ''}</span>
      <button class="icon-btn" id="ws-git-refresh" title="Refresh" aria-label="Refresh git status">⟳</button>`);
    const staged = g.files.filter((f) => f.staged);
    const changed = g.files.filter((f) => f.unstaged);
    const untracked = g.files.filter((f) => f.untracked);
    const sel = ws.view?.kind === 'diff' ? `${ws.view.staged ? 'S' : 'W'}:${ws.view.path}` : '';
    const rows = (list, isStaged, action) => list.map((f) => {
      const code = isStaged ? f.x : f.untracked ? 'N' : f.y;
      return `<div class="gf${sel === `${isStaged ? 'S' : 'W'}:${f.path}` ? ' on' : ''}">
        <button class="gf-name" data-diff="${esc(f.path)}" data-staged="${isStaged ? 1 : 0}" title="${STATUS_WORD[code] || code}"><span class="gs gs-${code}">${code}</span>${esc(f.path)}</button>
        <button class="gf-act" data-${action}="${esc(f.path)}" title="${action === 'stage' ? 'Stage' : 'Unstage'}" aria-label="${action === 'stage' ? 'Stage' : 'Unstage'} ${esc(f.path)}">${action === 'stage' ? '+' : '−'}</button>
      </div>`;
    }).join('');
    const group = (title, list, isStaged, action, all) => (list.length ? `<div class="gg-head"><span>${title} <b>${list.length}</b></span><button class="link" data-${action}-all="1">${all}</button></div>${rows(list, isStaged, action)}` : '');
    setHTML($('#ws-git-list'), `${g.files.length ? '' : '<p class="muted small pad">Working tree clean.</p>'}
      ${group('Staged', staged, true, 'unstage', 'Unstage all')}
      ${group('Changes', changed, false, 'stage', 'Stage all')}
      ${group('New files', untracked, false, 'stage', 'Stage all')}`);
    setHTML($('#ws-log'), g.commits.length ? `<div class="section-title">Recent commits</div><ul class="list commits">${g.commits.map((c) => `<li><code>${esc(c.hash)}</code><div class="li-main">${esc(c.subject)}<div class="li-sub">${esc(c.author)} · ${esc(c.when)}</div></div></li>`).join('')}</ul>` : '');
  }
  async function showDiff(path, staged) {
    try {
      ws.view = { kind: 'diff', path, staged, loading: true };
      renderView(); renderGit();
      ws.view = { kind: 'diff', staged, ...(await api('/api/ws/git/diff', { sessionId: ws.sessionId, path, staged })) };
      renderView();
    } catch (e) { toast(`⚠️ ${e.message}`); }
  }
  async function busy(fn) {
    if (ws.busy) return;
    ws.busy = true;
    try { await fn(); } catch (e) { toast(`⚠️ ${e.message}`); }
    ws.busy = false;
  }
  const gitAction = (kind, paths) => busy(async () => {
    await api(`/api/ws/git/${kind}`, { sessionId: ws.sessionId, paths });
    await refreshGit();
    if (ws.view?.kind === 'diff' && paths.includes(ws.view.path)) showDiff(ws.view.path, kind === 'stage');
  });
  const agentBusy = () => ['working', 'thinking', 'compacting', 'waiting'].includes(session()?.status);
  const branchAction = (kind, name) => busy(async () => {
    if (!name) throw new Error('Pick or type a branch name');
    if (agentBusy() && !window.confirm(`${session().project} is working in this folder right now. ${kind === 'switch' ? 'Switch' : 'Create and switch'} branch anyway? Its next edits will land on "${name}".`)) return;
    await api(`/api/ws/git/${kind === 'switch' ? 'switch' : 'branch'}`, { sessionId: ws.sessionId, name });
    toast(kind === 'switch' ? `⎇ Switched to ${name}` : `⎇ Created ${name}`);
    if (kind === 'create') $('#ws-branch-new').value = '';
    await refreshGit();
  });

  // ------------------------------------------------------------ skills
  function renderSkills() {
    if (ws.tab !== 'skills' || !$('#ws-skill-items')) return;
    if (!ws.skills) { setHTML($('#ws-skill-items'), '<p class="muted small pad">Looking for skills…</p>'); return; }
    const q = ws.query.trim().toLowerCase();
    const list = ws.skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    const html = [['project', 'This project'], ['personal', 'Personal'], ['plugin', 'Plugins']].map(([scope, title]) => {
      const items = list.filter((s) => s.scope === scope);
      if (!items.length) return '';
      return `<div class="section-title">${title} <span class="muted">${items.length}</span></div>${items.map((s) => `
        <button class="sk-row${ws.guideId === s.id ? ' on' : ''}" data-skill="${esc(s.id)}">
          <span class="sk-name">🧩 ${esc(s.name)}${ws.used[s.name] ? ` <span class="tag" style="--c:var(--accent)">${ws.used[s.name]}×</span>` : ''}</span>
          <span class="sk-desc">${esc(s.description)}</span>
        </button>`).join('')}`;
    }).join('');
    setHTML($('#ws-skill-items'), html || '<div class="empty">No skills match.</div>');
  }
  async function showGuide(id) {
    ws.guideId = id;
    ws.view = { kind: 'guide', id };
    renderSkills(); renderView();
    try { await loadGuide(id); renderView(); } catch (e) { toast(`⚠️ ${e.message}`); }
  }

  // ------------------------------------------------------------ plugins
  async function loadMarket(force) {
    if (ws.market && !force) { renderMarket(); return; }
    setHTML($('#ws-market-items'), '<p class="muted small pad">Loading marketplaces…</p>');
    try { ws.market = await api('/api/ws/market', { sessionId: ws.sessionId }); }
    catch (e) { ws.market = { markets: [], error: e.message }; }
    const cats = [...new Set(ws.market.markets.flatMap((m) => m.plugins.map((p) => p.category)))].sort();
    const sel = $('#ws-market-cat');
    if (sel) sel.innerHTML = `<option value="">All categories</option>${cats.map((c) => `<option value="${esc(c)}"${c === ws.mCat ? ' selected' : ''}>${esc(c)}</option>`).join('')}`;
    renderMarket();
  }
  function renderMarket() {
    if (ws.tab !== 'plugins' || !$('#ws-market-items') || !ws.market) return;
    const q = ws.mQuery.trim().toLowerCase();
    const parts = ws.market.markets.map((m) => {
      if (m.error) return `<div class="section-title">${esc(m.repo)}</div><p class="muted small pad">⚠️ ${esc(m.error)}</p>`;
      const items = m.plugins.filter((p) => (!ws.mCat || p.category === ws.mCat) && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.author.toLowerCase().includes(q)));
      const shown = items.slice(0, 150);
      return `<div class="section-title">${esc(m.name)} <span class="muted">${items.length}</span>${m.repo !== ws.market.official ? ` <button class="link" data-market-remove="${esc(m.repo)}">remove</button>` : ''}</div>
        ${shown.map((p) => `<button class="sk-row${ws.mSel?.id === `${p.name}@${m.name}` ? ' on' : ''}" data-plugin="${esc(p.name)}" data-market="${esc(m.name)}">
          <span class="sk-name">${esc(p.name)} ${p.installed ? '<span class="tag" style="--c:var(--st-standby)">installed</span>' : ''}<span class="tag plain">${esc(p.category)}</span></span>
          <span class="sk-desc">${esc(p.author ? `${p.author} · ` : '')}${esc(p.description)}</span>
        </button>`).join('')}${items.length > shown.length ? `<p class="muted small pad">${items.length - shown.length} more: refine the search.</p>` : ''}`;
    }).join('');
    setHTML($('#ws-market-items'), parts || '<div class="empty">No marketplaces.</div>');
  }
  function pluginCard(m, p) {
    const id = `${p.name}@${m.name}`;
    return `<article class="guide">
      <header><span class="guide-ic" aria-hidden="true">🧰</span>
        <div class="guide-name"><h4>${esc(p.name)}</h4>
          <div class="guide-tags"><span class="tag plain">${esc(p.category)}</span><span class="tag plain">${esc(m.name)}</span>${p.version ? `<span class="tag plain">v${esc(p.version)}</span>` : ''}${p.installed ? `<span class="tag" style="--c:var(--st-standby)">installed · ${esc(p.installed.scope)}</span>` : ''}</div>
        </div></header>
      <p class="guide-desc">${esc(p.description || 'No description.')}</p>
      <dl class="guide-kv">
        ${p.author ? `<dt>By</dt><dd>${esc(p.author)}</dd>` : ''}
        ${p.homepage ? `<dt>Homepage</dt><dd><a href="${esc(p.homepage)}" target="_blank" rel="noopener noreferrer">${esc(p.homepage.replace(/^https:\/\//, ''))}</a></dd>` : ''}
        ${p.tags.length ? `<dt>Tags</dt><dd>${p.tags.map((t) => `<span class="tag plain">${esc(t)}</span>`).join(' ')}</dd>` : ''}
      </dl>
      <div class="section-title">Install</div>
      ${cmdLine(`claude plugin install ${id}`)}
      <p class="hint">Or type <code>/plugin install ${esc(id)}</code> inside a session. Plugins can add skills, hooks and MCP servers that run on your computer, so install the ones you trust.</p>
      ${!p.installed && ws.market.cli ? `<div class="guide-actions"><button class="btn primary" data-install="${esc(id)}">Install now</button><span class="muted small">Runs the command above on this computer; new sessions pick it up.</span></div>` : ''}
    </article>`;
  }

  // ------------------------------------------------------------ MCP
  async function loadMcp() {
    setHTML($('#ws-left'), '<p class="muted small pad">Reading MCP configuration…</p>');
    try { ws.mcp = await api('/api/ws/mcp', { sessionId: ws.sessionId }); }
    catch (e) { ws.mcp = { servers: [], used: {}, error: e.message }; }
    renderMcp();
  }
  const SCOPES = [['local', 'Local (only you, this project)'], ['project', 'Project (.mcp.json, shared)'], ['user', 'User (all your projects)'], ['plugin', 'From plugins']];
  function renderMcp() {
    if (ws.tab !== 'mcp' || !$('#ws-left') || !ws.mcp) return;
    const { servers, used } = ws.mcp;
    const norm = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
    const configured = new Set(servers.map((s) => norm(s.name.split(':').pop())));
    const seen = Object.entries(used).filter(([n]) => !configured.has(norm(n.replace(/^plugin_[^_]+_/, ''))));
    const row = (s) => `<button class="sk-row${ws.mcpSel === `${s.scope}:${s.name}` ? ' on' : ''}" data-mcp="${esc(`${s.scope}:${s.name}`)}">
      <span class="sk-name">🔌 ${esc(s.name)} <span class="tag plain">${esc(s.type)}</span>${s.approval ? `<span class="tag plain">${esc(s.approval)}</span>` : ''}${usedCount(s) ? `<span class="tag" style="--c:var(--accent)">${usedCount(s)} calls</span>` : ''}</span>
      <span class="sk-desc mono">${esc(s.where || '—')}</span></button>`;
    setHTML($('#ws-left'), `${ws.mcp.error ? `<p class="muted small pad">⚠️ ${esc(ws.mcp.error)}</p>` : ''}
      ${SCOPES.map(([scope, title]) => { const list = servers.filter((s) => s.scope === scope); return list.length ? `<div class="section-title">${title} <span class="muted">${list.length}</span></div>${list.map(row).join('')}` : ''; }).join('')}
      <div class="section-title">Connectors and other servers seen in this session</div>
      ${seen.length ? seen.map(([n, c]) => `<div class="sk-row static"><span class="sk-name">✳️ ${esc(n)} <span class="tag" style="--c:var(--accent)">${c} calls</span></span></div>`).join('') : '<p class="muted small pad">None yet. Tools named <code>mcp__…</code> show up here as the agent uses them.</p>'}
      <p class="hint pad">claude.ai connectors aren't stored on this computer. Manage them at <a href="https://claude.ai/customize/connectors" target="_blank" rel="noopener noreferrer">claude.ai/customize/connectors</a>; check live status with <code>/mcp</code> in a session.</p>
      <div class="section-title">Add a server</div>
      <form class="mcp-add" id="ws-mcp-add">
        <input id="mcp-name" placeholder="name" required maxlength="60" aria-label="Server name">
        <select id="mcp-transport" aria-label="Transport"><option value="http">HTTP</option><option value="stdio">stdio</option><option value="sse">SSE</option></select>
        <select id="mcp-scope" aria-label="Scope"><option value="local">local</option><option value="project">project</option><option value="user">user</option></select>
        <input id="mcp-target" placeholder="https://… or the command to run" required aria-label="URL or command">
        <button class="btn" type="submit">Make command</button>
      </form>
      <div id="mcp-add-out"></div>`);
  }
  function usedCount(s) {
    const used = ws.mcp?.used || {};
    const short = s.name.split(':').pop();
    const keys = s.scope === 'plugin' ? [`plugin_${s.name.split(':')[1]}_${short}`] : [s.name];
    return keys.reduce((n, k) => n + (used[k] || 0), 0);
  }
  function mcpCard(s) {
    const scopeFlag = s.scope === 'plugin' ? '' : ` -s ${s.scope}`;
    return `<article class="guide">
      <header><span class="guide-ic" aria-hidden="true">🔌</span>
        <div class="guide-name"><h4>${esc(s.name)}</h4>
          <div class="guide-tags"><span class="tag plain">${esc(s.scope)}</span><span class="tag plain">${esc(s.type)}</span>${s.approval ? `<span class="tag plain">${esc(s.approval)}</span>` : ''}</div>
        </div></header>
      <dl class="guide-kv">
        <dt>${s.type === 'stdio' ? 'Command' : 'Endpoint'}</dt><dd class="mono">${esc(s.where || '—')}</dd>
        ${s.env.length ? `<dt>Env vars</dt><dd>${s.env.map((e) => `<code>${esc(e)}</code>`).join(' ')} <span class="muted">values hidden</span></dd>` : ''}
        ${s.headers.length ? `<dt>Headers</dt><dd>${s.headers.map((h) => `<code>${esc(h)}</code>`).join(' ')} <span class="muted">values hidden</span></dd>` : ''}
        <dt>This session</dt><dd>${usedCount(s) ? `${usedCount(s)} tool calls` : 'not used yet'}</dd>
      </dl>
      <div class="section-title">Manage</div>
      ${s.scope === 'plugin' ? '<p class="hint">This server comes with a plugin. Turn it off with the <code>/mcp</code> panel in a session, or uninstall the plugin.</p>' : `${cmdLine(`claude mcp get ${shq(s.name)}`)}${cmdLine(`claude mcp remove ${shq(s.name)}${scopeFlag}`)}`}
      ${s.scope === 'project' ? '<p class="hint">Project servers come from <code>.mcp.json</code>. Each person approves them on first use; <code>claude mcp reset-project-choices</code> asks again.</p>' : ''}
    </article>`;
  }

  // ------------------------------------------------------------ viewer
  function renderView() {
    const el = $('#ws-view');
    if (!el) return;
    const v = ws.view;
    if (!v) {
      const hint = {
        files: ['📂', 'Pick a file to read it here. Files the agent touched are marked E (edited), W (written) and R (read).'],
        git: ['±', 'Pick a changed file to see its diff.'],
        skills: ['🧩', 'Pick a skill to see its guide.'],
        plugins: ['🧰', 'Pick a plugin to see what it adds and how to install it.'],
        mcp: ['🔌', 'Pick a server to see its details. Secrets stay hidden.'],
      }[ws.tab];
      setHTML(el, `<div class="empty"><span class="big">${hint[0]}</span>${hint[1]}</div>`);
      return;
    }
    if (v.loading) { setHTML(el, `<p class="muted small pad">Loading ${esc(v.path || '')}…</p>`); return; }
    if (v.kind === 'file') {
      const head = `<div class="view-head"><span class="mono">${esc(v.path)}</span><span class="muted small">${v.size != null ? bytes(v.size) : ''}${v.truncated ? ' · first 400 KB' : ''}</span></div>`;
      if (v.blocked) { setHTML(el, `${head}<div class="empty"><span class="big">🔒</span>${esc(v.blocked)}</div>`); return; }
      if (v.binary) { setHTML(el, `${head}<div class="empty"><span class="big">⬚</span>Binary file, not shown.</div>`); return; }
      const lines = v.text.split('\n').slice(0, 5000);
      setHTML(el, `${head}<pre class="code">${lines.map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n')}</pre>`);
    } else if (v.kind === 'diff') {
      const head = `<div class="view-head"><span class="mono">${esc(v.path)}</span><span class="muted small">${v.staged ? 'staged' : 'working tree'}</span></div>`;
      if (v.note) { setHTML(el, `${head}<div class="empty">${esc(v.note)}</div>`); return; }
      const body = (v.diff || '').split('\n').map((l) => {
        const cls = /^(\+\+\+|---|diff |index |new file|deleted file)/.test(l) ? 'd-meta' : l.startsWith('@@') ? 'd-hunk' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : '';
        return `<span class="${cls}">${esc(l) || ' '}</span>`;
      }).join('\n');
      setHTML(el, `${head}${v.diff ? `<pre class="code diff">${body}</pre>` : '<div class="empty">No differences.</div>'}`);
    } else if (v.kind === 'guide') {
      const sk = ws.skills?.find((s) => s.id === v.id);
      setHTML(el, guideBlock(sk, { body: ws.guides.get(v.id) ?? null, used: ws.used[sk?.name] || 0 }));
    } else if (v.kind === 'plugin') {
      const m = ws.market?.markets.find((x) => x.name === v.market);
      const p = m?.plugins.find((x) => x.name === v.name);
      setHTML(el, p ? pluginCard(m, p) : '');
    } else if (v.kind === 'mcp') {
      const s = ws.mcp?.servers.find((x) => `${x.scope}:${x.name}` === v.key);
      setHTML(el, s ? mcpCard(s) : '');
    }
  }

  // ------------------------------------------------------------ events
  $('#ws-close').addEventListener('click', close);
  document.querySelectorAll('[data-ws]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.ws)));
  $('#ws-body').addEventListener('input', (e) => {
    if (e.target.id === 'ws-skill-q') { ws.query = e.target.value; renderSkills(); }
    if (e.target.id === 'ws-market-q') { ws.mQuery = e.target.value; renderMarket(); }
  });
  $('#ws-body').addEventListener('change', (e) => {
    if (e.target.id === 'ws-market-cat') { ws.mCat = e.target.value; renderMarket(); }
  });
  $('#ws-body').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'ws-market-add') {
      try {
        const r = await api('/api/ws/market/add', { repo: $('#ws-market-repo').value });
        $('#ws-market-repo').value = '';
        toast(`🛍️ Added ${r.repo}`);
        loadMarket(true);
      } catch (err) { toast(`⚠️ ${err.message}`); }
    } else if (e.target.id === 'ws-mcp-add') {
      const name = $('#mcp-name').value.trim(), t = $('#mcp-transport').value, scope = $('#mcp-scope').value, target = $('#mcp-target').value.trim();
      if (!/^[\w.-]{1,60}$/.test(name)) { toast('⚠️ Use letters, numbers, dots, dashes or underscores for the name'); return; }
      const cmd = t === 'stdio'
        ? `claude mcp add --transport stdio -s ${scope} ${name} -- ${target}`
        : `claude mcp add --transport ${t} -s ${scope} ${name} ${shq(target)}`;
      setHTML($('#mcp-add-out'), `${cmdLine(cmd)}<p class="hint">Add <code>--env KEY=value</code> or <code>--header "Authorization: Bearer …"</code> in your terminal. Secrets don't belong in this page.</p>`);
    }
  });
  $('#ws-body').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || (t.type === 'submit' && t.closest('form'))) return;
    const d = t.dataset;
    if (d.dir != null) {
      if (ws.expanded.has(d.dir)) { ws.expanded.delete(d.dir); renderTree(); }
      else if (ws.tree.has(d.dir)) { ws.expanded.add(d.dir); renderTree(); }
      else loadDir(d.dir);
    } else if (d.file != null) openFile(d.file);
    else if (d.diff != null) showDiff(d.diff, d.staged === '1');
    else if (d.stage != null) gitAction('stage', [d.stage]);
    else if (d.unstage != null) gitAction('unstage', [d.unstage]);
    else if (d.stageAll) gitAction('stage', ws.git.files.filter((f) => f.unstaged || f.untracked).map((f) => f.path));
    else if (d.unstageAll) gitAction('unstage', ws.git.files.filter((f) => f.staged).map((f) => f.path));
    else if (t.id === 'ws-git-refresh') refreshGit();
    else if (t.id === 'ws-branch-switch') { const name = $('#ws-branch').value; if (name !== ws.branches?.current) branchAction('switch', name); }
    else if (t.id === 'ws-branch-create') branchAction('create', $('#ws-branch-new').value.trim());
    else if (t.id === 'ws-commit-go') busy(async () => {
      const r = await api('/api/ws/git/commit', { sessionId: ws.sessionId, message: $('#ws-commit-msg').value });
      $('#ws-commit-msg').value = '';
      toast(`✅ ${r.summary}`);
      await refreshGit();
    });
    else if (t.id === 'ws-commit-agent') dispatch(ws.sessionId, 'Review `git status` and the diff, then commit the work in logical commits with clear messages. Do not push.');
    else if (d.skill) showGuide(d.skill);
    else if (d.assignSkill) ctx.assignWithSkill(ws.sessionId, d.assignSkill);
    else if (d.plugin) { ws.mSel = { id: `${d.plugin}@${d.market}` }; ws.view = { kind: 'plugin', name: d.plugin, market: d.market }; renderMarket(); renderView(); }
    else if (d.marketRemove) busy(async () => { await api('/api/ws/market/remove', { repo: d.marketRemove }); await loadMarket(true); });
    else if (d.install) {
      if (!window.confirm(`Install ${d.install} on this computer?\n\nIt runs "claude plugin install ${d.install}". The plugin's skills, hooks and MCP servers will load in new sessions.`)) return;
      t.disabled = true; t.textContent = 'Installing…';
      busy(async () => { const r = await api('/api/ws/market/install', { sessionId: ws.sessionId, id: d.install }); toast(`🧰 ${r.output || 'Installed'}`); await loadMarket(true); renderView(); });
    } else if (d.mcp) { ws.mcpSel = d.mcp; ws.view = { kind: 'mcp', key: d.mcp }; renderMcp(); renderView(); }
    else if (d.copy) copy(d.copy);
  });

  // Keep the explorer's "touched" marks and the git badge fresh as the agent works.
  let gitTimer = null;
  function onSessionUpdate(id) {
    if (!ws.open || id !== ws.sessionId) return;
    if (ws.tab === 'files') renderTree();
    if (ws.tab === 'git' && !gitTimer) gitTimer = setTimeout(() => { gitTimer = null; refreshGit(); }, 2500);
  }

  return { open, close, isOpen: () => ws.open, onSessionUpdate, loadSkills, guideBlock, loadGuide };
}
