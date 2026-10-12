/* VOXMIDI drum core: onset detection + 3-zone beatbox classifier.
 * Pure DSP, no DOM. Kick / snare / hat from spectral centroid + band
 * energy of each detected onset. Node-testable. */

const FFT_SIZE = 1024;

/** In-place radix-2 FFT on real input. Returns magnitudes (length N/2). */
export function fftMagnitudes(frame) {
  const n = FFT_SIZE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const len = Math.min(frame.length, n);
  // Hann window
  for (let i = 0; i < len; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
    re[i] = frame[i] * w;
  }
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const t = re[i]; re[i] = re[j]; re[j] = t;
      const u = im[i]; im[i] = im[j]; im[j] = u;
    }
  }
  // Cooley-Tukey
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = (-2 * Math.PI * k * step) / n;
        const wr = Math.cos(angle), wi = Math.sin(angle);
        const xr = re[i + k + half] * wr - im[i + k + half] * wi;
        const xi = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k + half] = re[i + k] - xr;
        im[i + k + half] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
    }
  }
  const mags = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
  return mags;
}

/** Spectral centroid in Hz from magnitudes. */
export function spectralCentroid(mags, sampleRate) {
  let num = 0, den = 0;
  const binHz = sampleRate / FFT_SIZE;
  for (let i = 1; i < mags.length; i++) {
    num += i * binHz * mags[i];
    den += mags[i];
  }
  return den === 0 ? 0 : num / den;
}

/** Energy in a frequency band [lo, hi) Hz. */
export function bandEnergy(mags, sampleRate, lo, hi) {
  const binHz = sampleRate / FFT_SIZE;
  const i0 = Math.max(1, Math.floor(lo / binHz));
  const i1 = Math.min(mags.length - 1, Math.ceil(hi / binHz));
  let e = 0;
  for (let i = i0; i <= i1; i++) e += mags[i] * mags[i];
  return e;
}

/**
 * Feature vector for one onset frame: centroid + band energy ratios.
 * Ratios are in [0,1] and sum to ~1 (plus sub-40Hz content ignored).
 */
export function extractFeatures(frame, sampleRate) {
  const mags = fftMagnitudes(frame);
  const centroid = spectralCentroid(mags, sampleRate);
  const total = bandEnergy(mags, sampleRate, 40, sampleRate / 2);
  if (total <= 0) return null;
  return {
    centroid,
    lowR: bandEnergy(mags, sampleRate, 40, 500) / total,
    midR: bandEnergy(mags, sampleRate, 500, 3000) / total,
    highR: bandEnergy(mags, sampleRate, 3000, sampleRate / 2) / total,
  };
}

/**
 * Distance between two feature vectors. Log-centroid keeps octaves linear;
 * band ratios are compared directly.
 */
export function featureDistance(a, b) {
  const dc = Math.log2((a.centroid + 50) / (b.centroid + 50));
  const dl = a.lowR - b.lowR;
  const dm = a.midR - b.midR;
  const dh = a.highR - b.highR;
  return Math.sqrt(dc * dc * 2 + dl * dl + dm * dm + dh * dh);
}

/** Default templates, measured from synthesized reference hits. */
export const DEFAULT_TEMPLATES = {
  kick:  { centroid: 120,   lowR: 0.95, midR: 0.04, highR: 0.01 },
  snare: { centroid: 2300,  lowR: 0.05, midR: 0.70, highR: 0.25 },
  hat:   { centroid: 10500, lowR: 0.01, midR: 0.02, highR: 0.97 },
};

/**
 * Classify features against templates (nearest neighbor).
 * Returns {kind, centroid, confidence} or null when nothing is close enough.
 * confidence = 1 at zero distance, falling to 0 at maxDistance.
 */
export function classifyFeatures(feat, templates = DEFAULT_TEMPLATES, maxDistance = 1.1) {
  if (!feat) return null;
  let best = null, bestD = Infinity;
  for (const kind of Object.keys(templates)) {
    const d = featureDistance(feat, templates[kind]);
    if (d < bestD) { bestD = d; best = kind; }
  }
  if (bestD > maxDistance) return null;
  return { kind: best, centroid: Math.round(feat.centroid), confidence: Math.max(0, 1 - bestD / maxDistance) };
}

/** Backwards-compatible single-frame classifier using default templates. */
export function classifyHit(frame, sampleRate, templates) {
  return classifyFeatures(extractFeatures(frame, sampleRate), templates);
}

/**
 * Streaming onset detector. Feed RMS + frame per analysis tick; emits
 * onHit({kind, velocity, centroid, confidence}) via callback.
 */
export class OnsetDetector {
  constructor(onHit, opts = {}) {
    this.onHit = onHit;
    this.sampleRate = opts.sampleRate ?? 48000;
    this.cooldownMs = opts.cooldownMs ?? 130;
    this.minRms = opts.minRms ?? 0.03;
    this.k = opts.k ?? 1.8;            // flux must exceed k * median recent flux
    this.history = new Float64Array(24);
    this.hi = 0;
    this.prevLogE = -Infinity;
    this.lastHitAt = -Infinity;
    this.minConfidence = opts.minConfidence ?? 0.45;
    this.templates = opts.templates ?? DEFAULT_TEMPLATES;
  }

  setTemplates(t) { this.templates = t; }

  reset() {
    this.history.fill(0); this.hi = 0;
    this.prevLogE = -Infinity; this.lastHitAt = -Infinity;
  }

  /** frame: Float32Array time-domain samples; nowMs: timestamp. */
  process(frame, rms, nowMs) {
    const logE = Math.log10(rms + 1e-9);
    const flux = Math.max(0, logE - this.prevLogE);
    this.prevLogE = logE;

    // Running median of recent flux (insertion into fixed history).
    this.history[this.hi % this.history.length] = flux;
    this.hi++;
    const sorted = Float64Array.from(this.history).sort();
    const median = sorted[Math.floor(sorted.length / 2)];
    const gate = Math.max(0.12, this.k * median);

    if (flux > gate && rms > this.minRms && nowMs - this.lastHitAt > this.cooldownMs) {
      const hit = classifyHit(frame, this.sampleRate, this.templates);
      if (hit && hit.confidence >= this.minConfidence) {
        this.lastHitAt = nowMs;
        this.onHit({
          kind: hit.kind,
          velocity: Math.max(30, Math.min(127, Math.round(50 + 300 * rms))),
          centroid: hit.centroid,
          confidence: hit.confidence,
        });
        return true;
      }
    }
    return false;
  }
}
