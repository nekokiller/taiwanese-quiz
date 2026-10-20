// 測驗模式：設定 → 隨機出題 → 按住錄音、評分、聽標準音 → 結果。
// 練習模式：設定 → 依題號瀏覽，上一題／下一題、聽標準音，不錄音。

import { analyze, compare } from "./scoring.js";
import { audioContext, loadAudio, play, stop, toAnalysisRate } from "./audio.js";
import { MicError, Recorder } from "./recorder.js";

const DEBUG = new URLSearchParams(location.search).has("debug");
const LOW_SCORE = 60;
const MIN_HOLD_MS = 300;

const $ = (id) => document.getElementById(id);
const recorder = new Recorder();

let bank = null;
const state = {
  mode: "quiz",
  hideAnswer: false,
  list: [],
  index: 0,
  results: [],
  busy: false,
  holding: false,
  micError: null,
  enablingMic: false,
  lastRecording: null,
  playToken: 0,
};

const audioUrl = (file) => bank.audioBase + encodeURIComponent(file);
const current = () => state.list[state.index];
const practicing = () => state.mode === "practice";
const selectedMode = () => document.querySelector("input[name=mode]:checked").value;

// ---------- 共用 ----------

function show(id) {
  for (const s of ["loading", "setup", "quiz", "result"]) $(s).hidden = s !== id;
  window.scrollTo(0, 0);
}

function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

/** 顯示題面，考字加上「」並標色。 */
function renderPrompt(target, text, char) {
  target.textContent = "";
  const i = text.indexOf(char);
  if (i < 0) {
    target.append(text);
    return;
  }
  target.append(
    text.slice(0, i),
    el("span", { className: "bracket" }, "「"),
    el("span", { className: "target" }, char),
    el("span", { className: "bracket" }, "」"),
    text.slice(i + char.length),
  );
}

const grade = (score) => (score >= 80 ? "good" : score >= LOW_SCORE ? "mid" : "bad");

// ---------- 標準音分析（每個音檔只做一次） ----------

const refAnalysis = new Map();

function referenceFor(q) {
  if (!refAnalysis.has(q.reference)) {
    const p = loadAudio(audioUrl(q.reference)).then(toAnalysisRate).then(analyze);
    p.catch(() => refAnalysis.delete(q.reference));
    refAnalysis.set(q.reference, p);
  }
  return refAnalysis.get(q.reference);
}

// ---------- 設定 ----------

function readRanges() {
  const ranges = [];
  for (const row of document.querySelectorAll(".range-row")) {
    const on = row.querySelector("input[type=checkbox]").checked;
    row.classList.toggle("off", !on);
    for (const input of row.querySelectorAll("input[type=number]")) input.disabled = !on;
    if (!on) continue;
    let from = parseInt(row.querySelector("[name=from]").value, 10);
    let to = parseInt(row.querySelector("[name=to]").value, 10);
    if (!Number.isFinite(from)) from = 1;
    if (!Number.isFinite(to)) to = 100;
    from = Math.min(100, Math.max(1, from));
    to = Math.min(100, Math.max(1, to));
    if (from > to) [from, to] = [to, from];
    ranges.push({ section: row.dataset.section, from, to });
  }
  return ranges;
}

function poolFor(ranges) {
  const inRange = bank.questions.filter((q) =>
    ranges.some((r) => r.section === q.section && q.no >= r.from && q.no <= r.to),
  );
  const playable = inRange.filter((q) => q.reference);
  return { playable, missing: inRange.length - playable.length };
}

function updateAvailable() {
  const { playable, missing } = poolFor(readRanges());
  const practice = selectedMode() === "practice";
  const lacking = missing ? `（另有 ${missing} 題尚無錄音）` : "";
  $("available").textContent = `目前範圍可出 ${playable.length} 題${lacking}`;
  $("practice-info").textContent = `依題號順序練習，共 ${playable.length} 題${lacking}`;
  $("practice-info").hidden = !practice;
  $("count-field").hidden = practice;
  $("mic-hint").hidden = practice;
  $("start").textContent = practice ? "開始練習" : "開始測驗";
  const count = parseInt($("count").value, 10);
  for (const chip of document.querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(Number(chip.dataset.count) === count));
  }
}

function setupError(message) {
  $("setup-error").textContent = message;
  $("setup-error").hidden = !message;
}

async function onStart(e) {
  e.preventDefault();
  audioContext(); // 在使用者點擊時建立，iOS 才允許播放與錄音
  setupError("");
  const ranges = readRanges();
  if (!ranges.length) return setupError("請至少選一個部分（字音或字形）。");
  const { playable } = poolFor(ranges);
  if (!playable.length) return setupError("這個範圍沒有可以出的題目，請調整範圍。");
  if (selectedMode() === "practice") return startSession(playable, "practice");

  let count = parseInt($("count").value, 10);
  if (!Number.isFinite(count) || count < 1) return setupError("請輸入要測驗的題數。");
  if (count > playable.length) {
    count = playable.length;
    $("count").value = count;
  }

  // 麥克風開不了也照樣進入測驗，作答畫面再提示（可重試或直接看答案）
  const button = $("start");
  button.disabled = true;
  button.textContent = "準備麥克風…";
  await tryInitMic();
  button.disabled = false;
  updateAvailable();
  startSession(shuffle(playable).slice(0, count), "quiz");
}

async function tryInitMic() {
  try {
    await recorder.init();
    state.micError = null;
  } catch (err) {
    state.micError = err instanceof MicError ? err.message : `無法開啟麥克風：${err.message}`;
  }
  return recorder.ready;
}

function micUnavailableText() {
  return `${state.micError} 按「開啟麥克風」可以再試一次；也可以按「看答案」聽標準發音（不評分）。`;
}

function updateRecordButton() {
  const ready = recorder.ready;
  $("record").classList.toggle("unavailable", !ready);
  $("record").querySelector(".record-label").textContent = ready ? "按住說話" : "開啟麥克風";
}

async function enableMic() {
  if (state.enablingMic) return;
  state.enablingMic = true;
  setStatus("正在開啟麥克風…");
  const ok = await tryInitMic();
  state.enablingMic = false;
  updateRecordButton();
  setStatus(ok ? "麥克風已開啟，請按住按鈕唸出讀音" : micUnavailableText());
}

// ---------- 作答 ----------

function startSession(list, mode) {
  state.mode = mode;
  state.list = list;
  state.index = 0;
  state.results = list.map((q) => ({ q, score: null }));
  show("quiz");
  renderQuestion();
}

function setStatus(text) {
  $("record-status").textContent = text;
}

function renderQuestion() {
  stop();
  const q = current();
  const n = state.list.length;
  $("progress").textContent = `第 ${state.index + 1} / ${n} 題`;
  $("progress-fill").style.width = `${(state.index / n) * 100}%`;
  $("q-label").textContent = `${q.section} 第 ${q.no} 題`;
  renderPrompt($("q-prompt"), q.prompt, q.target);

  const speak = $("q-speak");
  speak.textContent = "";
  if (q.speak !== q.prompt) {
    const isRef = q.audio.some((a) => a.kind === "同字參考詞" && a.word === q.speak);
    speak.append(
      "本題請唸「",
      el("b", {}, q.speak),
      isRef ? `」：以同一個字的另一個詞示範「${q.target}」的讀音` : "」這個字就好（沒有整個詞的標準錄音）",
    );
  }
  speak.hidden = q.speak === q.prompt;

  const practice = practicing();
  const last = state.index === n - 1;
  $("quiz").classList.toggle("practice", practice);
  // 練習模式把播放按鈕放進題目卡片；測驗模式放回評分結果下方
  if (practice) document.querySelector("#quiz .question").append($("actions"));
  else $("quiz").insertBefore($("actions"), document.querySelector("#quiz .nav"));
  $("feedback").hidden = true;
  $("feedback").classList.toggle("concealed", practice && state.hideAnswer);
  $("play-ref").disabled = true;
  $("play-mine").disabled = true;
  $("char-buttons").textContent = "";
  $("show-answer").hidden = false;
  $("record-area").hidden = practice;
  $("play-mine").hidden = practice;
  $("toggle-answer").hidden = !practice;
  $("toggle-answer").textContent = state.hideAnswer ? "顯示讀音" : "隱藏讀音";
  $("prev").hidden = !practice;
  $("prev").disabled = state.index === 0;
  $("next").textContent = !practice && last ? "看結果" : "下一題";
  $("next").disabled = practice && last;
  $("quit").textContent = practice ? "結束練習" : "結束測驗";
  state.lastRecording = null;
  updateRecordButton();
  setStatus(recorder.ready ? "按住按鈕唸出讀音，唸完再放開" : micUnavailableText());
  if (practice) revealWithoutScore();

  // 先在背景準備這題和下一題的標準音
  referenceFor(q).catch(() => {});
  const next = state.list[state.index + 1];
  if (next) referenceFor(next).catch(() => {});
}

function beginRecording() {
  if (state.busy || state.holding) return;
  if (!recorder.ready) {
    enableMic(); // 在使用者按下時重新要求權限
    return;
  }
  stop();
  state.holding = true;
  recorder.start();
  $("record").classList.add("active");
  setStatus("錄音中…唸完再放開");
}

async function endRecording() {
  if (!state.holding) return;
  state.holding = false;
  state.busy = true;
  $("record").classList.remove("active");
  setStatus("分析中…");
  const q = current();
  try {
    const { buffer, heldMs } = await recorder.stop();
    if (heldMs < MIN_HOLD_MS) {
      setStatus("請按住按鈕不放，唸完再放開");
      return;
    }
    state.lastRecording = buffer;
    $("play-mine").disabled = false;
    const user = analyze(await toAnalysisRate(buffer));
    if (user.error === "silent") {
      setStatus("沒有聽到聲音，請靠近麥克風再試一次");
      return;
    }
    if (user.error === "short") {
      setStatus("聲音太短了，請完整唸出讀音");
      return;
    }
    const ref = await referenceFor(q);
    if (ref.error) throw new Error("標準音無法分析");
    if (current() !== q) return; // 分析時已換題
    const result = compare(user, ref);
    state.results[state.index].score = result.score;
    showFeedback(q, result);
    setStatus("可以再按住重錄，分數以最後一次為準");
  } catch (err) {
    setStatus(`發生錯誤：${err.message}`);
  } finally {
    state.busy = false;
  }
}

function showAnswer(q) {
  const answer = $("answer");
  answer.textContent = "";
  const row = (label, ...value) => answer.append(el("dt", {}, label), el("dd", {}, ...value));
  row("標準音", el("span", { className: "han" }, q.speak), `　${q.speakRomanization.join(" / ")}`);
  row("試卷讀音", el("span", { className: "han" }, `「${q.target}」`), `　${q.readings.join(" / ")}`);
  if (q.section === "字形") row("試卷題目", q.paper);

  const note = $("accent-note");
  note.hidden = !q.gaps.readings.length;
  note.textContent = q.gaps.readings.length
    ? `試卷另列 ${q.gaps.readings.join("、")} 的讀法，標準音沒有收錄；唸得跟標準音不同，不一定是唸錯。`
    : "";

  if (!$("char-buttons").childElementCount) {
    const clips = q.audio.filter((a) => a.kind === "單字本調" && a.file !== q.reference);
    for (const [i, clip] of clips.entries()) {
      // 用半形括號縮短按鈕，窄螢幕才排得下；同題有多段且沒有文白標示時加編號
      const label = `單字${clip.register ? `(${clip.register})` : clips.length > 1 ? i + 1 : ""}`;
      const b = el("button", { type: "button", className: "secondary", textContent: `🔊 ${label}` });
      b.addEventListener("click", () => playClip(clip.file));
      $("char-buttons").append(b);
    }
  }
  $("play-ref").disabled = false;
  $("show-answer").hidden = true;
  $("feedback").hidden = false;
}

function showFeedback(q, result) {
  $("score-row").hidden = false;
  $("feedback").classList.remove("no-score");
  const score = $("score");
  score.textContent = result.score;
  score.className = `score ${grade(result.score)}`;
  $("score-text").textContent =
    result.score >= 80 ? "很好！" : result.score >= LOW_SCORE ? "接近了，再聽一次標準音" : "差距較大，先聽標準音再試試";
  $("score-parts").textContent = `音段 ${result.spectral}・聲調 ${result.tone ?? "無法判斷"}`;
  const warnings = $("warnings");
  warnings.textContent = "";
  for (const w of result.warnings) warnings.append(el("li", {}, w));
  const debug = $("debug");
  debug.hidden = !DEBUG;
  if (DEBUG) debug.textContent = JSON.stringify(result.details, (k, v) => (typeof v === "number" ? +v.toFixed(3) : v), 2);
  showAnswer(q);
}

function revealWithoutScore() {
  $("score-row").hidden = true;
  $("feedback").classList.add("no-score");
  $("warnings").textContent = "";
  $("debug").hidden = true;
  showAnswer(current());
}

async function playBuffer(getBuffer) {
  if (state.holding) return;
  const token = ++state.playToken;
  $("record").disabled = true;
  try {
    await play(await getBuffer());
  } catch (err) {
    setStatus(`無法播放：${err.message}`);
  } finally {
    if (token === state.playToken) $("record").disabled = false;
  }
}

const playClip = (file) => playBuffer(() => loadAudio(audioUrl(file)));

function goTo(index) {
  if (state.busy || state.holding) return;
  stop();
  state.playToken++;
  $("record").disabled = false;
  if (index >= state.list.length) {
    if (!practicing()) showResults();
    return;
  }
  if (index < 0) return;
  state.index = index;
  renderQuestion();
}

function quit() {
  if (state.busy || state.holding) return;
  if (!practicing()) return showResults();
  stop();
  state.playToken++;
  show("setup");
}

function toggleAnswer() {
  state.hideAnswer = !state.hideAnswer;
  $("feedback").classList.toggle("concealed", state.hideAnswer);
  $("toggle-answer").textContent = state.hideAnswer ? "顯示讀音" : "隱藏讀音";
}

// ---------- 結果 ----------

function showResults() {
  stop();
  state.playToken++;
  $("record").disabled = false;
  const scored = state.results.filter((r) => r.score !== null);
  const avg = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null;
  $("avg").textContent = avg ?? "—";
  $("result-meta").textContent = `作答 ${scored.length} / ${state.results.length} 題`;

  const list = $("result-list");
  list.textContent = "";
  for (const { q, score } of state.results) {
    const word = el("span", { className: "r-word" }, el("span", { className: "r-label" }, `${q.section} ${q.no}`));
    const prompt = el("span");
    renderPrompt(prompt, q.prompt, q.target);
    word.append(prompt);
    const playBtn = el("button", { type: "button", className: "secondary", textContent: "🔊", ariaLabel: "播放標準音" });
    playBtn.addEventListener("click", () => playClip(q.reference));
    const s = el("span", { className: `r-score ${score === null ? "" : grade(score)}` }, score ?? "—");
    list.append(el("li", {}, word, playBtn, s));
  }

  const low = state.results.filter((r) => r.score === null || r.score < LOW_SCORE);
  const retry = $("retry-low");
  retry.disabled = !low.length;
  retry.textContent = low.length ? `只重練 ${LOW_SCORE} 分以下的題目（${low.length} 題）` : `沒有 ${LOW_SCORE} 分以下的題目`;
  show("result");
}

// ---------- 啟動 ----------

function bindEvents() {
  const form = $("setup-form");
  form.addEventListener("input", updateAvailable);
  form.addEventListener("change", updateAvailable);
  form.addEventListener("submit", onStart);
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      $("count").value = chip.dataset.count;
      updateAvailable();
    });
  }

  const rec = $("record");
  rec.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      rec.setPointerCapture(e.pointerId);
    } catch {
      // 部分瀏覽器不支援
    }
    beginRecording();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) rec.addEventListener(type, endRecording);
  rec.addEventListener("contextmenu", (e) => e.preventDefault());

  // 桌機：測驗時按住空白鍵錄音；練習時用左右鍵換題
  const typing = (e) => e.target instanceof HTMLInputElement;
  document.addEventListener("keydown", (e) => {
    if ($("quiz").hidden || typing(e)) return;
    if (practicing()) {
      if (e.code === "ArrowLeft") goTo(state.index - 1);
      if (e.code === "ArrowRight") goTo(state.index + 1);
      return;
    }
    if (e.code !== "Space") return;
    e.preventDefault();
    if (!e.repeat) beginRecording();
  });
  document.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || $("quiz").hidden || practicing() || typing(e)) return;
    e.preventDefault();
    endRecording();
  });

  $("play-ref").addEventListener("click", () => playClip(current().reference));
  $("play-mine").addEventListener("click", () => state.lastRecording && playBuffer(async () => state.lastRecording));
  $("show-answer").addEventListener("click", revealWithoutScore);
  $("next").addEventListener("click", () => goTo(state.index + 1));
  $("prev").addEventListener("click", () => goTo(state.index - 1));
  $("toggle-answer").addEventListener("click", toggleAnswer);
  $("quit").addEventListener("click", quit);
  $("retry-low").addEventListener("click", () =>
    startSession(shuffle(state.results.filter((r) => r.score === null || r.score < LOW_SCORE).map((r) => r.q)), "quiz"),
  );
  $("restart").addEventListener("click", () => show("setup"));
}

async function main() {
  if (location.protocol === "file:") {
    $("loading").textContent = "請用網頁伺服器開啟這個頁面（直接開啟檔案無法載入題庫）。";
    return;
  }
  try {
    const r = await fetch("data/questions.json");
    if (!r.ok) throw new Error(r.status);
    bank = await r.json();
  } catch {
    $("loading").textContent = "題庫載入失敗，請重新整理頁面。";
    return;
  }
  bindEvents();
  updateAvailable();
  show("setup");
}

main();
