import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'flashc');
const DB_PATH = path.join(DATA_DIR, 'flashc.db');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_row INTEGER UNIQUE,           -- row number in the sheet (1 = header)
  thai TEXT NOT NULL,
  romanization TEXT,
  english TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1, -- 0 if row vanished from sheet
  -- SM-2 scheduling state
  due INTEGER NOT NULL DEFAULT 0,     -- epoch ms when card is due
  interval REAL NOT NULL DEFAULT 0,  -- days (0 = new/learning)
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,   -- learning step index (-1 = graduated)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(active, due);
`);

export function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setConfig(key, value) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
