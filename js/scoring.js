// 發音相似度評分：MFCC + DTW 比對音段，音高曲線比對聲調。
// 純函式、不依賴瀏覽器 API；輸入為 16 kHz 單聲道 Float32Array。

export const SAMPLE_RATE = 16000;

const FRAME = 400; // 25 ms
const HOP = 160; // 10 ms
const NFFT = 512;
const NMEL = 26;
const NCEP = 13; // 含 c0，c0 不用

// 分數換算門檻。依 tools/calibrate.html 的結果設定：同詞變聲的音段距離中位數 2.5、
// 不同詞的 p10 為 3.4、中位數 3.8；門檻刻意放寬，讓不同說話者唸對時不致被低估。
// 用真人錄音驗證後可再調整（網址加 ?debug 可看到原始數值）。
export const CALIBRATION = {
  spectral: { best: 2.5, worst: 4.4 }, // DTW 平均每格 MFCC 距離
  tone: { best: 0.8, worst: 3.0 }, // 對齊後音高差的均方根（半音）
  toneWeight: 0.4,
  minVoicedPairs: 8,
  durationRatio: { min: 0.5, max: 2.0, penalty: 0.7 },
};

const SILENCE_DB = -45; // 整段最大音量低於此值視為沒有聲音
const TRIM_BELOW_PEAK_DB = 35; // 比最大音量低這麼多的頭尾視為靜音
const MIN_SPEECH_SEC = 0.15;

// ---------- 前處理 ----------

function frameDb(x, start) {
  let sum = 0;
  const end = Math.min(start + FRAME, x.length);
  for (let i = start; i < end; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / FRAME + 1e-12);
}

/** 切除頭尾靜音。回傳 { samples, peakDb }；整段無聲時 samples 為 null。 */
export function trimSilence(x) {
  const n = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  if (n === 0) return { samples: null, peakDb: -Infinity };
  const db = new Float32Array(n);
  let peak = -Infinity;
  for (let i = 0; i < n; i++) {
    db[i] = frameDb(x, i * HOP);
    if (db[i] > peak) peak = db[i];
  }
  if (peak < SILENCE_DB) return { samples: null, peakDb: peak };
  const thr = peak - TRIM_BELOW_PEAK_DB;
  let first = 0;
  let last = n - 1;
  while (first < n && db[first] < thr) first++;
  while (last > first && db[last] < thr) last--;
  first = Math.max(0, first - 3);
  last = Math.min(n - 1, last + 3);
  return { samples: x.subarray(first * HOP, last * HOP + FRAME), peakDb: peak };
}

// ---------- FFT 與 MFCC ----------

const fftTables = (() => {
  const bits = Math.log2(NFFT);
  const rev = new Uint16Array(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(NFFT / 2);
  const sin = new Float64Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / NFFT);
    sin[i] = -Math.sin((2 * Math.PI * i) / NFFT);
  }
  return { rev, cos, sin };
})();

function powerSpectrum(frame, re, im, out) {
  const { rev, cos, sin } = fftTables;
  for (let i = 0; i < NFFT; i++) {
    re[rev[i]] = i < frame.length ? frame[i] : 0;
    im[rev[i]] = 0;
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1;
    const step = NFFT / size;
    for (let start = 0; start < NFFT; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step];
        const s = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let i = 0; i <= NFFT / 2; i++) out[i] = (re[i] * re[i] + im[i] * im[i]) / NFFT;
}

const melFilters = (() => {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const lo = mel(20);
  const hi = mel(SAMPLE_RATE / 2);
  const bins = [];
  for (let i = 0; i < NMEL + 2; i++) {
    bins.push(Math.floor(((NFFT + 1) * hz(lo + ((hi - lo) * i) / (NMEL + 1))) / SAMPLE_RATE));
  }
  const filters = [];
  for (let m = 1; m <= NMEL; m++) {
    const w = new Float32Array(NFFT / 2 + 1);
    for (let k = bins[m - 1]; k < bins[m]; k++) w[k] = (k - bins[m - 1]) / (bins[m] - bins[m - 1] || 1);
    for (let k = bins[m]; k <= bins[m + 1]; k++) w[k] = (bins[m + 1] - k) / (bins[m + 1] - bins[m] || 1);
    filters.push(w);
  }
  return filters;
})();

const hamming = Float32Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

/** 每 10 ms 一格的 MFCC（c1–c12），已做倒頻譜均值變異數正規化。 */
export function mfcc(x) {
  const n = Math.max(1, Math.floor((x.length - FRAME) / HOP) + 1);
  const frame = new Float32Array(FRAME);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const power = new Float64Array(NFFT / 2 + 1);
  const melEnergy = [];
  let maxEnergy = 0;
  for (let f = 0; f < n; f++) {
    const start = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      const cur = x[start + i] ?? 0;
      const prev = start + i > 0 ? x[start + i - 1] ?? 0 : 0;
      frame[i] = (cur - 0.97 * prev) * hamming[i];
    }
    powerSpectrum(frame, re, im, power);
    const e = new Float64Array(NMEL);
    for (let m = 0; m < NMEL; m++) {
      const w = melFilters[m];
      for (let k = 0; k < w.length; k++) e[m] += w[k] * power[k];
      if (e[m] > maxEnergy) maxEnergy = e[m];
    }
    melEnergy.push(e);
  }
  // 能量下限（最大值 -50 dB）：讓背景雜音與極弱的頻帶不影響比對
  const floor = maxEnergy * 1e-5 + 1e-12;
  const feats = melEnergy.map((e) => {
    const logMel = e.map((v) => Math.log(Math.max(v, floor)));
    const c = new Float32Array(NCEP - 1);
    for (let k = 1; k < NCEP; k++) {
      let s = 0;
      for (let m = 0; m < NMEL; m++) s += logMel[m] * Math.cos((Math.PI * k * (m + 0.5)) / NMEL);
      c[k - 1] = s;
    }
    return c;
  });
  // CMVN：消除錄音設備與說話者的整體差異
  const dim = NCEP - 1;
  for (let d = 0; d < dim; d++) {
    let mean = 0;
    for (const c of feats) mean += c[d];
    mean /= feats.length;
    let v = 0;
    for (const c of feats) v += (c[d] - mean) ** 2;
    const sd = Math.sqrt(v / feats.length) || 1;
    for (const c of feats) c[d] = (c[d] - mean) / sd;
  }
  return feats;
}

// ---------- 音高（YIN） ----------

const PITCH_WIN = 640;
const TAU_MIN = Math.floor(SAMPLE_RATE / 500);
const TAU_MAX = Math.ceil(SAMPLE_RATE / 70);

/** 每 10 ms 一格的音高（半音，相對於本段中位數）；無聲或氣音為 NaN。 */
export function pitchContour(x, nFrames) {
  const W = PITCH_WIN - TAU_MAX;
  const d = new Float64Array(TAU_MAX + 1);
  const raw = new Float32Array(nFrames).fill(NaN);
  let peak = 0;
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const s = f * HOP;
    let e = 0;
    for (let i = 0; i < W; i++) e += (x[s + i] ?? 0) ** 2;
    rms[f] = Math.sqrt(e / W);
    if (rms[f] > peak) peak = rms[f];
  }
  for (let f = 0; f < nFrames; f++) {
    if (rms[f] < peak * 0.1) continue;
    const s = f * HOP;
    if (s + PITCH_WIN > x.length) break;
    let running = 0;
    let tau = -1;
    for (let t = 1; t <= TAU_MAX; t++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const diff = x[s + i] - x[s + i + t];
        sum += diff * diff;
      }
      running += sum;
      d[t] = running > 0 ? (sum * t) / running : 1;
      if (t > TAU_MIN && d[t - 1] < 0.15 && d[t - 1] <= d[t] && d[t - 1] <= d[t - 2]) {
        tau = t - 1;
        break;
      }
    }
    if (tau < 0) continue;
    const a = d[tau - 1];
    const b = d[tau];
    const c = d[tau + 1];
    const denom = a - 2 * b + c;
    const refined = denom !== 0 ? tau + (a - c) / (2 * denom) : tau;
    raw[f] = 12 * Math.log2(SAMPLE_RATE / refined);
  }
  // 中位數濾波去掉零星誤判，再以本段中位數為 0，抵消男女老幼的音域差
  const smooth = new Float32Array(nFrames).fill(NaN);
  for (let f = 0; f < nFrames; f++) {
    if (Number.isNaN(raw[f])) continue;
    const win = [];
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < nFrames && !Number.isNaN(raw[k])) win.push(raw[k]);
    win.sort((p, q) => p - q);
    smooth[f] = win[win.length >> 1];
  }
  const voiced = Array.from(smooth).filter((v) => !Number.isNaN(v)).sort((p, q) => p - q);
  if (!voiced.length) return smooth;
  const median = voiced[voiced.length >> 1];
  for (let f = 0; f < nFrames; f++) {
    let v = smooth[f] - median;
    if (v > 9) v -= 12; // 倍頻誤判
    if (v < -9) v += 12;
    smooth[f] = v;
  }
  return smooth;
}

// ---------- DTW ----------

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/** 回傳 { cost: 平均每步距離, path: [[i, j], ...] } */
export function dtw(a, b) {
  const n = a.length;
  const m = b.length;
  const acc = new Float64Array((n + 1) * (m + 1)).fill(Infinity);
  const len = new Uint32Array((n + 1) * (m + 1));
  const from = new Uint8Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  acc[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = dist(a[i - 1], b[j - 1]);
      const diag = acc[at(i - 1, j - 1)];
      const up = acc[at(i - 1, j)];
      const left = acc[at(i, j - 1)];
      let best = diag;
      let dir = 0;
      if (up < best) {
        best = up;
        dir = 1;
      }
      if (left < best) {
        best = left;
        dir = 2;
      }
      const k = at(i, j);
      acc[k] = best + c;
      from[k] = dir;
      len[k] = (dir === 0 ? len[at(i - 1, j - 1)] : dir === 1 ? len[at(i - 1, j)] : len[at(i, j - 1)]) + 1;
    }
  }
  const path = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const dir = from[at(i, j)];
    if (dir === 0) {
      i--;
      j--;
    } else if (dir === 1) i--;
    else j--;
  }
  path.reverse();
  return { cost: acc[at(n, m)] / len[at(n, m)], path };
}

// ---------- 評分 ----------

const toScore = (value, { best, worst }) => Math.round(100 * Math.min(1, Math.max(0, (worst - value) / (worst - best))));

/** 預先分析一段聲音（標準音可重複使用分析結果）。 */
export function analyze(samples) {
  const { samples: speech, peakDb } = trimSilence(samples);
  if (!speech) return { error: "silent", peakDb };
  const duration = speech.length / SAMPLE_RATE;
  if (duration < MIN_SPEECH_SEC) return { error: "short", duration };
  const feats = mfcc(speech);
  return { feats, pitch: pitchContour(speech, feats.length), duration, peakDb };
}

/**
 * 比較使用者錄音與標準音，兩者皆為 analyze() 的結果。
 * 回傳 { score, spectral, tone, warnings, details }，tone 在有聲段不足時為 null。
 */
export function compare(user, ref, cal = CALIBRATION) {
  const { cost, path } = dtw(user.feats, ref.feats);
  const spectral = toScore(cost, cal.spectral);

  let sum = 0;
  let pairs = 0;
  for (const [i, j] of path) {
    const u = user.pitch[i];
    const r = ref.pitch[j];
    if (Number.isNaN(u) || Number.isNaN(r)) continue;
    sum += (u - r) ** 2;
    pairs++;
  }
  // 均方根：只有一個音節調錯時，不會被其他音節平均掉
  const toneDiff = pairs ? Math.sqrt(sum / pairs) : NaN;
  const tone = pairs >= cal.minVoicedPairs ? toScore(toneDiff, cal.tone) : null;

  let score = tone === null ? spectral : spectral * (1 - cal.toneWeight) + tone * cal.toneWeight;
  const warnings = [];
  const ratio = user.duration / ref.duration;
  if (ratio < cal.durationRatio.min || ratio > cal.durationRatio.max) {
    score *= cal.durationRatio.penalty;
    warnings.push(ratio < 1 ? "錄音比標準音短很多，可能少唸了字" : "錄音比標準音長很多，可能多唸了字");
  }
  return {
    score: Math.round(score),
    spectral,
    tone,
    warnings,
    details: { cost, toneDiff, pairs, durationUser: user.duration, durationRef: ref.duration },
  };
}
