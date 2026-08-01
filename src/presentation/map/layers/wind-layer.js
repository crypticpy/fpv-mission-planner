// wind-layer.js — which way the air is going, twice over.
//
// The control is the honest instrument: an arrow and a number, read straight off
// the rail the plan was made against. The particles are decoration and say so —
// `pointer-events: none`, no scale, no legend. Screen-space drift with a
// trailing-wake fade (the earth.nullschool technique, simplified): the wind
// field is uniform at the point scale this tool plans at, so every particle
// advects along the same vector at a speed proportional to the wind.
//
// Reduced motion removes the particles entirely rather than slowing them. The
// preference is injected once at construction, because that is when the app
// reads it — a pilot who changes the OS setting mid-session gets the change on
// the next load, which is what this has always done.
//
// `start` and `stop` sit beside the layer contract rather than inside it: an
// animation is not a render, and the host is the only thing that knows the map
// tab just went off screen. Frames are not burned behind a hidden panel.

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

  /** @param {MapAdapter} adapter */
  function ensureCanvas(adapter) {
    if (reducedMotion || canvas) return;
    host = adapter.container();
    canvas = document.createElement('canvas');
    canvas.className = 'wind-particles';
    host.appendChild(canvas);
    ctx = canvas.getContext('2d');
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
    ctx.strokeStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--wind-particle').trim() || PARTICLE_STROKE;
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

      if (!control) {
        control = adapter.control({
          /* Bottom-right: the top-right corner is the MapToolbar's (M10), and a
           * readout under an icon rail would read as one of its buttons. */
          position: 'bottomright',
          className: 'wind-control',
          html: '<span class="wind-arrow">➤</span><span class="wind-text"></span>',
        });
      }
      const el = control.element();
      if (!el) return;
      const arrow = /** @type {HTMLElement|null} */ (el.querySelector('.wind-arrow'));
      const text = el.querySelector('.wind-text');
      // "➤" points right, which is a 90° bearing; the air flows toward
      // windFromDeg + 180, so the rotation is (from + 90).
      if (arrow) arrow.style.transform = `rotate(${(windFromDeg + 90) % 360}deg)`;
      if (text) {
        text.textContent = `${Math.round(frame.units.speedFromMs(Number(env.windAvgMs) || 0))} `
          + `${frame.units.speedUnit} from ${Math.round(windFromDeg)}°`;
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
      host = null;
      particles = [];
      control?.remove();
      control = null;
    },
  };
}
