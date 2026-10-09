export type SoundCue = 'shot' | 'hit' | 'damage' | 'reload' | 'kill' | 'ui' | 'empty';

/** Small oscillator-only effects; no downloaded audio and no autoplay before interaction. */
export class SoundManager {
  private context: AudioContext | null = null;
  private enabled = true;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) void this.resume();
  }

  async unlock(): Promise<void> {
    if (!this.enabled || typeof window === 'undefined') return;
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    if (!this.context) this.context = new AudioContextConstructor();
    await this.resume();
  }

  private async resume(): Promise<void> {
    if (this.context?.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        // Browsers may still reject resume until a direct user gesture.
      }
    }
  }

  play(cue: SoundCue): void {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    const ctx = this.context;

    if (cue === 'shot') {
      this.tone(145, 53, 0.105, 'sawtooth', 0.075, now, 520);
      this.tone(620, 180, 0.038, 'square', 0.018, now, 1200);
      return;
    }

    if (cue === 'hit') {
      this.tone(720, 1040, 0.075, 'triangle', 0.045, now, 1800);
      return;
    }

    if (cue === 'damage') {
      this.tone(230, 86, 0.19, 'sawtooth', 0.055, now, 440);
      return;
    }

    if (cue === 'reload') {
      this.tone(420, 300, 0.09, 'square', 0.024, now, 900);
      this.tone(580, 440, 0.12, 'triangle', 0.025, now + 0.18, 1000);
      return;
    }

    if (cue === 'kill') {
      this.tone(530, 880, 0.08, 'triangle', 0.035, now, 1500);
      this.tone(770, 1160, 0.12, 'sine', 0.028, now + 0.075, 1700);
      return;
    }

    if (cue === 'empty') {
      this.tone(180, 130, 0.065, 'square', 0.025, now, 480);
      return;
    }

    // Light UI tick.
    this.tone(480, 390, 0.045, 'sine', 0.018, now, 900);
    void ctx;
  }

  private tone(
    startHz: number,
    endHz: number,
    duration: number,
    type: OscillatorType,
    volume: number,
    startAt: number,
    filterHz: number,
  ): void {
    const ctx = this.context;
    if (!ctx) return;

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startHz, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(25, endHz), startAt + duration);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterHz, startAt);
    gain.gain.setValueAtTime(Math.max(0.0001, volume), startAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.015);
    oscillator.onended = () => {
      oscillator.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  dispose(): void {
    if (!this.context) return;
    void this.context.close();
    this.context = null;
  }
}
