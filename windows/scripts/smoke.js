// End-to-end test, the way Claude Code uses Curator: start a hidden test copy, talk to it through
// the MCP bridge, answer cards by pressing its keys, and check what the agent gets back.
//   node scripts/smoke.js [path to Curator.exe or Electron] [folder for snapshots]
// Runs invisibly (CURATOR_QUIET): nothing shows on screen and no real keys are taken.
// SMOKE_VISIBLE=1 shows the windows for real, and on Windows also saves pictures of the whole desktop.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { drawLogo, png } = require('../src/raster');

const root = path.resolve(__dirname, '..');
const exe = process.argv[2] || require('electron');
const shots = process.argv[3] ? path.resolve(process.argv[3]) : null;
const packaged = !!process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-smoke-'));
const mcpScript = packaged ? path.join(path.dirname(exe), 'resources', 'app', 'src', 'mcp.js') : path.join(root, 'src', 'mcp.js');
const visible = process.env.SMOKE_VISIBLE === '1';
const env = { ...process.env, CURATOR_HOME: home, CURATOR_DEBUG: '1', ...(visible ? {} : { CURATOR_QUIET: '1' }) };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The real desktop, when visible on Windows. */
async function desktop(name) {
  if (!shots || !visible || process.platform !== 'win32') return;
  await sleep(1200); // let the cards finish dealing in
  fs.mkdirSync(shots, { recursive: true });
  await new Promise((resolve) => spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'screenshot.ps1'), path.join(shots, `desktop-${name}.png`)], { stdio: 'inherit' }).on('exit', resolve));
}
let failures = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

// Test pictures
const pics = {};
for (const [name, ink] of Object.entries({ red: '#c0392b', blue: '#2c6fbb', green: '#2e8b57' })) {
  pics[name] = path.join(home, `${name} option.png`); // a space, as Windows paths often have
  fs.writeFileSync(pics[name], png(drawLogo(256, { ink, tile: true }), 256));
}

// The app
const appProc = spawn(exe, packaged ? [] : [root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = '';
appProc.stdout.on('data', (d) => { appLog += d; });
appProc.stderr.on('data', (d) => { appLog += d; });

async function server() {
  for (let i = 0; i < 120; i++) {
    try { return JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')); } catch {}
    await sleep(250);
  }
  throw new Error('the app never wrote server.json\n' + appLog);
}

function request(info, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: info.port, path: p, method,
      headers: { 'X-Curator-Token': info.token, ...(data ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(text.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json, raw: text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// The MCP bridge, as Claude Code starts it
const mcp = spawn(exe, [mcpScript], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
let mcpBuffer = '';
let mcpErr = '';
const waiting = new Map();
mcp.stderr.on('data', (d) => { mcpErr += d; });
mcp.stdout.on('data', (d) => {
  mcpBuffer += d;
  let at;
  while ((at = mcpBuffer.indexOf('\n')) >= 0) {
    const line = mcpBuffer.slice(0, at);
    mcpBuffer = mcpBuffer.slice(at + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    setTimeout(() => reject(new Error(`no answer to ${method}\n${mcpErr}`)), 300000);
  });
}
async function tool(name, args) {
  const msg = await rpc('tools/call', { name, arguments: args });
  const text = msg.result?.content?.[0]?.text ?? '';
  if (msg.result?.isError) return { error: text };
  return JSON.parse(text);
}

async function main() {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  check('MCP bridge starts under ELECTRON_RUN_AS_NODE', init.result?.serverInfo?.name === 'curator', init);
  const list = await rpc('tools/list', {});
  check('seven tools listed', list.result?.tools?.length === 7, list.result?.tools?.map((t) => t.name));

  // The bridge opens the app if it isn't up yet; here it's starting alongside.
  const info = await server();
  const debug = (body) => request(info, 'POST', '/api/debug', body).then((r) => r.json);
  const evalIn = async (panel, script) => (await debug({ do: 'eval', panel, script })).result;

  check('health', (await request(info, 'GET', '/api/health')).json?.ok === true);
  check('wrong token refused', (await request({ ...info, token: 'nope' }, 'GET', '/api/state')).status === 401);
  const ui = await request(info, 'GET', `/ui/quick.html?token=${info.token}`);
  check('serves the shared quick pick page', ui.status === 200 && ui.raw.includes('curatorKey'));
  check('climbing out of the web folder is refused', (await request(info, 'GET', '/ui/..%2F..%2Fpackage.json')).status === 404);
  check('backslash climbing is refused', (await request(info, 'GET', '/ui/..%5C..%5Cpackage.json')).status === 404);

  // Quick pick: red against blue, chosen with the keys.
  const qp = await tool('curator_quick_pick', {
    project: 'Smoke', title: 'Pick a colour',
    options: [{ path: pics.red, label: 'A: red' }, { path: pics.blue, label: 'B: blue' }],
  });
  check('quick pick sent', typeof qp.id === 'string' && qp.status === 'pending', qp);
  let d;
  for (let i = 0; i < 40; i++) {
    d = await debug({});
    if (d.quick.visible && d.keysHeld.includes('left')) break;
    await sleep(250);
  }
  check('quick pick shows at the top centre', d.quick.visible && d.quick.frame[1] === d.screen[1], d);
  check('it holds the arrow keys', d.keysHeld.includes('left') && d.keysHeld.includes('right'), d.keysHeld);
  check('it never takes focus', d.quick.key === false && d.quick.focusable === false, d.quick);
  check('it stays on top', d.quick.onTop === true, d.quick);
  if (shots) await debug({ do: 'snapshot', panel: 'quick', out: path.join(shots, 'quick.png') });
  await desktop('quick-pick');
  const frame = await request(info, 'GET', `/media/${encodeURIComponent(qp.id)}/01_red_option.png?token=${info.token}`, null);
  check('media is served', frame.status === 200 && frame.headers['content-type'] === 'image/png', frame.status);
  const part = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: info.port, path: `/media/${qp.id}/01_red_option.png?token=${info.token}`, headers: { Range: 'bytes=0-7' } },
      (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); });
  });
  check('byte ranges work (video needs them)', part.status === 206 && part.body.length === 8, part.status);

  await debug({ do: 'press', key: 'left' });
  await sleep(400);
  await debug({ do: 'press', key: 'enter' });
  const picked = await tool('curator_wait', { ids: [qp.id], timeout_seconds: 20 });
  const pa = picked.answered?.[0]?.answer;
  // The bracket is shuffled, so either one may be on the left.
  check('← then Enter picks one', pa?.action === 'pick' && ['A: red', 'B: blue'].includes(pa?.chosen?.label) && pa?.matches?.length === 1, picked);
  check('the agent gets a real path', pa && fs.existsSync(pa.chosen.path), pa?.chosen);
  check('and the other is the runner-up', pa?.runnerUp?.label && pa.runnerUp.label !== pa.chosen.label, pa);

  // A note on a quick pick ends the pick (the newer behaviour, from the shared page).
  const qp2 = await tool('curator_quick_pick', {
    project: 'Smoke', title: 'Pick again', revises: qp.id,
    options: [{ path: pics.green, label: 'A: green' }, { path: pics.blue, label: 'B: blue' }],
  });
  for (let i = 0; i < 40 && !(await debug({})).keysHeld.includes('left'); i++) await sleep(250);
  await debug({ do: 'press', key: 'noteAny' });
  await sleep(500);
  await desktop('quick-note');
  await evalIn('quick', `(() => { const b = document.getElementById('note'); b.value = 'Make it orange'; document.getElementById('sendNote').click(); return true; })()`);
  const noted = await tool('curator_wait', { ids: [qp2.id], timeout_seconds: 20 });
  const na = noted.answered?.[0]?.answer;
  check('a quick pick note is the answer', na?.action === 'note' && na?.note === 'Make it orange', noted);
  check('with the two options on screen', na?.onScreen?.length === 2, na);
  const board0 = await tool('curator_board', { project: 'smoke' });
  check('board lists the note as answeredWithNote', board0.recentTournaments?.some((t) => t.answeredWithNote && t.note === 'Make it orange'), board0.recentTournaments);

  // Refine card, kept with Ctrl+Alt+K.
  const rf = await tool('curator_refine', { project: 'Smoke', title: 'Red pass', revises: qp.id, files: [{ path: pics.red }] });
  for (let i = 0; i < 40; i++) {
    d = await debug({});
    if (d.stack.visible && d.keysHeld.includes('keep')) break;
    await sleep(250);
  }
  const [sx, sy, sw, sh] = d.stack.frame;
  check('refine card sits in the bottom-right corner', d.stack.visible && sx + sw === d.screen[0] + d.screen[2] && sy + sh === d.screen[1] + d.screen[3], d);
  if (shots) await debug({ do: 'snapshot', panel: 'stack', out: path.join(shots, 'stack.png') });
  await desktop('refine');
  await debug({ do: 'press', key: 'keep' });
  const kept = await tool('curator_wait', { ids: [rf.id], timeout_seconds: 20 });
  check('Ctrl+Alt+K keeps it', kept.answered?.[0]?.answer?.action === 'keep' && kept.answered[0].answer.onBoard === true, kept);

  const board = await tool('curator_board', { project: 'SMOKE' });
  check('the board has the kept strip', board.kept?.length === 1 && board.kept[0].title === 'Red pass', board);
  check('with the road behind it', board.kept?.[0]?.earlierPasses?.length === 1, board.kept?.[0]);

  // Rules, retiring, withdrawing, errors.
  const rule = await request(info, 'POST', '/api/rule', { project: 'Smoke', text: 'Warm colours only.' });
  await request(info, 'POST', '/api/rule/answer', { id: rule.json.id, accept: true });
  const retire = await tool('curator_retire_strips', { strips: [board.kept[0].stripId], reason: 'Moved on.' });
  check('retire works', retire.ok === true, retire);
  const board2 = await tool('curator_board', { project: 'Smoke' });
  check('accepted rule and retired shelf show on the board', board2.acceptedRules?.[0] === 'Warm colours only.' && board2.retired?.length === 1, board2);
  const bad = await tool('curator_quick_pick', { project: 'Smoke', title: 'x', options: [{ path: pics.red }] });
  check('a one-option quick pick is refused', /at least 2/.test(bad.error ?? ''), bad);
  const missing = await tool('curator_refine', { project: 'Smoke', title: 'x', files: [{ path: path.join(home, 'nope.png') }] });
  check('a missing file is refused', /file not found/.test(missing.error ?? ''), missing);
  const wd = await tool('curator_refine', { project: 'Smoke', title: 'Withdraw me', files: [{ path: pics.blue }] });
  await tool('curator_withdraw', { id: wd.id });
  const wdState = await tool('curator_wait', { ids: [wd.id], timeout_seconds: 5 });
  check('withdraw takes a card down', wdState.answered?.[0]?.status === 'withdrawn', wdState);

  // The gallery
  await debug({ do: 'gallery', size: [1280, 820] });
  await sleep(2500);
  const galleryText = await evalIn(null, 'document.body.innerText');
  check('gallery opens and shows the rule', /Warm colours only/i.test(galleryText ?? ''), galleryText?.slice(0, 200));
  if (shots) await debug({ do: 'snapshot', out: path.join(shots, 'gallery.png') });
  await desktop('gallery');
  if (shots) await debug({ do: 'trayIcon', out: path.join(shots, 'tray.png'), scale: 2 });

  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  check('state.json saved in the Mac format', Array.isArray(state.items) && state.items.length === 4 && state.strips.length === 1, state.items?.length);
  check('no nulls written for missing fields', !JSON.stringify(state).includes('null'));
}

main()
  .catch((error) => { failures++; console.error('FAIL', error.stack || error); })
  .finally(async () => {
    mcp.stdin.end();
    appProc.kill();
    await sleep(500);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    console.log(failures ? `\n${failures} failed` : '\nAll passed');
    if (failures && appLog) console.log('--- app log ---\n' + appLog.slice(-4000));
    process.exit(failures ? 1 : 0);
  });
