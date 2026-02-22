export class SoundFeedback {
  constructor() {
    this._ctx = null;
  }

  warmUp() {
    if (!this._ctx) {
      this._ctx = new AudioContext();
    }
    if (this._ctx.state === 'suspended') {
      this._ctx.resume();
    }
  }

  _ensureContext() {
    this.warmUp();
    return this._ctx;
  }

  /** Rising two-tone chirp — recording started */
  playRecordingStart() {
    const ctx = this._ensureContext();
    const now = ctx.currentTime;
    // Primary tone: rising chirp
    this._playTone(ctx, 520, now, 0.15, 0.45, 'sine');
    this._playTone(ctx, 780, now + 0.12, 0.18, 0.5, 'sine');
    // Harmonic layer for richness
    this._playTone(ctx, 1040, now + 0.12, 0.14, 0.18, 'triangle');
  }

  /** Falling two-tone chirp — recording stopped */
  playRecordingStop() {
    const ctx = this._ensureContext();
    const now = ctx.currentTime;
    this._playTone(ctx, 680, now, 0.14, 0.45, 'sine');
    this._playTone(ctx, 440, now + 0.11, 0.18, 0.4, 'sine');
    this._playTone(ctx, 880, now, 0.1, 0.12, 'triangle');
  }

  /** Bright triple chime — transcript ready */
  playTranscriptDone() {
    const ctx = this._ensureContext();
    const now = ctx.currentTime;
    this._playTone(ctx, 784, now, 0.14, 0.4, 'sine');        // G5
    this._playTone(ctx, 988, now + 0.13, 0.14, 0.4, 'sine'); // B5
    this._playTone(ctx, 1318, now + 0.26, 0.22, 0.45, 'sine'); // E6
    // Shimmer
    this._playTone(ctx, 1568, now + 0.13, 0.25, 0.1, 'triangle');
    this._playTone(ctx, 2636, now + 0.26, 0.2, 0.06, 'triangle');
  }

  _playTone(ctx, freq, startTime, duration, gain, waveType = 'sine') {
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.type = waveType;
    osc.frequency.value = freq;
    vol.gain.setValueAtTime(gain, startTime);
    vol.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(vol);
    vol.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  }
}
