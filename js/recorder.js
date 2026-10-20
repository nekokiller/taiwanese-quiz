// 按住錄音：麥克風持續開著，按下時開始收集取樣，放開後回傳錄音。
// 保留按下前的一小段聲音、放開後再多錄一點，避免切掉開頭的子音與最後一個音。

import { audioContext, bufferFromSamples } from "./audio.js";

const PREROLL_SEC = 0.3;
const POSTROLL_MS = 250;

export class MicError extends Error {}

export class Recorder {
  constructor() {
    this.stream = null;
    this.recording = false;
    this.chunks = [];
    this.preroll = [];
    this.sampleRate = 48000;
  }

  get ready() {
    return this.stream !== null;
  }

  /** 取得麥克風權限並開始監聽（需在使用者點擊後呼叫）。 */
  async init() {
    if (this.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new MicError("這個瀏覽器無法使用麥克風。請用 HTTPS 網址開啟，並使用最新版 Chrome 或 Safari。");
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "SecurityError") {
        throw new MicError("麥克風權限被拒絕。請在瀏覽器的網站設定中允許使用麥克風，再重新整理頁面。");
      }
      if (e.name === "NotFoundError") throw new MicError("找不到麥克風，請確認裝置有麥克風。");
      throw new MicError(`無法開啟麥克風：${e.message}`);
    }

    const ctx = audioContext();
    this.sampleRate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    const onSamples = (samples) => this.push(samples);

    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      await ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
      const node = new AudioWorkletNode(ctx, "capture");
      node.port.onmessage = (e) => onSamples(e.data);
      source.connect(node).connect(mute);
      this.node = node;
    } else {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node).connect(mute);
      this.node = node;
    }
    this.source = source;
    this.stream = stream;
  }

  push(samples) {
    if (this.recording) {
      this.chunks.push(samples);
      return;
    }
    this.preroll.push(samples);
    let total = this.preroll.reduce((n, c) => n + c.length, 0);
    while (this.preroll.length > 1 && total - this.preroll[0].length >= PREROLL_SEC * this.sampleRate) {
      total -= this.preroll.shift().length;
    }
  }

  start() {
    audioContext();
    this.chunks = this.preroll;
    this.preroll = [];
    this.recording = true;
    this.startedAt = performance.now();
  }

  /** 停止錄音，回傳 { buffer: AudioBuffer, heldMs }。 */
  async stop() {
    await new Promise((r) => setTimeout(r, POSTROLL_MS));
    this.recording = false;
    const heldMs = performance.now() - this.startedAt - POSTROLL_MS;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      samples.set(c, offset);
      offset += c.length;
    }
    this.chunks = [];
    return { buffer: bufferFromSamples(samples, this.sampleRate), heldMs };
  }
}
