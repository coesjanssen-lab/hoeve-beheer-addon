'use strict';
// Hoeve Beheer – lokale server voor de beheer-app (Home Assistant add-on).
// Geen externe packages: alleen Node built-ins.
//
// De app-code is dezelfde als de Netlify-versie. Wat die tegen Google Drive deed,
// beantwoordt deze server nu zelf (een klein deel van de Drive v3-API), zodat alle
// data op de Pi staat. Daarnaast: AI-proxy (sleutel blijft op de server), schoonmaakrooster
// direct naar Home Assistant, en back-up/terugzetten.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8099);
const DATA = process.env.DATA_DIR || '/data';
const WWW = process.env.WWW_DIR || path.join(__dirname, 'www');
const SUPERVISOR = process.env.SUPERVISOR_URL || 'http://supervisor/core';
const ANTHROPIC_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const ONLY_INGRESS = process.env.ONLY_INGRESS !== '0';
const INGRESS_IP = '172.30.32.2';
const MAX_BODY = 200 * 1024 * 1024;

const DRIVE = path.join(DATA, 'drive');
const BLOBS = path.join(DRIVE, 'blobs');
const INDEX = path.join(DRIVE, 'index.json');

// ── opslag ────────────────────────────────────────────────────────────────
let index = { files: {} };
function loadIndex() {
  fs.mkdirSync(BLOBS, { recursive: true });
  try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); if (!index.files) index.files = {}; }
  catch (e) { index = { files: {} }; }
}
let writing = Promise.resolve();
function saveIndex() {
  writing = writing.then(async () => {
    const tmp = INDEX + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(index));
    await fsp.rename(tmp, INDEX);
  }).catch(e => console.error('Index opslaan mislukt:', e));
  return writing;
}
function options() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'options.json'), 'utf8')); } catch (e) { return {}; }
}
const newId = () => crypto.randomBytes(12).toString('hex');
const now = () => new Date().toISOString();

function view(f) {
  const link = 'drive/v3/files/' + f.id + '?alt=media';
  const o = { ...f, webViewLink: link };
  if ((f.mimeType || '').startsWith('image/')) o.thumbnailLink = link;
  return o;
}

// ── Drive-zoekopdracht (q) ────────────────────────────────────────────────
const unq = s => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
function parseQ(q) {
  const tests = [];
  const re = /name\s*=\s*'((?:[^'\\]|\\.)*)'|'((?:[^'\\]|\\.)*)'\s+in\s+parents|mimeType\s*=\s*'((?:[^'\\]|\\.)*)'|mimeType\s+contains\s+'((?:[^'\\]|\\.)*)'|trashed\s*=\s*(true|false)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    if (m[1] !== undefined) { const v = unq(m[1]); tests.push(f => f.name === v); }
    else if (m[2] !== undefined) { const v = unq(m[2]); tests.push(f => (f.parents || []).includes(v)); }
    else if (m[3] !== undefined) { const v = unq(m[3]); tests.push(f => f.mimeType === v); }
    else if (m[4] !== undefined) { const v = unq(m[4]); tests.push(f => (f.mimeType || '').includes(v)); }
    else if (m[5] !== undefined) { const v = m[5] === 'true'; tests.push(f => !!f.trashed === v); }
  }
  if (!/trashed/.test(q || '')) tests.push(f => !f.trashed);
  return f => tests.every(t => t(f));
}

// ── multipart (FormData: metadata + bestand) ──────────────────────────────
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Geen multipart-boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    let part = buf.slice(start + 2, next - 2); // \r\n na boundary, \r\n voor volgende
    const sep = part.indexOf('\r\n\r\n');
    const head = part.slice(0, sep).toString();
    const body = part.slice(sep + 4);
    const name = (/name="([^"]*)"/i.exec(head) || [])[1] || '';
    const type = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '';
    parts.push({ name, type: type.trim(), body });
    pos = next;
  }
  return parts;
}

// ── helpers ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { rej(new Error('Bestand te groot')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}
function send(res, status, obj, headers) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(headers || {}) });
  res.end(body);
}
const err = (res, status, message) => send(res, status, { error: { code: status, message } });

async function haPost(apiPath, body) {
  const token = process.env.SUPERVISOR_TOKEN;
  const r = await fetch(SUPERVISOR + apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('Home Assistant antwoordde ' + r.status + ': ' + (await r.text()).slice(0, 200));
}

// ── routes ────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+/g, '/');
  const user = req.headers['x-remote-user-display-name'] || req.headers['x-remote-user-name'] || '';

  // App
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = await fsp.readFile(path.join(WWW, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, files: Object.keys(index.files).length });

  // Drive v3-subset
  if (p === '/drive/v3/about') return send(res, 200, { user: { emailAddress: 'hoeve-server', displayName: user || 'Hoeve-server' } });

  if (p === '/drive/v3/files' && req.method === 'GET') {
    const test = parseQ(url.searchParams.get('q'));
    const files = Object.values(index.files).filter(test)
      .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || '')).map(view);
    return send(res, 200, { files });
  }
  if (p === '/drive/v3/files' && req.method === 'POST') {
    const meta = JSON.parse((await readBody(req)).toString() || '{}');
    const f = { id: newId(), name: meta.name || 'naamloos', mimeType: meta.mimeType || 'application/octet-stream', parents: meta.parents || [], description: meta.description || '', createdTime: now(), modifiedTime: now(), size: 0 };
    index.files[f.id] = f;
    if (f.mimeType !== 'application/vnd.google-apps.folder') await fsp.writeFile(path.join(BLOBS, f.id), Buffer.alloc(0));
    await saveIndex();
    return send(res, 200, view(f));
  }
  if (p === '/upload/drive/v3/files' && req.method === 'POST') {
    const parts = parseMultipart(await readBody(req), req.headers['content-type']);
    const metaPart = parts.find(x => x.name === 'metadata') || parts[0];
    const filePart = parts.find(x => x !== metaPart);
    if (!filePart) return err(res, 400, 'Geen bestand ontvangen');
    const meta = JSON.parse(metaPart.body.toString() || '{}');
    const f = { id: newId(), name: meta.name || 'bestand', mimeType: meta.mimeType || filePart.type || 'application/octet-stream', parents: meta.parents || [], description: meta.description || '', createdTime: now(), modifiedTime: now(), size: filePart.body.length };
    await fsp.writeFile(path.join(BLOBS, f.id), filePart.body);
    index.files[f.id] = f; await saveIndex();
    return send(res, 200, view(f));
  }
  let m = /^\/upload\/drive\/v3\/files\/([a-zA-Z0-9_-]+)$/.exec(p);
  if (m && req.method === 'PATCH') {
    const f = index.files[m[1]]; if (!f) return err(res, 404, 'Bestand niet gevonden');
    const body = await readBody(req);
    await fsp.writeFile(path.join(BLOBS, f.id), body);
    f.size = body.length; f.modifiedTime = now(); await saveIndex();
    return send(res, 200, view(f));
  }
  m = /^\/drive\/v3\/files\/([a-zA-Z0-9_-]+)$/.exec(p);
  if (m) {
    const f = index.files[m[1]];
    if (!f) return err(res, 404, 'Bestand niet gevonden');
    if (req.method === 'GET' && url.searchParams.get('alt') === 'media') {
      const fp = path.join(BLOBS, f.id);
      let st; try { st = await fsp.stat(fp); } catch (e) { return err(res, 404, 'Inhoud ontbreekt'); }
      res.writeHead(200, { 'Content-Type': f.mimeType || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(f.name) });
      return fs.createReadStream(fp).pipe(res);
    }
    if (req.method === 'GET') return send(res, 200, view(f));
    if (req.method === 'PATCH') {
      const meta = JSON.parse((await readBody(req)).toString() || '{}');
      for (const k of ['name', 'description', 'parents', 'trashed']) if (meta[k] !== undefined) f[k] = meta[k];
      f.modifiedTime = now(); await saveIndex();
      return send(res, 200, view(f));
    }
    if (req.method === 'DELETE') {
      delete index.files[f.id]; await saveIndex();
      await fsp.rm(path.join(BLOBS, f.id), { force: true });
      res.writeHead(204); return res.end();
    }
  }

  // AI: de sleutel staat in de add-on-instellingen, niet in de browser
  if (p === '/api/ai/messages' && req.method === 'POST') {
    const key = (options().anthropic_api_key || process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key) return err(res, 400, 'Geen Anthropic API-sleutel ingesteld in de add-on (Instellingen → Apps → Hoeve Beheer → Configuratie).');
    const r = await fetch(ANTHROPIC_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: await readBody(req) });
    return send(res, r.status, await r.text());
  }

  // Schoonmaakrooster direct naar Home Assistant (event, geen webhook nodig)
  if (p === '/api/ha/rooster' && req.method === 'POST') {
    const payload = JSON.parse((await readBody(req)).toString() || '{}');
    await haPost('/api/events/hoeve_beheer_rooster', { rooster: JSON.stringify(payload), door: user });
    return send(res, 200, { ok: true });
  }

  // Logboek: regel toevoegen (voor Claude en automatiseringen) of de regels lezen.
  // De regel komt in app-data.json; de app pakt hem bij het volgende opslaan/synchroniseren op.
  if (p === '/api/logboek' && (req.method === 'POST' || req.method === 'GET')) {
    const f = Object.values(index.files).find(x => x.name === 'app-data.json' && !x.trashed);
    if (!f) return err(res, 404, 'app-data.json niet gevonden; open eerst de app');
    const fp = path.join(BLOBS, f.id);
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return err(res, 500, 'app-data.json is onleesbaar'); }
    if (!data || typeof data !== 'object') return err(res, 500, 'app-data.json heeft een onverwacht formaat');
    if (!Array.isArray(data.logboek)) data.logboek = [];
    if (req.method === 'GET') return send(res, 200, { logboek: data.logboek });
    const b = JSON.parse((await readBody(req)).toString() || '{}');
    const werk = String(b.werk || '').trim();
    if (!werk) return err(res, 400, 'Veld "werk" ontbreekt');
    const entry = {
      id: Date.now(),
      datum: /^\d{4}-\d{2}-\d{2}$/.test(b.datum || '') ? b.datum : now().slice(0, 10),
      werk,
      uitv: String(b.uitv || 'Diederik'),
      kosten: String(b.kosten || ''),
      note: String(b.note || ''),
      bron: 'api'
    };
    const dup = data.logboek.find(l => l.werk === entry.werk && l.datum === entry.datum && l.note === entry.note);
    if (dup) return send(res, 200, { ok: true, duplicate: true, id: dup.id });
    while (data.logboek.some(l => l.id === entry.id)) entry.id++;
    data.logboek.unshift(entry);
    data.updated = now();
    const body = Buffer.from(JSON.stringify(data, null, 2));
    fs.writeFileSync(fp + '.tmp', body);
    fs.renameSync(fp + '.tmp', fp);
    f.size = body.length; f.modifiedTime = now();
    await saveIndex();
    return send(res, 200, { ok: true, id: entry.id });
  }

  // Back-up: alle data (zonder add-on-instellingen) als .tar.gz
  if (p === '/api/backup' && req.method === 'GET') {
    await writing;
    const stamp = now().slice(0, 16).replace(/[:T]/g, '-');
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="hoeve-beheer-backup-${stamp}.tar.gz"`, 'Cache-Control': 'no-store' });
    const tar = spawn('tar', ['-czf', '-', '-C', DATA, 'drive']);
    tar.stdout.pipe(res);
    tar.stderr.on('data', d => console.error('tar:', d.toString()));
    return;
  }
  // Terugzetten: huidige data blijft bewaard als drive.vorige
  if (p === '/api/restore' && req.method === 'POST') {
    const body = await readBody(req);
    const tmp = path.join(DATA, 'restore-tmp');
    await fsp.rm(tmp, { recursive: true, force: true }); await fsp.mkdir(tmp, { recursive: true });
    await fsp.writeFile(path.join(tmp, 'b.tar.gz'), body);
    const ok = await new Promise(done => { const t = spawn('tar', ['-xzf', 'b.tar.gz'], { cwd: tmp }); t.on('close', c => done(c === 0)); t.on('error', () => done(false)); });
    const ni = path.join(tmp, 'drive', 'index.json');
    let parsed = null; if (ok) { try { parsed = JSON.parse(await fsp.readFile(ni, 'utf8')); } catch (e) {} }
    if (!parsed) { await fsp.rm(tmp, { recursive: true, force: true }); return err(res, 400, 'Geen geldig back-upbestand van Hoeve Beheer'); }
    await writing;
    const prev = path.join(DATA, 'drive.vorige');
    await fsp.rm(prev, { recursive: true, force: true });
    if (fs.existsSync(DRIVE)) await fsp.rename(DRIVE, prev);
    await fsp.rename(path.join(tmp, 'drive'), DRIVE);
    await fsp.rm(tmp, { recursive: true, force: true });
    loadIndex();
    return send(res, 200, { ok: true, files: Object.keys(parsed.files || {}).length });
  }

  return err(res, 404, 'Niet gevonden: ' + p);
}

loadIndex();
http.createServer((req, res) => {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (ONLY_INGRESS && ip !== INGRESS_IP) { res.writeHead(403); return res.end('Alleen via Home Assistant'); }
  handle(req, res).catch(e => { console.error(req.method, req.url, e); if (!res.headersSent) err(res, 500, e.message); else res.end(); });
}).listen(PORT, () => console.log('Hoeve Beheer luistert op poort', PORT, '– data in', DATA));
