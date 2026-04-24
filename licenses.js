const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'licenses.json');

let cache = null;

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function load() {
  if (cache) return cache;
  ensureDir();
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!cache.licenses) cache.licenses = [];
  } catch {
    cache = { licenses: [] };
  }
  return cache;
}

function persist() {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

function list() {
  return load().licenses;
}

function find(deviceId) {
  if (!deviceId) return null;
  return list().find((l) => l.deviceId === deviceId) || null;
}

function makeKey() {
  return crypto.randomBytes(16).toString('hex');
}

function create({ deviceId, name }) {
  const id = (deviceId || '').trim();
  if (!id) throw new Error('deviceId required');
  const existing = find(id);
  if (existing) return existing;
  const lic = {
    deviceId: id,
    name: (name || '').trim(),
    key: makeKey(),
    enabled: true,
    createdAt: Date.now(),
    lastSeen: null,
  };
  load().licenses.push(lic);
  persist();
  return lic;
}

function update(deviceId, patch) {
  const lic = find(deviceId);
  if (!lic) return null;
  const allowed = ['name', 'enabled'];
  for (const k of allowed) {
    if (k in patch) {
      lic[k] = typeof patch[k] === 'string' ? patch[k].trim() : patch[k];
    }
  }
  persist();
  return lic;
}

function regenerate(deviceId) {
  const lic = find(deviceId);
  if (!lic) return null;
  lic.key = makeKey();
  persist();
  return lic;
}

function remove(deviceId) {
  const data = load();
  const before = data.licenses.length;
  data.licenses = data.licenses.filter((l) => l.deviceId !== deviceId);
  if (data.licenses.length === before) return false;
  cache = data;
  persist();
  return true;
}

function validate(deviceId, key) {
  const lic = find(deviceId);
  if (!lic) return { ok: false, reason: 'unknown device' };
  if (!lic.enabled) return { ok: false, reason: 'license disabled' };
  if (!key || lic.key !== key) return { ok: false, reason: 'invalid license key' };
  return { ok: true, license: lic };
}

function touch(deviceId) {
  const lic = find(deviceId);
  if (!lic) return;
  lic.lastSeen = Date.now();
  persist();
}

module.exports = { list, find, create, update, regenerate, remove, validate, touch };
