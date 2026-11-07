// Everything Curator knows. A port of Sources/Curator/Store.swift: same rules, same state.json.
// Optional fields are left undefined (not null) so the file matches what the Mac app writes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { homeDirectory } = require('./home');

const IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const MODELS = new Set(['glb']);
const VIDEOS = new Set(['mp4', 'mov', 'm4v', 'webm']);

const kindOf = (ext) => (MODELS.has(ext) ? 'model' : VIDEOS.has(ext) ? 'video' : 'image');
const extOf = (file) => path.extname(file).slice(1).toLowerCase();
const now = () => Date.now() / 1000;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const blank = (s) => (s ?? '').trim() === '';

class StoreError extends Error {}

class Store {
  constructor() {
    this.home = homeDirectory();
    this.mediaDir = path.join(this.home, 'media');
    this.stateFile = path.join(this.home, 'state.json');
    this.data = { items: [], strips: [], rules: [], paused: false };
    this.onChange = null;
    fs.mkdirSync(this.mediaDir, { recursive: true });
    let raw = null;
    try { raw = fs.readFileSync(this.stateFile, 'utf8'); } catch {}
    if (raw != null) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.items) || !Array.isArray(parsed.strips) || !Array.isArray(parsed.rules)) {
          throw new Error('missing items, strips or rules');
        }
        this.data = { items: parsed.items, strips: parsed.strips, rules: parsed.rules, paused: !!parsed.paused };
      } catch (error) {
        // Never write over a state file we couldn't read.
        const aside = path.join(this.home, `state.unreadable-${Math.floor(now())}.json`);
        try { fs.renameSync(this.stateFile, aside); } catch {}
        console.error(`Curator: state.json could not be read, moved to ${aside}: ${error.message}`);
      }
    }
  }

  commit() {
    const text = JSON.stringify(this.data);
    const temp = this.stateFile + '.tmp';
    try {
      fs.writeFileSync(temp, text);
      fs.renameSync(temp, this.stateFile);
    } catch {
      // Windows can refuse the rename while something (a virus scanner) has the file open.
      try { fs.writeFileSync(this.stateFile, text); } catch (error) { console.error('Curator: could not save', error); }
    }
    this.onChange?.();
  }

  newId(prefix) {
    return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
  }

  /** Project names are matched without caring about case, and keep the first spelling used. */
  canonicalProject(name) {
    const trimmed = String(name ?? '').trim();
    const known = [...this.data.items, ...this.data.strips, ...this.data.rules].map((x) => x.project);
    return known.find((p) => same(p, trimmed)) ?? trimmed;
  }

  // Sending

  send({ project, stage, title, prompt, frames: input, revises, keepOnPick, replaces = [] }) {
    if (stage !== 'quick_pick' && stage !== 'refine') throw new StoreError('stage must be quick_pick or refine');
    const name = this.canonicalProject(project);
    if (!name) throw new StoreError('project is required');
    if (blank(title)) throw new StoreError('title is required');
    if (!input.length) throw new StoreError('at least one file is required');
    if (stage === 'quick_pick' && input.length < 2) {
      throw new StoreError('a quick pick needs at least 2 options; send one direction as a refine card');
    }
    if (stage === 'quick_pick' && input.length > 16) {
      throw new StoreError('a quick pick takes at most 16 options, so it stays quick');
    }

    let parent;
    if (revises) {
      parent = this.data.items.find((i) => i.id === revises);
      if (!parent) throw new StoreError(`revises: no card with id ${revises}`);
    }
    const replaced = replaces.map((id) => {
      const strip = this.data.strips.find((s) => s.id === id);
      if (!strip) throw new StoreError(`replaces: no strip with id ${id}. curator_board lists them.`);
      return strip;
    });

    // Check every file before copying any of them.
    for (const entry of input) {
      let stat = null;
      try { stat = fs.statSync(entry.path); } catch {}
      if (!entry.path || !stat || stat.isDirectory()) throw new StoreError(`file not found: ${entry.path}`);
      const ext = extOf(entry.path);
      if (!IMAGES.has(ext) && !MODELS.has(ext) && !VIDEOS.has(ext)) {
        throw new StoreError(`can't show .${ext} files (${entry.path}). Send png, jpg, webp, gif, glb, mp4, mov or webm.`);
      }
    }

    const id = this.newId('card');
    const folder = path.join(this.mediaDir, id);
    fs.mkdirSync(folder, { recursive: true });
    const frames = [];
    input.forEach((entry, index) => {
      const safe = path.basename(entry.path).replace(/[^A-Za-z0-9._-]/g, '_');
      const stored = `${String(index + 1).padStart(2, '0')}_${safe}`;
      try {
        fs.copyFileSync(entry.path, path.join(folder, stored));
      } catch (error) {
        fs.rmSync(folder, { recursive: true, force: true });
        throw new StoreError(`couldn't copy ${entry.path}: ${error.message}`);
      }
      frames.push({ id: this.newId('frame'), label: entry.label ?? undefined, file: `${id}/${stored}`, kind: kindOf(extOf(entry.path)) });
    });

    const item = {
      id, project: parent?.project ?? name, stage, title, prompt: prompt ?? undefined, frames,
      thread: parent?.thread ?? this.newId('thread'),
      round: (parent?.round ?? 0) + 1,
      pass: stage === 'refine' ? this.passesSoFar(parent?.thread) + 1 : undefined,
      revises: revises ?? undefined, keepOnPick: !!keepOnPick,
      replaces: replaces.length ? replaces : undefined,
      replacesTitles: replaced.length ? replaced.map((s) => s.title) : undefined,
      status: 'pending', createdAt: now(), answer: undefined,
    };
    this.data.items.push(item);
    this.commit();
    return item;
  }

  passesSoFar(thread) {
    if (!thread) return 0;
    return this.data.items.filter((i) => i.thread === thread && i.stage === 'refine' && i.status !== 'withdrawn').length;
  }

  /** Saves a picture the user drew on, next to the card's own files. For a clip, `time` goes in the name. */
  saveMarkup({ id, frameId, png, time }) {
    const item = this.data.items.find((i) => i.id === id);
    if (!item || item.status !== 'pending') throw new StoreError("that card isn't waiting for an answer");
    const index = item.frames.findIndex((f) => f.id === frameId);
    if (index < 0) throw new StoreError("that picture isn't on this card");
    if (png.length < 4 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new StoreError('markup must be a PNG');
    }
    const at = typeof time === 'number' && Number.isFinite(time) ? `_at_${Math.max(0, time).toFixed(2)}s` : '';
    const name = `markup_${String(index + 1).padStart(2, '0')}${at}_${crypto.randomUUID().slice(0, 6).toLowerCase()}.png`;
    fs.writeFileSync(path.join(this.mediaDir, id, name), png);
    return `${id}/${name}`;
  }

  withdraw(id) {
    const item = this.data.items.find((i) => i.id === id);
    if (!item) throw new StoreError(`no card with id ${id}`);
    if (item.status !== 'pending') return;
    item.status = 'withdrawn';
    this.commit();
  }

  // Answering

  answer({ id, action, frameId, note, matches, markups, onScreen }) {
    const item = this.data.items.find((i) => i.id === id);
    if (!item) throw new StoreError(`no card with id ${id}`);
    if (item.status !== 'pending') throw new StoreError('that card has already been answered');
    const trimmed = typeof note === 'string' ? note.trim() : '';
    const cleanNote = trimmed || undefined;
    const ok = (stage, act) => item.stage === stage && action === act;
    if (ok('quick_pick', 'pick')) {
      if (!frameId || !item.frames.some((f) => f.id === frameId)) throw new StoreError("pick needs one of this card's frames");
    } else if (ok('quick_pick', 'redo') || ok('refine', 'keep') || action === 'delete') {
      // nothing to check
    } else if (ok('refine', 'note') || ok('quick_pick', 'note')) {
      // On a quick pick, a note ends the pick: it's the answer, with no winner forced out of it.
      if (!cleanNote) throw new StoreError("a note can't be empty");
    } else {
      throw new StoreError(`${action} isn't an answer for a ${item.stage} card`);
    }
    const kept = (markups ?? []).filter((m) => typeof m === 'string' && m.startsWith(id + '/'));
    const shown = (onScreen ?? []).filter((f) => item.frames.some((x) => x.id === f));
    item.status = 'answered';
    item.answer = {
      action, frameId: frameId ?? undefined, note: cleanNote, at: now(),
      matches: matches ?? undefined, markups: kept.length ? kept : undefined,
      onScreen: shown.length ? shown : undefined, // a quick pick's note: the two frames up when it was written
    };
    if (action === 'keep' || (action === 'pick' && item.keepOnPick)) this.makeStrip(item);
    this.commit();
  }

  /** A Keep becomes a photo strip: the road to it (the picked direction, each pass) ending on what was kept. */
  makeStrip(kept) {
    const frames = [];
    const notes = [];
    const road = this.data.items
      .filter((i) => i.thread === kept.thread && i.status === 'answered')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const item of road) {
      if (item.answer?.note) notes.push(item.answer.note);
      const isKept = item.id === kept.id;
      const strip = (f, final) => ({ file: f.file, kind: f.kind, label: f.label, round: item.round, final, stage: item.stage });
      if (item.stage === 'quick_pick') {
        const chosen = item.frames.find((f) => f.id === item.answer?.frameId);
        if (chosen) frames.push(strip(chosen, isKept));
      } else if (isKept) {
        frames.push(...item.frames.map((f) => strip(f, true)));
      } else if (item.frames[0]) {
        frames.push(strip(item.frames[0], false));
      }
    }
    // The wall shows current taste. A new Keep takes the place of any earlier Keep on the same
    // road, and of whatever the agent said this card replaces.
    for (const s of this.data.strips) {
      if (!s.removed && (s.thread === kept.thread || kept.replaces?.includes(s.id))) {
        s.removed = true;
        s.retiredReason = `Replaced by “${kept.title}”`;
      }
    }
    this.data.strips.push({
      id: this.newId('strip'), project: kept.project, thread: kept.thread, title: kept.title,
      frames, notes, keptAt: now(), removed: false, retiredReason: undefined,
    });
  }

  strip(id) {
    const s = this.data.strips.find((x) => x.id === id);
    if (!s) throw new StoreError(`no strip with id ${id}`);
    return s;
  }

  removeStrip(id) {
    // Taken off the wall, not deleted: it moves to the retired shelf and can be restored.
    const s = this.strip(id);
    s.removed = true;
    s.retiredReason = 'Taken down by you';
    this.commit();
  }

  /** The art direction moved on and these no longer represent it. */
  retireStrips(ids, reason) {
    const clean = String(reason ?? '').trim();
    if (!clean) throw new StoreError('say why these no longer fit');
    if (!ids.length) throw new StoreError('strips is required');
    for (const id of ids) {
      if (!this.data.strips.some((s) => s.id === id)) throw new StoreError(`no strip with id ${id}. curator_board lists them.`);
    }
    for (const s of this.data.strips) {
      if (ids.includes(s.id) && !s.removed) {
        s.removed = true;
        s.retiredReason = clean;
      }
    }
    this.commit();
  }

  restoreStrip(id) {
    const s = this.strip(id);
    s.removed = false;
    s.retiredReason = undefined;
    this.commit();
  }

  // Taste rules

  proposeRule(project, text, why) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new StoreError("a rule can't be empty");
    const name = this.canonicalProject(project);
    if (!name) throw new StoreError('project is required');
    const existing = this.data.rules.find((r) => r.project === name && same(r.text, clean) && r.status !== 'declined');
    if (existing) return existing;
    const rule = { id: this.newId('rule'), project: name, text: clean, why: why ?? undefined, status: 'proposed', createdAt: now() };
    this.data.rules.push(rule);
    this.commit();
    return rule;
  }

  answerRule(id, accept) {
    const rule = this.data.rules.find((r) => r.id === id);
    if (!rule) throw new StoreError(`no rule with id ${id}`);
    rule.status = accept ? 'accepted' : 'declined';
    this.commit();
  }

  // Reading

  setPaused(paused) {
    this.data.paused = paused;
    this.commit();
  }

  get pendingQuick() { return this.data.items.filter((i) => i.status === 'pending' && i.stage === 'quick_pick'); }
  get pendingRefine() { return this.data.items.filter((i) => i.status === 'pending' && i.stage === 'refine'); }
  get proposedRules() { return this.data.rules.filter((r) => r.status === 'proposed'); }
  get waitingCount() { return this.pendingQuick.length + this.pendingRefine.length + this.proposedRules.length; }

  get projects() {
    // Only projects with something to show: a card that was answered and left nothing isn't a board.
    const kept = this.data.strips.map((s) => s.project); // retired ones too, so their shelf can be reached
    const ruled = this.data.rules.filter((r) => r.status === 'accepted').map((r) => r.project);
    const waiting = this.data.items.filter((i) => i.status === 'pending').map((i) => i.project);
    return [...new Set([...kept, ...ruled, ...waiting])];
  }

  /** A media file's real path, with this system's separators. */
  pathOf(file) { return path.join(this.mediaDir, ...file.split('/')); }
}

module.exports = { Store, StoreError };
