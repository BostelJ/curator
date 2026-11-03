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

export function frameHTML(frame, { eager = false } = {}) {
  if (frame.kind === 'model') {
    return `<div class="shot model" data-model="${esc(media(frame.file))}"><span class="tag-3d">3D</span></div>`;
  }
  return `<img class="shot" src="${esc(media(frame.file))}" draggable="false" ${eager ? '' : 'loading="lazy"'} alt="">`;
}

// Fill in model thumbnails after rendering. Loaded only when a model is on screen.
export async function fillModels(root) {
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
