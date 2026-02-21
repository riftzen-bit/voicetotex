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

  playRecordingStart() {
    const ctx = this._ensureContext();
    const now = ctx.currentTime;
    this._playTone(ctx, 660, now, 0.12, 0.7);
    this._playTone(ctx, 880, now + 0.13, 0.12, 0.7);
  }

  playRecordingStop() {
    const ctx = this._ensureContext();
    const now = ctx.currentTime;
    this._playTone(ctx, 880, now, 0.12, 0.6);
    this._playTone(ctx, 660, now + 0.13, 0.12, 0.6);
  }

  playTranscriptDone() {
    const ctx = this._ensureContext();
    const now = ctx.currentTime;
    this._playTone(ctx, 880, now, 0.15, 0.55);
    this._playTone(ctx, 660, now + 0.17, 0.15, 0.55);
    this._playTone(ctx, 520, now + 0.34, 0.20, 0.55);
  }

  _playTone(ctx, freq, startTime, duration, gain) {
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    vol.gain.setValueAtTime(gain, startTime);
    vol.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(vol);
    vol.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  }
}
