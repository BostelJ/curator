// Connects Curator to Claude Code: registers the MCP server `curator` at user scope and installs
// the skill. The app does this by itself on first run; the installer script runs it directly:
//   ELECTRON_RUN_AS_NODE=1 Curator.exe resources\app\src\connect.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const MCP_SCRIPT = path.join(__dirname, 'mcp.js');

/** Where claude is: the native installer's spot, npm's, or whatever PATH finds. */
function findClaude() {
  const home = os.homedir();
  const found = [];
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      found.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    } catch {}
    found.push(path.join(home, '.local', 'bin', 'claude.exe'));
    if (process.env.APPDATA) found.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
    // An .exe runs directly; a .cmd needs cmd.exe, so prefer the .exe.
    const usable = found.filter((f) => /\.(exe|cmd|bat)$/i.test(f) && fs.existsSync(f));
    return usable.find((f) => /\.exe$/i.test(f)) ?? usable[0] ?? null;
  }
  try {
    found.push(execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 }).trim());
  } catch {}
  found.push(path.join(home, '.local', 'bin', 'claude'));
  return found.find((f) => f && fs.existsSync(f)) ?? null;
}

/** Runs claude with these arguments. A .cmd goes through cmd.exe, with every argument quoted. */
function runClaude(claude, args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // claude is not ours to change
    const done = (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    const options = { env, windowsHide: true, timeout: 60000 };
    if (/\.(cmd|bat)$/i.test(claude)) {
      const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const line = [claude, ...args].map(quote).join(' ');
      execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true }, done);
    } else {
      execFile(claude, args, options, done);
    }
  });
}

/** The skill, with the Mac-only wording made general. */
function installSkill(skillSource) {
  const text = fs.readFileSync(skillSource, 'utf8').replace('a Mac app that shows', 'a desktop app that shows');
  const dir = path.join(os.homedir(), '.claude', 'skills', 'curator');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return path.join(dir, 'SKILL.md');
}

/**
 * Registers `curator` with Claude Code. exe is Curator.exe; it runs mcp.js as plain Node.
 * Returns { ok, message }.
 */
async function connectClaude({ exe = process.execPath, skillSource } = {}) {
  const claude = findClaude();
  if (!claude) {
    return { ok: false, missing: true, message: "Claude Code isn't installed (or isn't on PATH), so Curator wasn't connected to it. Install Claude Code, then choose Connect to Claude Code from Curator's tray menu." };
  }
  await runClaude(claude, ['mcp', 'remove', 'curator', '-s', 'user']);
  const added = await runClaude(claude, ['mcp', 'add', 'curator', '-s', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', exe, MCP_SCRIPT]);
  if (!added.ok) return { ok: false, message: `Claude Code didn't accept Curator: ${added.out || 'no reason given'}` };
  let skill = '';
  try {
    if (skillSource) skill = installSkill(skillSource);
  } catch (error) {
    return { ok: false, message: `Connected, but the skill couldn't be copied: ${error.message}` };
  }
  return { ok: true, claude, skill, message: 'Connected to Claude Code. Restart any open Claude Code sessions to use Curator.' };
}

/** The skill that ships with the app: resources/skill/SKILL.md, or the repo's copy in a checkout. */
function bundledSkill() {
  const packaged = path.resolve(__dirname, '..', '..', 'skill', 'SKILL.md');
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', '..', 'skill', 'curator', 'SKILL.md');
}

/** Remembers the result, so the app doesn't connect again on its first run. */
function record(result, version) {
  try {
    const { homeDirectory } = require('./home');
    fs.mkdirSync(homeDirectory(), { recursive: true });
    fs.writeFileSync(path.join(homeDirectory(), 'connected.json'), JSON.stringify({
      ok: result.ok, exe: process.execPath, version, at: Date.now() / 1000, message: result.message,
    }));
  } catch {}
}

module.exports = { connectClaude, bundledSkill, findClaude, record };

if (require.main === module) {
  connectClaude({ skillSource: bundledSkill() }).then((result) => {
    record(result, require('../package.json').version);
    console.log(result.message);
    process.exit(result.ok ? 0 : result.missing ? 2 : 1);
  });
}
