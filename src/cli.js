import readline from 'node:readline';
import { db, getConfig, setConfig } from './db.js';
import { parseCSV, extractSheetId, sheetCsvUrl, cellRef, listTabs } from './sheet.js';
import { syncSheet, getMapping } from './sync.js';
import { schedule, previewLabels, isLearning, isNew, isDue } from './srs.js';
import { play, prefetch } from './audio.js';
import { detectTerminal, renderBigText, renderBlockText } from './bigtext.js';

// ---------- small helpers ----------

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const CYAN = (s) => `\x1b[36m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

function fmtDue(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return RED('due now');
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtInterval(card) {
  if (isLearning(card)) return `learning (step ${card.step + 1})`;
  if (isNew(card)) return DIM('new');
  return `${card.interval}d`;
}

async function fetchSheetRows(sheetId, gid = null) {
  const res = await fetch(sheetCsvUrl(sheetId, gid), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Could not fetch sheet: HTTP ${res.status}. Make sure it's shared "anyone with the link".`);
  return parseCSV(await res.text());
}

// ---------- setup ----------

async function cmdSetup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(BOLD('flashc setup — connect your Google Sheet\n'));

  // 1. Sheet URL
  let sheetId = null;
  if (getConfig('sheet_id')) {
    console.log(`Current sheet: ${getConfig('sheet_id')}`);
    if ((await ask(rl, 'Keep it? [Y/n] ')).toLowerCase() !== 'n') {
      sheetId = getConfig('sheet_id');
    }
  }
  while (!sheetId) {
    const url = await ask(rl, 'Paste your Google Sheets URL (or sheet id): ');
    sheetId = extractSheetId(url);
    if (!sheetId) console.log(RED('  That does not look like a Google Sheets link. Try again.'));
  }
  setConfig('sheet_id', sheetId);

  // 2. Pick a tab
  console.log('\nFetching tabs...');
  let gid = null;
  try {
    const tabs = await listTabs(sheetId);
    if (tabs.length > 1) {
      console.log(`\n${BOLD('Tabs in this sheet:')}`);
      tabs.forEach((t, i) => console.log(`  ${i + 1}. ${t.name} ${DIM(`(gid ${t.gid})`)}`));
      let pick;
      while (true) {
        pick = await ask(rl, `\nWhich tab do you want to study? [1-${tabs.length}] `);
        const n = parseInt(pick, 10);
        if (n >= 1 && n <= tabs.length) { gid = tabs[n - 1].gid; break; }
        // also allow selecting by (partial) name
        const byName = tabs.filter(t => t.name.toLowerCase().includes(pick.toLowerCase()));
        if (pick && byName.length === 1) { gid = byName[0].gid; break; }
        console.log(RED('  Pick a number from the list (or a unique part of a tab name).'));
      }
      console.log(`Using tab: ${CYAN(tabs.find(t => t.gid === gid).name)}`);
      setConfig('sheet_gid', gid);
      setConfig('sheet_tab', tabs.find(t => t.gid === gid).name);
    } else {
      gid = tabs[0]?.gid ?? null;
      setConfig('sheet_gid', gid);
      setConfig('sheet_tab', tabs[0]?.name ?? '');
      console.log(`Only one tab found: ${CYAN(tabs[0]?.name ?? '?')} — using it.`);
    }
  } catch {
    console.log(YELLOW('Could not list tabs automatically. If your sheet has multiple tabs, paste the gid from the URL (#gid=...) or press Enter for the first tab.'));
    const g = await ask(rl, 'gid [Enter = first tab]: ');
    setConfig('sheet_gid', g && /^\d+$/.test(g) ? g : null);
  }

  // 3. Fetch and inspect
  console.log('\nFetching sheet...');
  let rows;
  try {
    rows = await fetchSheetRows(sheetId, getConfig('sheet_gid'));
  } catch (e) {
    console.log(RED(e.message));
    rl.close();
    process.exit(1);
  }
  if (!rows.length) {
    console.log(RED('Sheet appears to be empty. Add some words and run setup again.'));
    rl.close();
    process.exit(1);
  }

  const numCols = Math.max(...rows.map(r => r.length));

  // 3. Header row?
  console.log(`\nFirst row of the sheet:`);
  rows[0].forEach((cell, i) => console.log(`  ${cellRef(i)}: ${cell || DIM('(empty)')}`));
  const hasHeader = (await ask(rl, '\nIs the first row a header row (column names)? [y/N] ')).toLowerCase() === 'y';
  setConfig('has_header', hasHeader ? '1' : '0');

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const preview = dataRows.slice(0, 5);

  // 4. Column mapping
  console.log(`\n${BOLD('Column mapping')} — for each field, enter the column letter (e.g. A) or leave empty to skip.\n`);
  if (preview.length) {
    console.log(DIM('  Data preview:'));
    for (const [ri, r] of preview.entries()) {
      console.log(DIM(`    row ${ri + 1}: `) + r.slice(0, numCols).map((c, i) => `${cellRef(i)}=${c || '·'}`).join('  '));
    }
    console.log();
  }

  const fields = [
    { name: 'thai', label: 'Thai script', required: true },
    { name: 'romanization', label: 'Romanization', required: false },
    { name: 'english', label: 'English / meaning', required: false },
    { name: 'notes', label: 'Notes', required: false },
  ];
  const mapping = {};
  for (const f of fields) {
    let col;
    while (true) {
      col = await ask(rl, `  ${f.label}${f.required ? RED(' (required)') : DIM(' (optional)')}: `);
      if (!col && !f.required) { col = null; break; }
      const idx = col ? col.trim().toUpperCase().split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1 : -1;
      if (idx >= 0 && idx < numCols) { mapping[f.name] = idx; break; }
      console.log(RED(`    Invalid column. Use a letter between A and ${cellRef(numCols - 1)}.`));
    }
  }
  setConfig('mapping', JSON.stringify(mapping));
  console.log(`\n${GREEN('Setup complete.')} Stored mapping: thai=${cellRef(mapping.thai)}${mapping.romanization != null ? `, romanization=${cellRef(mapping.romanization)}` : ''}${mapping.english != null ? `, english=${cellRef(mapping.english)}` : ''}${mapping.notes != null ? `, notes=${cellRef(mapping.notes)}` : ''}`);
  console.log(`Run ${BOLD('flashc sync')} to load your words, then ${BOLD('flashc')} (or ${BOLD('flashc review')}) to start reviewing.`);
  rl.close();
}

// ---------- sync ----------

async function cmdSync() {
  try {
    await syncSheet({ quiet: false });
  } catch (e) {
    console.error(RED(e.message));
    process.exit(1);
  }
}

// ---------- review ----------

const term = { sixel: false, cellH: 22, color: '#ffffff' };
let bigScale = 1.5;

function printCardFront(card, sess) {
  clearScreen();
  const now = Date.now();
  const learnDue = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND step >= 0 AND reps > 0 AND due <= ?').get(now).c;
  const revDue = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND step = -1 AND due <= ?').get(now).c;
  const newLeft = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND reps = 0').get().c;
  const budgetLeft = sess.max - sess.answered;
  console.log(DIM(`${card.english ? 'en→th' : 'th→en'} · answered ${sess.answered}/${sess.max} · this session: ${budgetLeft} left · due later: ${learnDue + revDue} · new unseen: ${newLeft}`));
  console.log('');
  const bigRows = Math.max(2, Math.round(bigScale * 1.5));
  const big = term.sixel
    ? renderBigText(card.thai, Math.round(term.cellH * bigScale), term.color)
    : renderBlockText(card.thai, bigRows, term.color);
  if (big) {
    process.stdout.write(big);
    process.stdout.write('\n');
  } else {
    console.log(`  ${BOLD(card.thai)}`);
    console.log('');
  }
  console.log(DIM('  [p] play audio   [space] reveal   [s] skip   [q] quit'));
}

function nextDueInfo() {
  const now = Date.now();
  const learn = db.prepare('SELECT MIN(due) m FROM cards WHERE active = 1 AND step >= 0 AND reps > 0 AND due > ?').get(now).m;
  const rev = db.prepare('SELECT MIN(due) m FROM cards WHERE active = 1 AND step = -1 AND due > ?').get(now).m;
  const times = [learn, rev].filter(Boolean);
  return times.length ? Math.min(...times) : null;
}

function printCardBack(card, previews) {
  if (card.romanization) console.log(`  ${CYAN(card.romanization)}`);
  if (card.english) console.log(`  ${card.english}`);
  if (card.notes) console.log(DIM(`  note: ${card.notes}`));
  console.log('');
  console.log('  How well did you remember it?');
  console.log(`    ${RED('1 Again')} (${previews[0]})  ${YELLOW('2 Hard')} (${previews[1]})  ${GREEN('3 Good')} (${previews[2]})  ${CYAN('4 Easy')} (${previews[3]})`);
  console.log(DIM('    [p] replay audio   [s] skip   [q] quit'));
}

function gradeCard(card, grade) {
  const state = schedule(card, grade);
  db.prepare('UPDATE cards SET due = ?, interval = ?, ease = ?, step = ?, lapses = ?, reps = reps + 1, updated_at = ? WHERE id = ?')
    .run(state.due, state.interval, state.ease, state.step, state.lapses, Date.now(), card.id);
}

async function cmdReview(argv) {
  if (!getConfig('sheet_id') || !getMapping()) {
    console.log('Not configured yet. Run ' + BOLD('flashc setup') + ' first.');
    process.exit(1);
  }

  // session budgets — tuned for a focused 5-20 minute session
  const minutes = argv.includes('--minutes')
    ? parseInt(argv[argv.indexOf('--minutes') + 1], 10)
    : (parseInt(process.env.FLASHC_MINUTES, 10) || null);
  const newLimit = parseInt(getConfig('new_per_session'), 10) || 5;
  const maxCards = parseInt(getConfig('session_cards'), 10) || 20;
  const endTime = minutes ? Date.now() + minutes * 60_000 : null;

  // sync on startup (registers new words from the sheet)
  try {
    await syncSheet({ quiet: true });
  } catch (e) {
    console.log(YELLOW(`Warning: sync failed (${e.message}) — reviewing with local data.`));
  }

  // probe terminal capabilities once (sixel support, cell size, fg color)
  bigScale = parseFloat(getConfig('big_scale')) || 1.5;
  const detected = await detectTerminal();
  term.sixel = detected.sixel;
  term.cellH = detected.cellH;
  term.color = detected.color;

  const skipped = new Set();
  let answered = { again: 0, hard: 0, good: 0, easy: 0 };
  let answeredTotal = 0;
  let newIntroduced = 0;
  let curCard = null;
  let revealed = false;
  let waiting = null; // active countdown timer
  let answersSinceNew = 0;

  const sess = () => ({ answered: answeredTotal, max: maxCards });
  const budgetLeft = () => answeredTotal < maxCards && (!endTime || Date.now() < endTime);

  /** Priority: cards you're actively learning > (a new card every 5th answer) > due reviews > new cards. */
  const pickNext = () => {
    const now = Date.now();
    const notSkipped = (rows) => rows.filter(c => !skipped.has(c.id));
    const learn = notSkipped(db.prepare('SELECT * FROM cards WHERE active = 1 AND step >= 0 AND reps > 0 AND due <= ? ORDER BY due LIMIT 25').all(now));
    if (learn.length) return learn[0];
    if (newIntroduced < newLimit && answersSinceNew >= 4) {
      const n = notSkipped(db.prepare('SELECT * FROM cards WHERE active = 1 AND reps = 0 ORDER BY sheet_row LIMIT 25').all())[0];
      if (n) { newIntroduced++; answersSinceNew = 0; return n; }
    }
    const rev = notSkipped(db.prepare('SELECT * FROM cards WHERE active = 1 AND step = -1 AND due <= ? ORDER BY due LIMIT 25').all(now));
    if (rev.length) return rev[0];
    if (newIntroduced < newLimit) {
      const n = notSkipped(db.prepare('SELECT * FROM cards WHERE active = 1 AND reps = 0 ORDER BY sheet_row LIMIT 25').all())[0];
      if (n) { newIntroduced++; answersSinceNew = 0; return n; }
    }
    return null;
  };

  console.log(`Session: up to ${maxCards} cards, ${newLimit} new.${minutes ? ` Time budget: ${minutes} min.` : ''} ${DIM('(synced from sheet on startup)')}`);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const finish = () => {
    if (waiting) clearTimeout(waiting);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    clearScreen();
    const total = answered.again + answered.hard + answered.good + answered.easy;
    if (total > 0) {
      console.log(BOLD('Session complete 🎉'));
      console.log(`  ${total} answers: ${RED(answered.again + ' again')} · ${YELLOW(answered.hard + ' hard')} · ${GREEN(answered.good + ' good')} · ${CYAN(answered.easy + ' easy')}`);
      console.log(`  new cards introduced: ${newIntroduced}`);
      const now = Date.now();
      const learnDue = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND step >= 0 AND reps > 0 AND due <= ?').get(now).c;
      const revDue = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND step = -1 AND due <= ?').get(now).c;
      const remaining = learnDue + revDue;
      if (remaining > 0) {
        console.log(YELLOW(`  ${remaining} cards still due — run ${BOLD('flashc')} again whenever you have another few minutes.`));
      } else {
        const nd = nextDueInfo();
        console.log(GREEN(`  Nothing more due right now!`) + (nd ? `  Next in ${fmtDue(nd)}.` : ''));
      }
    } else {
      console.log('Session ended.');
    }
    process.exit(0);
  };

  const showCard = (card) => {
    curCard = card;
    revealed = false;
    printCardFront(card, sess());
    prefetch(card.thai);
    play(card.thai).catch(() => {}); // auto-play on show
  };

  // Decide what to show next: a card, a countdown wait, or the finish screen.
  const step = () => {
    const next = pickNext();
    if (next) { showCard(next); return; }
    if (!budgetLeft()) { finish(); return; }
    // nothing due yet — wait for the next learning card if it's close
    const nd = nextDueInfo();
    if (nd && nd - Date.now() <= 3 * 60_000) {
      const secs = Math.max(1, Math.ceil((nd - Date.now()) / 1000));
      clearScreen();
      console.log(DIM(`next card in ${secs}s — ${BOLD('q')} to stop for now`));
      waiting = setTimeout(step, (secs * 1000) + 250);
      return;
    }
    finish();
  };

  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') { finish(); return; }
    if (key.name === 'q') { finish(); return; }
    if (!curCard) return; // still waiting for next card
    const card = curCard;

    if (key.name === 'p') { play(card.thai); return; }
    if (key.name === 's') { // skip for this session
      skipped.add(card.id);
      step();
      return;
    }
    if (!revealed) {
      if (key.name === 'space' || key.name === 'enter') {
        revealed = true;
        printCardBack(card, previewLabels(card));
      }
      return;
    }
    // grading
    const grades = { '1': 0, '2': 1, '3': 2, '4': 3 };
    if (str in grades) {
      const grade = grades[str];
      gradeCard(card, grade);
      answered[['again', 'hard', 'good', 'easy'][grade]]++;
      answeredTotal++;
      answersSinceNew++;
      if (!budgetLeft()) { finish(); return; }
      step();
    }
  });

  step();
}

// ---------- stats ----------

function cmdStats() {
  const now = Date.now();
  const total = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1').get().c;
  if (!total) { console.log('No cards yet. Run ' + BOLD('flashc sync') + '.'); return; }
  const due = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND due <= ?').get(now).c;
  const learning = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND step >= 0').get().c;
  const mature = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND interval >= 21').get().c;
  const avgEase = db.prepare('SELECT AVG(ease) e FROM cards WHERE active = 1 AND reps > 0').get().e;
  const reviews = db.prepare('SELECT SUM(reps) r, SUM(lapses) l FROM cards WHERE active = 1').get();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dueToday = db.prepare('SELECT COUNT(*) c FROM cards WHERE active = 1 AND due < ?').get(today.getTime() + 86_400_000).c;
  const next = db.prepare('SELECT MIN(due) m FROM cards WHERE active = 1 AND due > ?').get(now).m;

  console.log(BOLD('flashc stats'));
  console.log(`  cards: ${total} (${learning} learning, ${mature} mature)`);
  console.log(`  due now: ${due} · due by end of day: ${dueToday}`);
  if (next) console.log(`  next new material in: ${fmtDue(next)}`);
  if (reviews.r) {
    const retention = (1 - reviews.l / reviews.r) * 100;
    console.log(`  total reviews: ${reviews.r} · lapses: ${reviews.l} · retention: ${retention.toFixed(0)}%`);
    console.log(`  average ease: ${avgEase.toFixed(2)}`);
  }
}

// ---------- list ----------

function cmdList() {
  const cards = db.prepare('SELECT * FROM cards WHERE active = 1 ORDER BY sheet_row').all();
  if (!cards.length) { console.log('No cards yet. Run ' + BOLD('flashc sync') + '.'); return; }
  console.log(BOLD(`all cards (${cards.length})`));
  for (const c of cards) {
    const flag = isDue(c) ? RED('●') : GREEN(' ');
    console.log(`${flag} ${c.thai.padEnd(28)} ${CYAN((c.romanization || '').padEnd(20))} ${(c.english || '').padEnd(24)} ${DIM(fmtInterval(c) + ' / ' + (isDue(c) ? 'due' : fmtDue(c.due)))}`);
  }
}

// ---------- scale ----------

function cmdScale(argv) {
  const val = parseFloat(argv[1]);
  if (!val || val < 0.5 || val > 10) {
    const cur = getConfig('big_scale') || 1.5;
    console.log(`Big-text scale: ${BOLD(cur)}× (relative to your terminal's font height)`);
    console.log(`Set it with: ${BOLD('flashc scale <number>')}  e.g. ${BOLD('flashc scale 2')}`);
    return;
  }
  setConfig('big_scale', val);
  console.log(GREEN(`Big-text scale set to ${val}×.`));
}

// ---------- config ----------

const CONFIG_KEYS = ['new_per_session', 'session_cards', 'big_scale'];
const CONFIG_HELP = {
  new_per_session: 'new cards introduced per session (default 5)',
  session_cards: 'max cards answered per session (default 20)',
  big_scale: 'big-text size multiplier (default 1.5)',
};

function cmdConfig(argv) {
  const [key, value] = argv.slice(1);
  if (!key) {
    console.log(BOLD('flashc settings:'));
    for (const k of CONFIG_KEYS) console.log(`  ${k}: ${getConfig(k) || '(default)'}  ${DIM(CONFIG_HELP[k])}`);
    console.log(`\nChange one: ${BOLD('flashc config <key> <value>')}  e.g. ${BOLD('flashc config new_per_session 3')}`);
    return;
  }
  if (!CONFIG_KEYS.includes(key)) { console.error(`Unknown setting: ${key}`); process.exit(1); }
  if (value === undefined) { console.log(`${key} = ${getConfig(key) || '(default)'}`); return; }
  setConfig(key, value);
  console.log(GREEN(`${key} set to ${value}.`));
}

// ---------- main ----------

export async function main(rawArgv) {
  // allow --minutes anywhere: 'flashc --minutes 10' or 'flashc review --minutes 10'
  let minutes = null;
  const argv = [];
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] === '--minutes') { minutes = rawArgv[++i]; continue; }
    argv.push(rawArgv[i]);
  }
  if (minutes) process.env.FLASHC_MINUTES = minutes;
  const cmd = argv[0] || 'review';
  try {
    switch (cmd) {
      case 'setup': await cmdSetup(); break;
      case 'sync': await cmdSync(); break;
      case 'review': await cmdReview(argv); break;
      case 'stats': cmdStats(); break;
      case 'list': cmdList(); break;
      case 'scale': cmdScale(argv); break;
      case 'config': cmdConfig(argv); break;
      case 'serve': (await import('./server.js')).cmdServe(); break;
      case 'devices': case 'sync-devices': (await import('./devices.js')).cmdSyncDevices(argv); break;
      case 'help': case '--help': case '-h':
        console.log(`flashc — Google Sheet flashcards with SM-2 scheduling

Usage: flashc <command>

Commands:
  setup    Interactive: connect your sheet + map columns (thai, romanization, english, notes)
  sync     Fetch the sheet: register new words, update changed ones
  review   Review session (default). Syncs first, then shows due cards.
  scale    Show/set the big-text scale (default 1.5 = 50% bigger)
  config   Show/change settings (new_per_session, session_cards, big_scale)
  stats    Progress overview (due counts, retention, ease)
  list     Show all cards with scheduling state
  serve    Run the web UI server (for phone review; FLASHC_PORT env to change port, default 8814)
  devices  Two-way sync of scheduling progress with a remote host (default henry@nixos)
  help     This message

Keys during review:
  p        play Thai audio        space     reveal answer
  1/2/3/4  Again / Hard / Good / Easy
  s        skip card              q / ctrl+c  quit`);
        break;
      default:
        console.error(`Unknown command: ${cmd}. Try 'flashc help'.`);
        process.exit(1);
    }
  } catch (e) {
    console.error(RED(`Error: ${e.message}`));
    process.exit(1);
  }
}
