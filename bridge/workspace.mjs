// Workspace helpers for the dashboard: skills, a read-only file explorer, and git.
// Every path that comes from the browser is resolved inside a session's own folder;
// git always runs without a shell, with "--" before file arguments.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const HOME = os.homedir();
const tilde = (p) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);

// ------------------------------------------------------------------ skills
const skillPaths = new Map(); // id -> absolute SKILL.md / command .md path
const skillCache = new Map(); // cwd -> { at, list }

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(value.startsWith('|') ? '\n' : ' ');
    }
    meta[key] = value.replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

function readSkill(file, scope, fallbackName, prefix = '') {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 64 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const { meta, body } = parseFrontmatter(text);
  const id = crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);
  skillPaths.set(id, file);
  const name = `${prefix}${meta.name || fallbackName}`;
  return {
    id,
    name,
    scope,
    description: (meta.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').slice(0, 600),
    whenToUse: (meta.when_to_use || '').slice(0, 400),
    argumentHint: meta['argument-hint'] || '',
    userInvocable: meta['user-invocable'] !== 'false',
    modelInvocable: meta['disable-model-invocation'] !== 'true',
    file: tilde(file),
  };
}

function scanSkillDir(dir, scope, out, prefix = '') {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory() || e.isSymbolicLink()) {
      const f = path.join(dir, e.name, 'SKILL.md');
      if (fs.existsSync(f)) { const s = readSkill(f, scope, e.name, prefix); if (s) out.push(s); }
      else if (e.name === 'synced') scanSkillDir(path.join(dir, e.name), scope, out, prefix);
    }
  }
}
function scanCommandDir(dir, scope, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      const s = readSkill(path.join(dir, e.name), scope, e.name.slice(0, -3));
      if (s) out.push({ ...s, command: true });
    }
  }
}
// Plugins live under ~/.claude/plugins/**/<plugin>/skills/<skill>/SKILL.md
function scanPlugins(dir, out, depth = 0, budget = { n: 0 }) {
  if (depth > 6 || budget.n > 4000) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    budget.n++;
    const full = path.join(dir, e.name);
    if (e.name === 'skills') {
      const plugin = path.basename(dir);
      scanSkillDir(full, 'plugin', out, `${plugin}:`);
    } else scanPlugins(full, out, depth + 1, budget);
  }
}

export function listSkills(cwd) {
  const key = cwd || '';
  const hit = skillCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const out = [];
  if (cwd) {
    scanSkillDir(path.join(cwd, '.claude', 'skills'), 'project', out);
    scanCommandDir(path.join(cwd, '.claude', 'commands'), 'project', out);
  }
  scanSkillDir(path.join(HOME, '.claude', 'skills'), 'personal', out);
  scanCommandDir(path.join(HOME, '.claude', 'commands'), 'personal', out);
  scanPlugins(path.join(HOME, '.claude', 'plugins'), out);
  // first definition of a name wins (project > personal > plugin), like the / menu
  const seen = new Set();
  const list = out.filter((s) => (seen.has(s.name) ? false : seen.add(s.name))).sort((a, b) => a.name.localeCompare(b.name));
  skillCache.set(key, { at: Date.now(), list });
  return list;
}

export function skillGuide(id) {
  const file = skillPaths.get(id);
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'utf8').slice(0, 24 * 1024);
    const { body } = parseFrontmatter(text);
    return { id, body: body.split('\n').slice(0, 160).join('\n') };
  } catch { return null; }
}

// ------------------------------------------------------------------- files
const SECRET = /(^|[\\/])(\.env(\.[^\\/]*)?|[^\\/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const HEAVY = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.cache']);

// Resolve `rel` inside `root`, following symlinks, refusing anything outside it or inside .git.
export function resolveInside(root, rel = '') {
  const rootReal = fs.realpathSync(root);
  const target = path.resolve(rootReal, String(rel || '.'));
  if (target.split(path.sep).includes('.git')) throw new Error('The .git folder is not browsable');
  let real;
  try { real = fs.realpathSync(target); } catch { throw new Error('Not found'); }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error('Outside the session folder');
  return { rootReal, real, rel: path.relative(rootReal, real) };
}

export function listDir(root, rel) {
  const { real, rel: clean } = resolveInside(root, rel);
  const entries = fs.readdirSync(real, { withFileTypes: true })
    .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
    .slice(0, 800)
    .map((e) => {
      const full = path.join(real, e.name);
      let size = 0, type = e.isDirectory() ? 'dir' : 'file';
      if (e.isSymbolicLink()) { try { type = fs.statSync(full).isDirectory() ? 'dir' : 'file'; } catch { type = 'file'; } }
      if (type === 'file') { try { size = fs.statSync(full).size; } catch {} }
      const p = clean ? `${clean}/${e.name}` : e.name;
      return { name: e.name, path: p, type, size, heavy: type === 'dir' && HEAVY.has(e.name), secret: type === 'file' && SECRET.test(p) };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: clean, entries };
}

export function readFileSafe(root, rel) {
  const { real, rel: clean } = resolveInside(root, rel);
  if (SECRET.test(clean)) return { path: clean, blocked: 'This looks like a secrets file, so the office won\'t show it.' };
  const st = fs.statSync(real);
  if (st.isDirectory()) throw new Error('That is a folder');
  const cap = 400 * 1024;
  const fd = fs.openSync(real, 'r');
  const buf = Buffer.alloc(Math.min(st.size, cap));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  if (buf.subarray(0, 8000).includes(0)) return { path: clean, size: st.size, binary: true };
  return { path: clean, size: st.size, truncated: st.size > cap, text: buf.toString('utf8') };
}

// --------------------------------------------------------------------- git
function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      if (err && !allowFail) { reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' '))); return; }
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr });
    });
  });
}

export async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function gitStatus(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { repo: false };
  const { stdout } = await git(root, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  const parts = stdout.split('\0');
  let branch = '', ahead = 0, behind = 0;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    if (!t) continue;
    if (t.startsWith('## ')) {
      const h = t.slice(3);
      branch = h.split('...')[0].replace(/^No commits yet on /, '');
      ahead = Number(h.match(/ahead (\d+)/)?.[1] || 0);
      behind = Number(h.match(/behind (\d+)/)?.[1] || 0);
      continue;
    }
    const x = t[0], y = t[1], p = t.slice(3);
    if (x === 'R' || x === 'C') i++; // the original path follows a rename
    files.push({ path: p, x, y, staged: x !== ' ' && x !== '?', unstaged: y !== ' ' && x !== '?', untracked: x === '?' });
  }
  const log = await git(root, ['log', '-n', '8', '--pretty=format:%h%x1f%an%x1f%ar%x1f%s'], { allowFail: true });
  const commits = log.code === 0 ? log.stdout.split('\n').filter(Boolean).map((l) => { const [hash, author, when, subject] = l.split('\x1f'); return { hash, author, when, subject }; }) : [];
  return { repo: true, root: tilde(root), branch, ahead, behind, files, commits };
}

function checkPaths(root, paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).map(String).slice(0, 500);
  for (const p of list) {
    if (!p || p.includes('\0') || p.startsWith('-')) throw new Error(`Bad path: ${p}`);
    const abs = path.resolve(root, p);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Outside the repository: ${p}`);
  }
  return list;
}

export async function gitDiff(cwd, file, staged) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('Not a git repository');
  const [p] = checkPaths(root, [file]);
  const cap = 300 * 1024;
  let out = (await git(root, ['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', p])).stdout;
  if (!out && !staged) {
    // untracked: show the whole file as added (secrets stay hidden)
    if (SECRET.test(p)) return { path: p, diff: '', note: 'Secrets file: content hidden.' };
    const r = await git(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', p], { allowFail: true });
    out = r.stdout;
  }
  return { path: p, diff: out.length > cap ? `${out.slice(0, cap)}\n… diff truncated` : out };
}

export async function gitStage(cwd, paths) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('Not a git repository');
  await git(root, ['add', '--', ...checkPaths(root, paths)]);
}

export async function gitUnstage(cwd, paths) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('Not a git repository');
  const list = checkPaths(root, paths);
  const r = await git(root, ['restore', '--staged', '--', ...list], { allowFail: true });
  if (r.code !== 0) await git(root, ['reset', '-q', 'HEAD', '--', ...list]); // older git, or no commits yet
}

export async function gitCommit(cwd, message) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('Not a git repository');
  const msg = String(message || '').trim().slice(0, 5000);
  if (!msg) throw new Error('Write a commit message first');
  const staged = await git(root, ['diff', '--cached', '--name-only']);
  if (!staged.stdout.trim()) throw new Error('Nothing is staged');
  const { stdout } = await git(root, ['commit', '-m', msg]);
  return stdout.trim().split('\n')[0];
}

// ---------------------------------------------------------------- branches
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w][\w./-]{0,120}$/;
async function checkBranch(root, name) {
  name = String(name || '').trim();
  if (!BRANCH_RE.test(name)) throw new Error('Invalid branch name');
  const r = await git(root, ['check-ref-format', '--branch', name], { allowFail: true });
  if (r.code !== 0) throw new Error('Invalid branch name');
  return name;
}

export async function gitBranches(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { repo: false };
  const cur = (await git(root, ['branch', '--show-current'], { allowFail: true })).stdout.trim();
  const r = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:relative)%1f%(subject)', 'refs/heads'], { allowFail: true });
  const branches = r.stdout.split('\n').filter(Boolean).slice(0, 100).map((l) => {
    const [name, upstream, track, when, subject] = l.split('\x1f');
    return { name, upstream, track: track.replace(/[[\]]/g, ''), when, subject, current: name === cur };
  });
  return { repo: true, current: cur, branches };
}

export async function gitSwitch(cwd, name) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('Not a git repository');
  name = await checkBranch(root, name);
  await git(root, ['switch', name]); // git refuses if local changes would be overwritten
}

export async function gitCreateBranch(cwd, name) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('Not a git repository');
  name = await checkBranch(root, name);
  await git(root, ['switch', '-c', name]);
}

// ------------------------------------------------------------ settings io
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function settingsLayers(cwd) {
  const layers = [['user', path.join(HOME, '.claude', 'settings.json')]];
  if (cwd) layers.push(['project', path.join(cwd, '.claude', 'settings.json')], ['local', path.join(cwd, '.claude', 'settings.local.json')]);
  return layers.map(([scope, file]) => ({ scope, file, data: readJson(file) || {} }));
}

// ---------------------------------------------------------------- plugins
// Installed state comes from `enabledPlugins` ("name@marketplace": true) in the settings files.
export function enabledPlugins(cwd) {
  const out = {};
  for (const { scope, data } of settingsLayers(cwd)) {
    for (const [id, on] of Object.entries(data.enabledPlugins || {})) out[id] = { enabled: !!on, scope };
  }
  return out;
}

const OFFICIAL = 'anthropics/claude-plugins-official';
const catalogCache = new Map(); // repo -> { at, data }
const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export function marketplaceRepos(dataDir, cwd) {
  const saved = readJson(path.join(dataDir, 'marketplaces.json')) || [];
  const fromSettings = [];
  for (const { data } of settingsLayers(cwd)) {
    for (const m of Object.values(data.extraKnownMarketplaces || {})) {
      const repo = m?.source?.repo;
      if (repo && REPO_RE.test(repo)) fromSettings.push(repo);
    }
  }
  return [...new Set([OFFICIAL, ...fromSettings, ...saved.filter((r) => REPO_RE.test(r))])];
}
export function addMarketplace(dataDir, repo) {
  repo = String(repo || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!REPO_RE.test(repo)) throw new Error('Use the GitHub owner/repo form, e.g. acme/claude-plugins');
  const file = path.join(dataDir, 'marketplaces.json');
  const list = readJson(file) || [];
  if (!list.includes(repo)) list.push(repo);
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  return repo;
}
export function removeMarketplace(dataDir, repo) {
  const file = path.join(dataDir, 'marketplaces.json');
  fs.writeFileSync(file, JSON.stringify((readJson(file) || []).filter((r) => r !== repo), null, 2));
}

export async function fetchCatalog(repo) {
  const hit = catalogCache.get(repo);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.data;
  let json = null, lastErr = '';
  for (const ref of ['HEAD', 'main', 'master']) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/.claude-plugin/marketplace.json`, { signal: AbortSignal.timeout(12_000) });
      if (res.ok) { json = await res.json(); break; }
      lastErr = `HTTP ${res.status}`;
    } catch (e) { lastErr = e.message; }
  }
  if (!json) throw new Error(`Couldn't read ${repo}: ${lastErr}`);
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const data = {
    repo,
    name: str(json.name, 80) || repo,
    description: str(json.description, 300),
    plugins: (Array.isArray(json.plugins) ? json.plugins : []).slice(0, 2000).map((p) => ({
      name: str(p.name, 100),
      description: str(p.description, 600),
      author: str(p.author?.name || p.author, 80),
      category: str(p.category, 40) || 'other',
      homepage: /^https:\/\//.test(p.homepage || '') ? str(p.homepage, 300) : '',
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 8).map((t) => str(t, 30)) : [],
      version: str(p.version, 30),
    })).filter((p) => p.name),
  };
  catalogCache.set(repo, { at: Date.now(), data });
  return data;
}

let cliChecked = null;
export async function claudeCli() {
  if (cliChecked !== null) return cliChecked;
  cliChecked = await new Promise((resolve) => execFile('claude', ['--version'], { timeout: 8000 }, (err, out) => resolve(err ? false : out.trim())));
  return cliChecked;
}
export async function installPlugin(id) {
  if (!/^[\w][\w.-]{0,100}@[\w][\w.-]{0,100}$/.test(String(id))) throw new Error('Bad plugin id');
  if (!(await claudeCli())) throw new Error('The claude command was not found on this computer');
  return new Promise((resolve, reject) => {
    execFile('claude', ['plugin', 'install', id], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (err) reject(new Error(out.split('\n').slice(-3).join(' ') || err.message)); else resolve(out.split('\n').slice(-2).join(' '));
    });
  });
}

// -------------------------------------------------------------------- MCP
// Server definitions, never their secrets: env and header *names* only, URLs without query strings.
function describeServer(name, cfg, scope, extra = {}) {
  const type = cfg.type || (cfg.url ? 'http' : 'stdio');
  let where = '';
  if (cfg.url) { try { const u = new URL(cfg.url); where = `${u.protocol}//${u.host}${u.pathname}`; } catch { where = '(invalid url)'; } }
  else where = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].filter(Boolean).join(' ').slice(0, 200);
  return {
    name, scope, type, where,
    env: Object.keys(cfg.env || {}).slice(0, 20),
    headers: Object.keys(cfg.headers || {}).slice(0, 20),
    ...extra,
  };
}

export function mcpServers(cwd) {
  const out = [];
  const cj = readJson(path.join(HOME, '.claude.json')) || {};
  const proj = cwd ? cj.projects?.[cwd] || {} : {};
  for (const [n, c] of Object.entries(proj.mcpServers || {})) out.push(describeServer(n, c, 'local'));
  const layers = settingsLayers(cwd);
  const enabledList = new Set(layers.flatMap((l) => l.data.enabledMcpjsonServers || []));
  const disabledList = new Set(layers.flatMap((l) => l.data.disabledMcpjsonServers || []));
  const allProject = layers.some((l) => l.data.enableAllProjectMcpServers === true);
  if (cwd) {
    const pj = readJson(path.join(cwd, '.mcp.json')) || {};
    for (const [n, c] of Object.entries(pj.mcpServers || {})) {
      const approval = disabledList.has(n) ? 'disabled' : allProject || enabledList.has(n) ? 'approved' : 'asks on first use';
      out.push(describeServer(n, c, 'project', { approval }));
    }
  }
  for (const [n, c] of Object.entries(cj.mcpServers || {})) out.push(describeServer(n, c, 'user'));
  // plugin-provided servers: <plugin>/.mcp.json under ~/.claude/plugins
  const seen = new Set();
  (function walk(dir, depth) {
    if (depth > 6 || seen.size > 200) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && e.name === '.mcp.json') {
        const j = readJson(path.join(dir, e.name)) || {};
        const plugin = path.basename(dir);
        for (const [n, c] of Object.entries(j.mcpServers || j)) {
          if (typeof c !== 'object' || !c || seen.has(`${plugin}:${n}`)) continue;
          seen.add(`${plugin}:${n}`);
          out.push(describeServer(`plugin:${plugin}:${n}`, c, 'plugin'));
        }
      } else if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
    }
  })(path.join(HOME, '.claude', 'plugins'), 0);
  return out;
}
