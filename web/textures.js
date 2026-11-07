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

export function cloudTexture() {
  return make(256, 128, (ctx, w, h) => {
    const r = rng(21);
    for (let i = 0; i < 14; i++) {
      const x = 40 + r() * (w - 80), y = h * 0.55 + (r() - 0.5) * 30, s = 22 + r() * 30;
      const g = ctx.createRadialGradient(x, y, 0, x, y, s);
      g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.6, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill();
    }
  }, { repeat: [1, 1] });
}

export function moonTexture() {
  return make(128, 128, (ctx, w) => {
    const c = w / 2;
    const g = ctx.createRadialGradient(c, c, 20, c, c, 64);
    g.addColorStop(0, 'rgba(255,250,235,0.5)'); g.addColorStop(1, 'rgba(255,250,235,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
    ctx.fillStyle = '#FFF8E6'; ctx.beginPath(); ctx.arc(c, c, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(210,200,180,0.5)';
    for (const [x, y, s] of [[-8, -6, 6], [9, 4, 4], [-2, 11, 3], [6, -12, 3]]) { ctx.beginPath(); ctx.arc(c + x, c + y, s, 0, Math.PI * 2); ctx.fill(); }
  });
}

// The same skyline twice: pastel by day, dark with lit windows by night (cross-faded in the scene).
export function cityTextures() {
  const draw = (night) => (ctx, w, h) => {
    const r = rng(42);
    if (night) {
      ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.clearRect(0, 0, w, h);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#7EC8F5'); g.addColorStop(0.75, '#FFE9F2'); g.addColorStop(1, '#FFF4F8');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    const pastel = ['#FF8FB8', '#FFB070', '#7CC4F5', '#FFD86B', '#B9A8F0', '#8FDDB8', '#9FD4F2', '#FFC4D8'];
    let x = 0;
    while (x < w) {
      const bw = 30 + r() * 60, bh = 60 + r() * 180, y0 = h - bh, col = pastel[Math.floor(r() * pastel.length)];
      const c = new THREE.Color(col);
      if (night) c.multiplyScalar(0.18).lerp(new THREE.Color('#141a3a'), 0.5);
      ctx.fillStyle = `#${c.getHexString()}`;
      roundRect(ctx, x, y0, bw, bh + 10, 8); ctx.fill();
      if (r() < 0.3) { ctx.fillRect(x + bw / 2 - 1, y0 - 14, 2, 14); } // antenna
      for (let wy = y0 + 10; wy < h - 8; wy += 13) {
        for (let wx = x + 7; wx < x + bw - 7; wx += 10) {
          const lit = r();
          if (night) {
            if (lit < 0.55) { ctx.fillStyle = lit < 0.45 ? 'rgba(255,214,140,0.95)' : 'rgba(170,210,255,0.9)'; ctx.fillRect(wx, wy, 5, 7); }
          } else if (lit < 0.75) { ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillRect(wx, wy, 5, 7); }
        }
      }
      x += bw + 5;
    }
  };
  return { day: make(1024, 320, draw(false)), night: make(1024, 320, draw(true)) };
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
