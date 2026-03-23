const { Client } = require('ssh2');
const http = require('http');

const AGENT_TOKEN = process.env.AGENT_TOKEN || 'mtg-agent-secret';

// ── Input validation ───────────────────────────────────────
function sanitizeName(name) {
  if (!name || !/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
    throw new Error(`Invalid user/node name: "${name}". Only letters, digits, _ and - allowed (max 32 chars).`);
  }
  return name;
}

function sanitizeDir(dir) {
  if (!dir || /['"\\;|&`$(){}!<>*?[\]#~]/.test(dir)) {
    throw new Error(`Invalid directory path: "${dir}"`);
  }
  return dir;
}

// ── Agent HTTP client ─────────────────────────────────────
function agentFetch(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host,
      port: parseInt(port),
      path,
      method: 'GET',
      headers: { 'x-agent-token': AGENT_TOKEN },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from agent')); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Agent timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function getAgentMetrics(node) {
  if (!node.agent_port) return null;
  try {
    const data = await agentFetch(node.host, node.agent_port, '/metrics');
    return data.containers || null;
  } catch {
    return null;
  }
}

async function checkAgentHealth(node) {
  if (!node.agent_port) return false;
  try {
    const data = await agentFetch(node.host, node.agent_port, '/health');
    return data.status === 'ok';
  } catch {
    return false;
  }
}

// ── SSH exec ──────────────────────────────────────────────
function sshExec(node, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let errOutput = '';
    let timer;

    const config = {
      host: node.host,
      port: node.ssh_port || 22,
      username: node.ssh_user || 'root',
      readyTimeout: 15000,
    };

    if (timeoutMs) {
      timer = setTimeout(() => { conn.end(); reject(new Error('SSH command timed out')); }, timeoutMs);
    }

    if (node.ssh_key) {
      config.privateKey = node.ssh_key;
    } else if (node.ssh_password) {
      config.password = node.ssh_password;
    }

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        stream.on('data', d => { output += d.toString(); });
        stream.stderr.on('data', d => { errOutput += d.toString(); });
        stream.on('close', () => { if(timer) clearTimeout(timer); conn.end(); resolve({ output: output.trim(), error: errOutput.trim() }); });
      });
    });
    conn.on('error', err => reject(err));
    conn.connect(config);
  });
}

async function checkNode(node) {
  if (node.agent_port) {
    const agentOk = await checkAgentHealth(node);
    if (agentOk) return true;
  }
  try {
    const r = await sshExec(node, 'echo ok');
    return r.output === 'ok';
  } catch {
    return false;
  }
}


async function getRemoteUsers(node) {
  const containers = await getAgentMetrics(node);
  if (containers !== null) {
    return containers.map(c => ({
      name:        c.name.replace('mtg-', ''),
      port:        null,
      secret:      null,
      status:      c.running ? 'Up' : 'stopped',
      connections: c.connections || 0,
      via_agent:   true,
    }));
  }
  try {
    const cmd = [
      'BASE=' + node.base_dir,
      'for DIR in $BASE/*/; do',
      '  [ -d "$DIR" ] || continue',
      '  NAME=$(basename "$DIR")',
      "  SECRET=$(grep secret \"$DIR/config.toml\" 2>/dev/null | awk -F'\"' '{print $2}')",
      "  PORT=$(grep -o '[0-9]*:3128' \"$DIR/docker-compose.yml\" 2>/dev/null | cut -d: -f1)",
      "  STATUS=$(docker inspect -f '{{.State.Status}}' \"mtg-$NAME\" 2>/dev/null || echo stopped)",
      '  CONNS=0',
      '  if [ "$STATUS" = "running" ]; then',
      "    PID=$(docker inspect -f '{{.State.Pid}}' \"mtg-$NAME\" 2>/dev/null || echo 0)",
      '    if [ "$PID" != "0" ] && [ -r "/proc/$PID/net/tcp6" ]; then',
      '      CONNS=$(awk \'NR>1 { split($2,l,\":\"); if ($4==\"01\" && l[2]==\"0C38\") { split($3,r,\":\"); ips[r[1]]=1 } } END { c=0; for (ip in ips) c++; print c+0 }\' "/proc/$PID/net/tcp6" 2>/dev/null || echo 0)',
      '    fi',
      '    if [ "${CONNS:-0}" = "0" ] && [ "$PID" != "0" ] && [ -r "/proc/$PID/net/tcp" ]; then',
      '      CONNS=$(awk \'NR>1 { split($2,l,\":\"); if ($4==\"01\" && l[2]==\"0C38\") { split($3,r,\":\"); ips[r[1]]=1 } } END { c=0; for (ip in ips) c++; print c+0 }\' "/proc/$PID/net/tcp" 2>/dev/null || echo 0)',
      '    fi',
      '  fi',
      '  echo "USER|$NAME|$PORT|$SECRET|${STATUS:-stopped}|$CONNS"',
      'done'
    ].join('\n');
    const r = await sshExec(node, cmd, 15000);
    const users = [];
    for (const line of r.output.split('\n')) {
      if (!line.startsWith('USER|')) continue;
      const [, name, port, secret, status, conns] = line.split('|');
      if (!name) continue;
      users.push({ name, port: parseInt(port), secret, status, connections: parseInt(conns) || 0 });
    }
    return users;
  } catch {
    return [];
  }
}

async function getTraffic(node) {
  const containers = await getAgentMetrics(node);
  if (containers !== null) {
    const result = {};
    for (const c of containers) {
      const userName = c.name.replace('mtg-', '');
      result[userName] = { rx: c.traffic?.rx || '0B', tx: c.traffic?.tx || '0B' };
    }
    return result;
  }
  try {
    const r = await sshExec(node,
      "docker stats --no-stream --format '{{.Name}}|{{.NetIO}}' 2>/dev/null | grep '^mtg-' | grep -v 'mtg-agent'",
      12000
    );
    const result = {};
    for (const line of r.output.split('\n')) {
      if (!line.includes('|')) continue;
      const [name, netio] = line.split('|');
      const userName = name.replace('mtg-', '').trim();
      const parts = netio.trim().split(' / ');
      result[userName] = { rx: parts[0] || '0B', tx: parts[1] || '0B' };
    }
    return result;
  } catch {
    return {};
  }
}

async function createRemoteUser(node, name) {
  sanitizeName(name);
  const baseDir = sanitizeDir(node.base_dir);
  const startPort = parseInt(node.start_port) || 4433;
  const cmd = [
    `BASE='${baseDir}'`, `NAME='${name}'`, `START_PORT=${startPort}`,
    'USER_DIR="$BASE/$NAME"',
    'if [ -d "$USER_DIR" ]; then echo EXISTS; exit 1; fi',
    'USED_PORTS=$(grep -hroE \'[0-9]+:3128\' "$BASE"/*/docker-compose.yml 2>/dev/null | cut -d: -f1 | sort -n | uniq || true)',
    'PORT=$START_PORT',
    'while echo "$USED_PORTS" | grep -qx "$PORT"; do PORT=$((PORT + 1)); done',
    "SECRET=\"ee$(openssl rand -hex 16)$(echo -n 'google.com' | xxd -p)\"",
    'mkdir -p "$USER_DIR"',
    'printf \'secret = "%s"\nbind-to = "0.0.0.0:3128"\nhostname = "google.com"\n\' "$SECRET" > "$USER_DIR/config.toml"',
    'printf \'services:\n  mtg-%s:\n    image: nineseconds/mtg:2\n    container_name: mtg-%s\n    restart: unless-stopped\n    ports:\n      - "%s:3128"\n    volumes:\n      - %s/config.toml:/config.toml:ro\n    command: run /config.toml\n\' "$NAME" "$NAME" "$PORT" "$USER_DIR" > "$USER_DIR/docker-compose.yml"',
    'cd "$USER_DIR" && docker compose up -d 2>&1',
    'echo "OK|$NAME|$PORT|$SECRET"'
  ].join('\n');
  const r = await sshExec(node, cmd);
  if (r.output.includes('EXISTS')) throw new Error('User already exists on node');
  const okLine = r.output.split('\n').find(l => l.startsWith('OK|'));
  if (!okLine) throw new Error('Failed to create user: ' + r.output);
  const parts = okLine.split('|');
  return { port: parseInt(parts[2]), secret: parts[3] };
}

async function removeRemoteUser(node, name) {
  sanitizeName(name);
  const baseDir = sanitizeDir(node.base_dir);
  const cmd = [
    `BASE='${baseDir}'`, `NAME='${name}'`, 'USER_DIR="$BASE/$NAME"',
    'if [ -d "$USER_DIR" ]; then cd "$USER_DIR" && docker compose down 2>/dev/null; rm -rf "$USER_DIR"; fi',
    'echo DONE'
  ].join('\n');
  await sshExec(node, cmd);
}

async function stopRemoteUser(node, name) {
  sanitizeName(name);
  const baseDir = sanitizeDir(node.base_dir);
  await sshExec(node, `cd '${baseDir}/${name}' && docker compose stop 2>/dev/null`);
}

async function startRemoteUser(node, name) {
  sanitizeName(name);
  const baseDir = sanitizeDir(node.base_dir);
  await sshExec(node, `cd '${baseDir}/${name}' && docker compose start 2>/dev/null`);
}

// SSH-only fallback for status
async function getNodeStatusNoAgent(node) {
  try {
    const r = await sshExec(node, "COUNT=$(docker ps --filter 'name=mtg-' --format '{{.Names}}' 2>/dev/null | grep -v 'mtg-agent\\|mtg-panel' | wc -l); echo \"ONLINE|$COUNT\"");
    if (r.output.startsWith('ONLINE|')) {
      return { online: true, containers: parseInt(r.output.split('|')[1]) || 0 };
    }
    return { online: false, containers: 0 };
  } catch {
    return { online: false, containers: 0 };
  }
}

module.exports = {
  sshExec, checkNode, checkAgentHealth, getAgentMetrics, sanitizeName,
  getNodeStatusNoAgent, getRemoteUsers, getTraffic,
  createRemoteUser, removeRemoteUser, stopRemoteUser, startRemoteUser,
};
