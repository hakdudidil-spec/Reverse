// xray.js — downloads Xray-core and runs it with ./xray-config.json (no root, no unzip needed).
// No dependencies, Node 18+.
//
// Usage: put this file and xray-config.json next to index.js, then add this as the FIRST line of index.js:
//   require('./xray.js');
// (or run it alone with: node xray.js)
//
// If the process is not root, inbounds on ports below 1024 are skipped automatically
// (binding them would make Xray refuse to start at all).
//
// Links mode (automatic):
//   - XRAY_DOMAIN is set  -> links use the domain (TLS, port 443, sni/host = domain)
//   - XRAY_DOMAIN is empty -> links use the server's public IP (no TLS, port = the public port of this server)
//
// Optional env:
//   XRAY_DOMAIN       domain of the container (e.g. example.apps.bot-hosting.cloud). Empty/unset = IP mode.
//   XRAY_IP           force the IP used in IP mode (otherwise it is detected automatically)
//   XRAY_LINK_PORT    port written into the links (domain mode default 443, IP mode default = public port)
//   XRAY_LINK_TLS     "none" to disable TLS in domain mode (plain WS)
//   XRAY_PORT / SERVER_PORT   public port given by the host
//   XRAY_VERSION (e.g. v26.10.29), XRAY_UPDATE=1 (re-download), XRAY_DIR, XRAY_CONFIG.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'XTLS/Xray-core';
const BASE = process.env.XRAY_DIR || path.join(process.cwd(), 'xray');
const BIN = path.join(BASE, 'xray');
const SRC_CONF = process.env.XRAY_CONFIG || path.join(process.cwd(), 'xray-config.json');
const RUN_CONF = path.join(BASE, 'config.run.json');

// Domain of the container (if any). Accepts "https://host/..." too.
// Read from XRAY_DOMAIN, then DOMAIN / CONTAINER_DOMAIN / VIRTUAL_HOST. Empty = IP mode.
const DOMAIN = (process.env.XRAY_DOMAIN || process.env.DOMAIN || process.env.CONTAINER_DOMAIN || process.env.VIRTUAL_HOST || '')
  .trim().replace(/^[a-z]+:\/\//i, '').replace(/[\/:].*$/, '');

function log(...a) { console.log('[xray-launcher]', ...a); }
function die(msg) { console.error('[xray-launcher] ERROR:', msg); }

function httpGet(url, redirects = 5, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'xray-launcher', Accept: '*/*' }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), redirects - 1, timeout));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Finds the public IP of this server: env XRAY_IP -> external services -> local interface.
async function getPublicIp() {
  const forced = (process.env.XRAY_IP || '').trim();
  if (net.isIP(forced)) return forced;

  const services = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com', 'https://ipv4.icanhazip.com'];
  for (const url of services) {
    try {
      const ip = (await httpGet(url, 3, 8000)).toString().trim();
      if (net.isIP(ip)) return ip;
    } catch (_) { /* try the next one */ }
  }

  // Last resort: first non-internal IPv4 address of this machine (may be a private address).
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

// Extract one file from a zip held in memory (stored or deflate entries).
function unzipOne(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const data = buf.subarray(dataStart, dataStart + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('unsupported zip method ' + method);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(wanted + ' not found in the archive');
}

async function ensureBinary() {
  if (fs.existsSync(BIN) && !process.env.XRAY_UPDATE) return;
  const asset = { x64: 'Xray-linux-64.zip', arm64: 'Xray-linux-arm64-v8a.zip' }[process.arch];
  if (!asset) throw new Error('No Xray build for CPU ' + process.arch);

  let tag = process.env.XRAY_VERSION;
  if (!tag) {
    const meta = JSON.parse((await httpGet(`https://api.github.com/repos/${REPO}/releases/latest`)).toString());
    tag = meta.tag_name;
  }
  if (!tag) throw new Error('Could not find the latest Xray release.');
  log('Downloading Xray', tag, asset);

  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  const zip = await httpGet(url);
  const dgst = (await httpGet(url + '.dgst')).toString();
  const m = dgst.match(/SHA2-256=\s*([0-9a-fA-F]{64})/);
  if (!m) throw new Error('No SHA-256 in the .dgst file, refusing to install.');
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (actual !== m[1].toLowerCase()) throw new Error('Checksum mismatch: the download is damaged.');
  log('Checksum is good.');

  fs.mkdirSync(BASE, { recursive: true });
  const bin = unzipOne(zip, 'xray');
  const tmp = BIN + '.tmp';
  fs.writeFileSync(tmp, bin, { mode: 0o755 });
  fs.renameSync(tmp, BIN);
  log('Installed into', BASE);
}

async function prepareConfig() {
  if (!fs.existsSync(SRC_CONF)) throw new Error('Config not found: ' + SRC_CONF);
  const cfg = JSON.parse(fs.readFileSync(SRC_CONF, 'utf8'));
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  // The public entry point (tag "main") listens on the port the host gave this server.
  const main = (cfg.inbounds || []).find((i) => i.tag === 'main');
  if (main) {
    const p = Number(process.env.XRAY_PORT || process.env.SERVER_PORT);
    if (!p) throw new Error('No public port: set XRAY_PORT (or SERVER_PORT) to the port your host gave this server.');
    main.port = p;
    log('Public entry (main) on 0.0.0.0:' + p);
  }

  if (!isRoot && Array.isArray(cfg.inbounds)) {
    const skipped = cfg.inbounds.filter((i) => i !== main && Number(i.port) < 1024).map((i) => i.port);
    if (skipped.length) log('Not root: skipping privileged ports', skipped.join(', '));
    cfg.inbounds = cfg.inbounds.filter((i) => i === main || !(Number(i.port) < 1024));
  }
  // A fresh UUID on every start: replaces the client id in all inbounds.
  // XRAY_UUID pins it; XRAY_UUID=random (default) generates a new one each start.
  const pinned = (process.env.XRAY_UUID || '').trim();
  const uuid = /^[0-9a-f-]{36}$/i.test(pinned) ? pinned : crypto.randomUUID();
  for (const ib of cfg.inbounds || []) {
    const clients = ib.settings && ib.settings.clients;
    if (Array.isArray(clients)) for (const c of clients) c.id = uuid;
  }

  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(RUN_CONF, JSON.stringify(cfg, null, 2));
  log('Internal 127.0.0.1 ports:', (cfg.inbounds || []).filter((i) => i !== main).map((i) => i.port).join(', '));
  await printLinks(cfg, main, uuid);
}

// Builds one vless:// link per path the main entry forwards (/ws<port>), prints them and saves them to a file.
// Domain mode: domain + TLS + port 443.  IP mode: public IP + no TLS + the public port of this server.
async function printLinks(cfg, main, uuid) {
  const paths = ((main && main.settings && main.settings.fallbacks) || []).map((f) => f.path).filter(Boolean);
  if (!paths.length) paths.push('/');

  let host, port, security;
  if (DOMAIN) {
    const useTls = (process.env.XRAY_LINK_TLS || 'tls') !== 'none';
    host = DOMAIN;
    port = process.env.XRAY_LINK_PORT || (useTls ? '443' : String((main && main.port) || 80));
    security = useTls ? `security=tls&sni=${DOMAIN}&fp=chrome` : 'security=none';
    log('Domain found (' + DOMAIN + '): building links from the domain.');
  } else {
    const ip = await getPublicIp();
    if (!ip) throw new Error('No domain and the public IP could not be detected. Set XRAY_DOMAIN or XRAY_IP.');
    host = net.isIPv6(ip) ? `[${ip}]` : ip;
    port = process.env.XRAY_LINK_PORT || String((main && main.port) || '');
    security = 'security=none';
    log('No domain: building links from the IP (' + ip + ').');
  }

  const links = paths.map((p) =>
    `vless://${uuid}@${host}:${port}?encryption=none&${security}&type=ws&host=${host}` +
    `&path=${encodeURIComponent(p)}#${p.replace(/^\//, '') || 'ws'}`);
  const out = path.join(BASE, 'links.txt');
  fs.writeFileSync(out, links.join('\n') + '\n');
  log('UUID for this run:', uuid);
  log('Links (also saved to ' + out + '):');
  for (const l of links) console.log(l);
}

let child = null;
let stopping = false;
let delay = 2000;
function runXray() {
  if (stopping) return;
  const t0 = Date.now();
  let handled = false;
  const again = (why) => {
    if (handled || stopping) return;
    handled = true;
    delay = Date.now() - t0 > 60000 ? 2000 : Math.min(delay * 2, 60000);
    console.error(`[xray-launcher] xray stopped (${why}); restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(runXray, delay);
  };
  child = spawn(BIN, ['run', '-c', RUN_CONF], { stdio: 'inherit', cwd: BASE });
  child.on('error', (e) => again(e.message));
  child.on('exit', (c, s) => again(c !== null ? 'exit ' + c : s));
  log('Xray started (pid ' + child.pid + ')');
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { stopping = true; if (child) child.kill(sig); });
}

(async () => {
  try {
    await ensureBinary();
    await prepareConfig();
    runXray();
  } catch (e) {
    die(e.message);
  }
})();
