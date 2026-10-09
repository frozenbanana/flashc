import { db } from './db.js';
import { parseCSV, sheetCsvUrl } from './sheet.js';
import { getConfig } from './db.js';

export function getMapping() {
  const raw = getConfig('mapping');
  if (!raw) return null;
  return JSON.parse(raw);
}

/**
 * Fetch and sync the sheet into the cards table.
 * Returns { newCount, updatedCount, removedCount, total } or throws on network error.
 */
export async function syncSheet({ quiet = false } = {}) {
  const sheetId = getConfig('sheet_id');
  const mapping = getMapping();
  if (!sheetId || !mapping) {
    throw new Error('Not configured. Run `flashc setup` first.');
  }

  const res = await fetch(sheetCsvUrl(sheetId, getConfig('sheet_gid')), {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}. Is the sheet shared as "anyone with the link"?`);
  const csv = await res.text();
  const rows = parseCSV(csv);

  // If a header row is configured, skip it; otherwise all rows are cards.
  let dataRows = rows;
  if (getConfig('has_header') === '1') dataRows = rows.slice(1);

  const seenRows = new Set();
  let newCount = 0, updatedCount = 0;
  const now = Date.now();
  const { thai, romanization, english, notes } = mapping;

  const insert = db.prepare(`INSERT INTO cards (sheet_row, thai, romanization, english, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE cards SET thai = ?, romanization = ?, english = ?, notes = ?, active = 1, updated_at = ?
    WHERE sheet_row = ?`);

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const sheetRow = (getConfig('has_header') === '1' ? 2 : 1) + i;
    const get = (idx) => (idx != null && r[idx] != null ? r[idx].trim() : '');
    const thai = get(mapping.thai);
    if (!thai) continue;
    seenRows.add(sheetRow);

    const vals = [thai, get(mapping.romanization) || null, get(mapping.english) || null, get(mapping.notes) || null];
    const existing = db.prepare('SELECT id, thai, romanization, english, notes FROM cards WHERE sheet_row = ?').get(sheetRow);
    if (existing) {
      if (existing.thai !== thai || (existing.romanization ?? '') !== (vals[1] ?? '') ||
          (existing.english ?? '') !== (vals[2] ?? '') || (existing.notes ?? '') !== (vals[3] ?? '')) {
        update.run(...vals, now, sheetRow);
        updatedCount++;
      }
    } else {
      insert.run(sheetRow, ...vals, now, now);
      newCount++;
    }
  }

  // Rows that disappeared from the sheet: deactivate (progress kept, card hidden).
  const all = db.prepare('SELECT sheet_row FROM cards WHERE active = 1').all();
  let removedCount = 0;
  for (const { sheet_row } of all) {
    if (!seenRows.has(sheet_row)) {
      db.prepare('UPDATE cards SET active = 0, updated_at = ? WHERE sheet_row = ?').run(now, sheet_row);
      removedCount++;
    }
  }
  const total = db.prepare('SELECT COUNT(*) AS c FROM cards WHERE active = 1').get().c;

  if (!quiet) {
    const tab = getConfig('sheet_tab');
    console.log(`Synced${tab ? ` tab "${tab}"` : ''}: ${newCount} new, ${updatedCount} updated, ${removedCount} removed, ${total} total.`);
  }
  return { newCount, updatedCount, removedCount, total };
}
