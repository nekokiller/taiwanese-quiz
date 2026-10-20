// 共用的 AudioContext、音檔解碼與播放、重新取樣成 16 kHz。

import { SAMPLE_RATE } from "./scoring.js";

let ctx = null;
let current = null;

export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function decode(arrayBuffer) {
  // Safari 舊版只支援 callback 形式
  return new Promise((resolve, reject) => audioContext().decodeAudioData(arrayBuffer, resolve, reject));
}

/** AudioBuffer -> 16 kHz 單聲道 Float32Array */
export async function toAnalysisRate(buffer) {
  const length = Math.max(1, Math.ceil(buffer.duration * SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

export function bufferFromSamples(samples, sampleRate) {
  const buffer = audioContext().createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}

const cache = new Map();

/** 下載並解碼音檔，同一個網址只處理一次。 */
export function loadAudio(url) {
  if (!cache.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`無法下載音檔（${r.status}）`);
        return r.arrayBuffer();
      })
      .then(decode);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

/** 播放 AudioBuffer，回傳播放結束時完成的 Promise；會先停止正在播放的聲音。 */
export function play(buffer) {
  stop();
  const c = audioContext();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);
  return new Promise((resolve) => {
    src.onended = () => {
      if (current === src) current = null;
      resolve();
    };
    current = src;
    src.start();
  });
}

export function stop() {
  if (current) {
    const src = current;
    current = null;
    try {
      src.stop();
    } catch {
      // 已經停止
    }
  }
}
