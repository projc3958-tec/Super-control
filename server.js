require('dotenv').config();

const http = require('http');
const WebSocket = require('ws');
const licenses = require('./licenses');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const clients = new Map();
let nextId = 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 1_000_000) { req.destroy(); reject(new Error('payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    sendJson(res, 503, { error: 'admin API disabled: set ADMIN_TOKEN env var' });
    return false;
  }
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token !== ADMIN_TOKEN) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function kickDevice(deviceId, reason) {
  for (const [, ws] of clients) {
    if (ws.deviceId !== deviceId) continue;
    try { ws.send(JSON.stringify({ type: 'license', status: 'rejected', reason })); } catch {}
    try { ws.close(1008, reason); } catch {}
  }
}

function licenseView(lic, connectedSet) {
  return {
    deviceId: lic.deviceId,
    name: lic.name,
    key: lic.key,
    enabled: lic.enabled,
    createdAt: lic.createdAt,
    lastSeen: lic.lastSeen,
    isConnected: connectedSet.has(lic.deviceId),
  };
}

async function handleAdmin(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (!requireAdmin(req, res)) return;

  const u = new URL(req.url || '/', 'http://h');
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[1] !== 'licenses') return sendJson(res, 404, { error: 'not found' });

  const deviceId = parts[2];
  const action = parts[3];

  const connected = new Set();
  for (const [, ws] of clients) if (ws.deviceId && ws.licensed) connected.add(ws.deviceId);

  try {
    if (!deviceId) {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          licenses: licenses.list().map((l) => licenseView(l, connected)),
          total: licenses.list().length,
          connected: connected.size,
        });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const lic = licenses.create(body);
        return sendJson(res, 201, licenseView(lic, connected));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (action === 'regenerate' && req.method === 'POST') {
      const lic = licenses.regenerate(deviceId);
      if (!lic) return sendJson(res, 404, { error: 'not found' });
      kickDevice(deviceId, 'license key rotated');
      return sendJson(res, 200, licenseView(lic, connected));
    }

    if (req.method === 'GET') {
      const lic = licenses.find(deviceId);
      if (!lic) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, licenseView(lic, connected));
    }

    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const lic = licenses.update(deviceId, body);
      if (!lic) return sendJson(res, 404, { error: 'not found' });
      if (body.enabled === false) kickDevice(deviceId, 'license disabled');
      return sendJson(res, 200, licenseView(lic, connected));
    }

    if (req.method === 'DELETE') {
      const ok = licenses.remove(deviceId);
      if (ok) kickDevice(deviceId, 'license removed');
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
    }

    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message || 'bad request' });
  }
}

const httpServer = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS); res.end(); return;
  }

  if (u === '/' || u === '/health') {
    return sendJson(res, 200, {
      service: 'clipboard-sync-server',
      status: 'ok',
      clients: Array.from(clients.values()).filter((c) => c.licensed).length,
      connectionsPending: Array.from(clients.values()).filter((c) => !c.licensed).length,
      licensed: licenses.list().length,
      uptimeSec: Math.round(process.uptime()),
      adminEnabled: Boolean(ADMIN_TOKEN),
    });
  }

  if (u.startsWith('/admin/')) return handleAdmin(req, res);

  res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
  res.end('Not found');
});

const wss = new WebSocket.Server({
  server: httpServer,
  maxPayload: 100 * 1024 * 1024,
});

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendToPartner(sender, raw) {
  const partner = sender.partner;
  if (partner && partner.readyState === WebSocket.OPEN) partner.send(raw);
}

function findLicensedByDeviceId(deviceId) {
  for (const [, ws] of clients) {
    if (ws.licensed && ws.deviceId === deviceId) return ws;
  }
  return null;
}

function licenseName(deviceId) {
  const lic = licenses.find(deviceId);
  return (lic && lic.name) || deviceId;
}

function breakPair(ws, reason) {
  const partner = ws.partner;
  if (!partner) return;
  ws.partner = null;
  ws.role = null;
  if (partner.partner === ws) {
    partner.partner = null;
    partner.role = null;
    send(partner, { type: 'pair-broken', reason, partner: ws.deviceId });
  }
}

function handlePairRequest(ws, msg) {
  const target = (msg.target || '').trim();
  if (!target) return send(ws, { type: 'pair-result', ok: false, reason: 'target device ID required' });
  if (target === ws.deviceId) return send(ws, { type: 'pair-result', ok: false, reason: 'cannot pair with yourself' });
  if (ws.partner) return send(ws, { type: 'pair-result', ok: false, reason: 'already paired — unpair first' });

  const partner = findLicensedByDeviceId(target);
  if (!partner) return send(ws, { type: 'pair-result', ok: false, reason: 'target device not online' });
  if (partner.partner) return send(ws, { type: 'pair-result', ok: false, reason: 'target is already paired with someone else' });

  ws.partner = partner;
  ws.role = 'controller';
  partner.partner = ws;
  partner.role = 'controlled';

  send(ws, {
    type: 'pair-result',
    ok: true,
    partner: partner.deviceId,
    partnerName: licenseName(partner.deviceId),
    role: 'controller',
  });
  send(partner, {
    type: 'pair-result',
    ok: true,
    partner: ws.deviceId,
    partnerName: licenseName(ws.deviceId),
    role: 'controlled',
  });
  console.log(`[=] paired: ${ws.deviceId} (controller) ↔ ${partner.deviceId} (controlled)`);
}

wss.on('connection', (ws, req) => {
  const id = nextId++;
  clients.set(id, ws);
  ws.isAlive = true;
  ws.licensed = false;
  ws.on('pong', () => { ws.isAlive = true; });

  const u = new URL(req.url || '/', 'http://h');
  const deviceId = (u.searchParams.get('deviceId') || '').trim();
  const key = (u.searchParams.get('key') || '').trim();
  const from = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const check = licenses.validate(deviceId, key);
  if (!check.ok) {
    console.log(`[x] rejected #${id} device=${deviceId || '?'} from=${from}: ${check.reason}`);
    send(ws, { type: 'license', status: 'rejected', reason: check.reason, deviceId });
    setTimeout(() => { try { ws.close(1008, check.reason); } catch {} }, 50);
    ws.on('close', () => clients.delete(id));
    return;
  }

  ws.deviceId = deviceId;
  ws.licensed = true;
  ws.partner = null;
  ws.role = null;
  licenses.touch(deviceId);
  console.log(`[+] accepted #${id} device=${deviceId} name="${check.license.name}" from=${from}`);

  send(ws, {
    type: 'license',
    status: 'accepted',
    deviceId,
    name: check.license.name,
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary || !ws.licensed) return;
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch (err) {
      return console.warn(`[!] bad message from #${id}: ${err.message}`);
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'pair') return handlePairRequest(ws, msg);
    if (msg.type === 'unpair') {
      breakPair(ws, 'partner unpaired');
      return send(ws, { type: 'pair-broken', reason: 'you unpaired' });
    }

    // Routed-to-partner messages require an active pair.
    if (!ws.partner) return;
    // Only the controller can push remote-control commands and theme changes.
    if ((msg.type === 'command' || msg.type === 'theme') && ws.role !== 'controller') return;
    if (['clipboard', 'command', 'theme'].includes(msg.type)) sendToPartner(ws, raw);
  });

  ws.on('close', () => {
    clients.delete(id);
    breakPair(ws, 'partner disconnected');
    console.log(`[-] client #${id} disconnected device=${deviceId}`);
  });

  ws.on('error', (err) => console.warn(`[!] client #${id} socket error: ${err.message}`));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {}; continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, HOST, () => {
  console.log(`Clipboard-sync server listening on http://${HOST}:${PORT}`);
  console.log(`Admin API: ${ADMIN_TOKEN ? 'enabled' : 'DISABLED (set ADMIN_TOKEN env var)'}`);
  console.log(`Licenses loaded: ${licenses.list().length}`);
});

function shutdown(sig) {
  console.log(`Received ${sig} — shutting down…`);
  clearInterval(heartbeat);
  for (const [, ws] of clients) { try { ws.close(1001, 'server shutdown'); } catch {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
