/**
 * Procedural combat audio: no files, no dependencies, a handful of short
 * oscillator and noise envelopes. The context is created on the first user
 * gesture (browsers block it before that), and every sound is fire-and-forget.
 */
export class Sfx {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  constructor() {
    const unlock = (): void => {
      this.ensure();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  /** Air moved by the blade: the "you swung" cue, hit or miss. */
  swing(heavy: boolean): void {
    this.noise(heavy ? 0.22 : 0.16, 0.05, 'bandpass', heavy ? 900 : 1600, heavy ? 380 : 520);
  }

  /** Weapon meeting bone or shield. */
  impact(heavy: boolean): void {
    this.tone(heavy ? 170 : 210, 55, heavy ? 0.18 : 0.13, heavy ? 0.2 : 0.13);
    this.noise(0.07, heavy ? 0.12 : 0.08, 'lowpass', 1400, 300);
  }

  /** Bowstring loosed: a short snap of air, no file. */
  bowRelease(heavy: boolean): void {
    this.noise(0.08, heavy ? 0.07 : 0.05, 'highpass', heavy ? 1700 : 2300, 800);
    this.tone(heavy ? 150 : 195, 95, 0.09, heavy ? 0.07 : 0.05, 'triangle');
  }

  /** Arrow meeting wood, stone or bone. */
  arrowHit(): void {
    this.tone(300, 105, 0.09, 0.09);
    this.noise(0.05, 0.06, 'bandpass', 1400, 420);
  }

  /** Magic projectile loosed from staff: resonant rising chime and arcane whoosh. */
  magicCast(heavy: boolean): void {
    this.tone(heavy ? 220 : 360, heavy ? 580 : 780, heavy ? 0.2 : 0.14, heavy ? 0.14 : 0.08, 'sine');
    this.noise(heavy ? 0.16 : 0.1, heavy ? 0.08 : 0.05, 'bandpass', heavy ? 1800 : 2600, heavy ? 800 : 1200);
  }

  /** Magic impact against enemy, wall or ground: crystal burst and resonant ping. */
  magicHit(heavy: boolean): void {
    this.tone(heavy ? 420 : 540, heavy ? 90 : 180, heavy ? 0.24 : 0.14, heavy ? 0.18 : 0.1, 'sine');
    this.tone(heavy ? 840 : 1080, heavy ? 220 : 360, heavy ? 0.18 : 0.09, heavy ? 0.08 : 0.04, 'triangle');
    this.noise(heavy ? 0.2 : 0.1, heavy ? 0.12 : 0.07, heavy ? 'lowpass' : 'bandpass', heavy ? 1800 : 2200, heavy ? 250 : 600);
  }

  /** Shield ringing off a blow. */
  block(): void {
    this.tone(520, 470, 0.12, 0.06, 'triangle');
    this.tone(1040, 880, 0.09, 0.035, 'triangle');
    this.noise(0.08, 0.05, 'highpass', 2400, 1800);
  }

  /** Metallic clash when an incoming blow is countered during the counter window. */
  counterClash(): void {
    this.tone(780, 520, 0.28, 0.16, 'triangle');
    this.tone(1560, 1100, 0.22, 0.08, 'sine');
    this.noise(0.14, 0.06, 'highpass', 3200, 2400);
  }

  /** Heavy shield riposte strike slamming into the countered attacker. */
  shieldRiposte(): void {
    this.tone(180, 45, 0.32, 0.25, 'triangle');
    this.tone(480, 240, 0.18, 0.12, 'sine');
    this.noise(0.25, 0.14, 'lowpass', 1200, 200);
  }

  dodge(): void {
    this.noise(0.16, 0.035, 'bandpass', 500, 1500);
  }

  hurt(): void {
    this.tone(235, 90, 0.2, 0.12);
    this.noise(0.1, 0.05, 'lowpass', 900, 250);
  }

  enemyDeath(): void {
    this.tone(130, 45, 0.45, 0.13);
    this.noise(0.22, 0.05, 'lowpass', 800, 180);
  }

  private ensure(): AudioContext | null {
    if (this.muted) return null;

    if (!this.context) {
      const Ctor = window.AudioContext;
      if (!Ctor) return null;
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.context.destination);
    }

    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  private tone(
    startFrequency: number,
    endFrequency: number,
    duration: number,
    gain: number,
    type: OscillatorType = 'sine',
  ): void {
    const context = this.ensure();
    const master = this.master;
    if (!context || !master) return;

    const start = context.currentTime;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);

    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noise(
    duration: number,
    gain: number,
    filterType: BiquadFilterType,
    startFrequency: number,
    endFrequency: number,
  ): void {
    const context = this.ensure();
    const master = this.master;
    if (!context || !master) return;

    const start = context.currentTime;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();

    source.buffer = this.buildNoiseBuffer(context);
    filter.type = filterType;
    filter.Q.value = filterType === 'bandpass' ? 1.2 : 0.7;
    filter.frequency.setValueAtTime(startFrequency, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), start + duration);

    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(master);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  private buildNoiseBuffer(context: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const length = Math.floor(context.sampleRate * 0.35);
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    }
    return this.noiseBuffer;
  }
}
