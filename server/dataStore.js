// ---------------------------------------------------------------------------
// Persistence (Phase 4 storage layer)
// ---------------------------------------------------------------------------
// A tiny JSON-file-backed store. Users are persisted to disk; sessions are
// kept in memory (they are live events) but finished tests (summary + the
// per-rider 1 Hz samples used for TCX/GPX/Excel export) are written to disk. This keeps the app runnable
// with zero external dependencies while presenting a clean async API that
// could later be swapped for a real database.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const TESTS_DIR = path.join(DATA_DIR, 'tests');
const testFile = (id) => path.join(TESTS_DIR, `${String(id).replace(/[^\w-]/g, '')}.json`);

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file); // atomic replace
}

class DataStore {
  constructor() {
    /** @type {Map<string, import('./models.js').User>} */
    this.users = new Map();
    /** @type {Array} finished session summaries */
    this.history = [];
  }

  async load() {
    const users = await readJson(USERS_FILE, []);
    for (const u of users) this.users.set(u.id, u);
    this.history = await readJson(HISTORY_FILE, []);
  }

  // --- users -------------------------------------------------------------
  listUsers() {
    return [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getUser(id) {
    return this.users.get(id) || null;
  }

  async saveUser(user) {
    this.users.set(user.id, user);
    await writeJson(USERS_FILE, this.listUsers());
    return user;
  }

  async deleteUser(id) {
    const existed = this.users.delete(id);
    if (existed) await writeJson(USERS_FILE, this.listUsers());
    return existed;
  }

  // --- history -----------------------------------------------------------
  listHistory() {
    return this.history;
  }

  async addHistory(entry) {
    this.history.unshift(entry);
    this.history = this.history.slice(0, 500); // keep it bounded
    await writeJson(HISTORY_FILE, this.history);
    return entry;
  }

  // --- full test records (summary + 1 Hz samples per rider) ----------------
  async saveTest(record) {
    await writeJson(testFile(record.id), record);
    return record;
  }

  getTest(id) {
    return readJson(testFile(id), null);
  }

  async deleteTest(id) {
    const before = this.history.length;
    this.history = this.history.filter((h) => h.sessionId !== id);
    await writeJson(HISTORY_FILE, this.history);
    await fs.rm(testFile(id), { force: true });
    return this.history.length < before;
  }
}

export const store = new DataStore();
