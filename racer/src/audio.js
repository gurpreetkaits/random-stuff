// Synthesized car audio: an engine built from individual exhaust pulses
// (AudioWorklet), backfires on lift-off, tyre squeal, wind, impacts and the
// race countdown. The car physics owns the gearbox; this just voices it.

const ENGINE_WORKLET = `
class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 1800, minValue: 300, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.phase = 0; this.cyl = 0; this.env = 0; this.body = 0;
    this.dcx = 0; this.dcy = 0; this.lp = 0; this.lp2 = 0;
    this.cylGain = [1, 0.86, 0.95, 0.9];   // uneven cylinders give the lumpy idle
  }
  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    const rpm = params.rpm[0], load = params.load[0];
    const fireHz = rpm / 60 * 2;                        // 4 cylinders, 4-stroke
    const inc = fireHz / sampleRate;
    const pulseLen = 0.0016 + 0.0045 * (1 - Math.min(1, rpm / 7000));
    const decay = Math.exp(-1 / (sampleRate * pulseLen));
    const bodyDecay = Math.exp(-1 / (sampleRate * 0.012));
    for (let i = 0; i < out.length; i++) {
      this.phase += inc;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.cyl = (this.cyl + 1) & 3;
        const kick = this.cylGain[this.cyl] * (0.35 + 0.65 * load) * (0.88 + Math.random() * 0.24);
        this.env = kick;
        this.body += kick * 0.5;
      }
      const noise = Math.random() * 2 - 1;
      // sharp pressure pulse + a softer resonant body that carries the pitch
      const x = this.env * (0.75 + noise * (0.25 + 0.35 * load)) + this.body * 0.6;
      this.env *= decay;
      this.body *= bodyDecay;
      // DC blocker, then two gentle low-passes for the muffler
      this.dcy = x - this.dcx + 0.995 * this.dcy; this.dcx = x;
      this.lp += (this.dcy - this.lp) * 0.35;
      this.lp2 += (this.lp - this.lp2) * 0.5;
      out[i] = this.lp2 * 0.55;
    }
    return true;
  }
}
registerProcessor('engine-processor', EngineProcessor);
`;

const REDLINE = 8000;

export class CarAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.ready = false;
    this.rpm = 950;
    this.throttle = 0;
    this.prevThrottle = 0;
  }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // engine tone chain: source → drive → body EQ → cutoff → gain
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(2.2 * x); }
    drive.curve = curve;
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 160; low.gain.value = 7;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 420; mid.Q.value = 1.2; mid.gain.value = 4;
    this.cutoff = ctx.createBiquadFilter(); this.cutoff.type = 'lowpass'; this.cutoff.frequency.value = 900; this.cutoff.Q.value = 0.9;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    drive.connect(low).connect(mid).connect(this.cutoff).connect(this.engGain).connect(this.master);

    try {
      // data: URLs load from file:// pages, where blob: worklet modules are refused
      try {
        await ctx.audioWorklet.addModule('data:application/javascript,' + encodeURIComponent(ENGINE_WORKLET));
      } catch {
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([ENGINE_WORKLET], { type: 'application/javascript' })));
      }
      this.engine = new AudioWorkletNode(ctx, 'engine-processor', { outputChannelCount: [1] });
      this.engine.connect(drive);
      this.rpmParam = this.engine.parameters.get('rpm');
      this.loadParam = this.engine.parameters.get('load');
    } catch {
      // Fallback: two detuned oscillators at the firing frequency.
      this.oscA = ctx.createOscillator(); this.oscA.type = 'sawtooth';
      this.oscB = ctx.createOscillator(); this.oscB.type = 'square';
      const gb = ctx.createGain(); gb.gain.value = 0.4;
      this.oscA.connect(drive); this.oscB.connect(gb).connect(drive);
      this.oscA.start(); this.oscB.start();
    }

    // looping noise beds: gravel spray and wind
    const loop = (filterType, freq, q) => {
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master); src.start();
      return { g, f };
    };
    this.gravel = loop('bandpass', 1400, 0.6);
    this.squeal = loop('bandpass', 1100, 9);
    this.wind = loop('lowpass', 500, 0.5);
    this.ready = true;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  // rpm/gear come from the car. throttle 0..1, slide 0..1 (tyre squeal),
  // speed m/s, grass: on the grass, running: engine on.
  update(dt, { rpm, throttle, slide, speed, grass, running, shifted }) {
    this.throttle += (throttle - this.throttle) * Math.min(1, dt * (throttle > this.throttle ? 10 : 5));
    this.rpm = rpm;
    if (shifted > 0) this.shiftDip();
    if (this.prevThrottle > 0.6 && throttle < 0.1 && rpm > 5500 && running && Math.random() < 0.7) this.backfire();
    this.prevThrottle = throttle;

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const r = Math.max(400, rpm);
    // sound like a V8: two pulse trains, the second half a step lower
    if (this.rpmParam) {
      this.rpmParam.setTargetAtTime(r * 2, t, 0.02);
      this.loadParam.setTargetAtTime(this.throttle, t, 0.03);
    } else {
      const hz = r / 60 * 4;
      this.oscA.frequency.setTargetAtTime(hz, t, 0.02);
      this.oscB.frequency.setTargetAtTime(hz / 2, t, 0.02);
    }
    this.cutoff.frequency.setTargetAtTime(600 + r * 0.32 + this.throttle * 2600, t, 0.04);
    const vol = running ? 0.2 + 0.22 * this.throttle + 0.1 * (r / REDLINE) : 0;
    this.engGain.gain.setTargetAtTime(vol, t, 0.05);

    const squeal = running ? Math.min(1, Math.max(0, (slide - 0.12) * 2.2)) * Math.min(1, speed / 6) : 0;
    this.squeal.g.gain.setTargetAtTime(squeal * 0.16, t, 0.04);
    this.squeal.f.frequency.setTargetAtTime(900 + Math.random() * 500 + squeal * 400, t, 0.02);
    this.gravel.g.gain.setTargetAtTime(running && grass ? Math.min(0.25, speed / 40 * 0.25) : 0, t, 0.06);
    this.wind.g.gain.setTargetAtTime(running ? Math.min(0.16, speed / 75 * 0.16) : 0, t, 0.2);
    this.wind.f.frequency.setTargetAtTime(250 + speed * 14, t, 0.2);
  }

  impact(strength) {
    if (!this.ready) return;
    const s = Math.min(1, strength);
    this.burst(0.003, 0.25 + s * 0.2, 700, 'lowpass', 0.5 * s + 0.1);
    this.burst(0.003, 0.15, 3200, 'bandpass', 0.25 * s, 0.01);
    this.tone(90, 0.25, 0.35 * s, 'sine', 0, 40);
  }

  shiftDip() {
    if (!this.ready) return;
    this.burst(0.03, 0.05, 900, 'lowpass', 0.12);
  }

  // short filtered-noise hit
  burst(attack, decay, freq, type, vol, when = 0) {
    const ctx = this.ctx, t = ctx.currentTime + when;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + attack + decay + 0.05);
  }

  tone(freq, dur, vol, type = 'sine', when = 0, endFreq = null) {
    const ctx = this.ctx, t = ctx.currentTime + when;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  backfire() {
    if (!this.ready) return;
    const pops = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < pops; i++) {
      const w = i * (0.06 + Math.random() * 0.07);
      this.burst(0.002, 0.07, 700 + Math.random() * 500, 'lowpass', 0.5, w);
      this.tone(90, 0.08, 0.25, 'sine', w, 45);
    }
  }

  bonus() {
    if (!this.ready) return;
    [784, 988, 1175, 1568].forEach((n, i) => this.tone(n, 0.22, 0.07, 'square', i * 0.07));
  }

  crash() {
    if (!this.ready) return;
    this.burst(0.003, 0.6, 900, 'lowpass', 0.7);
    this.burst(0.003, 0.35, 3000, 'bandpass', 0.3, 0.02);
    this.tone(523, 0.9, 0.08, 'triangle', 0.01, 470);
    this.tone(741, 0.7, 0.06, 'triangle', 0.01, 690);
    this.tone(70, 0.4, 0.4, 'sine', 0, 30);
  }

  countBeep(go) {
    if (!this.ready) return;
    this.tone(go ? 1175 : 587, go ? 0.5 : 0.18, 0.12, 'square');
    this.tone(go ? 2350 : 1174, go ? 0.3 : 0.1, 0.03, 'sine');
  }

}
