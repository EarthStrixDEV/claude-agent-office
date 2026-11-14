// Small DOM and date helpers shared by the History panel and the Timeline.
// Everything that comes from a transcript is put in the page as text nodes, never as markup.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c); // strings become text nodes
  return el;
}

// Locale comes from the browser (undefined), so a Thai browser gets "วันนี้ / เมื่อวาน / 8 พ.ย. / ต.ค. 2569".
const DAY_MS = 86_400_000;
export const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const daysAgo = (t, now = Date.now()) => Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);
const cap = (s) => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const fmtDM = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fmtDMY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtMY = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const fmtHM = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const relDay = (n) => cap(rel.format(n, 'day'));

// History group header: Today · Yesterday · day within a week · then one header per month.
export function groupLabel(t) {
  const d = daysAgo(t);
  if (d <= 0) return relDay(0);
  if (d === 1) return relDay(-1);
  if (d < 7) return fmtDM.format(t);
  return fmtMY.format(t);
}

// Timeline day separator: same wording, but always a single day.
export function dayLabel(t) {
  const d = daysAgo(t);
  if (d <= 0) return relDay(0);
  if (d === 1) return relDay(-1);
  return new Date(t).getFullYear() === new Date().getFullYear() ? fmtDM.format(t) : fmtDMY.format(t);
}

export const hhmm = (t) => fmtHM.format(t);
export const fullTime = (t) => fmtFull.format(t);

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// The bridge without the Session Trail API answers 404 "unknown api"; that is an error, not a missing session.
export const isGone = (err) => err?.status === 404 && !/unknown api/i.test(err.message || '');
