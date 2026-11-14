// Redaction helpers shared by the bridge and the transcript indexer.
// Anything that leaves the bridge (SSE, API, trail files) goes through clip() / summarizeTool().

import path from 'node:path';

export const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g,
  /((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)(\S+)/gi,
  /(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/g,
];

export function redact(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, a, b) => (b !== undefined ? a + '••••' : '••••'));
  }
  return out;
}

export const clip = (t, n = 140) => {
  const s = redact(t).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Only a short, redacted summary of tool input ever leaves this function.
export function summarizeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash': return clip(input.description || input.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return base(input.file_path || input.notebook_path);
    case 'Grep': return clip(`/${input.pattern ?? ''}/`, 60);
    case 'Glob': return clip(input.pattern, 60);
    case 'WebFetch': try { return new URL(input.url).host; } catch { return ''; }
    case 'WebSearch': return clip(input.query, 80);
    case 'Agent': case 'Task': return clip(input.description || input.subagent_type, 80);
    case 'TodoWrite': return `${(input.todos || []).length} todos`;
    case 'Skill': return clip(`${input.skill || input.command || input.name || ''}${input.args ? ` ${input.args}` : ''}`, 80);
    case 'TaskCreate': return clip(input.subject || input.title, 80);
    default:
      if (name?.startsWith('mcp__')) return name.split('__').slice(1).join(' › ');
      return '';
  }
}
