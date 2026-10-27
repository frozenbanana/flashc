// flashc sync-devices — two-way merge of the flashc.db between this machine
// and a remote host running `flashc serve` (default: henry@nixos).
//
// Merge rules, per card (keyed by sheet_row, which is stable on both sides):
//   - scheduling state (due, interval, ease, reps, lapses, step):
//       the copy with more reps wins; tie -> the copy with newer updated_at
//   - content (thai, romanization, english, notes, active):
//       the copy with newer updated_at wins
//   - cards existing on only one side are copied to the other
// The merged DB is written locally, then pushed to the remote (single
// shared history going forward). Audio cache is synced both directions.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'flashc');
const DB_PATH = path.join(DATA_DIR, 'flashc.db');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DEFAULT_REMOTE = 'henry@nixos';
const REMOTE_DATA = '.local/share/flashc';

const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

const SCHED_COLS = ['due', 'interval', 'ease', 'reps', 'lapses', 'step'];
const CONTENT_COLS = ['thai', 'romanization', 'english', 'notes', 'active', 'created_at', 'updated_at'];

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || '').toString().trim()}`);
  }
  return r.stdout;
}

function parseRemote(arg) {
  const m = arg.match(/^((?:[\w.-]+@)?[\w.-]+)(?::(.+))?$/);
  if (!m) throw new Error(`Remote must look like [user@]host, got: ${arg}`);
  return { host: m[1], appPath: m[2] || null };
}

function openDB(file) {
  const db = new DatabaseSync(file);
  return db;
}

function mergeDbs(local, remoteDb, stats) {
  const locals = local.prepare('SELECT * FROM cards').all();
  const remotes = new Map(remoteDb.prepare('SELECT * FROM cards').all().map(r => [r.sheet_row, r]));

  const updSched = local.prepare(
    `UPDATE cards SET ${SCHED_COLS.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
  );
  const updContent = local.prepare(
    `UPDATE cards SET ${CONTENT_COLS.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
  );
  const insertRow = local.prepare(
    `INSERT INTO cards (id, sheet_row, thai, romanization, english, notes, active, due, interval, ease, reps, lapses, step, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const maxLocalId = local.prepare('SELECT MAX(id) m FROM cards').get().m || 0;
  const maxRemoteId = remoteDb.prepare('SELECT MAX(id) m FROM cards').get().m || 0;
  let nextId = Math.max(maxLocalId, maxRemoteId) + 1; // keep ids unique across devices

  for (const lc of locals) {
    const rc = remotes.get(lc.sheet_row);
    if (!rc) continue;               // exists only locally: local copy is the history
    remotes.delete(lc.sheet_row);

    // scheduling: more reps wins; tie -> newer updated_at
    if (rc.reps > lc.reps || (rc.reps === lc.reps && rc.updated_at > lc.updated_at)) {
      updSched.run(...SCHED_COLS.map(c => rc[c]), Math.max(lc.updated_at, rc.updated_at), lc.id);
      stats.schedFromRemote++;
    }

    // content: newer updated_at wins
    if (rc.updated_at > lc.updated_at) {
      updContent.run(...CONTENT_COLS.map(c => rc[c]), rc.updated_at, lc.id);
      stats.contentFromRemote++;
    }
  }

  // cards that exist only on the remote -> insert with fresh unique ids
  for (const rc of remotes.values()) {
    insertRow.run(nextId++, rc.sheet_row, rc.thai, rc.romanization, rc.english, rc.notes, rc.active,
      rc.due, rc.interval, rc.ease, rc.reps, rc.lapses, rc.step, rc.created_at, rc.updated_at);
    stats.addedFromRemote++;
  }
}

export function cmdSyncDevices(argv) {
  const arg = argv[1] || process.env.FLASHC_REMOTE || DEFAULT_REMOTE;
  const { host, appPath } = parseRemote(arg);
  const remoteData = REMOTE_DATA;

  console.log(`flashc sync-devices — syncing with ${BOLD(host)}`);

  // dev deployments may use a non-default app dir; not needed for the db (lives in $HOME)
  if (appPath) console.log(`(ignoring custom path ${appPath} — data always lives in ~/${remoteData})`);

  // 1. stop remote service + checkpoint its WAL so the main db file is complete
  sh('ssh', [host, 'systemctl --user stop flashc 2>/dev/null; sqlite3 ~/.local/share/flashc/flashc.db "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null; true']);

  // 2. pull remote db
  const tmp = path.join('/tmp', `flashc-remote-${Date.now()}.db`);
  sh('scp', ['-q', `${host}:${remoteData}/flashc.db`, tmp]);
  const remoteDb = openDB(tmp);

  // 2. merge into the local db
  const stats = { schedFromRemote: 0, contentFromRemote: 0, addedFromRemote: 0 };
  const local = openDB(DB_PATH);
  try {
    mergeDbs(local, remoteDb, stats);
  } finally {
    local.close();
    remoteDb.close();
  }
  fs.rmSync(tmp, { force: true });

  // checkpoint WAL so the merged state is fully in the main db file for scp
  sh('sqlite3', [DB_PATH, 'PRAGMA wal_checkpoint(TRUNCATE);']);

  // 4. push the merged db back (shared history) and restart the service
  sh('scp', ['-q', DB_PATH, `${host}:${remoteData}/flashc.db`]);
  const restart = spawnSync('ssh', [host, 'systemctl --user start flashc'], { stdio: 'ignore' });
  if (restart.status !== 0) console.log(YELLOW('note: could not restart remote flashc service automatically.'));

  // 5. audio cache: sync both directions (cheap incremental)
  try {
    sh('rsync', ['-a', '--ignore-existing', `${host}:${remoteData}/audio/`, `${AUDIO_DIR}/`]);
    sh('rsync', ['-a', '--ignore-existing', `${AUDIO_DIR}/`, `${host}:${remoteData}/audio/`]);
  } catch (e) {
    console.log(YELLOW(`audio sync skipped: ${e.message}`));
  }

  console.log(GREEN(`Merged: ${stats.schedFromRemote} scheduling states and ${stats.contentFromRemote} content edits taken from remote, ${stats.addedFromRemote} cards added from remote.`));
  console.log(GREEN('Both devices now have the same state. Next review session reflects everything.'));
}
