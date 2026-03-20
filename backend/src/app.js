require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
const ssh     = require('./ssh');
const authenticator = require('./totp');

// ── Config ────────────────────────────────────────────────
const AUTH_TOKEN     = process.env.AUTH_TOKEN || 'changeme';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PORT           = process.env.PORT || 3000;
const crypto         = require('crypto');

// Version: /app/src/app.js → ../package.json = /app/package.json = backend/package.json in Docker
let pkgVersion = 'unknown';
try { pkgVersion = require('../package.json').version; } catch (_) {}

// ── DB Migrations ─────────────────────────────────────────
function runMigrations() {
  const migrations = [
    "ALTER TABLE nodes ADD COLUMN flag TEXT DEFAULT NULL",
    "ALTER TABLE nodes ADD COLUMN agent_port INTEGER DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN traffic_rx_snap TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN traffic_tx_snap TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN traffic_reset_at DATETIME DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN last_seen_at DATETIME DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN billing_price REAL DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN billing_currency TEXT DEFAULT 'RUB'",
    "ALTER TABLE users ADD COLUMN billing_period TEXT DEFAULT 'monthly'",
    "ALTER TABLE users ADD COLUMN billing_paid_until DATETIME DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN billing_status TEXT DEFAULT 'active'",
    // v1.7.0 — device limits & auto traffic reset
    "ALTER TABLE users ADD COLUMN max_devices INTEGER DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN traffic_reset_interval TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN next_reset_at DATETIME DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN total_traffic_rx_bytes INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN total_traffic_tx_bytes INTEGER DEFAULT 0",
    // v1.8.0 — node hardware info
    "ALTER TABLE nodes ADD COLUMN cpu_cores INTEGER DEFAULT NULL",
    "ALTER TABLE nodes ADD COLUMN ram_mb INTEGER DEFAULT NULL",
  ];
  for (const sql of migrations) {
    try { db.prepare(sql).run(); } catch (_) {}
  }
}
runMigrations();

// ── Security helpers ──────────────────────────────────────
// Simple in-memory rate limiter for login endpoint
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 min
  const maxAttempts = 10;
  const attempts = (loginAttempts.get(ip) || []).filter(t => now - t < windowMs);
  if (attempts.length >= maxAttempts) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 15 минут.' });
  }
  attempts.push(now);
  loginAttempts.set(ip, attempts);
  next();
}
// Cleanup stale rate limit entries every 30 min
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [ip, times] of loginAttempts.entries()) {
    const fresh = times.filter(t => t > cutoff);
    if (fresh.length === 0) loginAttempts.delete(ip);
    else loginAttempts.set(ip, fresh);
  }
}, 30 * 60 * 1000);

// Rate limiter для TOTP (10 попыток за 5 минут)
const totpAttempts = new Map();
function totpRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxAttempts = 10;
  const attempts = (totpAttempts.get(ip) || []).filter(t => now - t < windowMs);
  if (attempts.length >= maxAttempts) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 5 минут.' });
  }
  attempts.push(now);
  totpAttempts.set(ip, attempts);
  next();
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [ip, times] of totpAttempts.entries()) {
    const fresh = times.filter(t => t > cutoff);
    if (fresh.length === 0) totpAttempts.delete(ip);
    else totpAttempts.set(ip, fresh);
  }
}, 10 * 60 * 1000);

// ── App ───────────────────────────────────────────────────
const PANEL_ORIGIN = process.env.PANEL_URL || 'https://fn.viplinilo.ru';

const app = express();
// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(cors({ origin: PANEL_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Public endpoints (no auth) ────────────────────────────
app.get('/api/version', (req, res) => {
  res.json({ version: pkgVersion });
});

app.get('/api/health', (req, res) => {
  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  res.json({ status: 'ok', version: pkgVersion, nodes: nodeCount, users: userCount });
});

app.get('/api/docs', (req, res) => {
  res.json({
    version: pkgVersion,
    auth: 'Header: x-auth-token: <your_token>',
    base_url: '/api',
    endpoints: [
      { method: 'GET',    path: '/health',                              auth: false, description: 'Health check' },
      { method: 'GET',    path: '/version',                             auth: false, description: 'Panel version' },
      { method: 'POST',   path: '/login',                               auth: false, description: 'Get auth token. Body: {username, password}' },
      { method: 'GET',    path: '/nodes',                               auth: true,  description: 'List all nodes' },
      { method: 'GET',    path: '/nodes/best',                          auth: true,  description: 'Get node with fewest users (for auto-provisioning)' },
      { method: 'POST',   path: '/nodes',                               auth: true,  description: 'Add node. Body: {name, host, ssh_user, ssh_port, ssh_key|ssh_password, base_dir, start_port}' },
      { method: 'PUT',    path: '/nodes/:id',                           auth: true,  description: 'Update node' },
      { method: 'DELETE', path: '/nodes/:id',                           auth: true,  description: 'Delete node and all its users' },
      { method: 'GET',    path: '/nodes/:id/check',                     auth: true,  description: 'Check node connectivity (SSH or agent)' },
      { method: 'GET',    path: '/nodes/:id/traffic',                   auth: true,  description: 'Get traffic stats for all users on node' },
      { method: 'GET',    path: '/counts',                              auth: true,  description: 'User count per node_id (fast, SQLite only)' },
      { method: 'GET',    path: '/users',                               auth: true,  description: 'Search users across all nodes. Query: name, note, node_id, limit, offset' },
      { method: 'GET',    path: '/users/:name',                         auth: true,  description: 'Find user by exact name. Returns link: tg://proxy?...' },
      { method: 'GET',    path: '/nodes/:id/users',                     auth: true,  description: 'List users on a node (includes real-time status from SSH/agent)' },
      { method: 'POST',   path: '/nodes/:id/users',                     auth: true,  description: 'Create user. Body: {name, note?, expires_at?, traffic_limit_gb?}. Returns link: tg://proxy?...' },
      { method: 'PUT',    path: '/nodes/:id/users/:name',               auth: true,  description: 'Update user. Body: {note?, expires_at?, billing_status?, max_devices?, traffic_reset_interval?}' },
      { method: 'DELETE', path: '/nodes/:id/users/:name',               auth: true,  description: 'Delete user and stop container' },
      { method: 'POST',   path: '/nodes/:id/users/:name/renew',         auth: true,  description: 'Renew subscription. Body: {days: 30}. Auto-resumes if suspended.' },
      { method: 'POST',   path: '/nodes/:id/users/:name/stop',          auth: true,  description: 'Stop user container' },
      { method: 'POST',   path: '/nodes/:id/users/:name/start',         auth: true,  description: 'Start user container' },
      { method: 'POST',   path: '/nodes/:id/users/:name/reset-traffic', auth: true,  description: 'Reset traffic counter (restarts container)' },
      { method: 'GET',    path: '/nodes/:id/users/:name/history',       auth: true,  description: 'Connection count history (last 48 records)' },
      { method: 'GET',    path: '/status',                              auth: true,  description: 'Online status of all nodes' },
    ],
  });
});

app.post('/api/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD)
    return res.status(500).json({ error: 'Credentials not configured' });
  if (!username || !password)
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  const userMatch = username === ADMIN_USERNAME;
  const passMatch = crypto.timingSafeEqual(
    Buffer.from(password || ''),
    Buffer.from(ADMIN_PASSWORD)
  );
  if (userMatch && passMatch) {
    res.json({ token: AUTH_TOKEN });
  } else {
    res.status(401).json({ error: 'Неверный логин или пароль' });
  }
});

// ── Auth middleware ───────────────────────────────────────
app.use('/api', (req, res, next) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── TOTP 2FA ──────────────────────────────────────────────
const TOTP_ISSUER = 'MTG Panel';

function getTotpSecret() {
  const row = db.prepare("SELECT value FROM settings WHERE key='totp_secret'").get();
  return row ? row.value : null;
}
function isTotpEnabled() {
  const row = db.prepare("SELECT value FROM settings WHERE key='totp_enabled'").get();
  return row && row.value === '1';
}

app.get('/api/totp/status', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ enabled: isTotpEnabled() });
});
app.post('/api/totp/setup', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const secret = authenticator.generateSecret();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_secret', ?)").run(secret);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_enabled', '0')").run();
  res.json({ secret, qr: authenticator.keyuri('admin', TOTP_ISSUER, secret) });
});
app.post('/api/totp/verify', totpRateLimit, (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  const secret = getTotpSecret();
  if (!secret) return res.status(400).json({ error: 'Setup first' });
  if (authenticator.verify(code, secret)) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_enabled', '1')").run();
    res.json({ ok: true });
  } else { res.status(400).json({ error: 'Invalid code' }); }
});
app.post('/api/totp/disable', totpRateLimit, (req, res) => {
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

// ── Nodes ─────────────────────────────────────────────────
app.get('/api/nodes', (req, res) => {
  res.json(db.prepare('SELECT id, name, host, ssh_user, ssh_port, base_dir, start_port, created_at, flag, agent_port, cpu_cores, ram_mb FROM nodes').all());
});

// Быстрый подсчёт клиентов по нодам (только SQLite, без SSH)
app.get('/api/counts', (req, res) => {
  const rows = db.prepare('SELECT node_id, COUNT(*) as cnt FROM users GROUP BY node_id').all();
  const result = {};
  for (const r of rows) result[r.node_id] = r.cnt;
  res.json(result);
});

// ── Integration API ────────────────────────────────────────
// GET /api/nodes/best — нода с наименьшим числом пользователей (для автопровизионинга)
app.get('/api/nodes/best', (req, res) => {
  const nodes = db.prepare('SELECT id, name, host, flag, agent_port FROM nodes').all();
  if (!nodes.length) return res.status(404).json({ error: 'No nodes available' });
  const counts = db.prepare('SELECT node_id, COUNT(*) as cnt FROM users GROUP BY node_id').all();
  const countMap = Object.fromEntries(counts.map(r => [r.node_id, r.cnt]));
  const sorted = [...nodes].sort((a, b) => (countMap[a.id] || 0) - (countMap[b.id] || 0));
  const best = sorted[0];
  res.json({ ...best, user_count: countMap[best.id] || 0 });
});

// GET /api/users?name=xxx — поиск пользователя по имени или заметке (все ноды)
app.get('/api/users', (req, res) => {
  const { name, note, node_id, limit = 50, offset = 0 } = req.query;
  let sql = `SELECT u.*, n.name as node_name, n.host as node_host
             FROM users u JOIN nodes n ON u.node_id = n.id WHERE 1=1`;
  const params = [];
  if (name)    { sql += ' AND u.name LIKE ?';    params.push(`%${name}%`); }
  if (note)    { sql += ' AND u.note LIKE ?';    params.push(`%${note}%`); }
  if (node_id) { sql += ' AND u.node_id = ?';    params.push(node_id); }
  sql += ' ORDER BY u.id DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit) || 50, parseInt(offset) || 0);
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(u => ({
    ...u,
    link: `tg://proxy?server=${u.node_host}&port=${u.port}&secret=${u.secret}`,
    expired: u.expires_at ? new Date(u.expires_at) < new Date() : false,
  })));
});

// GET /api/users/:name — найти пользователя по точному имени (первая совпадающая нода)
app.get('/api/users/:name', (req, res) => {
  const row = db.prepare(`
    SELECT u.*, n.name as node_name, n.host as node_host
    FROM users u JOIN nodes n ON u.node_id = n.id
    WHERE u.name = ? LIMIT 1
  `).get(req.params.name);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({
    ...row,
    link: `tg://proxy?server=${row.node_host}&port=${row.port}&secret=${row.secret}`,
    expired: row.expires_at ? new Date(row.expires_at) < new Date() : false,
  });
});

// POST /api/nodes/:id/users/:name/renew — продление подписки на N дней
// Body: { days: 30 }
app.post('/api/nodes/:id/users/:name/renew', async (req, res) => {
  const { days } = req.body;
  if (!days || isNaN(days) || days <= 0) return res.status(400).json({ error: 'days must be a positive number' });
  const user = db.prepare('SELECT * FROM users WHERE node_id = ? AND name = ?').get(req.params.id, req.params.name);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Считаем новую дату: от текущей даты истечения (если в будущем) или от сейчас
  const base = user.expires_at && new Date(user.expires_at) > new Date()
    ? new Date(user.expires_at)
    : new Date();
  base.setDate(base.getDate() + parseInt(days));
  const newExpiry = base.toISOString().replace('T', ' ').slice(0, 19);

  const wasSuspended = user.billing_status === 'suspended';
  db.prepare(`UPDATE users SET expires_at=?, billing_status='active' WHERE node_id=? AND name=?`)
    .run(newExpiry, req.params.id, req.params.name);

  // Если был suspended — запускаем контейнер
  if (wasSuspended) {
    try {
      const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(req.params.id);
      if (node) await ssh.startRemoteUser(node, req.params.name);
    } catch (e) { console.error(`Failed to resume ${req.params.name}:`, e.message); }
  }

  const node = db.prepare('SELECT host FROM nodes WHERE id=?').get(req.params.id);
  res.json({
    ok: true,
    name: req.params.name,
    expires_at: newExpiry,
    days_added: parseInt(days),
    resumed: wasSuspended,
    link: node ? `tg://proxy?server=${node.host}&port=${user.port}&secret=${user.secret}` : undefined,
  });
});

app.post('/api/nodes', (req, res) => {
  const { name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port, flag, agent_port } = req.body;
  if (!name || !host) return res.status(400).json({ error: 'name и host обязательны' });
  const result = db.prepare(
    'INSERT INTO nodes (name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port, flag, agent_port) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, host, ssh_user||'root', ssh_port||22, ssh_key||null, ssh_password||null, base_dir||'/opt/mtg/users', start_port||4433, flag||null, agent_port||null);
  res.json({ id: result.lastInsertRowid, name, host });
});

app.put('/api/nodes/:id', (req, res) => {
  const { name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port, flag, agent_port } = req.body;
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  db.prepare(
    'UPDATE nodes SET name=?, host=?, ssh_user=?, ssh_port=?, ssh_key=?, ssh_password=?, base_dir=?, start_port=?, flag=?, agent_port=? WHERE id=?'
  ).run(
    name||node.name, host||node.host, ssh_user||node.ssh_user, ssh_port||node.ssh_port,
    ssh_key!==undefined ? ssh_key : node.ssh_key,
    ssh_password!==undefined ? ssh_password : node.ssh_password,
    base_dir||node.base_dir, start_port||node.start_port,
    flag!==undefined ? flag : node.flag,
    agent_port!==undefined ? (agent_port||null) : node.agent_port,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/nodes/:id', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  // Stop and remove all users on this node via SSH before deleting
  const users = db.prepare('SELECT name FROM users WHERE node_id = ?').all(req.params.id);
  for (const u of users) {
    try { await ssh.removeRemoteUser(node, u.name); } catch (_) {}
  }
  db.prepare('DELETE FROM users WHERE node_id = ?').run(req.params.id);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Check agent health on a node
app.get('/api/nodes/:id/check-agent', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (!node.agent_port) return res.json({ available: false, reason: 'no agent_port configured' });
  try {
    const ok = await ssh.checkAgentHealth(node);
    res.json({ available: ok });
  } catch (e) {
    res.json({ available: false, reason: e.message });
  }
});

// Full setup: install Docker + xxd + MTG Agent on a fresh Ubuntu server
app.post('/api/nodes/:id/setup-node', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const agentToken = process.env.AGENT_TOKEN || 'mtg-agent-secret';
  const agentPort  = node.agent_port || 8081;
  const baseDir    = node.base_dir || '/opt/mtg/users';
  const sshPort    = node.ssh_port || 22;
  const cmd = [
    'export DEBIAN_FRONTEND=noninteractive',
    // ── Package installation ────────────────────────────────
    'apt-get update -qq',
    'apt-get install -y -qq docker.io docker-compose-v2 xxd curl wget ufw',
    'systemctl start docker',
    'systemctl enable docker',
    // ── Detect hardware ─────────────────────────────────────
    'CPU_CORES=$(nproc)',
    'RAM_MB=$(free -m | awk \'/Mem:/{print $2}\')',
    'echo "=== HW: CPU=${CPU_CORES} RAM=${RAM_MB}MB ==="',
    // ── TCP/Network optimizations (BBR + tuning) ────────────
    'modprobe tcp_bbr 2>/dev/null || true',
    'sysctl -w net.core.default_qdisc=fq 2>/dev/null || true',
    'sysctl -w net.ipv4.tcp_congestion_control=bbr 2>/dev/null || true',
    `cat > /etc/sysctl.d/99-mtg.conf << 'SYSCTL'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.ipv4.tcp_rmem=4096 87380 16777216
net.ipv4.tcp_wmem=4096 65536 16777216
net.core.somaxconn=65535
net.ipv4.tcp_max_syn_backlog=65535
net.ipv4.ip_local_port_range=1024 65535
fs.file-max=1048576
SYSCTL`,
    'sysctl -p /etc/sysctl.d/99-mtg.conf 2>/dev/null || true',
    // ── Docker log limits ───────────────────────────────────
    `mkdir -p /etc/docker && cat > /etc/docker/daemon.json << 'DOCKER'
{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}
DOCKER`,
    'systemctl restart docker',
    // ── UFW firewall ────────────────────────────────────────
    'ufw --force reset',
    'ufw default deny incoming',
    'ufw default allow outgoing',
    `ufw allow ${sshPort}/tcp comment 'SSH'`,
    `ufw allow ${agentPort}/tcp comment 'MTG Agent'`,
    'ufw --force enable',
    // ── Ulimits for high-connection workloads ───────────────
    `grep -q '* soft nofile' /etc/security/limits.conf || echo '* soft nofile 1048576
* hard nofile 1048576' >> /etc/security/limits.conf`,
    // ── User dir + MTG Agent setup ──────────────────────────
    `mkdir -p ${baseDir}`,
    `mkdir -p /opt/mtg-agent && cd /opt/mtg-agent`,
    `wget -q https://raw.githubusercontent.com/MaksimTMB/mtg-adminpanel/main/mtg-agent/install-agent.sh -O install.sh`,
    `bash install.sh ${agentToken}`,
    'echo "==SETUP_DONE=="'
  ].join(' && ');
  try {
    const r = await ssh.sshExec(node, cmd, 180000);
    const installed = r.output.includes('==SETUP_DONE==');
    if (!installed) {
      return res.json({ ok: false, output: r.output.slice(-1500), error: 'Установка не завершилась' });
    }
    // Parse hardware info from output
    const hwMatch = r.output.match(/=== HW: CPU=(\d+) RAM=(\d+)MB ===/);
    const cpuCores = hwMatch ? parseInt(hwMatch[1]) : null;
    const ramMb    = hwMatch ? parseInt(hwMatch[2]) : null;

    db.prepare('UPDATE nodes SET agent_port=? WHERE id=?').run(agentPort, node.id);
    if (cpuCores || ramMb) {
      try {
        db.prepare('ALTER TABLE nodes ADD COLUMN cpu_cores INTEGER DEFAULT NULL').run();
      } catch (_) {}
      try {
        db.prepare('ALTER TABLE nodes ADD COLUMN ram_mb INTEGER DEFAULT NULL').run();
      } catch (_) {}
      db.prepare('UPDATE nodes SET cpu_cores=?, ram_mb=? WHERE id=?').run(cpuCores, ramMb, node.id);
    }

    // Ждём пока агент поднимется (pip install занимает ~30-40 сек)
    const updatedNode = { ...node, agent_port: agentPort };
    let agentReady = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        agentReady = await ssh.checkAgentHealth(updatedNode);
        if (agentReady) break;
      } catch (_) {}
    }

    const hwInfo = cpuCores ? `\n💻 CPU: ${cpuCores} ядер, RAM: ${ramMb} MB` : '';
    res.json({
      ok: agentReady,
      agent_ready: agentReady,
      cpu_cores: cpuCores,
      ram_mb: ramMb,
      output: r.output.slice(-2000) + hwInfo + (agentReady ? '\n\n✅ Агент запущен и отвечает!' : '\n\n⚠️ Установка прошла, но агент ещё не ответил. Подожди 30 сек и нажми «Проверить».'),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Update agent on node via SSH
app.post('/api/nodes/:id/update-agent', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const token = process.env.AGENT_TOKEN || 'mtg-agent-secret';
  // Use wget (more universally available than curl), write to temp file
  const RAW = 'https://raw.githubusercontent.com/MaksimTMB/mtg-adminpanel/dev/mtg-agent';
  const cmd = [
    `mkdir -p /opt/mtg-agent && cd /opt/mtg-agent`,
    `wget -q "${RAW}/main.py" -O main.py`,
    `wget -q "${RAW}/docker-compose.yml" -O docker-compose.yml`,
    `echo "AGENT_TOKEN=${token}" > .env`,
    `docker compose down 2>/dev/null || true`,
    `docker compose up -d`,
    `echo "==> Done"`
  ].join(' && ');
  try {
    const r = await ssh.sshExec(node, cmd);
    const ok = r.output.includes('Done');
    res.json({ ok, output: r.output.slice(-800) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/nodes/:id/check', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try { res.json({ online: await ssh.checkNode(node) }); }
  catch (e) { res.json({ online: false, error: e.message }); }
});

app.get('/api/nodes/:id/traffic', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try { res.json(await ssh.getTraffic(node)); }
  catch (_) { res.json({}); }
});

app.get('/api/nodes/:id/mtg-version', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ssh.sshExec(node, "docker inspect nineseconds/mtg:2 --format 'mtg:2 | built {{.Created}}' 2>/dev/null | head -1");
    res.json({ version: (r.output||'').trim().split('\n')[0]||'unknown', raw: r.output });
  } catch (e) { res.json({ version: 'error', error: e.message }); }
});

app.post('/api/nodes/:id/mtg-update', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ssh.sshExec(node, 'docker pull nineseconds/mtg:2 2>&1 | tail -3');
    res.json({ ok: true, output: r.output });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', async (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const results = await Promise.allSettled(
    nodes.map(async node => {
      // Single agent request, reused for both status and online_users
      let agentContainers = null;
      if (node.agent_port) {
        try { agentContainers = await ssh.getAgentMetrics(node); } catch (_) {}
      }
      const status = agentContainers !== null
        ? { online: true, containers: agentContainers.filter(c => c.running).length, via_agent: true }
        : await ssh.getNodeStatusNoAgent(node);
      const online_users = agentContainers
        ? agentContainers.filter(c => (c.connections || 0) > 0).length
        : 0;
      return { id: node.id, name: node.name, host: node.host, ...status, online_users };
    })
  );
  res.json(results.map((r, i) => r.status === 'fulfilled'
    ? r.value
    : { id: nodes[i].id, name: nodes[i].name, online: false, online_users: 0 }
  ));
});

// ── Users ─────────────────────────────────────────────────
app.get('/api/nodes/:id/users', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const dbUsers = db.prepare('SELECT * FROM users WHERE node_id = ?').all(req.params.id);

  const mkUser = (u, remote) => ({
    ...u,
    connections: remote ? remote.connections : 0,
    running: remote ? !remote.status.includes('stopped') : false,
    is_online: remote ? (remote.connections || 0) > 0 : false,
    link: `tg://proxy?server=${node.host}&port=${u.port}&secret=${u.secret}`,
    expired: u.expires_at ? new Date(u.expires_at) < new Date() : false,
  });

  try {
    const remoteUsers = await ssh.getRemoteUsers(node);

    // Real-time device limit enforcement
    for (const remote of remoteUsers) {
      const dbUser = dbUsers.find(u => u.name === remote.name);
      if (dbUser && dbUser.max_devices && (remote.connections || 0) > dbUser.max_devices) {
        console.log(`⚠️ Device limit exceeded: ${remote.name} (${remote.connections}/${dbUser.max_devices}) — stopping`);
        ssh.stopRemoteUser(node, remote.name).catch(e => console.error(`Device limit stop failed for ${remote.name}:`, e.message));
        db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('stopped', req.params.id, remote.name);
        remote.status = 'stopped';
        remote.connections = 0;
      }
      if ((remote.connections || 0) > 0) {
        db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE node_id=? AND name=?")
          .run(req.params.id, remote.name);
      }
    }

    res.json(dbUsers.map(u => mkUser(u, remoteUsers.find(r => r.name === u.name))));
  } catch (_) {
    res.json(dbUsers.map(u => mkUser(u, null)));
  }
});

app.post('/api/nodes/:id/sync', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    const remoteUsers = await ssh.getRemoteUsers(node);
    let imported = 0;
    for (const u of remoteUsers) {
      const exists = db.prepare('SELECT id FROM users WHERE node_id = ? AND name = ?').get(req.params.id, u.name);
      if (!exists) {
        db.prepare('INSERT INTO users (node_id, name, port, secret, note, expires_at, traffic_limit_gb) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(req.params.id, u.name, u.port, u.secret, '', null, null);
        imported++;
      }
    }
    res.json({ imported, total: remoteUsers.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const normalizeDate = (d) => d ? d.replace('T', ' ') : null;

app.post('/api/nodes/:id/users', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const { name, note, expires_at, traffic_limit_gb } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try { ssh.sanitizeName(name); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (db.prepare('SELECT id FROM users WHERE node_id = ? AND name = ?').get(req.params.id, name)) {
    return res.status(400).json({ error: 'User already exists' });
  }
  try {
    const { port, secret } = await ssh.createRemoteUser(node, name);
    const result = db.prepare(
      'INSERT INTO users (node_id, name, port, secret, note, expires_at, traffic_limit_gb) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.id, name, port, secret, note||'', normalizeDate(expires_at), traffic_limit_gb||null);
    res.json({ id: result.lastInsertRowid, name, port, secret, note: note||'',
      expires_at: expires_at||null, traffic_limit_gb: traffic_limit_gb||null,
      link: `tg://proxy?server=${node.host}&port=${port}&secret=${secret}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/nodes/:id/users/:name', async (req, res) => {
  const { note, expires_at, traffic_limit_gb, billing_price, billing_currency, billing_period,
    billing_paid_until, billing_status, max_devices, traffic_reset_interval } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE node_id = ? AND name = ?').get(req.params.id, req.params.name);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Calculate next_reset_at if interval changed
  let next_reset_at = user.next_reset_at;
  const newInterval = traffic_reset_interval !== undefined ? traffic_reset_interval : user.traffic_reset_interval;
  if (traffic_reset_interval !== undefined && traffic_reset_interval !== user.traffic_reset_interval) {
    next_reset_at = calcNextReset(traffic_reset_interval);
  }

  const newExpiry = expires_at !== undefined ? normalizeDate(expires_at) : user.expires_at;
  const wasExpiredOrSuspended = user.billing_status === 'suspended';
  const newExpiryIsValid = newExpiry && new Date(newExpiry) > new Date();

  db.prepare(`UPDATE users SET
    note=?, expires_at=?, traffic_limit_gb=?,
    billing_price=?, billing_currency=?, billing_period=?, billing_paid_until=?, billing_status=?,
    max_devices=?, traffic_reset_interval=?, next_reset_at=?
    WHERE node_id=? AND name=?`).run(
    note!==undefined ? note : user.note,
    newExpiry,
    traffic_limit_gb!==undefined ? traffic_limit_gb : user.traffic_limit_gb,
    billing_price!==undefined ? billing_price : user.billing_price,
    billing_currency||user.billing_currency||'RUB',
    billing_period||user.billing_period||'monthly',
    billing_paid_until!==undefined ? billing_paid_until : user.billing_paid_until,
    wasExpiredOrSuspended && newExpiryIsValid ? 'active' : (billing_status||user.billing_status||'active'),
    max_devices!==undefined ? max_devices : user.max_devices,
    newInterval||null,
    next_reset_at||null,
    req.params.id, req.params.name
  );

  // Если пользователь был suspended и новая дата в будущем — запускаем контейнер
  if (wasExpiredOrSuspended && newExpiryIsValid) {
    try {
      const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(req.params.id);
      if (node) {
        await ssh.startRemoteUser(node, req.params.name);
        console.log(`▶️ Resumed user: ${req.params.name} on node ${req.params.id}`);
      }
    } catch (e) { console.error(`Failed to resume user ${req.params.name}:`, e.message); }
  }

  res.json({ ok: true });
});

app.delete('/api/nodes/:id/users/:name', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.removeRemoteUser(node, req.params.name);
    db.prepare('DELETE FROM users WHERE node_id = ? AND name = ?').run(req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop: respond immediately, then save traffic snapshot and stop container in background
app.post('/api/nodes/:id/users/:name/stop', (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const { id: nodeId, name: userName } = { id: req.params.id, name: req.params.name };

  // Return immediately so the bot doesn't hang
  res.json({ ok: true, status: 'pending' });

  // Do the actual work in the background
  (async () => {
    try {
      try {
        const traffic = await ssh.getTraffic(node);
        const ut = traffic[userName];
        if (ut) {
          db.prepare('UPDATE users SET traffic_rx_snap=?, traffic_tx_snap=? WHERE node_id=? AND name=?')
            .run(ut.rx, ut.tx, nodeId, userName);
        }
      } catch (_) {}
      await ssh.stopRemoteUser(node, userName);
      db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('stopped', nodeId, userName);
    } catch (e) {
      console.error(`Background stop failed for ${userName} on node ${nodeId}:`, e.message);
    }
  })();
});

app.post('/api/nodes/:id/users/:name/start', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.startRemoteUser(node, req.params.name);
    db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('active', req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset traffic: restart container (clears MTG counter) + record timestamp
app.post('/api/nodes/:id/users/:name/reset-traffic', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.stopRemoteUser(node, req.params.name);
    await ssh.startRemoteUser(node, req.params.name);
    db.prepare(`UPDATE users SET
      traffic_reset_at=datetime('now'), traffic_rx_snap=NULL, traffic_tx_snap=NULL,
      status='active' WHERE node_id=? AND name=?`
    ).run(req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nodes/:id/users/:name/history', (req, res) => {
  const rows = db.prepare(
    'SELECT connections, recorded_at FROM connections_history WHERE node_id=? AND user_name=? ORDER BY recorded_at DESC LIMIT 48'
  ).all(req.params.id, req.params.name);
  res.json(rows.reverse());
});

// ── SPA fallback ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Helpers ───────────────────────────────────────────────
function calcNextReset(interval) {
  if (!interval || interval === 'never') return null;
  const now = new Date();
  if (interval === 'daily')   { now.setDate(now.getDate() + 1); now.setHours(0,0,0,0); }
  if (interval === 'monthly') { now.setMonth(now.getMonth() + 1); now.setDate(1); now.setHours(0,0,0,0); }
  if (interval === 'yearly')  { now.setFullYear(now.getFullYear() + 1); now.setMonth(0); now.setDate(1); now.setHours(0,0,0,0); }
  return now.toISOString().replace('T',' ').slice(0,19);
}

function parseBytes(str) {
  if (!str) return 0;
  const m = str.match(/([\d.]+)(GB|MB|KB|B)/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === 'GB') return Math.round(v * 1073741824);
  if (u === 'MB') return Math.round(v * 1048576);
  if (u === 'KB') return Math.round(v * 1024);
  return Math.round(v);
}

// ── Background jobs ───────────────────────────────────────
let _recordHistoryRunning = false;
async function recordHistory() {
  if (_recordHistoryRunning) return;
  _recordHistoryRunning = true;
  try {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  for (const node of nodes) {
    try {
      const remoteUsers = await ssh.getRemoteUsers(node);
      const traffic = await ssh.getTraffic(node).catch(() => ({}));

      // Загружаем всех пользователей ноды одним запросом (вместо N запросов в цикле)
      const allDbUsers = db.prepare('SELECT * FROM users WHERE node_id=?').all(node.id);
      const dbUsersMap = Object.fromEntries(allDbUsers.map(u => [u.name, u]));

      for (const u of remoteUsers) {
        const conns = u.connections || 0;
        db.prepare('INSERT INTO connections_history (node_id, user_name, connections) VALUES (?, ?, ?)')
          .run(node.id, u.name, conns);

        if (conns > 0) {
          db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE node_id=? AND name=?")
            .run(node.id, u.name);
        }

        // Device limit enforcement
        const dbUser = dbUsersMap[u.name];
        if (dbUser && dbUser.max_devices && conns > dbUser.max_devices) {
          console.log(`⚠️ Device limit exceeded: ${u.name} on node ${node.id} (${conns}/${dbUser.max_devices})`);
          try {
            await ssh.stopRemoteUser(node, u.name);
            db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('stopped', node.id, u.name);
            console.log(`🛑 Auto-stopped ${u.name}: exceeded device limit`);
          } catch (e) { console.error('Failed to stop user:', e.message); }
        }
      }

      // Auto traffic reset check
      const usersToReset = db.prepare(`
        SELECT * FROM users WHERE node_id=? AND traffic_reset_interval IS NOT NULL
        AND traffic_reset_interval != 'never' AND next_reset_at IS NOT NULL
        AND next_reset_at <= datetime('now')
      `).all(node.id);

      for (const u of usersToReset) {
        try {
          // Accumulate total traffic before reset
          const t = traffic[u.name];
          if (t) {
            const rxBytes = parseBytes(t.rx) + (u.total_traffic_rx_bytes || 0);
            const txBytes = parseBytes(t.tx) + (u.total_traffic_tx_bytes || 0);
            db.prepare('UPDATE users SET total_traffic_rx_bytes=?, total_traffic_tx_bytes=? WHERE id=?')
              .run(rxBytes, txBytes, u.id);
          }
          // Reset traffic (restart container)
          await ssh.stopRemoteUser(node, u.name);
          await ssh.startRemoteUser(node, u.name);
          const next = calcNextReset(u.traffic_reset_interval);
          db.prepare(`UPDATE users SET traffic_reset_at=datetime('now'), traffic_rx_snap=NULL,
            traffic_tx_snap=NULL, next_reset_at=?, status='active' WHERE id=?`).run(next, u.id);
          console.log(`♻️ Auto-reset traffic for ${u.name} on node ${node.id}, next: ${next}`);
        } catch (e) { console.error(`Failed to auto-reset traffic for ${u.name}:`, e.message); }
      }

    } catch (_) {}
  }
  db.prepare("DELETE FROM connections_history WHERE recorded_at < datetime('now', '-24 hours')").run();
  } finally { _recordHistoryRunning = false; }
}

async function checkExpiredUsers() {
  // Останавливаем истёкших (если ещё работают)
  const expired = db.prepare(
    "SELECT u.*, u.id as uid FROM users u WHERE u.expires_at IS NOT NULL AND datetime(u.expires_at) < datetime('now') AND (u.billing_status IS NULL OR u.billing_status != 'suspended')"
  ).all();
  for (const u of expired) {
    try {
      const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(u.node_id);
      if (node) await ssh.stopRemoteUser(node, u.name);
      db.prepare("UPDATE users SET billing_status='suspended' WHERE id=?").run(u.uid);
      console.log(`⏸️ Suspended expired user: ${u.name} on node ${u.node_id}`);
    } catch (e) { console.error(`Failed to suspend expired user ${u.name}:`, e.message); }
  }
}

setInterval(recordHistory,       5  * 60 * 1000);
setInterval(checkExpiredUsers,   5  * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🔒 MTG Panel running on http://0.0.0.0:${PORT}`);
  console.log(`🔑 Auth token: ${AUTH_TOKEN.slice(0,8)}...`);
  console.log(`📦 Version: ${pkgVersion}`);
  setTimeout(recordHistory,       10000);
  setTimeout(checkExpiredUsers,    5000);
});
