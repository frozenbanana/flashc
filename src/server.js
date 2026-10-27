// flashc serve — simple web UI for phone-based review sessions.
// Zero dependencies: node:http + the existing flashc modules.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, getConfig, AUDIO_DIR } from './db.js';
import { syncSheet, getMapping } from './sync.js';
import { schedule, previewLabels, isLearning, isNew, isDue } from './srs.js';

const PORT = parseInt(process.env.FLASHC_PORT || '8814', 10);
const HOST = process.env.FLASHC_HOST || '0.0.0.0';
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const DAY_MS = 86_400_000;
const NEW_LIMIT = 20; // new cards introduced per session (same as CLI)

// ---------- session state ----------

// A "session" builds a queue of due cards once; the phone walks through it.
let session = null; // { builtAt, queue: [card], index }

function buildSession() {
  const now = Date.now();
  const newIds = db.prepare(
    'SELECT id FROM cards WHERE active = 1 AND due <= ? AND reps = 0 ORDER BY sheet_row LIMIT ?'
  ).all(now, NEW_LIMIT).map(r => r.id);
  const newSet = new Set(newIds);
  const queue = db.prepare(`
    SELECT * FROM cards WHERE active = 1 AND due <= ?
    ORDER BY CASE WHEN step >= 0 THEN 0 ELSE 1 END, due ASC
  `).all(now).filter(c => !isNew(c) || newSet.has(c.id));
  session = { builtAt: now, queue, index: 0 };
  return session;
}

function counts() {
  const now = Date.now();
  const due = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND due <= ?').get(now).c;
  const total = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1').get().c;
  return { due, total };
}

function gradeCard(card, grade) {
  const state = schedule(card, grade);
  db.prepare('UPDATE cards SET due = ?, interval = ?, ease = ?, step = ?, lapses = ?, reps = reps + 1, updated_at = ? WHERE id = ?')
    .run(state.due, state.interval, state.ease, state.step, state.lapses, Date.now(), card.id);
}

function nextDueIn() {
  const m = db.prepare('SELECT MIN(due) m FROM cards WHERE active = 1 AND due > ?').get(Date.now()).m;
  if (m == null) return null;
  const d = m - Date.now();
  const min = Math.round(d / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// ---------- TTS proxy (cached on disk, shared with the CLI) ----------

const TTS_URL = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q=';
const ttsInFlight = new Map();

function ttsPath(text) {
  const hash = crypto.createHash('sha1').update(text, 'utf8').digest('hex');
  return path.join(AUDIO_DIR, `${hash}.mp3`);
}

async function tts(text) {
  const file = ttsPath(text);
  if (fs.existsSync(file) && fs.statSync(file).size > 100) return file;
  if (ttsInFlight.has(file)) return ttsInFlight.get(file);
  const p = (async () => {
    try {
      const res = await fetch(TTS_URL + encodeURIComponent(text), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return null;
      fs.writeFileSync(file, buf);
      return file;
    } catch {
      return null;
    } finally {
      ttsInFlight.delete(file);
    }
  })();
  ttsInFlight.set(file, p);
  return p;
}

// ---------- queue payload for the UI ----------

function cardPayload(card, now = Date.now()) {
  const before = card.reps > 0;
  return {
    id: card.id,
    thai: card.thai,
    romanization: card.romanization,
    english: card.english,
    notes: card.notes,
    kind: !isNew(card) ? 'review' : before ? 'relearn' : 'new',
    learning: isLearning(card),
    previews: previewLabels(card),
  };
}

function sessionPayload() {
  if (!session) buildSession();
  if (session.index >= session.queue.length) {
    // everything graded — rebuild to pick up fast-due learning cards
    buildSession();
  }
  const counts_ = counts();
  if (!session.queue.length) {
    return { done: true, ...counts_, nextDueIn: nextDueIn(), message: 'Nothing due! 🎉' };
  }
  return {
    done: false,
    ...counts_,
    remaining: session.queue.length - session.index,
    card: cardPayload(session.queue[session.index]),
  };
}

// ---------- HTTP plumbing ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

async function handleAPI(req, res, url) {
  try {
    if (url.pathname === '/api/queue' && req.method === 'GET') {
      // best-effort sync on session start / reset
      if (!session) {
        try { await syncSheet({ quiet: true }); } catch { /* review with local data */ }
        buildSession();
      }
      return sendJSON(res, 200, sessionPayload());
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      session = null;
      try { await syncSheet({ quiet: true }); } catch { /* offline ok */ }
      buildSession();
      return sendJSON(res, 200, sessionPayload());
    }

    if (url.pathname === '/api/answer' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const grade = parsed.grade;
      if (!Number.isInteger(grade) || grade < 0 || grade > 3) {
        return sendJSON(res, 400, { error: 'grade must be 0-3' });
      }
      if (!session || session.index >= session.queue.length) {
        return sendJSON(res, 409, { error: 'no active card' });
      }
      const card = session.queue[session.index];
      gradeCard(card, grade);
      session.index++;
      return sendJSON(res, 200, sessionPayload());
    }

    if (url.pathname === '/api/skip' && req.method === 'POST') {
      if (session && session.index < session.queue.length) {
        session.queue.push(session.queue.splice(session.index, 1)[0]);
      }
      return sendJSON(res, 200, sessionPayload());
    }

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const now = Date.now();
      const reviews = db.prepare('SELECT SUM(reps) r, SUM(lapses) l FROM cards WHERE active = 1').get();
      const stats = {
        total: db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1').get().c,
        due: db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND due <= ?').get(now).c,
        learning: db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND step >= 0').get().c,
        mature: db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND interval >= 21').get().c,
        avgEase: db.prepare('SELECT AVG(ease) e FROM cards WHERE active = 1 AND reps > 0').get().e,
        reps: reviews.r || 0,
        lapses: reviews.l || 0,
        nextDueIn: nextDueIn(),
      };
      if (stats.reps) stats.retention = 1 - stats.lapses / stats.reps;
      return sendJSON(res, 200, stats);
    }

    if (url.pathname === '/api/audio' && req.method === 'GET') {
      const text = (url.searchParams.get('t') || '').trim();
      if (!text) { sendJSON(res, 400, { error: 'missing t' }); return; }
      const file = await tts(text);
      if (!file) { sendJSON(res, 502, { error: 'tts failed' }); return; }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

function serveStatic(res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    send(res, 404, 'not found', 'text/plain');
    return;
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

// ---------- main ----------

export function cmdServe() {
  if (!getConfig('sheet_id') || !getMapping()) {
    console.error('Not configured. Run `flashc setup` first (or rsync ~/.local/share/flashc from your desktop).');
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) handleAPI(req, res, url);
    else serveStatic(res, url.pathname);
  });
  // warm up: build session lazily on first request instead
  server.listen(PORT, HOST, () => {
    console.log(`flashc web listening on http://${HOST}:${PORT}`);
  });
}
