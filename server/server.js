const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_VERSION = require('./package.json').version;

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DB_PATH = path.join(DATA_DIR, 'lotto.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD || '';
const PORT = process.env.PORT || 3000;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS draws (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  cost REAL NOT NULL,
  win REAL NOT NULL DEFAULT 0,
  note TEXT
);
CREATE TABLE IF NOT EXISTS draw_shares (
  id TEXT PRIMARY KEY,
  draw_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  cost_share REAL NOT NULL,
  win_share REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT
);
`);

// safe migration: add "kind" column to distinguish deposit / bulk / payout entries
try { db.exec("ALTER TABLE contributions ADD COLUMN kind TEXT DEFAULT 'deposit'"); } catch (e) { /* already exists */ }

// ---------- helpers ----------
const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

function logAction(action, details) {
  db.prepare('INSERT INTO audit_log (id, ts, action, details) VALUES (?,?,?,?)')
    .run(uid(), now(), action, JSON.stringify(details || {}));
}

// splits `total` (in shekels) equally among memberIds, rounded to agorot,
// with remainder cents distributed deterministically so the sum matches exactly.
function splitEqually(total, memberIds) {
  const n = memberIds.length;
  const shares = {};
  if (n === 0) return shares;
  const totalCents = Math.round(total * 100);
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n;
  memberIds.forEach((id, i) => {
    let cents = base;
    if (remainder > 0) { cents += 1; remainder -= 1; }
    shares[id] = cents / 100;
  });
  return shares;
}

function getState() {
  const members = db.prepare('SELECT * FROM members ORDER BY created_at').all();
  const contributions = db.prepare('SELECT * FROM contributions ORDER BY date').all();
  const draws = db.prepare('SELECT * FROM draws ORDER BY date').all();
  const shares = db.prepare('SELECT * FROM draw_shares').all();

  const totalDeposits = contributions.reduce((s, c) => s + c.amount, 0);
  const totalCosts = draws.reduce((s, d) => s + d.cost, 0);
  const totalWins = draws.reduce((s, d) => s + d.win, 0);

  // ledger in agorot (integer cents) throughout, to avoid float drift entirely
  const ledgerCents = {};
  members.forEach(m => { ledgerCents[m.id] = 0; });
  contributions.forEach(c => {
    ledgerCents[c.member_id] = (ledgerCents[c.member_id] || 0) + Math.round(c.amount * 100);
  });
  shares.forEach(s => {
    ledgerCents[s.member_id] = (ledgerCents[s.member_id] || 0)
      - Math.round(s.cost_share * 100) + Math.round(s.win_share * 100);
  });

  const ledger = {};
  Object.keys(ledgerCents).forEach(id => { ledger[id] = ledgerCents[id] / 100; });

  // kupa is ALWAYS the sum of individual ledgers - single source of truth,
  // so the headline number can never drift from what members individually see.
  const kupaCents = Object.values(ledgerCents).reduce((s, c) => s + c, 0);
  const kupa = kupaCents / 100;

  return {
    version: APP_VERSION,
    members, contributions, draws, draw_shares: shares,
    totals: { deposits: totalDeposits, costs: totalCosts, wins: totalWins, kupa },
    ledger
  };
}

// ---------- auth ----------
// two roles: 'admin' (everything) and 'operator' (deposits + draws only,
// can't touch members, reset, or backups). sessions store the role granted at login.
const sessions = new Map(); // token -> { role, expiry }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const session = token && sessions.get(token);
  if (!session || session.expiry < Date.now()) return null;
  return session;
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== 'admin') {
    return res.status(401).json({ error: 'נדרשת התחברות כמנהל' });
  }
  next();
}

// admin OR operator - used for the day-to-day actions operators are allowed to do
function requireOperator(req, res, next) {
  const session = getSession(req);
  if (!session || (session.role !== 'admin' && session.role !== 'operator')) {
    return res.status(401).json({ error: 'נדרשת התחברות' });
  }
  next();
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', async (req, res) => {
  const { password } = req.body || {};
  let role = null;
  if (password && password === ADMIN_PASSWORD) role = 'admin';
  else if (password && OPERATOR_PASSWORD && password === OPERATOR_PASSWORD) role = 'operator';

  if (!role) return res.status(401).json({ error: 'סיסמה שגויה' });

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, expiry: Date.now() + SESSION_TTL_MS });
  logAction('login', { role });
  res.json({ token, role, expiresInMs: SESSION_TTL_MS });
});

app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

app.get('/api/state', (req, res) => {
  res.json(getState());
});

app.post('/api/members', requireAdmin, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'חסר שם' });
  const id = uid();
  db.prepare('INSERT INTO members (id, name, active, created_at) VALUES (?,?,1,?)')
    .run(id, name, now());
  logAction('add_member', { id, name });
  res.json(getState());
});

// soft delete / retire / rename / reactivate.
// retiring with payout=true pays the member their current ledger balance
// (as a negative contribution) so the kupa total drops accordingly and
// their own balance zeroes out - the money doesn't stay "orphaned".
app.patch('/api/members/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const member = db.prepare('SELECT * FROM members WHERE id=?').get(id);
  if (!member) return res.status(404).json({ error: 'לא נמצא' });
  const { active, name, payout } = req.body || {};

  if (active === false && payout) {
    const balance = getState().ledger[id] || 0;
    const cents = Math.round(balance * 100);
    if (cents !== 0) {
      db.prepare('INSERT INTO contributions (id, member_id, amount, date, kind) VALUES (?,?,?,?,?)')
        .run(uid(), id, -(cents / 100), now().slice(0, 10), 'payout');
      logAction('payout_member', { id, name: member.name, amount: cents / 100 });
    }
  }

  if (typeof active === 'boolean') {
    db.prepare('UPDATE members SET active=? WHERE id=?').run(active ? 1 : 0, id);
    logAction(active ? 'reactivate_member' : 'retire_member', { id, name: member.name });
  }
  if (typeof name === 'string' && name.trim()) {
    db.prepare('UPDATE members SET name=? WHERE id=?').run(name.trim(), id);
    logAction('rename_member', { id, oldName: member.name, newName: name.trim() });
  }
  res.json(getState());
});

app.post('/api/contributions', requireOperator, (req, res) => {
  const { memberId, amount, date } = req.body || {};
  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  if (!member) return res.status(400).json({ error: 'חבר לא קיים' });
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'סכום לא תקין' });
  const id = uid();
  db.prepare('INSERT INTO contributions (id, member_id, amount, date) VALUES (?,?,?,?)')
    .run(id, memberId, amt, date || now().slice(0, 10));
  logAction('add_contribution', { id, memberId, amount: amt });
  res.json(getState());
});

// deposits the same amount for every currently active member in one go
app.post('/api/contributions/bulk', requireOperator, (req, res) => {
  const { amount, date } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'סכום לא תקין' });

  const activeMembers = db.prepare('SELECT id FROM members WHERE active=1').all().map(m => m.id);
  if (activeMembers.length === 0) return res.status(400).json({ error: 'אין חברים פעילים' });

  const d = date || now().slice(0, 10);
  const insert = db.prepare('INSERT INTO contributions (id, member_id, amount, date, kind) VALUES (?,?,?,?,?)');
  activeMembers.forEach(memberId => insert.run(uid(), memberId, amt, d, 'bulk'));

  logAction('add_bulk_contribution', { amount: amt, memberCount: activeMembers.length });
  res.json(getState());
});

// draw cost/win are split equally among currently ACTIVE members,
// locked in at draw time so later member changes don't rewrite history.
app.post('/api/draws', requireOperator, (req, res) => {
  const { date, cost, win, note } = req.body || {};
  const c = Number(cost) || 0;
  const w = Number(win) || 0;
  if (c <= 0) return res.status(400).json({ error: 'עלות לא תקינה' });

  const activeMembers = db.prepare('SELECT id FROM members WHERE active=1').all().map(m => m.id);
  if (activeMembers.length === 0) return res.status(400).json({ error: 'אין חברים פעילים' });

  const drawId = uid();
  db.prepare('INSERT INTO draws (id, date, cost, win, note) VALUES (?,?,?,?,?)')
    .run(drawId, date || now().slice(0, 10), c, w, note || '');

  const costShares = splitEqually(c, activeMembers);
  const winShares = splitEqually(w, activeMembers);
  const insertShare = db.prepare(
    'INSERT INTO draw_shares (id, draw_id, member_id, cost_share, win_share) VALUES (?,?,?,?,?)'
  );
  activeMembers.forEach(memberId => {
    insertShare.run(uid(), drawId, memberId, costShares[memberId] || 0, winShares[memberId] || 0);
  });

  logAction('add_draw', { drawId, cost: c, win: w, activeMembers });
  res.json(getState());
});

// raw SQLite file - the real, restorable backup (JSON below is for reading/auditing)
app.get('/api/backup/db', requireAdmin, (req, res) => {
  db.pragma('wal_checkpoint(FULL)'); // flush WAL into the main file before copying
  res.download(DB_PATH, `lotto-${Date.now()}.db`);
});

app.get('/api/backup', requireAdmin, (req, res) => {
  const state = getState();
  const auditLog = db.prepare('SELECT * FROM audit_log ORDER BY ts').all();
  res.setHeader('Content-Disposition', `attachment; filename=lotto-backup-${Date.now()}.json`);
  res.json({ ...state, audit_log: auditLog, exportedAt: now() });
});

app.post('/api/reset', requireAdmin, (req, res) => {
  if (req.body?.confirm !== 'RESET') {
    return res.status(400).json({ error: 'נדרש אישור מפורש' });
  }
  // auto-backup to disk before wiping
  const state = getState();
  const auditLog = db.prepare('SELECT * FROM audit_log ORDER BY ts').all();
  const backupPath = path.join(BACKUP_DIR, `auto-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ ...state, audit_log: auditLog, exportedAt: now() }, null, 2));

  db.exec('DELETE FROM draw_shares; DELETE FROM draws; DELETE FROM contributions; DELETE FROM members;');
  logAction('reset', { backupPath });
  res.json({ ok: true, backupPath, state: getState() });
});

app.listen(PORT, () => console.log(`kupat-lotto listening on :${PORT}`));
