// Procedural textures, drawn once on canvases: no image downloads, crisp at any size.
import * as THREE from 'three';

export function rng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function make(w, h, draw, { repeat = [1, 1], srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Light birch desk top with long grain.
export function woodTexture() {
  return make(512, 512, (ctx, w, h) => {
    const r = rng(7);
    ctx.fillStyle = '#EBD7BA'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 140; i++) {
      const y0 = r() * h, amp = 2 + r() * 6, freq = 0.004 + r() * 0.01, ph = r() * 6;
      ctx.strokeStyle = `rgba(${150 + r() * 40},${105 + r() * 30},${60 + r() * 30},${0.05 + r() * 0.12})`;
      ctx.lineWidth = 0.6 + r() * 2.2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) ctx.lineTo(x, y0 + Math.sin(x * freq + ph) * amp);
      ctx.stroke();
    }
    for (let i = 0; i < 5; i++) { // a few knots
      const x = r() * w, y = r() * h;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 10 + r() * 8);
      g.addColorStop(0, 'rgba(140,95,55,0.35)'); g.addColorStop(1, 'rgba(140,95,55,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
    }
  });
}

// Cream terrazzo with pastel chips, like a Minju City plaza.
export function terrazzoTexture() {
  return make(512, 512, (ctx, w, h) => {
    const r = rng(11);
    ctx.fillStyle = '#F8F2EA'; ctx.fillRect(0, 0, w, h);
    const chips = ['#FF8FB8', '#FFD86B', '#7CC4F5', '#B9A8F0', '#8FDDB8', '#E2D3C2', '#CDBDAA', '#FFB070'];
    for (let i = 0; i < 1600; i++) {
      const x = r() * w, y = r() * h, s = 1.5 + r() * (r() < 0.1 ? 7 : 3.5);
      ctx.fillStyle = chips[Math.floor(r() * chips.length)];
      ctx.globalAlpha = 0.35 + r() * 0.5;
      ctx.beginPath();
      const n = 3 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2 + r(); ctx.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s); }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, { repeat: [14, 14] });
}

export function grassTexture() {
  return make(256, 256, (ctx, w, h) => {
    const r = rng(5);
    ctx.fillStyle = '#9ED69A'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 5000; i++) {
      const x = r() * w, y = r() * h, l = 3 + r() * 6;
      const g = 150 + r() * 70;
      ctx.strokeStyle = `rgba(${70 + r() * 50},${g},${80 + r() * 40},${0.35 + r() * 0.4})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (r() - 0.5) * 3, y - l); ctx.stroke();
    }
  }, { repeat: [26, 26] });
}

// Near-white woven fabric: tinted by the material colour.
export function fabricTexture() {
  return make(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#F2F2F2'; ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        ctx.fillStyle = ((x + y) / 4) % 2 ? '#E2E2E2' : '#FAFAFA';
        ctx.fillRect(x, y, 4, 2);
      }
    }
  }, { repeat: [3, 3] });
}

export function rockTexture() {
  return make(256, 256, (ctx, w, h) => {
    const r = rng(3);
    ctx.fillStyle = '#EBC3D1'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const x = r() * w, y = r() * h, s = 2 + r() * 14;
      ctx.fillStyle = `rgba(${200 + r() * 50},${150 + r() * 50},${170 + r() * 50},${0.15 + r() * 0.25})`;
      ctx.beginPath(); ctx.ellipse(x, y, s, s * (0.4 + r() * 0.6), r() * 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(150,100,120,0.18)';
    for (let i = 0; i < 40; i++) { ctx.beginPath(); ctx.moveTo(r() * w, 0); ctx.lineTo(r() * w, h); ctx.stroke(); }
  }, { repeat: [12, 1] });
}

// Round rug under Minju's desk.
export function rugTexture() {
  return make(512, 512, (ctx, w) => {
    const c = w / 2;
    const rings = ['#FFE1EC', '#FFD0E0', '#FFE9F2', '#FFC4D8', '#FFF4F8', '#FFD6E5'];
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = rings[i % rings.length];
      ctx.beginPath(); ctx.arc(c, c, c - i * 20, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(200,50,95,0.18)'; ctx.lineWidth = 3;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * 60, c + Math.sin(a) * 60); ctx.lineTo(c + Math.cos(a) * 240, c + Math.sin(a) * 240); ctx.stroke();
    }
    const r = rng(9);
    for (let i = 0; i < 2500; i++) { // pile
      ctx.fillStyle = `rgba(255,255,255,${r() * 0.12})`;
      ctx.fillRect(r() * w, r() * w, 1.5, 1.5);
    }
  });
}

export function keyboardTexture() {
  return make(256, 88, (ctx, w, h) => {
    ctx.fillStyle = '#E3E6EC'; ctx.fillRect(0, 0, w, h);
    const rows = 5, kh = (h - 8) / rows;
    for (let r = 0; r < rows; r++) {
      let x = 4 + (r % 2) * 5;
      const y = 4 + r * kh;
      while (x < w - 10) {
        const kw = r === 4 && x > 60 && x < 150 ? 90 : 14;
        ctx.fillStyle = '#C9CDD6'; roundRect(ctx, x, y + 1.5, kw - 2, kh - 2, 2.5); ctx.fill();
        ctx.fillStyle = '#FFFFFF'; roundRect(ctx, x, y, kw - 2, kh - 3, 2.5); ctx.fill();
        x += kw;
      }
    }
  });
}

// Solar array blanket: dark blue cells in a silver frame.
export function solarPanelTexture() {
  return make(256, 512, (ctx, w, h) => {
    const r = rng(8);
    ctx.fillStyle = '#C9CED8'; ctx.fillRect(0, 0, w, h);
    const cols = 4, rows = 16, pad = 6, gap = 3;
    const cw = (w - pad * 2 - gap * (cols - 1)) / cols, ch = (h - pad * 2 - gap * (rows - 1)) / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const px = pad + x * (cw + gap), py = pad + y * (ch + gap), l = 16 + r() * 10;
        const g = ctx.createLinearGradient(px, py, px + cw, py + ch);
        g.addColorStop(0, `hsl(222,62%,${l + 6}%)`); g.addColorStop(1, `hsl(228,70%,${l - 4}%)`);
        ctx.fillStyle = g; ctx.fillRect(px, py, cw, ch);
        ctx.strokeStyle = 'rgba(150,180,235,0.35)'; ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(px + (cw * i) / 4, py); ctx.lineTo(px + (cw * i) / 4, py + ch); ctx.stroke(); }
      }
    }
  });
}

// Crinkled gold multi-layer insulation.
export function foilTexture() {
  return make(256, 256, (ctx, w, h) => {
    const r = rng(19);
    ctx.fillStyle = '#C8963A'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const x = r() * w, y = r() * h, s = 8 + r() * 30, l = r();
      ctx.fillStyle = l < 0.5 ? `rgba(120,78,20,${0.15 + r() * 0.25})` : `rgba(255,226,150,${0.15 + r() * 0.3})`;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 3; k++) ctx.lineTo(x + (r() - 0.5) * s * 2, y + (r() - 0.5) * s * 2);
      ctx.closePath(); ctx.fill();
    }
  }, { repeat: [2, 1] });
}

// Open lattice for the station truss (used with alphaTest).
export function trussTexture() {
  return make(256, 64, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#D9DCE3'; ctx.lineCap = 'round';
    ctx.lineWidth = 7; ctx.strokeRect(3.5, 3.5, w - 7, h - 7);
    ctx.lineWidth = 5;
    for (let x = 0; x < w; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 64, h); ctx.stroke();
    }
  }, { repeat: [10, 1] });
}

// The Sun: a white-hot core in a warm corona.
export function sunTexture() {
  return make(512, 512, (ctx, w) => {
    const c = w / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.05, 'rgba(255,255,250,1)');
    g.addColorStop(0.09, 'rgba(255,240,215,0.85)');
    g.addColorStop(0.2, 'rgba(255,205,150,0.32)');
    g.addColorStop(0.45, 'rgba(255,160,110,0.08)');
    g.addColorStop(1, 'rgba(255,140,100,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
  }, { repeat: [1, 1] });
}

// Glare streaks around the Sun.
export function sunRaysTexture() {
  return make(512, 512, (ctx, w) => {
    const r = rng(5), c = w / 2;
    ctx.translate(c, c);
    ctx.globalCompositeOperation = 'lighter';
    const ray = (angle, len, width, alpha) => {
      ctx.save(); ctx.rotate(angle);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, `rgba(255,236,200,${alpha})`); g.addColorStop(1, 'rgba(255,236,200,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, -width); ctx.lineTo(len, 0); ctx.lineTo(0, width); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    for (let i = 0; i < 6; i++) ray((i / 6) * Math.PI * 2 + 0.3, c * 0.98, 5, 0.55);
    for (let i = 0; i < 40; i++) ray(r() * Math.PI * 2, c * (0.25 + r() * 0.55), 1.5 + r() * 3, 0.12 + r() * 0.2);
  }, { repeat: [1, 1] });
}

// A code editor / terminal, drawn per desk and scrolled while the agent works.
const TOKEN = ['#FF8FB8', '#7CC4F5', '#FFD86B', '#8FDDB8', '#B9A8F0', '#C9CED8', '#C9CED8', '#FFB070'];
export function drawScreen(ctx, w, h, { seed = 1, offset = 0, accent = '#7CC4F5', on = true, label = '' }) {
  if (!on) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#2C313D'); g.addColorStop(0.5, '#1E222C'); g.addColorStop(1, '#262A35');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(w * 0.55, 0); ctx.lineTo(w * 0.75, 0); ctx.lineTo(w * 0.4, h); ctx.lineTo(w * 0.2, h); ctx.fill();
    return;
  }
  ctx.fillStyle = '#1E2230'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, w, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '600 9px "IBM Plex Sans Thai", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.slice(0, 34), 6, 6.5);
  ctx.fillStyle = '#262B3A'; ctx.fillRect(0, 12, 46, h - 12); // file tree
  const tr = rng(seed * 7);
  for (let i = 0; i < 9; i++) { ctx.fillStyle = 'rgba(201,206,216,0.45)'; ctx.fillRect(6 + (tr() < 0.4 ? 6 : 0), 18 + i * 11, 18 + tr() * 18, 4); }
  const lineH = 9, rows = Math.floor((h - 16) / lineH);
  for (let i = 0; i < rows; i++) {
    const r = rng(seed * 1000 + i + offset);
    const y = 16 + i * lineH;
    ctx.fillStyle = 'rgba(201,206,216,0.3)'; ctx.fillRect(52, y + 2, 7, 4);
    let x = 64 + Math.floor(r() * 4) * 8;
    const n = 1 + Math.floor(r() * 5);
    for (let k = 0; k < n && x < w - 10; k++) {
      const tw = 8 + r() * 34;
      ctx.fillStyle = TOKEN[Math.floor(r() * TOKEN.length)];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y + 1.5, Math.min(tw, w - 8 - x), 5);
      x += tw + 4;
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = accent; ctx.fillRect(64 + ((offset * 13) % 80), 16 + (rows - 1) * lineH, 2, 7); // cursor
}
