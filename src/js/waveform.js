/**
 * Canvas-based scrolling waveform visualizer.
 * Renders RMS audio levels as a smooth, mirrored wave.
 * Standalone — no external dependencies, no Web Audio API.
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

function easeOutQuad(t) {
  return t * (2 - t);
}

export class WaveformVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');

    this._barColor = 'rgba(255, 68, 68, 0.85)';

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

  /**
   * Push an RMS level (0.0–1.0) as a new bar on the right edge.
   * @param {number} rms
   */
  pushLevel(rms) {
    const clamped = Math.max(0, Math.min(1, rms));
    const eased = easeOutQuad(clamped);

    if (!this._bars || this._maxBars === 0) return;

    this._bars[this._head] = eased;
    this._head = (this._head + 1) % this._maxBars;
    if (this._count < this._maxBars) this._count++;

    this._lastPushTime = performance.now();
  }

  /** Start the animation loop. */
  start() {
    if (this._running) return;
    this._running = true;
    this._lastFrameTime = performance.now();
    this._tick(this._lastFrameTime);
  }

  /** Stop the animation loop. */
  stop() {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Clear all bar data, reset to flat idle state. */
  reset() {
    if (this._bars) this._bars.fill(0);
    if (this._renderTargets) this._renderTargets.fill(0);
    if (this._renderValues) this._renderValues.fill(0);
    this._head = 0;
    this._count = 0;
    this._lastPushTime = 0;
  }

  /**
   * Change the active bar color.
   * @param {string} color — CSS color string
   */
  setColor(color) {
    this._barColor = color;
  }

  /** Full cleanup: stop animation, disconnect observer. */
  destroy() {
    this.stop();
    this._resizeObserver.disconnect();
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  /** Recalculate canvas dimensions for HiDPI and reallocate buffer. */
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
    }
  }

  /** Animation frame callback. */
  _tick(now) {
    if (!this._running) return;

    const dt = (now - this._lastFrameTime) / 1000;
    this._lastFrameTime = now;

    this._draw(now, dt);

    this._rafId = requestAnimationFrame((t) => this._tick(t));
  }

  /** Render smooth mirrored wave onto the canvas. */
  _draw(now, dt) {
    const ctx = this._ctx;
    const w = this._pxWidth;
    const h = this._pxHeight;

    ctx.clearRect(0, 0, w, h);
    if (this._renderValues.length === 0) return;

    const points = this._renderValues.length;
    const centerY = h * 0.5;
    const xStep = points > 1 ? w / (points - 1) : w;
    const idle = this._lastPushTime <= 0 || (now - this._lastPushTime) > IDLE_TIMEOUT_MS;
    const lerpAlpha = 1 - Math.exp(-Math.max(0.001, dt) * LERP_SPEED);

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
    }

    const topPoints = new Array(points);
    const bottomPoints = new Array(points);

    for (let i = 0; i < points; i++) {
      const x = i * xStep;
      const edgeAttenuation = EDGE_FADE + ((1 - EDGE_FADE) * Math.sin((i / Math.max(1, points - 1)) * Math.PI));
      const amplitude = this._renderValues[i] * this._waveMaxAmplitude * edgeAttenuation;

      topPoints[i] = { x, y: centerY - amplitude };
      bottomPoints[points - 1 - i] = { x, y: centerY + amplitude };
    }

    const fillGradient = ctx.createLinearGradient(0, 0, 0, h);
    fillGradient.addColorStop(0, this._alphaColor(this._barColor, 0.02));
    fillGradient.addColorStop(0.5, this._alphaColor(this._barColor, 0.38));
    fillGradient.addColorStop(1, this._alphaColor(this._barColor, 0.02));

    ctx.save();
    ctx.shadowColor = this._alphaColor(this._barColor, 0.45);
    ctx.shadowBlur = 10 * this._dpr;
    ctx.beginPath();
    this._traceBezier(topPoints, true);
    this._traceBezier(bottomPoints, false);
    ctx.closePath();
    ctx.fillStyle = fillGradient;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.lineWidth = Math.max(1.5, 1.8 * this._dpr);
    ctx.strokeStyle = this._alphaColor(this._barColor, 0.92);
    ctx.shadowColor = this._alphaColor(this._barColor, 0.55);
    ctx.shadowBlur = 8 * this._dpr;

    ctx.beginPath();
    this._traceBezier(topPoints, true);
    ctx.stroke();

    ctx.beginPath();
    this._traceBezier(bottomPoints, true);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw connected points with cubic Bezier smoothing.
   * @param {{x:number,y:number}[]} points
   * @param {boolean} moveToStart
   */
  _traceBezier(points, moveToStart) {
    if (!points || points.length === 0) return;

    if (moveToStart) {
      this._ctx.moveTo(points[0].x, points[0].y);
    }

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];

      const cp1x = p1.x + ((p2.x - p0.x) / 6);
      const cp1y = p1.y + ((p2.y - p0.y) / 6);
      const cp2x = p2.x - ((p3.x - p1.x) / 6);
      const cp2y = p2.y - ((p3.y - p1.y) / 6);

      this._ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  /**
   * Produce an alpha-scaled rgba color from an rgb/rgba CSS string.
   * @param {string} color
   * @param {number} alphaMultiplier
   * @returns {string}
   */
  _alphaColor(color, alphaMultiplier) {
    const rgbaMatch = color.match(
      /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/
    );
    if (!rgbaMatch) return color;

    const r = rgbaMatch[1];
    const g = rgbaMatch[2];
    const b = rgbaMatch[3];
    const baseAlpha = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
    const nextAlpha = Math.max(0, Math.min(1, baseAlpha * alphaMultiplier));
    return `rgba(${r}, ${g}, ${b}, ${nextAlpha.toFixed(3)})`;
  }
}
