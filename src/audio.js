import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AUDIO_DIR } from './db.js';

const TTS_URL = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q=';
const PLAYER = 'mpv';

const inFlight = new Map();

function audioPath(text) {
  const hash = crypto.createHash('sha1').update(text, 'utf8').digest('hex');
  return path.join(AUDIO_DIR, `${hash}.mp3`);
}

/** Fetch the mp3 for `text`. Resolves true if the file is ready to play. */
async function ensureAudio(text) {
  const file = audioPath(text);
  if (fs.existsSync(file) && fs.statSync(file).size > 100) return true;
  if (inFlight.has(file)) return inFlight.get(file);

  const promise = (async () => {
    try {
      const res = await fetch(TTS_URL + encodeURIComponent(text), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return false;
      fs.writeFileSync(file, buf);
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(file);
    }
  })();
  inFlight.set(file, promise);
  return promise;
}

/** Play the Thai pronunciation of `text`. Non-blocking. */
export async function play(text) {
  const ok = await ensureAudio(text);
  if (!ok) return false;
  const p = spawn(PLAYER, ['--no-video', '--really-quiet', '--', audioPath(text)], {
    stdio: 'ignore',
    detached: true,
  });
  p.unref();
  return true;
}

/** Prefetch audio for a card so review playback feels instant. */
export function prefetch(text) {
  ensureAudio(text).catch(() => {});
}
