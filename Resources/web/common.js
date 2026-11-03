// Shared by the quick pick strip, the corner stack and the gallery.
export const token = new URLSearchParams(location.search).get('token');

export async function api(path, body) {
  const res = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + token, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : {});
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
  return json;
}

export const state = () => api('/api/state');
export const media = (file) => '/media/' + file.split('/').map(encodeURIComponent).join('/') + '?token=' + token;
export const native = (message) => window.webkit?.messageHandlers?.curator?.postMessage(message);

export function esc(text) {
  const d = document.createElement('div');
  d.textContent = text ?? '';
  return d.innerHTML;
}

// A hand-drawn loop, stroked like a china marker on a contact sheet. Drawn at the frame's real
// pixel size: WebKit miscalculates dashes on a stretched SVG, and the loop would stop short.
const LOOP = [[13,7],[41,-3],[88,0],[96,21],[103,52],[98,90],[71,96],[44,102],[6,98],[3,61],[0,30],[11,6],[39,4]];
export function markerSVG(width, height, extra = '') {
  const w = width + 18, h = height + 18;
  const at = ([x, y]) => `${(x / 100 * w).toFixed(1)} ${(y / 100 * h).toFixed(1)}`;
  let d = `M ${at(LOOP[0])}`;
  for (let i = 1; i < LOOP.length; i += 3) d += ` C ${at(LOOP[i])}, ${at(LOOP[i + 1])}, ${at(LOOP[i + 2])}`;
  return `<svg class="marker ${extra}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" pathLength="1"/></svg>`;
}

// Report the page's size to the panel holding it, so it only ever covers what it draws.
export function reportSize(element) {
  const send = () => {
    const box = element.getBoundingClientRect();
    native({ type: 'size', w: Math.ceil(box.width), h: Math.ceil(box.height) });
  };
  new ResizeObserver(send).observe(element);
  send();
  return send;
}

// `play` is for clips: 'sync' plays under runClips, 'loop' plays by itself, and anything else shows a still.
export function frameHTML(frame, { eager = false, play = null } = {}) {
  if (frame.kind === 'model') {
    return `<div class="shot model" data-model="${esc(media(frame.file))}"><span class="tag-3d">3D</span></div>`;
  }
  if (frame.kind === 'video') {
    const how = play === 'sync' ? 'data-sync preload="auto"'
      : play === 'loop' ? 'autoplay loop preload="auto"'
      : 'preload="auto"';
    const src = media(frame.file) + (play ? '' : '#t=0.1');
    return `<video class="shot clip" src="${esc(src)}" muted playsinline disablepictureinpicture ${how}></video><span class="tag-3d tag-clip">▶</span>`;
  }
  return `<img class="shot" src="${esc(media(frame.file))}" draggable="false" ${eager ? '' : 'loading="lazy"'} alt="">`;
}

// The clip as it stands right now, as a picture.
export function stillOf(video, type = 'image/png') {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, 0.9);
}

// A copy of a print to toss as a leaf, with each clip swapped for the frame it was showing.
export function paperHTML(element) {
  const copy = element.cloneNode(true);
  const live = element.querySelectorAll('video');
  copy.querySelectorAll('video').forEach((video, i) => {
    const img = document.createElement('img');
    img.className = video.className;
    try { if (live[i].readyState >= 2) img.src = stillOf(live[i], 'image/jpeg'); } catch {}
    video.replaceWith(img);
  });
  copy.querySelectorAll('.clipbar').forEach((bar) => bar.remove());
  return copy.outerHTML;
}

const PLAY = '<svg viewBox="0 0 12 12"><path d="M3 1.8v8.4L10 6z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 12 12"><path d="M2.6 1.8h2.4v8.4H2.6zM7 1.8h2.4v8.4H7z" fill="currentColor"/></svg>';
const RATES = [1, 0.5, 0.25];
const STEP = 1 / 30;

export const clipBarHTML = () => `<div class="clipbar">
  <button data-c="play" title="Play or pause">${PAUSE}</button>
  <button data-c="back" title="Back a frame">‹</button><button data-c="fwd" title="Forward a frame">›</button>
  <input type="range" data-c="scrub" min="0" max="1000" value="0" step="1">
  <span class="clip-time">0.00s</span>
  <button data-c="rate" title="Slow motion">1×</button>
</div>`;

// Where each set of clips was, so a redraw of the same card picks up where it left off.
const clocks = new Map();

// Plays every clip in `scope` together, from one clock: they start on the same frame, the shorter
// ones hold their last frame until the longest finishes, then all start over. A .clipbar in scope
// plays, pauses, steps, scrubs and slows them all at once. Returns a function that stops it.
export function runClips(scope, key) {
  const videos = [...scope.querySelectorAll('video[data-sync]')];
  if (!videos.length) return () => {};
  if (!clocks.has(key)) { clocks.clear(); clocks.set(key, { t: 0, playing: true, rate: 1 }); }
  const clock = clocks.get(key);
  const bar = scope.querySelector('.clipbar');
  const dur = (v) => (Number.isFinite(v.duration) ? v.duration : 0);
  const length = () => Math.max(0, ...videos.map(dur));
  const master = () => videos.reduce((a, b) => (dur(b) > dur(a) ? b : a));
  let alive = true, frame = 0, ready = false;

  const seek = (t) => {
    clock.t = Math.max(0, Math.min(t, length()));
    for (const v of videos) {
      const want = Math.min(clock.t, Math.max(0, dur(v) - 0.001));
      if (Math.abs(v.currentTime - want) > 0.001) v.currentTime = want;
    }
  };
  const apply = () => {
    for (const v of videos) {
      v.muted = true;
      v.playbackRate = clock.rate;
      if (clock.playing && clock.t < dur(v) - 0.02) v.play().catch(() => {});
      else v.pause();
    }
    paint();
  };
  const paint = () => {
    if (!bar) return;
    const total = length();
    bar.querySelector('[data-c=play]').innerHTML = clock.playing ? PAUSE : PLAY;
    bar.querySelector('[data-c=rate]').textContent = clock.rate === 1 ? '1×' : clock.rate === 0.5 ? '½×' : '¼×';
    bar.querySelector('[data-c=scrub]').value = total ? Math.round(clock.t / total * 1000) : 0;
    bar.querySelector('.clip-time').textContent = `${clock.t.toFixed(2)}s / ${total.toFixed(2)}s`;
  };
  const pause = () => { clock.playing = false; apply(); };

  const tick = () => {
    if (!alive) return;
    if (ready && clock.playing) {
      const m = master();
      if (m.ended || m.currentTime >= dur(m) - 0.001) {
        seek(0);
        apply();
      } else {
        clock.t = m.currentTime;
        for (const v of videos) {
          // A clip that's finished holds its last frame: play() would start it over.
          if (v === m || v.ended || clock.t >= dur(v) - 0.05) continue;
          if (Math.abs(v.currentTime - clock.t) > 0.08) v.currentTime = clock.t; // drifted
          if (v.paused) v.play().catch(() => {});
        }
      }
      paint();
    }
    frame = requestAnimationFrame(tick);
  };

  const start = () => {
    if (!alive || ready || !videos.every((v) => v.readyState >= 1)) return;
    ready = true;
    seek(clock.t);
    apply();
  };
  for (const v of videos) v.addEventListener('loadedmetadata', start);
  start();
  frame = requestAnimationFrame(tick);

  if (bar) {
    bar.addEventListener('click', (e) => e.stopPropagation());
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.querySelector('[data-c=play]').onclick = () => {
      if (!clock.playing && clock.t >= length() - 0.02) seek(0);
      clock.playing = !clock.playing;
      apply();
    };
    bar.querySelector('[data-c=back]').onclick = () => { seek(clock.t - STEP); pause(); };
    bar.querySelector('[data-c=fwd]').onclick = () => { seek(clock.t + STEP); pause(); };
    bar.querySelector('[data-c=rate]').onclick = () => {
      clock.rate = RATES[(RATES.indexOf(clock.rate) + 1) % RATES.length];
      apply();
    };
    bar.querySelector('[data-c=scrub]').oninput = (e) => {
      clock.playing = false;
      seek(Number(e.target.value) / 1000 * length());
      apply();
    };
  }
  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    for (const v of videos) v.pause();
  };
}

// Fill in model thumbnails after rendering. Loaded only when a model is on screen.
export async function fillModels(root) {
  // Clips get their length on the tag.
  root.querySelectorAll('video.clip + .tag-clip:not([data-done])').forEach((tag) => {
    tag.dataset.done = '1';
    const video = tag.previousElementSibling;
    const show = () => { if (Number.isFinite(video.duration)) tag.textContent = `▶ ${video.duration.toFixed(1)}s`; };
    video.addEventListener('loadedmetadata', show);
    show();
  });
  const slots = [...root.querySelectorAll('.shot.model[data-model]:not([data-done])')];
  if (!slots.length) return;
  const { thumbnail } = await import('./viewer.js');
  for (const slot of slots) {
    slot.dataset.done = '1';
    try {
      const url = await thumbnail(slot.dataset.model);
      slot.style.backgroundImage = `url(${url})`;
    } catch (error) {
      slot.classList.add('broken');
      console.error(error);
    }
  }
}
