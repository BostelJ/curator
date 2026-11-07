// The stdio MCP bridge Claude Code talks to. A port of Sources/Curator/MCP.swift.
// It holds no state: everything goes to the running app over loopback.
// Runs as plain Node: Claude Code starts `Curator.exe <this file>` with ELECTRON_RUN_AS_NODE=1.
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { homeDirectory } = require('./home');

// Word for word what the Mac app says. scripts/sync-tools.sh refreshes it from MCP.swift.
const tools = require('./tools.json');

const INSTRUCTIONS = "Curator is the user's taste layer. Read curator_board before a visual pass, use curator_quick_pick to choose a direction, then curator_refine for each real pass. Nothing is approved until it's kept.";

function write(object) {
  process.stdout.write(JSON.stringify(object) + '\n');
}

const reply = (id, result) => write({ jsonrpc: '2.0', id, result });

async function handle(message) {
  const { id, method } = message;
  if (id === undefined || id === null || typeof method !== 'string') return; // notifications
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'curator', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools });
    case 'tools/call': {
      const params = message.params ?? {};
      try {
        const output = await call(params.name ?? '', params.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(sortKeys(output), null, 2) }] });
      } catch (error) {
        return reply(id, { isError: true, content: [{ type: 'text', text: error.message || String(error) }] });
      }
    }
    default:
      return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

// Tools

async function call(name, args) {
  switch (name) {
    case 'curator_quick_pick':
      return post('/api/send', {
        stage: 'quick_pick', project: args.project ?? '', title: args.title ?? '', prompt: args.prompt ?? null,
        files: args.options ?? [], revises: args.revises ?? null, keepOnPick: args.keep_on_pick ?? false,
        replaces: args.replaces ?? [],
      });
    case 'curator_refine':
      return post('/api/send', {
        stage: 'refine', project: args.project ?? '', title: args.title ?? '', prompt: args.prompt ?? null,
        files: args.files ?? [], revises: args.revises ?? null, replaces: args.replaces ?? [],
      });
    case 'curator_wait': {
      const timeout = Math.min(typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 240, 280);
      return wait(Array.isArray(args.ids) ? args.ids : [], timeout);
    }
    case 'curator_board':
      return get('/api/board?project=' + encodeURIComponent(args.project ?? ''));
    case 'curator_propose_rule':
      return post('/api/rule', { project: args.project ?? '', text: args.rule ?? '', why: args.why ?? null });
    case 'curator_retire_strips':
      return post('/api/strip/retire', { strips: args.strips ?? [], reason: args.reason ?? '' });
    case 'curator_withdraw':
      return post('/api/withdraw', { id: args.id ?? '' });
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wait(ids, timeout) {
  if (!ids.length) throw new Error('ids is required');
  const deadline = Date.now() + timeout * 1000;
  const joined = ids.map(encodeURIComponent).join(',');
  for (;;) {
    const result = await get(`/api/items?ids=${joined}`);
    const items = result.items ?? [];
    if (items.length < ids.length) throw new Error("some of those card ids don't exist");
    const settled = items.filter((i) => i.status !== 'pending');
    if (settled.length || Date.now() >= deadline) {
      return { answered: settled, stillPending: items.filter((i) => i.status === 'pending').map((i) => i.id) };
    }
    await sleep(1000);
  }
}

// Talking to the app

function readServerInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(homeDirectory(), 'server.json'), 'utf8'));
    if (typeof info.port === 'number' && typeof info.token === 'string') return info;
  } catch {}
  return null;
}

async function healthy(server) {
  try { await request(server, 'GET', '/api/health', null, 2000); return true; } catch { return false; }
}

/** Starts the app, without this process's ELECTRON_RUN_AS_NODE, so it comes up as the real app. */
function launchApp() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Installed, this file is resources/app/src/mcp.js and Curator.exe starts the app by itself.
  // From a checkout, Electron needs the app folder.
  const appDir = path.resolve(__dirname, '..');
  const packaged = path.basename(path.dirname(appDir)) === 'resources';
  const child = spawn(process.execPath, packaged ? [] : [appDir], { env, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

let launched = false;

/** Finds the running app, and opens it if it isn't running. */
async function connect() {
  let server = readServerInfo();
  if (server && (await healthy(server))) return server;
  if (!launched) {
    launched = true;
    launchApp();
  }
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    server = readServerInfo();
    if (server && (await healthy(server))) {
      launched = false;
      return server;
    }
  }
  launched = false;
  throw new Error("Couldn't reach the Curator app. Is it installed? Open Curator from the Start menu.");
}

const get = async (p) => request(await connect(), 'GET', p, null, 15000);
const post = async (p, body) => request(await connect(), 'POST', p, body, 60000);

function request(server, method, p, body, timeout) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1', port: server.port, path: p, method, timeout,
      headers: { 'X-Curator-Token': server.token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let object = {};
        try { object = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode >= 400) reject(new Error(object.error || `HTTP ${res.statusCode}`));
        else resolve(object);
      });
    });
    req.on('timeout', () => req.destroy(new Error('the Curator app took too long to answer')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function run() {
  const pending = new Set();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    // Each call runs by itself, so a long wait doesn't hold up sending more cards.
    const task = handle(message).catch((error) => console.error(error)).finally(() => pending.delete(task));
    pending.add(task);
  });
  lines.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

if (require.main === module) run();

module.exports = { run };
