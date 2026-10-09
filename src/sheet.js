// Minimal RFC 4180 CSV parser (handles quotes, embedded commas/newlines, CRLF).

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i += 2; continue;
    }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // last field/row (if file doesn't end with newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // drop fully-empty trailing rows
  while (rows.length && rows[rows.length - 1].every(f => f.trim() === '')) rows.pop();
  return rows;
}

// Extract the sheet id from any Google Sheets URL (or accept a bare id).
export function extractSheetId(input) {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{25,}$/.test(input.trim())) return input.trim();
  return null;
}

export function sheetCsvUrl(sheetId, gid = null) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
  return gid != null ? `${url}&gid=${gid}` : url;
}

function decodeName(raw) {
  let name = raw;
  // names are JSON-escaped (sometimes twice) inside the page's embedded JSON
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = JSON.parse(`"${name}"`);
      if (decoded === name) break;
      name = decoded;
    } catch { break; }
  }
  name = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return name.trim();
}

/**
 * List the sheet's tabs (name + gid) by scraping the public /edit page.
 * Returns [{ name, gid }] or [] if it can't be parsed.
 */
export async function listTabs(sheetId) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const re = /\[\d+,0,\\?"(\d+)\\?",\[\{\\?"1\\?":\[\[0,0,\\?"((?:\\\\.|[^"\\])*)\\?"/g;
  const tabs = [];
  let m;
  while ((m = re.exec(html))) {
    tabs.push({ gid: m[1], name: decodeName(m[2]) });
  }
  // de-dup (the same tab can appear twice in the snapshot)
  const seen = new Set();
  return tabs.filter(t => { const k = t.gid + '|' + t.name; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function cellRef(colIndex) {
  let s = '';
  let n = colIndex;
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}
