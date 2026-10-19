// Synthesized car audio: a 4-cylinder engine built from individual exhaust
// pulses (AudioWorklet), an automatic gearbox, backfires on lift-off, gravel
// spray when the tyres spin, wind, landing thumps, pickups and crash.

const ENGINE_WORKLET = `
class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 900, minValue: 300, maxValue: 9000, automationRate: 'k-rate' },
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

const GEARS = [6.0, 3.9, 2.6, 1.75, 1.15];   // 5th reaches the redline near top speed
const RPM_PER_WHEEL = 128;          // engine rpm per (wheel rad/s × gear ratio)
const IDLE = 900, REDLINE = 6800;

export class CarAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.ready = false;
    this.rpm = IDLE;
    this.gear = 0;
    this.throttle = 0;
    this.shiftTimer = 0;
    this.prevGas = false;
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
    this.gravel = loop('bandpass', 2200, 0.7);
    this.wind = loop('lowpass', 500, 0.5);
    this.ready = true;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  // Gearbox + engine model; also returns rpm/gear for the HUD tachometer.
  // wheelW: average wheel speed (rad/s), grounded: any wheel touching.
  update(dt, { wheelW, gas, brake, grounded, speed, slip, running }) {
    const want = gas || brake ? 1 : 0;
    this.throttle += (want - this.throttle) * Math.min(1, dt * (want ? 9 : 5));
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    const w = Math.abs(wheelW);
    let target = IDLE + w * GEARS[this.gear] * RPM_PER_WHEEL;
    if (gas && this.gear === 0) target = Math.max(target, IDLE + 2600 * this.throttle);   // clutch slip off the line
    if (gas && !grounded) target = Math.max(target, REDLINE * 0.92);                        // free-revving in the air
    if (!running) target = 0;
    target = Math.min(REDLINE + 150, target);

    if (running && this.shiftTimer === 0 && grounded) {
      if (this.rpm > REDLINE - 500 && this.gear < GEARS.length - 1) { this.gear++; this.shiftTimer = 0.32; this.shiftDip(); }
      else if (this.rpm < 2600 && this.gear > 0) { this.gear--; this.shiftTimer = 0.25; }
    }
    if (w < 3 && !gas) this.gear = 0;

    const k = target > this.rpm ? (this.shiftTimer > 0 ? 3 : 7) : 4;
    this.rpm += (target - this.rpm) * Math.min(1, dt * k);

    // lift-off at high revs: exhaust crackle
    if (this.prevGas && !gas && this.rpm > 4300 && running) this.backfire();
    this.prevGas = gas;

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const rpm = Math.max(300, this.rpm);
    const load = this.shiftTimer > 0.15 ? 0.1 : this.throttle;
    if (this.rpmParam) {
      this.rpmParam.setTargetAtTime(rpm, t, 0.03);
      this.loadParam.setTargetAtTime(load, t, 0.04);
    } else {
      const hz = rpm / 60 * 2;
      this.oscA.frequency.setTargetAtTime(hz, t, 0.03);
      this.oscB.frequency.setTargetAtTime(hz / 2, t, 0.03);
    }
    this.cutoff.frequency.setTargetAtTime(500 + rpm * 0.28 + load * 1900, t, 0.05);
    const vol = running ? 0.22 + 0.2 * load + 0.1 * (rpm / REDLINE) : 0;
    this.engGain.gain.setTargetAtTime(vol, t, 0.06);

    const spray = running && grounded ? Math.min(1, Math.max(0, (slip - 120) / 500)) : 0;
    this.gravel.g.gain.setTargetAtTime(spray * 0.22, t, 0.05);
    this.gravel.f.frequency.setTargetAtTime(1600 + Math.random() * 1400, t, 0.02);
    this.wind.g.gain.setTargetAtTime(running ? Math.min(0.14, speed / 900 * 0.14) : 0, t, 0.2);
    this.wind.f.frequency.setTargetAtTime(300 + speed * 0.6, t, 0.2);
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

  coin(big) {
    if (!this.ready) return;
    const notes = big ? [1047, 1319, 1568, 2093] : [1319, 1976];
    notes.forEach((n, i) => {
      this.tone(n, 0.18, 0.07, 'triangle', i * 0.045);
      this.tone(n * 2, 0.08, 0.025, 'sine', i * 0.045);
    });
  }

  fuel() {
    if (!this.ready) return;
    for (let i = 0; i < 3; i++) this.tone(380 - i * 40, 0.12, 0.12, 'sine', i * 0.08, 160);
    this.tone(880, 0.35, 0.08, 'triangle', 0.26);
    this.tone(1320, 0.35, 0.05, 'triangle', 0.3);
  }

  land(strength) {
    if (!this.ready) return;
    const s = Math.min(1, strength);
    this.tone(85, 0.22, 0.35 * s, 'sine', 0, 38);
    this.burst(0.004, 0.12, 350, 'lowpass', 0.3 * s);
    if (s > 0.5) this.tone(240, 0.18, 0.05 * s, 'square', 0.02, 180);   // suspension clunk
  }

  scrape(strength) {
    if (!this.ready) return;
    this.burst(0.005, 0.18, 2600, 'bandpass', 0.18 * Math.min(1, strength));
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

  outOfFuel() {
    if (!this.ready) return;
    [3, 2, 1].forEach((k, i) => this.tone(110 * k, 0.25, 0.08, 'sawtooth', i * 0.16, 90 * k));
  }
}
