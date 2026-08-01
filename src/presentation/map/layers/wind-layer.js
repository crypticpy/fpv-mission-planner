// wind-layer.js — which way the air is going, three times over.
//
// The control is the honest instrument: an arrow, a number, and a legend line
// that says which height the figure was read at, all straight off the rail the
// plan was made against. The arrows (design evolution M11, W-04) are the same
// instrument spread across the map: a sparse, staggered grid of identical
// glyphs pointing downwind, so a route leg drawn on the map can be read against
// the air it flies through without leaving the map. Identical on purpose — the
// wind field is uniform at the point scale this tool plans at, and a grid that
// varied would be inventing structure the forecast never claimed. One length
// per frame, nudged by speed; the number lives in the legend, not in the
// pixels. The particles are decoration and say so — `pointer-events: none`,
// no scale. Screen-space drift with a trailing-wake fade (the earth.nullschool
// technique, simplified): every particle advects along the same vector at a
// speed proportional to the wind.
//
// Reduced motion removes the particles entirely rather than slowing them. The
// arrows stay — they are a static reading, not an animation, and they are what
// a reduced-motion pilot has instead of the drift. The preference is injected
// once at construction, because that is when the app reads it — a pilot who
// changes the OS setting mid-session gets the change on the next load, which
// is what this has always done.
//
// `start` and `stop` sit beside the layer contract rather than inside it: an
// animation is not a render, and the host is the only thing that knows the map
// tab just went off screen. Frames are not burned behind a hidden panel. The
// arrows redraw on render passes instead, which is when the wind can move.

/**
 * @typedef {import('../map-adapter.js').ControlOverlay} ControlOverlay
 * @typedef {import('../map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('../map-adapter.js').MapLayer} MapLayer
 */

/** @typedef {{ x: number, y: number, life: number, jitter: number }} Particle */

/** @typedef {MapLayer & { start: (adapter: MapAdapter) => void, stop: () => void }} WindLayer */

/** Fallback when the theme has no `--wind-particle` of its own. */
const PARTICLE_STROKE = 'rgba(190, 226, 255, 0.62)';

/** Below this the direction is noise and the arrows would be pointing at it. */
const CALM_MS = 0.5;

/** Arrows and particles share the theme's stroke, read fresh so a theme switch
 * repaints both without either latching a stale color. */
const stroke = () => getComputedStyle(document.documentElement)
  .getPropertyValue('--wind-particle').trim() || PARTICLE_STROKE;

/**
 * The legend line under the readout: what the arrows are and which height the
 * figure was read at. `levelM` is the snapshot's own provenance answer — null
 * on a preset, where naming a height would be an invention. Pure and exported
 * so the wording has one testable definition.
 * @param {{ speedMs: number, levelM: number|null }} spec
 * @returns {string}
 */
export function windLegendLine({ speedMs, levelM }) {
  if (!(speedMs >= CALM_MS)) return 'Calm — no arrows to draw';
  return levelM == null
    ? 'Arrows point downwind'
    : `Arrows point downwind · read at ${Math.round(levelM)} m`;
}

/**
 * @param {{ reducedMotion: boolean }} opts
 * @returns {WindLayer}
 */
export function createWindLayer({ reducedMotion }) {
  /** @type {ControlOverlay|null} */
  let control = null;
  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  let ctx = null;
  /** @type {HTMLElement|null} */
  let host = null;
  /** @type {Particle[]} */
  let particles = [];
  let rafId = 0;
  /** The direction the air moves TOWARD, in radians, and how fast. */
  let flow = { toRad: 0, speedMs: 0 };
  /** @type {HTMLCanvasElement|null} the static W-04 arrow grid */
  let arrows = null;
  /** @type {CanvasRenderingContext2D|null} */
  let actx = null;

  /** @param {MapAdapter} adapter */
  function ensureCanvas(adapter) {
    if (reducedMotion || canvas) return;
    host = adapter.container();
    canvas = document.createElement('canvas');
    canvas.className = 'wind-particles';
    host.appendChild(canvas);
    ctx = canvas.getContext('2d');
  }

  /** Not gated on reducedMotion — see the header. @param {MapAdapter} adapter */
  function ensureArrows(adapter) {
    if (arrows) return;
    host ??= adapter.container();
    arrows = document.createElement('canvas');
    arrows.className = 'wind-arrows';
    host.appendChild(arrows);
    actx = arrows.getContext('2d');
  }

  /** One pass over the grid: cleared and redrawn whole, because the whole
   * field turns together when the wind does. */
  function drawArrows() {
    if (!host || !arrows || !actx) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return; // the container is hidden; nothing to draw into
    const dpr = window.devicePixelRatio || 1;
    if (arrows.width !== Math.round(w * dpr) || arrows.height !== Math.round(h * dpr)) {
      arrows.width = Math.round(w * dpr);
      arrows.height = Math.round(h * dpr);
      actx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    actx.clearRect(0, 0, w, h);
    if (flow.speedMs < CALM_MS) return; // calm: the legend says so instead

    const dirX = Math.sin(flow.toRad), dirY = -Math.cos(flow.toRad);
    // One length for every arrow, nudged by speed so a scrubbed-forward gale
    // reads heavier than a breeze — but the number stays in the legend.
    const len = 14 + Math.min(flow.speedMs, 24) * 0.5;
    const ang = Math.atan2(dirY, dirX);
    const step = 92;
    actx.lineCap = 'round';
    actx.beginPath();
    for (let row = 0, y = step / 2; y < h + len; y += step, row++) {
      // Alternate rows offset by half a step: air, not graph paper.
      for (let x = row % 2 ? step : step / 2; x < w + len; x += step) {
        const tx = x + dirX * (len / 2), ty = y + dirY * (len / 2);
        actx.moveTo(x - dirX * (len / 2), y - dirY * (len / 2));
        actx.lineTo(tx, ty);
        for (const s of [1, -1]) {
          actx.moveTo(tx, ty);
          actx.lineTo(tx - 5 * Math.cos(ang - s * 0.5), ty - 5 * Math.sin(ang - s * 0.5));
        }
      }
    }
    // The same path twice: a quiet dark halo, then the glyph — the map-label
    // trick, so the arrows stay readable over sunlit rooftops and dark water
    // alike without getting louder.
    actx.strokeStyle = 'rgba(8, 14, 22, 0.4)';
    actx.lineWidth = 3.2;
    actx.stroke();
    actx.strokeStyle = stroke();
    actx.globalAlpha = 0.75;
    actx.lineWidth = 1.5;
    actx.stroke();
    actx.globalAlpha = 1;
  }

  /** @param {number} w @param {number} h @returns {Particle} */
  const spawn = (w, h) => ({
    x: Math.random() * w,
    y: Math.random() * h,
    life: 40 + Math.random() * 100,    // frames until it respawns elsewhere
    jitter: 0.7 + Math.random() * 0.6, // per-particle gustiness
  });

  /** @param {number} w @param {number} h */
  function resizeCanvas(w, h) {
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width === Math.round(w * dpr) && canvas.height === Math.round(h * dpr)) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    particles = Array.from({ length: Math.min(360, Math.round(w * h / 3200)) },
      () => spawn(w, h));
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (document.hidden || !host || !canvas || !ctx) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w) return; // the container is hidden; nothing to draw into
    resizeCanvas(w, h);

    // Decay the existing trails toward transparent, then lay this frame's
    // segments over them. `destination-in` is what makes a wake rather than a
    // smear: it fades what is already there instead of painting over it.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.93)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    const dirX = Math.sin(flow.toRad), dirY = -Math.cos(flow.toRad);
    const step = (8 + flow.speedMs * 6) / 60; // px per frame — dead calm still drifts
    ctx.strokeStyle = stroke();
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const p of particles) {
      const nx = p.x + dirX * step * p.jitter;
      const ny = p.y + dirY * step * p.jitter;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny;
      if (--p.life <= 0 || nx < -4 || nx > w + 4 || ny < -4 || ny > h + 4) {
        Object.assign(p, spawn(w, h));
      }
    }
    ctx.stroke();
  }

  return {
    id: 'wind',

    render(frame, adapter) {
      const env = frame.env;
      const windFromDeg = Number(env.windFromDeg) || 0;
      flow = {
        toRad: (windFromDeg + 180) * Math.PI / 180,
        speedMs: Number(env.windAvgMs) || 0,
      };
      ensureArrows(adapter);
      drawArrows();

      if (!control) {
        control = adapter.control({
          /* Bottom-right: the top-right corner is the MapToolbar's (M10), and a
           * readout under an icon rail would read as one of its buttons. */
          position: 'bottomright',
          className: 'wind-control',
          html: '<span class="wind-row"><span class="wind-arrow">➤</span>'
            + '<span class="wind-text"></span></span><span class="wind-legend"></span>',
        });
      }
      const el = control.element();
      if (!el) return;
      const arrow = /** @type {HTMLElement|null} */ (el.querySelector('.wind-arrow'));
      const text = el.querySelector('.wind-text');
      const legend = el.querySelector('.wind-legend');
      // "➤" points right, which is a 90° bearing; the air flows toward
      // windFromDeg + 180, so the rotation is (from + 90).
      if (arrow) arrow.style.transform = `rotate(${(windFromDeg + 90) % 360}deg)`;
      if (text) {
        text.textContent = `${Math.round(frame.units.speedFromMs(Number(env.windAvgMs) || 0))} `
          + `${frame.units.speedUnit} from ${Math.round(windFromDeg)}°`;
      }
      if (legend) {
        legend.textContent = windLegendLine({
          speedMs: flow.speedMs,
          // The advisory provenance already answered "which height was the
          // planning wind read at", preset-honesty included — null there means
          // the figure belongs to no level, and the legend says nothing.
          levelM: frame.snapshot.advisories?.provenance?.wind?.levelM ?? null,
        });
      }
    },

    start(adapter) {
      ensureCanvas(adapter);
      if (!canvas || rafId) return;
      rafId = requestAnimationFrame(tick);
    },

    stop() {
      if (!rafId) return;
      cancelAnimationFrame(rafId);
      rafId = 0;
    },

    dispose() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      canvas?.remove();
      canvas = null;
      ctx = null;
      arrows?.remove();
      arrows = null;
      actx = null;
      host = null;
      particles = [];
      control?.remove();
      control = null;
    },
  };
}
