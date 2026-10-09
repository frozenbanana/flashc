import { spawnSync } from 'node:child_process';

// Big-text rendering: renders text with Pango (proper Thai shaping) via ImageMagick
// and prints it inline as a sixel image. Auto-detects sixel support, cell size and
// foreground color from the terminal.

const cache = new Map();

/** Send an escape-sequence query to the terminal and wait for a matching response. */
function queryTerm(payload, regex, timeoutMs = 400) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) { resolve(null); return; }
    const wasRaw = !!process.stdin.isRaw;
    let data = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      try { process.stdin.setRawMode(wasRaw); } catch { /* ignore */ }
      resolve(val);
    };
    const onData = (chunk) => {
      data += chunk.toString('latin1');
      const m = data.match(regex);
      if (m) finish(m);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { process.stdin.setRawMode(true); } catch { finish(null); return; }
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdout.write(payload);
  });
}

async function detectSixel() {
  const m = await queryTerm('\x1b[c', /\x1b\[\?([\d;]+)c/);
  if (!m) return false;
  return m[1].split(';').includes('4');
}

async function detectCellSize() {
  const m = await queryTerm('\x1b[16t', /\x1b\[6;(\d+);(\d+)t/);
  if (!m) return null;
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

function toHex8(component) {
  const v = parseInt(component, 16);
  return Math.round((v / 0xffff) * 255).toString(16).padStart(2, '0');
}

async function detectFgColor() {
  const m = await queryTerm('\x1b]10;?\x07', /\x1b\]10;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/);
  if (!m) return '#ffffff';
  return `#${toHex8(m[1])}${toHex8(m[2])}${toHex8(m[3])}`;
}

/**
 * Probe the terminal once at session start.
 * Returns { sixel: bool, cellH: px|16, color: '#rrggbb' }.
 */
export async function detectTerminal() {
  const [sixel, cell, color] = await Promise.all([detectSixel(), detectCellSize(), detectFgColor()]);
  return { sixel: !!sixel, cellH: cell?.h || 22, color: color || '#ffffff' };
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render `text` as a sixel image with a glyph height of ~pxHeight screen pixels.
 * Returns a Buffer (the sixel escape sequence) or null on failure.
 */
export function renderBigText(text, pxHeight, color = '#ffffff') {
  const key = `${text}\u0000${pxHeight}\u0000${color}`;
  if (cache.has(key)) return cache.get(key);

  // px -> pt at 96dpi (Pango font sizes are in points)
  const pts = Math.max(10, Math.round(pxHeight * 0.75));
  const markup = `<span font_desc="Noto Sans Thai ${pts}" foreground="${color}">${escapeXml(text)}</span>`;

  let out = null;
  try {
    const r = spawnSync('magick', [
      '-background', 'none',
      '-units', 'PixelsPerInch', '-density', '72x72',
      `pango:${markup}`,
      'sixel:-',
    ], { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', timeout: 5000 });
    if (r.status === 0 && r.stdout && r.stdout.length > 10 && r.stdout[0] === 0x1b) {
      out = r.stdout;
    }
  } catch { /* fall through */ }
  cache.set(key, out);
  return out;
}

/**
 * Render `text` as Unicode half-block art (▀▄█) occupying `rows` terminal rows.
 * Works in any terminal (no sixel needed). Returns a string or null.
 */
export function renderBlockText(text, rows, color = '#ffffff') {
  rows = Math.max(4, Math.round(rows)); // below ~4 rows, block art is illegible
  const key = `block\u0000${text}\u0000${rows}\u0000${color}`;
  if (cache.has(key)) return cache.get(key);

  const cols = process.stdout.columns || 80;
  // em height ≈ rows*2 px (each block row = 2 pixel rows)
  const pts = Math.max(2, Math.round(rows * 2 * 0.75));
  const markup = `<span font_desc="Noto Sans Thai ${pts}" foreground="#ffffff">${escapeXml(text)}</span>`;

  let out = null;
  try {
    const r = spawnSync('magick', [
      '-background', 'none',
      `pango:${markup}`,
      '-depth', '8',
      'txt:-',
    ], { maxBuffer: 32 * 1024 * 1024, timeout: 5000 });

    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.toString('utf8').split('\n');
      // header: # ImageMagick pixel enumeration: W,H,depth,max, colorspace
      const hdr = lines[0].match(/pixel enumeration: (\d+),(\d+),(\d+),(\d+)/);
      const maxVal = hdr ? +hdr[4] : 255;
      const px = new Map();
      let W = 0, H = 0;
      for (const line of lines) {
        const m = line.match(/^(\d+),(\d+): \(([\d,.]+)\)/);
        if (!m) continue;
        const x = +m[1], y = +m[2];
        const parts = m[3].split(',');
        const alpha = parts.length >= 4 ? parseFloat(parts[3]) : maxVal; // srgba: 4th channel = alpha
        if (alpha < maxVal / 2) continue; // coverage threshold
        px.set(`${x},${y}`, 1);
        if (x + 1 > W) W = x + 1;
        if (y + 1 > H) H = y + 1;
      }
      // too wide for the terminal -> caller falls back to plain text
      if (W > 0 && W <= cols - 4) {
        const blockRows = Math.ceil(H / 2);
        const [rr, gg, bb] = hexToRgb888(color);
        let art = `\x1b[38;2;${rr};${gg};${bb}m`;
        for (let y = 0; y < blockRows * 2; y += 2) {
          for (let x = 0; x < W; x++) {
            const top = px.has(`${x},${y}`);
            const bot = px.has(`${x},${y + 1}`);
            art += (top && bot) ? '█' : top ? '▀' : bot ? '▄' : ' ';
          }
          art += '\n';
        }
        art += '\x1b[0m';
        out = art;
      }
    }
  } catch { /* fall through */ }
  cache.set(key, out);
  return out;
}

function hexToRgb888(hex) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
