'use strict';

// Audio worklet processors, loaded from a Blob so they also work when the app runs from file://.
const Worklets = {
  url: null,

  code: `
// Look-ahead brick-wall limiter. The output never exceeds 'ceil':
// the gain is the moving average of a sliding minimum of the per-sample gain needed,
// applied to audio delayed by the same window, so it is always low enough when a peak arrives.
class TpLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 64, automationRate: 'k-rate' },
      { name: 'ceil', defaultValue: 0.89, minValue: 0.01, maxValue: 1, automationRate: 'k-rate' },
      { name: 'rel', defaultValue: 0.08, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    const D = this.D = Math.max(8, Math.round(sampleRate * 0.005));
    this.tg = new Float32Array(D).fill(1);
    this.rb = new Float32Array(D).fill(1);
    this.dl = new Float32Array(D);
    this.dr = new Float32Array(D);
    this.i = 0; this.mn = 1; this.r = 1;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!out.length) return true;
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1], n = oL.length;
    const g = params.gain[0], c = params.ceil[0], rc = 1 - Math.exp(-1 / (params.rel[0] * sampleRate));
    const D = this.D, tg = this.tg, rb = this.rb, dl = this.dl, dr = this.dr;
    let i = this.i, mn = this.mn, r = this.r, sum = 0;
    for (let j = 0; j < D; j++) sum += rb[j];
    for (let k = 0; k < n; k++) {
      const l = iL ? iL[k] * g : 0, rr = iR ? iR[k] * g : 0;
      const al = l < 0 ? -l : l, ar = rr < 0 ? -rr : rr, pk = al > ar ? al : ar;
      const t = pk > c ? c / pk : 1, old = tg[i];
      tg[i] = t;
      if (t <= mn) mn = t;
      else if (old <= mn) { mn = 1; for (let j = 0; j < D; j++) if (tg[j] < mn) mn = tg[j]; }
      r = mn < r ? mn : r + (mn - r) * rc;
      sum += r - rb[i]; rb[i] = r;
      dl[i] = l; dr[i] = rr;
      i = i + 1 === D ? 0 : i + 1;
      const a = sum / D;
      oL[k] = dl[i] * a;
      if (oR) oR[k] = dr[i] * a;
    }
    this.i = i; this.mn = mn; this.r = r;
    return true;
  }
}
registerProcessor('tp-limiter', TpLimiter);

// Passes microphone input back to the main thread as raw samples.
class TpRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp[0]) this.port.postMessage(inp.map(ch => ch.slice()));
    return true;
  }
}
registerProcessor('tp-recorder', TpRecorder);
`,

  // Resolves either way; ctx._tp says whether the processors are available on that context.
  async add(ctx) {
    try {
      if (!this.url) this.url = URL.createObjectURL(new Blob([this.code], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(this.url);
      ctx._tp = true;
    } catch (e) {
      console.warn('Audio worklets unavailable, using fallbacks', e);
      ctx._tp = false;
    }
  },
};
