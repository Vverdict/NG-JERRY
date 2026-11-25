// Live Google Sheets mirror of the bot's data.
//
//   • "Verifications" tab  – every verified team (mirror of store.verifications:
//                            new/edited/deleted teams update the sheet).
//   • "Registrations" tab  – every team currently holding a Rebound-scrim slot
//                            (mirror of store.scrim.slots: new registrations
//                            appear, and rows disappear when a team is removed
//                            or its group is closed/cleared).
//
// storage.saveGuildStore() calls onGuildSaved() on every save; a few seconds
// later the affected tabs are rewritten. No extra npm packages: built-in
// crypto + fetch (Node 18+).
//
// Env vars (Railway):
//   GOOGLE_SHEET_ID                – the long id in the sheet's URL
//   GOOGLE_SERVICE_ACCOUNT_JSON    – service-account key (raw JSON or base64)
//   GOOGLE_SHEET_TAB               – optional, verifications tab name (default "Verifications")
//   GOOGLE_SHEET_REG_TAB           – optional, registrations tab name (default "Registrations")
//   GOOGLE_SHEET_GUILD_ID          – optional, only mirror this server. Unset =
//                                    every server gets its own "<tab>-<guildId>" tabs.
// Share the sheet with the service account's client_email (Editor).
// If the env vars are missing this module does nothing.

const crypto = require('crypto');
const { groupLetterForSlot, groupDisplayName, localSlotNumber } = require('./group-schedule');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEBOUNCE_MS = 4000;

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const creds = JSON.parse(text);
    if (!creds.client_email || !creds.private_key) throw new Error('missing client_email/private_key');
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    return creds;
  } catch (err) {
    console.error('[sheets] GOOGLE_SERVICE_ACCOUNT_JSON is invalid:', err.message);
    return null;
  }
}

const creds = loadCredentials();
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const VERIFY_TAB = process.env.GOOGLE_SHEET_TAB || 'Verifications';
const REG_TAB = process.env.GOOGLE_SHEET_REG_TAB || 'Registrations';
const ONLY_GUILD = process.env.GOOGLE_SHEET_GUILD_ID || null;

function isEnabled() {
  return !!(creds && SHEET_ID);
}

// ---- auth (service-account JWT -> access token, cached) ----
let token = null;
let tokenExp = 0;

const b64url = (b) => Buffer.from(b).toString('base64url');

async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email, scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), creds.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${sig}`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token request failed: ${json.error_description || json.error || res.status}`);
  token = json.access_token;
  tokenExp = Date.now() + json.expires_in * 1000;
  return token;
}

async function api(path, method, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${(json.error && json.error.message) || ''}`);
  return json;
}

// ---- shared helpers ----
function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST';
}

const cell = (v) => (typeof v === 'number' ? v : String(v ?? ''));

// ---- Verifications table ----
const VERIFY_HEADERS = [
  'ID', 'Owner ID', 'Team Name', 'Owner Full Name', 'WhatsApp Number', 'Owner Email', 'City',
  'Player 1 IGN', 'Player 1 UID', 'Player 2 IGN', 'Player 2 UID',
  'Player 3 IGN', 'Player 3 UID', 'Player 4 IGN', 'Player 4 UID',
  'Player 5 IGN', 'Player 5 UID', 'Timestamp',
];

function buildVerifyRows(guildData) {
  const records = Object.entries(guildData.verifications || {})
    .sort((a, b) => (a[1].teamNumber || 0) - (b[1].teamNumber || 0));
  // ID column = simple row count (1, 2, 3...) so the sheet always starts at 1.
  const rows = records.map(([ownerId, r], i) => [
    i + 1, String(ownerId), r.team_name || '', r.owner_name || '',
    String(r.whatsapp || ''), r.owner_email || '', r.city || '',
    r.p1_ign || '', String(r.p1_uid || ''), r.p2_ign || '', String(r.p2_uid || ''),
    r.p3_ign || '', String(r.p3_uid || ''), r.p4_ign || '', String(r.p4_uid || ''),
    r.p5_ign || '', r.p5_ign ? String(r.p5_uid || '') : '',
    formatTimestamp(r.registeredDate),
  ].map(cell));
  return [VERIFY_HEADERS, ...rows];
}

// ---- Registrations table (live mirror of current scrim slots) ----
const REG_HEADERS = [
  'ID', 'Registered At', 'Group', 'Slot', 'Global Slot', 'Team Name',
  'Owner ID', 'Owner Full Name', 'WhatsApp Number',
  'Player 1', 'Player 2', 'Player 3', 'Player 4', 'Lineup Discord IDs',
];

function buildRegRows(guildData) {
  const slots = Object.values((guildData.scrim && guildData.scrim.slots) || {})
    .filter(sl => sl && sl.team)
    .sort((a, b) => (a.slotNumber || 0) - (b.slotNumber || 0));
  // ID column = simple row count (1, 2, 3...) so the sheet always starts at 1.
  const rows = slots.map((sl, i) => {
    const group = sl.group || groupLetterForSlot(sl.slotNumber);
    const players = sl.players || [];
    return [
      i + 1,
      formatTimestamp(sl.registeredAt),
      group ? groupDisplayName(group) : '',
      sl.slotNumber ? localSlotNumber(sl.slotNumber) : '',
      sl.slotNumber ?? '',
      sl.team, String(sl.userId || ''), sl.ownerName || '', String(sl.whatsapp || ''),
      players[0] || '', players[1] || '', players[2] || '', players[3] || '',
      (sl.selectedPlayerIds || []).join(', '),
    ].map(cell);
  });
  return [REG_HEADERS, ...rows];
}

// ---- sheet writing ----
const tabReady = new Set();

async function ensureTab(title) {
  if (tabReady.has(title)) return;
  const meta = await api('?fields=sheets.properties.title', 'GET');
  const exists = (meta.sheets || []).some(s => s.properties.title === title);
  if (!exists) {
    const sheetId = Math.floor(Math.random() * 2e9);
    await api(':batchUpdate', 'POST', {
      requests: [
        { addSheet: { properties: { title, sheetId, gridProperties: { frozenRowCount: 1 } } } },
        { repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        } },
      ],
    });
  }
  tabReady.add(title);
}

async function writeTab(title, rows) {
  const q = `'${title.replace(/'/g, "''")}'`;
  await ensureTab(title);
  // Write new data first, then blank anything below it so the sheet is never
  // momentarily empty.
  await api(`/values/${encodeURIComponent(`${q}!A1`)}?valueInputOption=RAW`, 'PUT',
    { range: `${q}!A1`, majorDimension: 'ROWS', values: rows });
  try {
    await api(`/values/${encodeURIComponent(`${q}!A${rows.length + 1}:Z`)}:clear`, 'POST', {});
  } catch (err) {
    // If our data fills the sheet exactly to its last row, the range below it
    // starts outside the grid ("exceeds grid limits"). Nothing is left to
    // clear in that case, so this is not a failure.
    if (!/exceeds grid limits/i.test(err.message)) throw err;
  }
}

// ---- job queue: one debounced job per (guild, table) ----
const jobs = new Map(); // jobKey -> { timer, running, dirty, guildId, kind, guildData, lastHash }

function tabTitle(kind, guildId) {
  const base = kind === 'verify' ? VERIFY_TAB : REG_TAB;
  return ONLY_GUILD ? base : `${base}-${guildId}`;
}

function queueJob(guildId, kind, guildData) {
  const jobKey = `${guildId}|${kind}`;
  let j = jobs.get(jobKey);
  if (!j) {
    j = { timer: null, running: false, dirty: false, guildId, kind, guildData, lastHash: null };
    jobs.set(jobKey, j);
  }
  j.guildData = guildData;
  j.dirty = true;
  if (j.timer || j.running) return;
  j.timer = setTimeout(() => runJob(jobKey), DEBOUNCE_MS);
}

async function runJob(jobKey) {
  const j = jobs.get(jobKey);
  j.timer = null;
  if (j.running) return;
  j.running = true;
  try {
    while (j.dirty) {
      j.dirty = false;
      const rows = j.kind === 'verify' ? buildVerifyRows(j.guildData) : buildRegRows(j.guildData);
      const hash = crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex');
      if (hash === j.lastHash) continue; // nothing visible changed
      try {
        await writeTab(tabTitle(j.kind, j.guildId), rows);
        j.lastHash = hash;
      } catch (err) {
        console.error(`[sheets] ${j.kind} sync failed for guild ${j.guildId}:`, err.message);
        token = null; // force fresh token next time
        tabReady.clear();
        j.timer = setTimeout(() => { j.dirty = true; runJob(jobKey); }, 60000);
        break;
      }
    }
  } finally {
    j.running = false;
  }
}

// Called by storage.saveGuildStore() on every save.
function onGuildSaved(guildId, guildData) {
  if (!isEnabled() || guildId === '_dmThreads') return;
  if (ONLY_GUILD && guildId !== ONLY_GUILD) return;
  if (!guildData) return;
  if (guildData.verifications) queueJob(guildId, 'verify', guildData);
  if (guildData.scrim) queueJob(guildId, 'reg', guildData);
}

// Called once at startup: backfills the sheet with everything already saved.
function syncAllGuilds(allData) {
  if (!isEnabled()) return;
  console.log(`[sheets] Live sync enabled -> sheet ${SHEET_ID}`);
  console.log(`[sheets] Share that sheet (as Editor) with: ${creds.client_email}`);
  for (const [guildId, g] of Object.entries(allData || {})) {
    if (g && typeof g === 'object') onGuildSaved(guildId, g);
  }
}

module.exports = { isEnabled, onGuildSaved, syncAllGuilds };
