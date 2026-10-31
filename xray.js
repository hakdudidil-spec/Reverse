// xray.js — downloads Xray-core and runs it with ./xray-config.json (no root, no unzip needed).
// No dependencies, Node 18+.
//
// Usage: put this file and xray-config.json next to index.js, then add this as the FIRST line of index.js:
//   require('./xray.js');
// (or run it alone with: node xray.js)
//
// If the process is not root, inbounds on ports below 1024 are skipped automatically
// (binding them would make Xray refuse to start at all).
// Optional env: XRAY_VERSION (e.g. v26.10.29), XRAY_UPDATE=1 (re-download), XRAY_DIR, XRAY_CONFIG.

const fs = require('fs');
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

// The address in the printed links is detected at start-up (see detectAddress), nothing is hard-coded.
// Optional overrides: XRAY_DOMAIN, XRAY_LINK_PORT, XRAY_LINK_TLS (tls | none).
const HOST_RE = /[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.bot-hosting\.cloud/i;

function log(...a) { console.log('[xray-launcher]', ...a); }
function die(msg) { console.error('[xray-launcher] ERROR:', msg); }

function httpGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'xray-launcher', Accept: '*/*' }, timeout: 120000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), redirects - 1));
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

function prepareConfig() {
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
  const uuid = crypto.randomUUID();
  for (const ib of cfg.inbounds || []) {
    const clients = ib.settings && ib.settings.clients;
    if (Array.isArray(clients)) for (const c of clients) c.id = uuid;
  }

  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(RUN_CONF, JSON.stringify(cfg, null, 2));
  log('Internal 127.0.0.1 ports:', (cfg.inbounds || []).filter((i) => i !== main).map((i) => i.port).join(', '));
  return { main, uuid };
}

// Public IP of this container's host, asked from a few services (first valid answer wins).
async function publicIp() {
  for (const u of ['https://api.ipify.org', 'https://icanhazip.com', 'https://ifconfig.me/ip']) {
    try {
      const ip = (await httpGet(u)).toString().trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || (ip.includes(':') && /^[0-9a-f:]+$/i.test(ip))) return ip;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

// Works out the address clients should use, in this order:
//   1) XRAY_DOMAIN env  2) a *.bot-hosting.cloud name found in this container's environment
//   3) the container's public IP (plain WS on the public port, since an IP has no TLS certificate)
async function detectAddress(publicPort) {
  const forcedPort = process.env.XRAY_LINK_PORT;
  const forcedTls = process.env.XRAY_LINK_TLS;
  let host = (process.env.XRAY_DOMAIN || '').trim();
  let source = 'XRAY_DOMAIN';
  if (!host) {
    for (const [k, v] of Object.entries(process.env)) {
      const m = v && String(v).match(HOST_RE);
      if (m) { host = m[0]; source = 'env ' + k; break; }
    }
  }
  if (host) return { host, port: forcedPort || '443', tls: forcedTls !== 'none', source };
  const ip = await publicIp();
  if (ip) {
    return { host: ip.includes(':') ? `[${ip}]` : ip, port: forcedPort || String(publicPort), tls: forcedTls === 'tls', source: 'public IP' };
  }
  return null;
}

// Builds one vless:// link per path the main entry forwards (/ws<port>), prints them and saves them to a file.
async function printLinks(main, uuid) {
  const paths = ((main && main.settings && main.settings.fallbacks) || []).map((f) => f.path).filter(Boolean);
  if (!paths.length) paths.push('/');
  let addr = await detectAddress(main ? main.port : 443);
  if (!addr) {
    log('WARNING: could not detect this server\'s domain or IP. Set XRAY_DOMAIN, then restart. Links use a placeholder.');
    addr = { host: 'YOUR_HOST', port: String(main ? main.port : 443), tls: false, source: 'placeholder' };
  }
  const tls = addr.tls ? `security=tls&sni=${addr.host}&fp=chrome` : 'security=none';
  const links = paths.map((p) =>
    `vless://${uuid}@${addr.host}:${addr.port}?encryption=none&${tls}&type=ws&host=${addr.host}` +
    `&path=${encodeURIComponent(p)}#${p.replace(/^\//, '') || 'ws'}`);
  const out = path.join(BASE, 'links.txt');
  fs.writeFileSync(out, links.join('\n') + '\n');
  log('UUID for this run:', uuid);
  log(`Address: ${addr.host}:${addr.port} (${addr.tls ? 'TLS' : 'no TLS'}, from ${addr.source})`);
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
    const { main, uuid } = prepareConfig();
    runXray();
    await printLinks(main, uuid);
  } catch (e) {
    die(e.message);
  }
})();
