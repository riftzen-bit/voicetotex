/**
 * Canvas-based scrolling waveform visualizer.
 * Renders RMS audio levels as a smooth, mirrored wave.
 * Optimized for Linux — avoids shadowBlur (extremely expensive in
 * software-rendered Canvas2D) and minimizes per-frame allocations.
 */

const SAMPLE_POINTS_MIN = 40;
const SAMPLE_POINTS_MAX = 60;
const SAMPLE_SPACING_CSS = 12;
const WAVE_MAX_AMPLITUDE_RATIO = 0.42;
const IDLE_TIMEOUT_MS = 240;
const IDLE_FLOOR = 0.02;
const IDLE_BREATH_AMPLITUDE = 0.055;
const IDLE_BREATH_SWAY = 0.03;
const IDLE_BREATH_HZ = 0.7;
const LERP_SPEED = 11;
const EDGE_FADE = 0.35;

// Number of layered fills to simulate a soft glow without shadowBlur.
const GLOW_LAYERS = 3;
const GLOW_BASE_ALPHA = 0.12;
const GLOW_EXPANSION_PX = 4;

function easeOutQuad(t) {
  return t * (2 - t);
}

export class WaveformVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });

    this._barColor = 'rgba(255, 68, 68, 0.85)';
    this._colorR = 255;
    this._colorG = 68;
    this._colorB = 68;
    this._colorA = 0.85;

    this._cssWidth = 0;
    this._cssHeight = 0;
    this._pxWidth = 0;
    this._pxHeight = 0;
    this._dpr = 1;
    this._waveMaxAmplitude = 0;

    this._maxBars = 0;
    this._bars = null;
    this._head = 0;
    this._count = 0;

    this._renderTargets = new Float32Array(0);
    this._renderValues = new Float32Array(0);

    // Reusable point arrays — avoids per-frame allocation.
    this._topPoints = [];
    this._bottomPoints = [];

    // Cached gradient — rebuilt only on resize or color change.
    this._fillGradient = null;
    this._gradientDirty = true;

    this._rafId = null;
    this._running = false;
    this._lastFrameTime = 0;
    this._lastPushTime = 0;

    this._resizeObserver = new ResizeObserver(() => this._resize());
    const parent = canvas.parentElement || canvas;
    this._resizeObserver.observe(parent);

    this._resize();
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                        */
  /* ------------------------------------------------------------------ */

  pushLevel(rms) {
    const clamped = Math.max(0, Math.min(1, rms));
    const eased = easeOutQuad(clamped);

    if (!this._bars || this._maxBars === 0) return;

    this._bars[this._head] = eased;
    this._head = (this._head + 1) % this._maxBars;
    if (this._count < this._maxBars) this._count++;

    this._lastPushTime = performance.now();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastFrameTime = performance.now();
    this._rafId = requestAnimationFrame((t) => this._tick(t));
  }

  stop() {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  reset() {
    if (this._bars) this._bars.fill(0);
    if (this._renderTargets) this._renderTargets.fill(0);
    if (this._renderValues) this._renderValues.fill(0);
    this._head = 0;
    this._count = 0;
    this._lastPushTime = 0;
  }

  setColor(color) {
    this._barColor = color;
    this._parseColor(color);
    this._gradientDirty = true;
  }

  destroy() {
    this.stop();
    this._resizeObserver.disconnect();
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  _parseColor(color) {
    const m = color.match(
      /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/
    );
    if (m) {
      this._colorR = parseInt(m[1], 10);
      this._colorG = parseInt(m[2], 10);
      this._colorB = parseInt(m[3], 10);
      this._colorA = m[4] !== undefined ? parseFloat(m[4]) : 1;
    }
  }

  _rgba(a) {
    return `rgba(${this._colorR},${this._colorG},${this._colorB},${a.toFixed(3)})`;
  }

  _resize() {
    this._dpr = window.devicePixelRatio || 1;

    const parent = this._canvas.parentElement || this._canvas;
    const rect = parent.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    this._cssWidth = rect.width;
    this._cssHeight = rect.height;
    this._pxWidth = Math.round(this._cssWidth * this._dpr);
    this._pxHeight = Math.round(this._cssHeight * this._dpr);

    this._canvas.width = this._pxWidth;
    this._canvas.height = this._pxHeight;
    this._canvas.style.width = this._cssWidth + 'px';
    this._canvas.style.height = this._cssHeight + 'px';

    this._waveMaxAmplitude = this._pxHeight * WAVE_MAX_AMPLITUDE_RATIO;
    this._gradientDirty = true;

    const idealPoints = Math.round(this._cssWidth / SAMPLE_SPACING_CSS);
    const clampedPoints = Math.max(SAMPLE_POINTS_MIN, Math.min(SAMPLE_POINTS_MAX, idealPoints));
    const newMax = Math.max(2, clampedPoints);

    if (newMax !== this._maxBars) {
      const oldBars = this._bars;
      const oldCount = this._count;
      const oldHead = this._head;
      const oldMax = this._maxBars;

      this._maxBars = newMax;
      this._bars = new Float32Array(newMax);

      if (oldBars && oldCount > 0) {
        const toCopy = Math.min(oldCount, newMax);
        for (let i = 0; i < toCopy; i++) {
          const srcIdx = (oldHead - oldCount + i + oldMax) % oldMax;
          this._bars[i] = oldBars[srcIdx];
        }
        this._count = toCopy;
        this._head = toCopy % newMax;
      } else {
        this._count = 0;
        this._head = 0;
      }

      this._renderTargets = new Float32Array(newMax);
      this._renderValues = new Float32Array(newMax);

      // Pre-allocate point arrays.
      this._topPoints = new Array(newMax);
      this._bottomPoints = new Array(newMax);
      for (let i = 0; i < newMax; i++) {
        this._topPoints[i] = { x: 0, y: 0 };
        this._bottomPoints[i] = { x: 0, y: 0 };
      }
    }
  }

  _ensureGradient() {
    if (!this._gradientDirty) return;
    const h = this._pxHeight;
    const g = this._ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, this._rgba(this._colorA * 0.02));
    g.addColorStop(0.5, this._rgba(this._colorA * 0.38));
    g.addColorStop(1, this._rgba(this._colorA * 0.02));
    this._fillGradient = g;
    this._gradientDirty = false;
  }

  _tick(now) {
    if (!this._running) return;

    const dt = (now - this._lastFrameTime) / 1000;
    this._lastFrameTime = now;

    this._draw(now, dt);

    this._rafId = requestAnimationFrame((t) => this._tick(t));
  }

  _draw(now, dt) {
    const ctx = this._ctx;
    const w = this._pxWidth;
    const h = this._pxHeight;

    ctx.clearRect(0, 0, w, h);

    const points = this._renderValues.length;
    if (points === 0) return;

    const centerY = h * 0.5;
    const xStep = points > 1 ? w / (points - 1) : w;
    const idle = this._lastPushTime <= 0 || (now - this._lastPushTime) > IDLE_TIMEOUT_MS;
    const lerpAlpha = 1 - Math.exp(-Math.max(0.001, dt) * LERP_SPEED);

    // Update render values and populate point arrays (no allocation).
    for (let i = 0; i < points; i++) {
      const t = points > 1 ? i / (points - 1) : 0;
      const ageFloat = (1 - t) * Math.max(0, this._count - 1);
      const age = Math.round(ageFloat);

      let level = 0;
      if (this._count > 0 && this._maxBars > 0) {
        const idx = (this._head - 1 - age + this._maxBars) % this._maxBars;
        level = this._bars[idx] || 0;
      }

      const breathPhase = (now * 0.001 * IDLE_BREATH_HZ * Math.PI * 2) + (i * 0.22);
      const breath = IDLE_FLOOR + IDLE_BREATH_AMPLITUDE + (Math.sin(breathPhase) * IDLE_BREATH_SWAY);

      const target = idle
        ? Math.max(level * 0.25, breath)
        : Math.max(IDLE_FLOOR, level);

      this._renderTargets[i] = target;
      this._renderValues[i] += (target - this._renderValues[i]) * lerpAlpha;

      const x = i * xStep;
      const edgeSin = Math.sin(t * Math.PI);
      const edgeAttenuation = EDGE_FADE + ((1 - EDGE_FADE) * edgeSin);
      const amplitude = this._renderValues[i] * this._waveMaxAmplitude * edgeAttenuation;

      this._topPoints[i].x = x;
      this._topPoints[i].y = centerY - amplitude;
      this._bottomPoints[points - 1 - i].x = x;
      this._bottomPoints[points - 1 - i].y = centerY + amplitude;
    }

    this._ensureGradient();

    // --- Glow: multiple expanded semi-transparent fills (no shadowBlur). ---
    for (let layer = GLOW_LAYERS; layer >= 1; layer--) {
      const expand = layer * GLOW_EXPANSION_PX * this._dpr;
      const alpha = GLOW_BASE_ALPHA / layer;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this._rgba(this._colorA * 0.5);
      ctx.beginPath();
      this._traceBezierExpanded(this._topPoints, this._bottomPoints, points, centerY, expand);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // --- Main fill ---
    ctx.beginPath();
    this._traceBezier(this._topPoints, points, true);
    this._traceBezier(this._bottomPoints, points, false);
    ctx.closePath();
    ctx.fillStyle = this._fillGradient;
    ctx.fill();

    // --- Stroke (top + bottom outlines) ---
    ctx.lineWidth = Math.max(1.5, 1.8 * this._dpr);
    ctx.strokeStyle = this._rgba(this._colorA * 0.92);

    ctx.beginPath();
    this._traceBezier(this._topPoints, points, true);
    ctx.stroke();

    ctx.beginPath();
    this._traceBezier(this._bottomPoints, points, true);
    ctx.stroke();
  }

  _traceBezier(pts, count, moveToStart) {
    if (count === 0) return;
    const ctx = this._ctx;

    if (moveToStart) {
      ctx.moveTo(pts[0].x, pts[0].y);
    }

    for (let i = 0; i < count - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(count - 1, i + 2)];

      const cp1x = p1.x + ((p2.x - p0.x) / 6);
      const cp1y = p1.y + ((p2.y - p0.y) / 6);
      const cp2x = p2.x - ((p3.x - p1.x) / 6);
      const cp2y = p2.y - ((p3.y - p1.y) / 6);

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  /**
   * Trace an expanded shape from top + bottom point arrays for the glow effect.
   * Pushes points outward from centerY by `expand` pixels.
   */
  _traceBezierExpanded(topPts, bottomPts, count, centerY, expand) {
    if (count === 0) return;
    const ctx = this._ctx;

    // Expanded top line (pushed upward).
    ctx.moveTo(topPts[0].x, topPts[0].y - expand);
    for (let i = 0; i < count - 1; i++) {
      const p0 = topPts[Math.max(0, i - 1)];
      const p1 = topPts[i];
      const p2 = topPts[i + 1];
      const p3 = topPts[Math.min(count - 1, i + 2)];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y - expand + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - expand - (p3.y - p1.y) / 6,
        p2.x, p2.y - expand,
      );
    }

    // Expanded bottom line (pushed downward), reversed.
    for (let i = 0; i < count - 1; i++) {
      const p0 = bottomPts[Math.max(0, i - 1)];
      const p1 = bottomPts[i];
      const p2 = bottomPts[i + 1];
      const p3 = bottomPts[Math.min(count - 1, i + 2)];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y + expand + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y + expand - (p3.y - p1.y) / 6,
        p2.x, p2.y + expand,
      );
    }
  }
}
