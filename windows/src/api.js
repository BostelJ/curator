// The HTTP surface: the web views and the MCP bridge both go through here.
// A port of Sources/Curator/API.swift and HTTPServer.swift, on Node's http server, bound to loopback.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { StoreError } = require('./store');

const MAX_BODY = 24 * 1024 * 1024; // room for a marked-up picture

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', glb: 'model/gltf-binary', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', json: 'application/json',
};
const contentType = (file) => TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

/** "bytes=a-b", "bytes=a-" or "bytes=-n" as an inclusive range within the file. Only one range. */
function byteRange(header, size) {
  if (!header.startsWith('bytes=') || size <= 0) return null;
  const spec = header.slice(6).split(',')[0] ?? '';
  const ends = spec.split('-');
  if (ends.length !== 2) return null;
  const [a, b] = ends.map((s) => s.trim());
  if (a === '') {
    const n = parseInt(b, 10);
    if (!(n > 0)) return null;
    return [Math.max(0, size - n), size - 1];
  }
  if (!/^\d+$/.test(a)) return null;
  const start = parseInt(a, 10);
  if (start >= size) return null;
  const end = b === '' ? size - 1 : /^\d+$/.test(b) ? Math.min(parseInt(b, 10), size - 1) : -1;
  return end >= start ? [start, end] : null;
}

/** A file under root, or null. Refuses anything that could climb out, Windows tricks included. */
function locate(root, relative) {
  const parts = relative.split('/');
  if (!parts.length || parts.some((p) => p === '' || p === '.' || p === '..' || /[\\:*?"<>|\0]/.test(p))) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, ...parts);
  if (!file.startsWith(base + path.sep)) return null;
  return file;
}

class API {
  constructor({ store, token, webRoot, windowsLook }) {
    this.store = store;
    this.token = token;
    this.webRoot = webRoot;
    this.windowsLook = windowsLook;
    this.port = 0;
    this.debug = null; // set only with CURATOR_DEBUG=1
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.receive(req, res));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  receive(req, res) {
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        refused = true;
        this.write(res, json({ error: 'request too large' }, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (refused) return;
      let response;
      try {
        response = await this.handle(req, Buffer.concat(chunks));
      } catch (error) {
        response = json({ error: error instanceof StoreError ? error.message : String(error.message || error) }, 400);
      }
      this.write(res, response);
    });
  }

  write(res, { status = 200, type = 'application/json', body = Buffer.alloc(0), headers = {} }) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': type, ...headers, 'Content-Length': body.length, 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(body);
  }

  async handle(req, raw) {
    // Refuse anything addressed to another hostname, so a web page can't reach us by DNS rebinding.
    if (req.headers.host !== `127.0.0.1:${this.port}`) return json({ error: 'forbidden' }, 403);

    const [target, search = ''] = req.url.split('?', 2);
    const query = {};
    for (const pair of search.split('&')) {
      if (!pair) continue;
      const [k, v = ''] = pair.split('=', 2);
      try { query[k] = decodeURIComponent(v); } catch { query[k] = v; }
    }
    let pathname;
    try { pathname = decodeURIComponent(target); } catch { pathname = target; }

    if (pathname.startsWith('/ui/')) return this.serveUI(pathname.slice(4));
    if (query.token !== this.token && req.headers['x-curator-token'] !== this.token) {
      return json({ error: 'unauthorized' }, 401);
    }
    if (pathname.startsWith('/media/')) {
      const file = locate(this.store.mediaDir, pathname.slice(7));
      return file ? serveFile(file, req.headers.range) : json({ error: 'not found' }, 404);
    }

    const body = () => { try { return JSON.parse(raw.toString('utf8') || '{}') ?? {}; } catch { return {}; } };
    const str = (v) => (typeof v === 'string' ? v : '');
    const opt = (v) => (typeof v === 'string' ? v : undefined);
    const ok = { ok: true };
    const store = this.store;

    switch (`${req.method} ${pathname}`) {
      case 'GET /api/health': return json(ok);
      case 'POST /api/debug': return this.debug ? json(await this.debug(body())) : json({ error: 'not found' }, 404);
      case 'GET /api/state': return json(this.state());
      case 'GET /api/items': return json({ items: this.items(query.ids ?? '') });
      case 'GET /api/board': return json(this.board(query.project ?? ''));
      case 'POST /api/send': return json(this.send(body()));
      case 'POST /api/answer': {
        const b = body();
        store.answer({ id: str(b.id), action: str(b.action), frameId: opt(b.frameId), note: opt(b.note),
          matches: matchesOf(b.matches), markups: Array.isArray(b.markups) ? b.markups : undefined,
          onScreen: Array.isArray(b.onScreen) ? b.onScreen.filter((f) => typeof f === 'string') : undefined });
        return json(ok);
      }
      case 'POST /api/markup': {
        const b = body();
        const text = str(b.png).replace('data:image/png;base64,', '');
        if (!/^[A-Za-z0-9+/=\s]*$/.test(text)) return json({ error: 'png must be base64' }, 400);
        const file = store.saveMarkup({ id: str(b.id), frameId: str(b.frameId), png: Buffer.from(text, 'base64'),
          time: typeof b.time === 'number' ? b.time : undefined });
        return json({ file });
      }
      case 'POST /api/withdraw': store.withdraw(str(body().id)); return json(ok);
      case 'POST /api/rule': {
        const b = body();
        return json(store.proposeRule(str(b.project), str(b.text), opt(b.why)));
      }
      case 'POST /api/rule/answer': {
        const b = body();
        store.answerRule(str(b.id), b.accept === true);
        return json(ok);
      }
      case 'POST /api/strip/retire': {
        const b = body();
        store.retireStrips(Array.isArray(b.strips) ? b.strips.filter((s) => typeof s === 'string') : [], str(b.reason));
        return json(ok);
      }
      case 'POST /api/strip/restore': store.restoreStrip(str(body().id)); return json(ok);
      case 'POST /api/strip/remove': store.removeStrip(str(body().id)); return json(ok);
      default: return json({ error: 'not found' }, 404);
    }
  }

  state() {
    const s = this.store;
    const byCreated = (a, b) => a.createdAt - b.createdAt;
    const byKept = (a, b) => b.keptAt - a.keptAt;
    return {
      quick: [...s.pendingQuick].sort(byCreated),
      refine: [...s.pendingRefine].sort(byCreated),
      proposedRules: s.proposedRules,
      rules: s.data.rules.filter((r) => r.status === 'accepted'),
      strips: s.data.strips.filter((x) => !x.removed).sort(byKept),
      retired: s.data.strips.filter((x) => x.removed).sort(byKept),
      projects: s.projects,
      paused: s.data.paused,
    };
  }

  /** What an agent gets back about a card, with real paths it can open. */
  describe(item) {
    const s = this.store;
    const out = { id: item.id, stage: item.stage, status: item.status, title: item.title,
      project: item.project, thread: item.thread, round: item.round };
    const answer = item.answer;
    if (answer) {
      const a = { action: answer.action };
      if (answer.note) a.note = answer.note;
      if (answer.markups?.length) a.markups = answer.markups.map((m) => s.pathOf(m));
      const frame = item.frames.find((f) => f.id === answer.frameId);
      if (frame) a.chosen = { label: frame.label ?? '', path: s.pathOf(frame.file) };
      const played = answer.matches ?? [];
      if (played.length) {
        const name = (id) => {
          const index = item.frames.findIndex((f) => f.id === id);
          return index < 0 ? id : item.frames[index].label ?? `Option ${index + 1}`;
        };
        a.matches = played.map((m) => ({ round: m.round, winner: name(m.winner), loser: name(m.winner === m.a ? m.b : m.a) }));
        const last = played[played.length - 1];
        const loser = item.frames.find((f) => f.id === (last.winner === last.a ? last.b : last.a));
        if (loser) a.runnerUp = { label: loser.label ?? '', path: s.pathOf(loser.file) };
      }
      if (answer.onScreen?.length) {
        // The note was written while these two were up, so it may be about them.
        a.onScreen = answer.onScreen.map((id) => item.frames.find((f) => f.id === id)).filter(Boolean)
          .map((f) => ({ label: f.label ?? '', path: s.pathOf(f.file) }));
      }
      if (answer.action === 'keep' || (answer.action === 'pick' && item.keepOnPick)) a.onBoard = true;
      out.answer = a;
    }
    return out;
  }

  items(ids) {
    return ids.split(',').filter(Boolean)
      .map((id) => this.store.data.items.find((i) => i.id === id))
      .filter(Boolean).map((i) => this.describe(i));
  }

  board(project) {
    const s = this.store;
    const same = (name) => String(name).toLowerCase() === project.toLowerCase();
    const strips = s.data.strips.filter((x) => !x.removed && same(x.project)).sort((a, b) => b.keptAt - a.keptAt);
    return {
      project,
      acceptedRules: s.data.rules.filter((r) => r.status === 'accepted' && same(r.project)).map((r) => r.text),
      declinedRules: s.data.rules.filter((r) => r.status === 'declined' && same(r.project)).map((r) => r.text),
      recentTournaments: this.recentTournaments(same),
      retired: s.data.strips.filter((x) => x.removed && same(x.project))
        .map((x) => ({ stripId: x.id, title: x.title, why: x.retiredReason ?? 'Taken down' })),
      kept: strips.map((strip) => ({
        stripId: strip.id, title: strip.title, notes: strip.notes,
        keptFiles: strip.frames.filter((f) => f.final).map((f) => s.pathOf(f.file)),
        earlierPasses: strip.frames.filter((f) => !f.final).map((f) => s.pathOf(f.file)),
      })),
    };
  }

  /** Who beat whom lately: a direct read of preference, even for things never kept. */
  recentTournaments(same) {
    const played = this.store.data.items.filter((i) => same(i.project) && i.stage === 'quick_pick'
      && (i.answer?.action === 'pick' || i.answer?.action === 'note'));
    return played.slice(-12).map((item) => {
      const label = (id) => {
        const index = item.frames.findIndex((f) => f.id === id);
        return index < 0 ? '' : item.frames[index].label ?? `Option ${index + 1}`;
      };
      const matches = item.answer?.matches ?? [];
      const last = matches[matches.length - 1];
      const out = { title: item.title };
      if (item.answer?.action === 'note') {
        out.answeredWithNote = true; // they wrote a note instead of finishing the bracket
        if (item.answer.onScreen) out.onScreen = item.answer.onScreen.map(label);
      } else {
        out.winner = label(item.answer?.frameId);
        if (last) out.runnerUp = label(last.winner === last.a ? last.b : last.a);
      }
      if (item.answer?.note) out.note = item.answer.note;
      return out;
    });
  }

  send(body) {
    if (!Array.isArray(body.files)) throw new StoreError('files is required');
    const frames = body.files.map((f) => ({ path: typeof f?.path === 'string' ? f.path : '', label: typeof f?.label === 'string' ? f.label : undefined }));
    const item = this.store.send({
      project: typeof body.project === 'string' ? body.project : '',
      stage: typeof body.stage === 'string' ? body.stage : '',
      title: typeof body.title === 'string' ? body.title : '',
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      frames,
      revises: typeof body.revises === 'string' ? body.revises : undefined,
      keepOnPick: body.keepOnPick === true,
      replaces: Array.isArray(body.replaces) ? body.replaces.filter((r) => typeof r === 'string') : [],
    });
    return { id: item.id, thread: item.thread, round: item.round, status: item.status };
  }

  serveUI(relative) {
    const file = locate(this.webRoot, relative);
    if (!file) return json({ error: 'not found' }, 404);
    const response = serveFile(file, undefined);
    if (response.status === 200 && this.windowsLook) response.body = windowsLook(file, response.body);
    return response;
  }
}

/** Key names, fonts and words for Windows, swapped in as the shared pages are served. */
function windowsLook(file, body) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.css' && path.basename(file) === 'photo.css') {
    // Marker Felt and the Mac fonts aren't on Windows. Ink Free ships with Windows 10 and 11.
    return Buffer.concat([body, Buffer.from(`
:root {
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
  --hand: "Marker Felt", "Ink Free", "Segoe Print", cursive;
  --serif: "New York", "Iowan Old Style", Georgia, serif;
}
html, body, button, textarea, input { font-family: -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
/* The gallery has a normal Windows title bar, so no room is needed for the Mac's window buttons. */
body .top, body .l-top { padding-left: 0; }
`)]);
  }
  if (ext !== '.html' && ext !== '.js') return body;
  return Buffer.from(body.toString('utf8')
    .replaceAll('⌃⌥⌫', 'Ctrl+Alt+Backspace')
    .replaceAll('⌃⌥', 'Ctrl+Alt+')
    .replaceAll('<kbd>return</kbd>', '<kbd>enter</kbd>')
    .replaceAll('<kbd>⌫</kbd>', '<kbd>backspace</kbd>'));
}

function matchesOf(raw) {
  if (!Array.isArray(raw)) return undefined;
  const ok = raw.every((m) => m && typeof m.round === 'number' && ['a', 'b', 'winner'].every((k) => typeof m[k] === 'string'));
  return ok ? raw.map((m) => ({ round: m.round, a: m.a, b: m.b, winner: m.winner })) : undefined;
}

function json(value, status = 200) {
  return { status, type: 'application/json', body: Buffer.from(JSON.stringify(value)) };
}

/** Serves a file, or the byte range asked for. Video only plays well when it can be fetched in ranges. */
function serveFile(file, range) {
  let stat;
  try { stat = fs.statSync(file); } catch { return json({ error: 'not found' }, 404); }
  if (!stat.isFile()) return json({ error: 'not found' }, 404);
  const type = contentType(file);
  const size = stat.size;
  if (range == null) return { status: 200, type, body: fs.readFileSync(file), headers: { 'Accept-Ranges': 'bytes' } };
  const span = byteRange(range, size);
  if (!span) return { status: 416, type, headers: { 'Content-Range': `bytes */${size}` } };
  const [start, end] = span;
  const body = Buffer.alloc(end - start + 1);
  const fd = fs.openSync(file, 'r');
  let read = 0;
  try { read = fs.readSync(fd, body, 0, body.length, start); } finally { fs.closeSync(fd); }
  return { status: 206, type, body: body.subarray(0, read),
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${start + read - 1}/${size}` } };
}

module.exports = { API, byteRange, locate };
