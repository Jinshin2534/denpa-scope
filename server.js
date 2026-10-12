// Swift ヘルパーの出力をブラウザへ Server-Sent Events で流す。依存なし。
//   node server.js          実機の Wi-Fi を読む (macOS)
//   node server.js --demo   作り物のデータで動かす (どの OS でも)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDemo } from './demo.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5730;
const forceDemo = process.argv.includes('--demo');

const clients = new Set();
let lastScan = null;
let mode = 'starting'; // 'live' | 'demo' | 'error'
let modeReason = '';

function broadcast(obj) {
  if (obj.type === 'scan') lastScan = obj;
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) res.write(msg);
}

function setMode(m, reason = '') {
  mode = m;
  modeReason = reason;
  broadcast({ type: 'mode', mode, reason });
}

function startDemo(reason) {
  setMode('demo', reason);
  createDemo(broadcast).start();
}

function ensureHelper() {
  const src = path.join(root, 'helper/wifi-probe.swift');
  const bin = path.join(root, 'bin/wifi-probe');
  const stale = !fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs;
  if (stale) {
    console.log('Swift ヘルパーをビルドしています…');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const r = spawnSync('swiftc', ['-O', src, '-o', bin], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('swiftc でのビルドに失敗しました');
  }
  return bin;
}

function startLive() {
  if (process.platform !== 'darwin') return startDemo('macOS 以外なので実測できません');
  let bin;
  try {
    bin = ensureHelper();
  } catch (e) {
    return startDemo(e.message);
  }
  const child = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  let gotData = false;
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === 'error') return startDemo(obj.message);
      if (!gotData) { gotData = true; setMode('live'); }
      broadcast(obj);
    }
  });
  child.on('exit', (code) => {
    if (mode === 'live' || mode === 'starting') setMode('error', `ヘルパーが終了しました (code ${code})`);
  });
  process.on('exit', () => child.kill());
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(); process.exit(0); });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'mode', mode, reason: modeReason })}\n\n`);
    if (lastScan) res.write(`data: ${JSON.stringify(lastScan)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(root, 'web', rel);
  if (!file.startsWith(path.join(root, 'web') + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`電波スコープ: http://localhost:${PORT}`);
  if (forceDemo) startDemo('--demo で起動しました');
  else startLive();
});
