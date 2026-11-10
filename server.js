// DropShare v2 — LAN file + text drop. Zero dependencies. Run: node server.js
// Files are saved to SAVE_DIR (default: ~/DropShare) and sorted into folders by type.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const DIR = path.resolve(process.env.SAVE_DIR || path.join(os.homedir(), 'DropShare'));
const TMP = path.join(DIR, '.incoming');
const CLIPS = path.join(DIR, 'clips.json');
const PAGE = path.join(__dirname, 'index.html');

// Files the browser/phone needs for the installable app (Android "Share to DropShare")
const ASSETS = {
  '/manifest.webmanifest': ['application/manifest+json', 'manifest.webmanifest'],
  '/sw.js': ['text/javascript', 'sw.js'],
  '/icon-192.png': ['image/png', 'icon-192.png'],
  '/icon-512.png': ['image/png', 'icon-512.png'],
};
let certs = null;       // { key, cert, ca } when HTTPS is available
let httpsPort = '';     // injected into the page so it can show the phone setup hint
const lanIPs = () => Object.values(os.networkInterfaces()).flatMap(l => l || [])
  .filter(i => (i.family === 'IPv4' || i.family === 4) && !i.internal).map(i => i.address);

const TYPES = {
  Images: 'jpg jpeg png gif webp heic heif bmp tif tiff avif svg ico dng raw',
  Videos: 'mp4 mov mkv avi webm 3gp m4v wmv flv mpg mpeg',
  Audio: 'mp3 wav m4a aac ogg opus flac amr wma mid',
  Documents: 'pdf doc docx xls xlsx ppt pptx odt ods odp txt rtf csv md epub json xml html htm',
  Archives: 'zip rar 7z tar gz bz2 xz iso',
  Apps: 'apk exe msi dmg deb appimage',
};
const EXT = {};
for (const [cat, list] of Object.entries(TYPES)) for (const e of list.split(' ')) EXT[e] = cat;
const CATS = [...Object.keys(TYPES), 'Other'];
const catOf = name => EXT[path.extname(name).slice(1).toLowerCase()] || 'Other';

// Types the browser may play/preview inline. Everything else is download-only (no html/svg).
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
};

fs.mkdirSync(TMP, { recursive: true });
for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f), { force: true });

let clips = [];
try { clips = JSON.parse(fs.readFileSync(CLIPS, 'utf8')); } catch {}
const saveClips = () => {
  try { fs.writeFileSync(CLIPS + '.tmp', JSON.stringify(clips)); fs.renameSync(CLIPS + '.tmp', CLIPS); } catch {}
};

const sse = new Set();
const notify = () => sse.forEach(r => r.write('data: change\n\n'));

const cleanName = n =>
  path.basename(String(n || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 200) || 'file';

function uniqueName(folder, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let n = name, i = 1;
  while (fs.existsSync(path.join(folder, n))) n = `${base} (${i++})${ext}`;
  return n;
}

function listFiles() {
  const now = Date.now(), out = [];
  for (const cat of CATS) {
    let names = [];
    try { names = fs.readdirSync(path.join(DIR, cat)); } catch { continue; }
    for (const name of names) {
      try {
        const s = fs.statSync(path.join(DIR, cat, name));
        if (s.isFile()) out.push({ cat, name, size: s.size, age: now - s.mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => a.age - b.age);
}

const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const readBody = (req, limit = 1e6) => new Promise((ok, no) => {
  let n = 0; const parts = [];
  req.on('data', d => { n += d.length; if (n > limit) { no(new Error('too big')); req.destroy(); } else parts.push(d); });
  req.on('end', () => ok(Buffer.concat(parts).toString()));
  req.on('error', no);
});

function sendFile(req, res, file, name, inline) {
  fs.stat(file, (err, s) => {
    if (err || !s.isFile()) return json(res, 404, { error: 'not found' });
    const ext = path.extname(name).slice(1).toLowerCase();
    const type = inline && MIME[ext] ? MIME[ext] : 'application/octet-stream';
    let start = 0, end = s.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], s.size - 1); }
      else start = Math.max(0, s.size - +m[2]);
      if (start > end || start >= s.size) { res.writeHead(416, { 'Content-Range': `bytes */${s.size}` }); return res.end(); }
      code = 206;
    }
    const h = {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline && MIME[ext] ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
    if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${s.size}`;
    res.writeHead(code, h);
    if (s.size === 0) return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;

  if (req.method === 'GET' && route === '/') {
    fs.readFile(PAGE, 'utf8', (err, html) => {
      if (err) return json(res, 500, { error: 'page missing' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html.replace('%%HTTPS_PORT%%', String(httpsPort)));
    });
    return;
  }

  if (req.method === 'GET' && route === '/list') return json(res, 200, listFiles());

  if (req.method === 'GET' && route === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    sse.add(res);
    const beat = setInterval(() => res.write(': hb\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); sse.delete(res); });
    return;
  }

  // Upload: raw body streamed to disk (any size), then moved into its type folder.
  if (req.method === 'POST' && route === '/upload') {
    const name = cleanName(url.searchParams.get('name'));
    const tmp = path.join(TMP, crypto.randomBytes(8).toString('hex'));
    const out = fs.createWriteStream(tmp);
    let done = false;
    const fail = () => { if (!done) { done = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); } };
    req.on('aborted', fail);
    req.on('error', fail);
    out.on('error', () => { fail(); if (!res.headersSent) json(res, 500, { error: 'write failed' }); });
    out.on('finish', () => {
      if (done) return;
      done = true;
      try {
        const cat = catOf(name), folder = path.join(DIR, cat);
        fs.mkdirSync(folder, { recursive: true });
        const final = uniqueName(folder, name);
        fs.renameSync(tmp, path.join(folder, final));
        json(res, 200, { cat, name: final });
        notify();
      } catch { fs.rm(tmp, { force: true }, () => {}); json(res, 500, { error: 'save failed' }); }
    });
    return req.pipe(out);
  }

  // Files: /f/<Category>/<name>   (?inline=1 to preview/play)
  if (route.startsWith('/f/')) {
    let cat, name;
    try {
      const [c, n, extra] = route.slice(3).split('/').map(decodeURIComponent);
      if (extra !== undefined || !CATS.includes(c) || !n) throw 0;
      cat = c; name = cleanName(n);
    } catch { return json(res, 400, { error: 'bad path' }); }
    const file = path.join(DIR, cat, name);
    if (req.method === 'GET') return sendFile(req, res, file, name, url.searchParams.has('inline'));
    if (req.method === 'DELETE') return fs.rm(file, { force: true }, () => { json(res, 200, { ok: true }); notify(); });
  }

  // Shared text (copy/paste between devices)
  if (route === '/clips' && req.method === 'GET')
    return json(res, 200, clips.map(c => ({ id: c.id, text: c.text, age: Date.now() - c.t })));

  if (route === '/clips' && req.method === 'POST') {
    try {
      const text = String(JSON.parse(await readBody(req)).text || '').slice(0, 200000);
      if (!text.trim()) return json(res, 400, { error: 'empty' });
      clips.unshift({ id: crypto.randomBytes(4).toString('hex'), text, t: Date.now() });
      clips = clips.slice(0, 50);
      saveClips(); notify();
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: 'bad request' }); }
  }

  if (route.startsWith('/clips/') && req.method === 'DELETE') {
    const id = route.slice(7);
    clips = clips.filter(c => c.id !== id);
    saveClips(); notify();
    return json(res, 200, { ok: true });
  }

  // Android "Share to DropShare": the service worker normally handles this POST.
  // This is only a fallback if it has not activated yet.
  if (req.method === 'POST' && route === '/share') {
    req.resume();
    res.writeHead(303, { Location: '/' });
    return res.end();
  }

  const asset = ASSETS[route];
  if (req.method === 'GET' && asset) {
    res.writeHead(200, { 'Content-Type': asset[0], 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    return fs.createReadStream(path.join(__dirname, asset[1])).on('error', () => res.destroy()).pipe(res);
  }

  // The phone installs this once so it trusts the HTTPS address
  if (req.method === 'GET' && route === '/DropShare-CA.crt' && certs) {
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="DropShare-CA.crt"' });
    return res.end(certs.ca);
  }

  json(res, 404, { error: 'not found' });
};

// HTTPS (needed for the Android share button). Plain HTTP keeps working too.
try {
  certs = require('./cert').ensureCerts(path.join(__dirname, 'certs'), [...lanIPs(), '127.0.0.1', 'localhost', os.hostname()]);
} catch (e) { console.log('HTTPS disabled:', e.message); }

const plain = http.createServer(handler);
const secure = certs && https.createServer({ key: certs.key, cert: certs.cert }, handler);
for (const s of [plain, secure]) if (s) { s.requestTimeout = 0; s.timeout = 0; } // no cap on upload time => no size limit

plain.listen(PORT, '0.0.0.0', () => {
  console.log('\nDropShare running. Open on any device on your WiFi:\n');
  for (const ip of lanIPs()) console.log(`  http://${ip}:${PORT}`);
  console.log(`\nSaving files to: ${DIR}\n(sorted into: ${CATS.join(', ')})\n`);
});

if (secure) {
  secure.on('error', e => { console.log('HTTPS disabled:', e.message); httpsPort = ''; });
  secure.listen(HTTPS_PORT, '0.0.0.0', () => {
    httpsPort = HTTPS_PORT;
    console.log('Phone "Share to DropShare" (HTTPS):');
    for (const ip of lanIPs()) console.log(`  https://${ip}:${HTTPS_PORT}`);
    console.log(`  Install the certificate once: http://<this-pc-ip>:${PORT}/DropShare-CA.crt\n`);
  });
}
