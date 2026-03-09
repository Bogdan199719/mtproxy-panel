require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const ssh = require('./ssh');
const authenticator = require('./totp');


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── TOTP 2FA ──────────────────────────────────────────────
const TOTP_ISSUER = 'MTG Panel';

function getTotpSecret() {
  const row = db.prepare("SELECT value FROM settings WHERE key='totp_secret'").get();
  return row ? row.value : null;
}

function isTotpEnabled() {
  const row = db.prepare("SELECT value FROM settings WHERE key='totp_enabled'").get();
  return row && row.value === '1';
}

app.use('/api', (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Получить статус 2FA
app.get('/api/totp/status', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ enabled: isTotpEnabled() });
});

// Сгенерировать новый TOTP секрет и QR
app.post('/api/totp/setup', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const secret = authenticator.generateSecret();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_secret', ?)").run(secret);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_enabled', '0')").run();
  const otpauth = authenticator.keyuri('admin', TOTP_ISSUER, secret);
  const qrDataUrl = otpauth;
  res.json({ secret, qr: qrDataUrl });
});

// Подтвердить и включить 2FA
app.post('/api/totp/verify', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  const secret = getTotpSecret();
  if (!secret) return res.status(400).json({ error: 'Setup first' });
  if (authenticator.verify(code, secret)) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_enabled', '1')").run();
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'Invalid code' });
  }
});

// Отключить 2FA
app.post('/api/totp/disable', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  const secret = getTotpSecret();
  if (secret && !authenticator.verify(code, secret)) {
    return res.status(400).json({ error: 'Invalid code' });
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_enabled', '0')").run();
  res.json({ ok: true });
});

// ── Auth middleware ───────────────────────────────────────
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';

// ══════════════════════════════════════════════════════════
// NODES
// ══════════════════════════════════════════════════════════

app.get('/api/nodes', (req, res) => {
  const nodes = db.prepare('SELECT id, name, host, ssh_user, ssh_port, base_dir, start_port, created_at FROM nodes').all();
  res.json(nodes);
});

app.post('/api/nodes', (req, res) => {
  const { name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port } = req.body;
  if (!name || !host) return res.status(400).json({ error: 'name и host обязательны' });
  const result = db.prepare(`
    INSERT INTO nodes (name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, host, ssh_user || 'root', ssh_port || 22, ssh_key || null, ssh_password || null, base_dir || '/opt/mtg/users', start_port || 4433);
  res.json({ id: result.lastInsertRowid, name, host });
});

app.put('/api/nodes/:id', (req, res) => {
  const { name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port } = req.body;
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  db.prepare(`
    UPDATE nodes SET name=?, host=?, ssh_user=?, ssh_port=?, ssh_key=?, ssh_password=?, base_dir=?, start_port=?
    WHERE id=?
  `).run(
    name || node.name, host || node.host,
    ssh_user || node.ssh_user, ssh_port || node.ssh_port,
    ssh_key !== undefined ? ssh_key : node.ssh_key,
    ssh_password !== undefined ? ssh_password : node.ssh_password,
    base_dir || node.base_dir, start_port || node.start_port,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/nodes/:id', (req, res) => {
  db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/nodes/:id/check', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const online = await ssh.checkNode(node);
    res.json({ online });
  } catch (e) {
    res.json({ online: false, error: e.message });
  }
});

app.get('/api/nodes/:id/traffic', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const traffic = await ssh.getTraffic(node);
    res.json(traffic);
  } catch (e) {
    res.json({});
  }
});

// ── MTG Version check & update ───────────────────────────
app.get('/api/nodes/:id/mtg-version', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ssh.sshExec(node, "docker inspect nineseconds/mtg:2 --format 'mtg:2 | built {{.Created}}' 2>/dev/null | head -1");
    const version = (r.output || '').trim().split('\n')[0] || 'unknown';
    res.json({ version, raw: r.output });
  } catch (e) {
    res.json({ version: 'error', error: e.message });
  }
});

app.post('/api/nodes/:id/mtg-update', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ssh.sshExec(node, 'docker pull nineseconds/mtg:2 2>&1 | tail -3');
    res.json({ ok: true, output: r.output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', async (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const results = await Promise.allSettled(
    nodes.map(async node => {
      const status = await ssh.getNodeStatus(node);
      return { id: node.id, name: node.name, host: node.host, ...status };
    })
  );
  res.json(results.map((r, i) => r.status === 'fulfilled' ? r.value : { id: nodes[i].id, name: nodes[i].name, online: false }));
});

// ══════════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════════

app.get('/api/nodes/:id/users', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const dbUsers = db.prepare('SELECT * FROM users WHERE node_id = ?').all(req.params.id);
  try {
    const remoteUsers = await ssh.getRemoteUsers(node);
    const merged = dbUsers.map(u => {
      const remote = remoteUsers.find(r => r.name === u.name);
      return {
        ...u,
        connections: remote ? remote.connections : 0,
        running: remote ? !remote.status.includes('stopped') : false,
        link: `tg://proxy?server=${node.host}&port=${u.port}&secret=${u.secret}`,
        expired: u.expires_at ? new Date(u.expires_at) < new Date() : false
      };
    });
    res.json(merged);
  } catch {
    res.json(dbUsers.map(u => ({
      ...u,
      connections: 0,
      running: false,
      link: `tg://proxy?server=${node.host}&port=${u.port}&secret=${u.secret}`,
      expired: u.expires_at ? new Date(u.expires_at) < new Date() : false
    })));
  }
});

app.post('/api/nodes/:id/users', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const { name, note, expires_at, traffic_limit_gb } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const exists = db.prepare('SELECT id FROM users WHERE node_id = ? AND name = ?').get(req.params.id, name);
  if (exists) return res.status(400).json({ error: 'User already exists' });
  try {
    const { port, secret } = await ssh.createRemoteUser(node, name);
    const result = db.prepare(
      'INSERT INTO users (node_id, name, port, secret, note, expires_at, traffic_limit_gb) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.id, name, port, secret, note || '', expires_at || null, traffic_limit_gb || null);
    res.json({
      id: result.lastInsertRowid, name, port, secret,
      note: note || '', expires_at: expires_at || null, traffic_limit_gb: traffic_limit_gb || null,
      link: `tg://proxy?server=${node.host}&port=${port}&secret=${secret}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/nodes/:id/users/:name', (req, res) => {
  const { note, expires_at, traffic_limit_gb } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE node_id = ? AND name = ?').get(req.params.id, req.params.name);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET note=?, expires_at=?, traffic_limit_gb=? WHERE node_id=? AND name=?')
    .run(note !== undefined ? note : user.note, expires_at !== undefined ? expires_at : user.expires_at,
      traffic_limit_gb !== undefined ? traffic_limit_gb : user.traffic_limit_gb, req.params.id, req.params.name);
  res.json({ ok: true });
});

app.delete('/api/nodes/:id/users/:name', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.removeRemoteUser(node, req.params.name);
    db.prepare('DELETE FROM users WHERE node_id = ? AND name = ?').run(req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/nodes/:id/users/:name/stop', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.stopRemoteUser(node, req.params.name);
    db.prepare('UPDATE users SET status = ? WHERE node_id = ? AND name = ?').run('stopped', req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nodes/:id/users/:name/start', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.startRemoteUser(node, req.params.name);
    db.prepare('UPDATE users SET status = ? WHERE node_id = ? AND name = ?').run('active', req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Connections history ───────────────────────────────────
app.get('/api/nodes/:id/users/:name/history', (req, res) => {
  const rows = db.prepare(`
    SELECT connections, recorded_at FROM connections_history
    WHERE node_id = ? AND user_name = ?
    ORDER BY recorded_at DESC LIMIT 48
  `).all(req.params.id, req.params.name);
  res.json(rows.reverse());
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ══════════════════════════════════════════════════════════
// BACKGROUND JOBS
// ══════════════════════════════════════════════════════════

// Запись истории подключений каждые 5 минут
async function recordHistory() {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  for (const node of nodes) {
    try {
      const remoteUsers = await ssh.getRemoteUsers(node);
      for (const u of remoteUsers) {
        db.prepare('INSERT INTO connections_history (node_id, user_name, connections) VALUES (?, ?, ?)')
          .run(node.id, u.name, u.connections || 0);
      }
    } catch {}
  }
  // Чистим старые данные (храним 24 часа = 288 записей на юзера)
  db.prepare("DELETE FROM connections_history WHERE recorded_at < datetime('now', '-24 hours')").run();
}

// Автоудаление истёкших юзеров раз в час
async function cleanExpiredUsers() {
  const expired = db.prepare("SELECT u.*, n.* FROM users u JOIN nodes n ON u.node_id = n.id WHERE u.expires_at IS NOT NULL AND u.expires_at < datetime('now')").all();
  for (const u of expired) {
    try {
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(u.node_id);
      await ssh.removeRemoteUser(node, u.name);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      console.log(`🗑️ Auto-deleted expired user: ${u.name} on node ${u.node_id}`);
    } catch (e) {
      console.error(`Failed to delete expired user ${u.name}:`, e.message);
    }
  }
}

setInterval(recordHistory, 5 * 60 * 1000);
setInterval(cleanExpiredUsers, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🔒 MTG Panel running on http://0.0.0.0:${PORT}`);
  console.log(`🔑 Auth token: ${AUTH_TOKEN}`);
  // ткай запускаем сразу при старте
  setTimeout(recordHistory, 10000);
  setTimeout(cleanExpiredUsers, 5000);
});
