// app.js — 音アタリ ブラウザUI。音源の時計（AudioContext）を唯一のマスターにし、事前計算した Intent を引いて描く。
import { analyzePCM, downmix, refineWithDrums } from "./lib/analyze-core.mjs";
import { compileIntents, discreteBetween, continuousAt, paletteNameAt } from "./lib/mapping-engine.mjs";
import { validateFeatureTimeline, validateMapping } from "./lib/validate.mjs";
import { InkRenderer } from "./renderers/ink.mjs";
import { RigRenderer } from "./renderers/rig.mjs";
import { ExperienceRenderer } from "./renderers/experience.mjs";
import { buildGammaDraft, detectTemplate } from "./renderers/gamma-export.mjs";

const VERSION = "0.3.0";
const $ = (id) => document.getElementById(id);
const state = {
  audioCtx: null, buffer: null, source: null, startedAt: 0, offset: 0, playing: false,
  ft: null, mapping: null, intents: null, disabledRules: new Set(), lastT: -1, view: "ink",
  gammaTemplate: null, fileName: "", focus: false,
};
$("version").textContent = `v${VERSION}`;
window.otoAtari = { state }; // 検証用（ブラウザ自動操作から状態を読む。書き換え用ではない）
const ink = new InkRenderer($("inkCanvas"));
const rig = new RigRenderer($("rigCanvas"));
const exp = new ExperienceRenderer($("expCanvas"));
$("reduceMotion").addEventListener("change", (e) => { exp.reduce = e.target.checked; });

// ---------- 音源 ----------
function ctx() {
  if (!state.audioCtx) {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx = ac;
    // Safari対策: contextの生成直後、ユーザー操作と同じ呼び出しスタックの中で
    // 同期的に resume() と「無音1サンプルの再生」を行う。Safariは resume() を呼ぶだけでなく
    // 実際に音を鳴らす操作までがユーザー操作起点でないと、後から再生してもずっと無音のままに
    // なることがある（本人環境2026-09-28実測: Safariのみ無音・Chromeは正常）。
    ac.resume().catch(() => {});
    try { const src = ac.createBufferSource(); src.buffer = ac.createBuffer(1, 1, ac.sampleRate); src.connect(ac.destination); src.start(0); } catch (_) {}
    // OS都合の中断（バックグラウンド化・Bluetooth切替等）で suspended になったまま気付かないと
    // 「再生中の表示なのに音が出ない」状態になる。検知して復帰を試み、UIの表示とずれないようにする。
    ac.addEventListener("statechange", () => {
      if (ac.state === "suspended" && state.playing) {
        ac.resume().catch(() => {});
        setTimeout(() => { if (ac.state === "suspended" && state.playing) { setStatus("音声が中断されました。もう一度 ▶ を押してください"); stop(); } }, 800);
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.playing && ac.state === "suspended") ac.resume().catch(() => {});
    });
  }
  return state.audioCtx;
}
async function loadAudio(arrayBuffer, name) {
  stop();
  state.ft = null; state.ftBase = null; state.intents = null; ink.reset(); rig.reset(); exp.reset();
  ink.pointMode = false;
  $("facts").hidden = true; $("sensRow").hidden = true; $("pianoNotice").hidden = true;
  $("btnExportFeatures").disabled = true; $("btnExportIntents").disabled = true; $("btnExportGamma").disabled = true;
  $("btnNextEvent").disabled = true;
  const ac = ctx();
  const buf = await ac.decodeAudioData(arrayBuffer.slice(0));
  state.buffer = buf; state.fileName = name; state.offset = 0;
  const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  state.mono = downmix(chans);
  state.stereo = buf.numberOfChannels >= 2 ? { left: chans[0], right: chans[1] } : null;
  $("tDur").textContent = fmt(buf.duration);
  $("btnPlay").disabled = false;
  $("btnFocus").disabled = false;
  setStatus(`${name} — ${fmt(buf.duration)} / ${buf.sampleRate} Hz / ${buf.numberOfChannels}ch`);
}
async function analyzeInBrowser() {
  const buf = state.buffer; if (!buf) return;
  const mono = state.mono;
  showProgress(0.05, "解析中…");
  await new Promise((r) => setTimeout(r, 30));
  const ft = analyzePCM(mono, buf.sampleRate, { fileName: state.fileName, channels: buf.numberOfChannels, stereo: state.stereo, sensitivity: currentSensitivity(), reinforce: currentReinforce(), onProgress: (p, s) => showProgress(0.05 + p * 0.9, `解析中… ${s}`) });
  showProgress(1, "完了"); setTimeout(() => { $("progress").hidden = true; }, 600);
  setFeatures(ft);
}
function setFeatures(ft, { detectDrums = !ft.events?.some((e) => e.type === "note") } = {}) {
  const errs = validateFeatureTimeline(ft);
  if (errs.length) { alert("解析JSONが仕様に合いません:\n" + errs.join("\n")); return; }
  // 打楽器判定は感度で何度でもやり直せるよう、判定前の形を控えておく
  state.ftBase = detectDrums && !ft.drums ? JSON.parse(JSON.stringify(ft)) : null;
  if (detectDrums && !ft.drums && state.mono && state.buffer && Math.abs(ft.source.durationSec - state.buffer.duration) <= 1.0) {
    setStatus("打楽器（キック／スネア／ハット）を判定中…");
    refineWithDrums(ft, state.mono, state.buffer.sampleRate, { stereo: state.stereo, sensitivity: currentSensitivity(), reinforce: currentReinforce() });
  }
  state.ft = ft;
  $("pianoNotice").hidden = !ft.events.some((e) => e.type === "note");
  $("sensRow").hidden = !(state.ftBase && state.mono);
  if (state.buffer && Math.abs(ft.source.durationSec - state.buffer.duration) > 1.0) setStatus(`注意: 解析JSONの長さ ${fmt(ft.source.durationSec)} と音源 ${fmt(state.buffer.duration)} が違います（別の曲の可能性）`);
  $("facts").hidden = false;
  $("fAnalyzer").textContent = `${ft.source.analyzer.name} ${ft.source.analyzer.version}${ft.source.stems ? " ＋ステム" : ""}`;
  $("fBpm").textContent = ft.tempo.bpm.toFixed(1);
  $("fBpmConf").textContent = `確からしさ ${Math.round(ft.tempo.confidence * 100)}%／小節 ${Math.round((ft.tempo.barConfidence ?? 0) * 100)}%（${ft.tempo.grid === "fixed" ? "一定格子" : "追跡"}）`;
  $("fSections").textContent = ft.sections.map((s) => `${s.label}`).join(" › ");
  const counts = {}; for (const e of ft.events) counts[e.type] = (counts[e.type] || 0) + 1;
  $("fEvents").textContent = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("・");
  $("tempoBox").textContent = `${ft.tempo.bpm.toFixed(1)} BPM`;
  $("fDrums").textContent = ft.drums ? `kick ${ft.drums.counts.kick}・snare ${ft.drums.counts.snare}・hat ${ft.drums.counts.hat}${ft.drums.grid && ft.drums.grid.applied ? `／拍格子を ${Math.round(ft.drums.grid.shiftSec * 1000)}ms 補正（一致 ${Math.round(ft.drums.grid.agreement * 100)}%）` : ""}${ft.drums.patternGrid && ft.drums.patternGrid.applied ? `／規則性（${ft.drums.patternGrid.mode === "every-beat" ? "毎拍=四つ打ち" : "1拍おき"}）から ${ft.drums.patternGrid.recovered} 件を復元（キックが薄い区間 ${ft.drums.patternGrid.skippedLocal ?? 0}・クラップ主体 ${ft.drums.patternGrid.skippedClap ?? 0} は見送り）` : ""}` : (detectDrums ? "未判定（音源が無い）" : "このピアノ試験では打楽器判定なし");
  $("btnExportFeatures").disabled = false;
  recompile();
  drawTimeline();
}

function currentSensitivity() { return parseFloat($("sensitivity").value) || 3; }
function currentReinforce() { return $("reinforce").checked; }
$("sensitivity").addEventListener("input", () => { $("sensVal").textContent = $("sensitivity").value; });
function redetectDrums() {
  if (!state.ftBase || !state.mono) return;
  const ft = JSON.parse(JSON.stringify(state.ftBase));
  setStatus(`感度 ${currentSensitivity()} で打楽器を判定し直しています…`);
  setTimeout(() => { refineWithDrums(ft, state.mono, state.buffer.sampleRate, { stereo: state.stereo, sensitivity: currentSensitivity(), reinforce: currentReinforce() }); const keep = state.ftBase; setFeatures(ft); state.ftBase = keep; setStatus(`感度 ${currentSensitivity()}${currentReinforce() ? "" : "・復元なし"}: kick ${ft.drums.counts.kick}・snare ${ft.drums.counts.snare}・hat ${ft.drums.counts.hat}`); }, 20);
}
$("sensitivity").addEventListener("change", redetectDrums);
$("reinforce").addEventListener("change", redetectDrums);

// ---------- 割り振り ----------
async function loadPreset(url) {
  const res = await fetch(`../${url}`); const m = await res.json();
  setMapping(m);
}
function setMapping(m) {
  const errs = validateMapping(m);
  if (errs.length) { alert("割り振りJSONが仕様に合いません:\n" + errs.join("\n")); return; }
  state.mapping = m; state.disabledRules = new Set(m.rules.filter((r) => r.enabled === false).map((r) => r.id));
  renderRules(); renderPalette(m.startPalette); recompile();
}
function effectiveMapping() {
  if (!state.mapping) return null;
  return { ...state.mapping, rules: state.mapping.rules.map((r) => ({ ...r, enabled: !state.disabledRules.has(r.id) })) };
}
function recompile() {
  if (!state.ft || !state.mapping) return;
  const t0 = performance.now();
  state.intents = compileIntents(state.ft, effectiveMapping());
  const c = {}; for (const d of state.intents.discrete) c[d.intent] = (c[d.intent] || 0) + 1;
  $("mappingStats").textContent = `意図 ${state.intents.discrete.length} 件（${Object.entries(c).map(([k, v]) => `${k} ${v}`).join("・")}）＋連続 ${state.intents.continuous.length} 本 — ${Math.round(performance.now() - t0)} ms`;
  $("btnExportIntents").disabled = false;
  $("btnNextEvent").disabled = !state.buffer || !state.intents.discrete.some((d) => d.intent !== "pulse");
  $("btnExportGamma").disabled = !state.gammaTemplate || state.intents.discrete.some((d) => d.intent === "point");
  if (state.gammaTemplate && state.intents.discrete.some((d) => d.intent === "point")) $("gammaSummary").textContent = "単音の位置指定はγ下書きへ未対応";
  renderRules();
  ink.setSurface(state.mapping.palettes[state.mapping.startPalette]?.surface);
  ink.reset(); rig.reset();
  ink.pointMode = rig.pointMode = state.intents.discrete.some((d) => d.intent === "point");
  exp.setData(state.intents.discrete, state.ft.events);
  seedActivePoints(now()); state.lastT = now();
  updateStageGuide();
}
function ruleDesc(r) {
  const on = r.on.event ? `${[].concat(r.on.event).join("/")}${r.on.band ? " " + [].concat(r.on.band).join("|") : ""}${r.on.tags ? " #" + [].concat(r.on.tags).join("|") : ""}${r.on.minStrength ? ` ≥${r.on.minStrength}` : ""}` : `curve ${r.on.curve}`;
  const zone = [].concat(r.emit.zone || "all").join("+");
  return `${on} → ${r.emit.intent} @${zone}${r.emit.toZone ? "→" + r.emit.toZone : ""}${r.quantize && r.quantize.to && r.quantize.to !== "none" ? `（${r.quantize.to} に吸着）` : ""}`;
}
function renderRules() {
  const ul = $("rules"); ul.innerHTML = "";
  if (!state.mapping) return;
  const counts = new Map();
  if (state.intents) for (const d of state.intents.discrete) counts.set(d.ruleId, (counts.get(d.ruleId) || 0) + 1);
  for (const r of state.mapping.rules) {
    const li = document.createElement("li"); li.className = state.disabledRules.has(r.id) ? "off" : "";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !state.disabledRules.has(r.id); cb.setAttribute("aria-label", `${r.id} を有効にする`);
    cb.addEventListener("change", () => { cb.checked ? state.disabledRules.delete(r.id) : state.disabledRules.add(r.id); recompile(); });
    const id = document.createElement("span"); id.className = "id"; id.textContent = r.id;
    const n = document.createElement("span"); n.className = "n"; n.textContent = r.on.curve ? "連続" : `${counts.get(r.id) ?? "—"}`;
    const desc = document.createElement("span"); desc.className = "desc"; desc.textContent = ruleDesc(r);
    li.append(cb, id, n, desc); ul.appendChild(li);
  }
}
function renderPalette(name) {
  const row = $("paletteRow"); row.innerHTML = "";
  const pal = state.mapping && state.mapping.palettes[name]; if (!pal) return;
  for (const [k, v] of Object.entries(pal)) { const d = document.createElement("div"); d.className = "sw" + (k === "surface" ? " surface" : ""); d.style.background = v; d.dataset.key = k; d.title = `${k}: ${v}`; row.appendChild(d); }
  const p = document.createElement("span"); p.className = "pname"; p.textContent = name; row.appendChild(p);
  row.dataset.current = name;
}

// ---------- 再生 ----------
function now() { if (!state.buffer) return 0; return state.playing ? Math.min(state.buffer.duration, state.offset + (ctx().currentTime - state.startedAt)) : state.offset; }
async function play() {
  if (!state.buffer || state.playing) return;
  const ac = ctx();
  if (ac.state !== "running") { try { await ac.resume(); } catch (_) {} }
  if (ac.state !== "running") { setStatus("音声を開始できません（ブラウザにより一時停止されています）。もう一度 ▶ を押してください"); return; }
  if (state.playing) return; // resume 待ちの間に既に再生開始していたら二重に開始しない
  const src = ac.createBufferSource(); src.buffer = state.buffer; src.connect(ac.destination);
  src.onended = () => { if (state.playing && now() >= state.buffer.duration - 0.05) { stop(); state.offset = 0; } };
  state.startedAt = ac.currentTime; src.start(0, state.offset); state.source = src; state.playing = true; resetAudition();
  $("btnPlay").textContent = "❚❚";
  // 再生開始位置より前の Intent は捨てる
  state.lastT = state.offset;
}
function stop() {
  if (state.source) { try { state.source.stop(); } catch (_) {} state.source.disconnect(); state.source = null; }
  if (state.playing) state.offset = now();
  state.playing = false; $("btnPlay").textContent = "▶";
}
function seedActivePoints(t) {
  if (!state.intents) return;
  for (const d of state.intents.discrete) if (d.intent === "point" && d.t <= t && t < d.t + d.dur) { ink.receive(d, t); rig.receive(d, t); }
}
function seek(t) { const was = state.playing; stop(); state.offset = Math.max(0, Math.min(state.buffer ? state.buffer.duration : 0, t)); ink.reset(); rig.reset(); rig.pointMode = !!state.intents?.discrete.some((d) => d.intent === "point"); seedActivePoints(state.offset); state.lastT = state.offset; if (was) play(); drawTimeline(); }
$("btnPlay").addEventListener("click", () => (state.playing ? stop() : play()));
window.addEventListener("keydown", (e) => { if (e.code === "Space" && !["INPUT", "SELECT", "BUTTON", "TEXTAREA"].includes(document.activeElement.tagName)) { e.preventDefault(); state.playing ? stop() : play(); } });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.focus) setFocus(false); });
$("btnNextEvent").addEventListener("click", () => {
  if (!state.intents || !state.buffer) return;
  const next = state.intents.discrete.find((d) => d.intent !== "pulse" && d.t > now() + 0.05);
  if (!next) { setStatus("この先に反応はありません"); return; }
  seek(next.t);
  if (next.intent !== "point") { ink.receive(next, next.t); rig.receive(next, next.t); }
  setStatus(`次の反応 ${fmt(next.t)} — ${next.intent}`);
});

// ---------- 描画ループ ----------
const meterIds = ["sub", "bass", "lowmid", "mid", "high", "air", "loud"];
(function buildMeters() { const m = $("meters"); for (const id of meterIds) { const d = document.createElement("div"); d.className = "m"; d.innerHTML = `<i></i><b>${id === "loud" ? "L" : id.slice(0, 2)}</b>`; d.dataset.id = id; m.appendChild(d); } })();
const logItems = [];
function pushLog(d) { logItems.unshift(`<b>${fmt(d.t)}</b> ${d.intent} @${[].concat(d.zone).join("+")}${d.color ? ` <span style="color:${d.color}">■</span>` : ""} <span class="sub">${d.ruleId}${d.srcPattern ? " 復元" : ""}${typeof d.srcConfidence === "number" ? ` ${Math.round(d.srcConfidence * 100)}%` : ""}</span>`); if (logItems.length > 6) logItems.length = 6; $("log").innerHTML = logItems.map((x) => `<li>${x}</li>`).join(""); }

function frame() {
  requestAnimationFrame(frame);
  if (!state.buffer) return;
  const latency = (parseFloat($("latencyMs").value) || 0) / 1000;
  const t = now() + latency;
  const it = state.intents;
  const cont = it ? continuousAt(it, t) : [];
  const palName = it ? paletteNameAt(it, t) : null;
  const surface = it && palName && it.palettes[palName] ? it.palettes[palName].surface : null;
  if (palName && $("paletteRow").dataset.current !== palName) renderPalette(palName);
  if (it && state.playing && $("audition").checked) scheduleAudition(it, t);
  if (it && state.playing && t > state.lastT) {
    const suppress = $("suppressStrobe").checked;
    for (let d of discreteBetween(it, state.lastT, t)) {
      if (suppress && d.intent === "strobe") d = { ...d, intent: "pulse", level: 0.5, decaySec: 0.3 };
      if (d.intent === "point" || state.view !== "rig") ink.receive(d, t);
      if (d.intent === "point" || state.view !== "ink") rig.receive(d, t);
      if (d.intent !== "pulse" && d.intent !== "point") pushLog(d);
    }
    state.lastT = t;
  }
  if (state.view === "exp") exp.frame(t, { playing: state.playing });
  else {
    if (state.view !== "rig") ink.frame(t, cont, surface);
    if (state.view !== "ink") rig.frame(t, cont);
  }
  // メーター
  if (state.ft) {
    const i = Math.max(0, Math.min(state.ft.clock.frames - 1, Math.floor(t / state.ft.clock.hopSec)));
    for (const el of $("meters").children) { const id = el.dataset.id; const v = id === "loud" ? state.ft.curves.loudness[i] : (state.ft.curves[`band.${id}`] || [])[i] || 0; el.firstChild.style.height = `${Math.round(v * 100)}%`; }
  }
  $("tNow").textContent = fmt(t - latency);
  if (state.playing) drawTimeline();
}
requestAnimationFrame(frame);

// ---------- 合図音（検証用）: splat の時刻に短いクリックを音源時計で正確に鳴らす ----------
let auditionScheduled = new Set(), auditionUntil = -1;
function scheduleAudition(it, t) {
  const ac = ctx(); const lookahead = 0.25;
  if (auditionUntil < t) auditionUntil = t;
  const from = auditionUntil, to = t + lookahead;
  for (const d of discreteBetween(it, from, to)) {
    if (d.intent !== "splat") continue;
    const key = `${d.t}|${d.ruleId}`; if (auditionScheduled.has(key)) continue; auditionScheduled.add(key);
    const when = state.startedAt + (d.t - state.offset) - ((parseFloat($("latencyMs").value) || 0) / 1000);
    if (when < ac.currentTime - 0.01) continue;
    const osc = ac.createOscillator(), g = ac.createGain();
    osc.type = "square"; osc.frequency.value = d.srcPattern ? 3200 : (d.zone === "low" || d.zone === "floor" ? 1200 : 2400);
    g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(0.5, when + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
    const panNode = ac.createStereoPanner ? ac.createStereoPanner() : null;
    if (panNode) { panNode.pan.value = typeof d.x === "number" ? (d.x - 0.5) * 2 : 0; osc.connect(g).connect(panNode).connect(ac.destination); } else osc.connect(g).connect(ac.destination);
    osc.start(when); osc.stop(when + 0.04);
  }
  auditionUntil = to;
  if (auditionScheduled.size > 4000) auditionScheduled = new Set();
}
function resetAudition() { auditionScheduled = new Set(); auditionUntil = -1; }

// ---------- 時間軸 ----------
const tl = $("timeline");
function drawTimeline() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(tl.clientWidth * dpr), h = Math.floor(tl.clientHeight * dpr);
  if (tl.width !== w || tl.height !== h) { tl.width = w; tl.height = h; }
  const c = tl.getContext("2d"); c.clearRect(0, 0, w, h);
  const dur = state.buffer ? state.buffer.duration : (state.ft ? state.ft.source.durationSec : 0); if (!dur) return;
  const x = (t) => (t / dur) * w;
  const ft = state.ft;
  if (ft) {
    // 区切り帯
    ft.sections.forEach((s, k) => { c.fillStyle = k % 2 ? "rgba(236,230,218,0.08)" : "rgba(236,230,218,0.04)"; c.fillRect(x(s.start), 0, x(s.end) - x(s.start), h); c.fillStyle = "#a39d92"; c.font = `${10 * dpr}px system-ui`; c.fillText(s.label, x(s.start) + 4 * dpr, 12 * dpr); });
    // loudness 波形
    c.fillStyle = "rgba(236,230,218,0.35)";
    const L = ft.curves.loudness, step = Math.max(1, Math.floor(L.length / w));
    for (let i = 0; i < L.length; i += step) { const v = L[i]; c.fillRect(x(i * ft.clock.hopSec), h * (0.95 - v * 0.6), Math.max(1, w / (L.length / step)), h * v * 0.6); }
    // ピアノ単音候補（低い音ほど下、高い音ほど上）
    for (const e of ft.events) if (e.type === "note") { c.fillStyle = "rgba(143,212,201,0.72)"; c.fillRect(x(e.t), h * (0.72 - e.position01 * 0.48), Math.max(1.5 * dpr, x(e.t + e.dur) - x(e.t)), 2 * dpr); }
    // 拍・小節
    if (ft.tempo.confidence >= 0.3) for (const b of ft.tempo.beats) { c.fillStyle = b.beatInBar === 0 ? "rgba(245,180,0,0.55)" : "rgba(236,230,218,0.18)"; c.fillRect(x(b.t), h - (b.beatInBar === 0 ? 14 : 7) * dpr, 1, (b.beatInBar === 0 ? 14 : 7) * dpr); }
    // 打楽器判定（kick=下の帯・snare=中・hat=上）
    for (const e of ft.events) {
      if (e.type !== "onset" || !e.tags) continue;
      for (const tg of e.tags) {
        if (tg.name === "kick") { if (tg.patternConfirmed) { c.fillStyle = "rgba(56,198,217,0.95)"; c.fillRect(x(e.t) - 1 * dpr, h - 26 * dpr, Math.max(2, 3.5 * dpr), 12 * dpr); } c.fillStyle = "rgba(31,42,92,0.9)"; c.fillRect(x(e.t), h - 24 * dpr, Math.max(1, 1.5 * dpr), 8 * dpr); }
        else if (tg.name === "snare") { c.fillStyle = "rgba(226,69,47,0.9)"; c.fillRect(x(e.t), h - 34 * dpr, Math.max(1, 1.5 * dpr), 6 * dpr); }
        else if (tg.name === "hat") { c.fillStyle = "rgba(56,198,217,0.6)"; c.fillRect(x(e.t), h - 40 * dpr, 1, 4 * dpr); }
      }
    }
    // 事象
    for (const e of ft.events) {
      if (e.type === "drop") { c.fillStyle = "#ff5fa2"; c.fillRect(x(e.t) - 1, 16 * dpr, 2 * dpr, h - 32 * dpr); }
      if (e.type === "build") { c.fillStyle = "rgba(56,198,217,0.5)"; c.fillRect(x(e.t), 18 * dpr, x(e.t + (e.dur || 1)) - x(e.t), 3 * dpr); }
      if (e.type === "silence") { c.fillStyle = "rgba(0,0,0,0.6)"; c.fillRect(x(e.t), 0, Math.max(1, x(e.t + (e.dur || 0.4)) - x(e.t)), h); }
    }
  }
  const t = now();
  c.fillStyle = "#f5b400"; c.fillRect(x(t) - 1, 0, 2 * dpr, h);
}
tl.addEventListener("click", (e) => { if (!state.buffer) return; const r = tl.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * state.buffer.duration); });
window.addEventListener("resize", drawTimeline);

// ---------- 入力 ----------
$("btnSample").addEventListener("click", async () => {
  // Safari対策: AudioContextの生成・resume()はユーザー操作から同期的に呼ばないと
  // 「無音のまま一時停止状態で固まる」ことがある。await の手前で必ず先に呼ぶ。
  ctx();
  try {
    setStatus("サンプル曲を読み込み中…");
    const [audioRes, ftRes] = await Promise.all([fetch("../samples/gensan-extend.mp3"), fetch("../samples/gensan-extend.features.json")]);
    await loadAudio(await audioRes.arrayBuffer(), "gensan-extend.mp3");
    if (ftRes.ok) { setFeatures(await ftRes.json()); setStatus(`gensan-extend.mp3 — Python版の解析JSONを使用（analysis/analyze.py）`); }
    else await analyzeInBrowser();
    if ($("presetSelect").value === "presets/mapping-piano-notes.json") {
      $("presetSelect").value = "presets/mapping-kick-only.json";
      await loadPreset($("presetSelect").value);
    }
  } catch (err) { setStatus("サンプルの読み込みに失敗: " + err.message); }
});
$("btnPianoSample").addEventListener("click", async () => {
  ctx();
  try {
    setStatus("B曲のピアノ候補を読み込み中…");
    const [audioRes, ftRes] = await Promise.all([fetch("../samples/B.mp3"), fetch("../samples/B-piano.features.v2.json")]);
    if (!audioRes.ok || !ftRes.ok) throw new Error("B曲の試験ファイルを取得できません");
    await loadAudio(await audioRes.arrayBuffer(), "B.mp3");
    const ft = await ftRes.json();
    if (ft.source.file !== "B.mp3" || Math.abs(ft.source.durationSec - state.buffer.duration) > 0.05) throw new Error("音源と解析JSONが一致しません");
    $("presetSelect").value = "presets/mapping-piano-notes.json";
    await loadPreset($("presetSelect").value);
    setFeatures(ft, { detectDrums: false });
    setView("rig");
    setStatus("B.mp3 — 推定ピアノ単音493件。音高→左右位置、モデル強度＋原曲の相対音量→光量");
  } catch (err) { setStatus("B曲の読み込みに失敗: " + err.message); }
});
$("fileAudio").addEventListener("change", async (e) => {
  ctx(); // 同上（Safari対策）
  const f = e.target.files[0]; if (!f) return;
  await loadAudio(await f.arrayBuffer(), f.name);
  await analyzeInBrowser();
});
$("fileFeatures").addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { setFeatures(JSON.parse(await f.text())); } catch (err) { alert("JSONを読めません: " + err.message); } });
$("presetSelect").addEventListener("change", (e) => loadPreset(e.target.value));
$("fileMapping").addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { setMapping(JSON.parse(await f.text())); } catch (err) { alert("JSONを読めません: " + err.message); } });
document.querySelectorAll(".views .view").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
function setView(v) {
  state.view = v;
  document.querySelectorAll(".views .view").forEach((b) => { const on = b.dataset.view === v; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  $("inkCanvas").hidden = v === "rig" || v === "exp"; $("rigCanvas").hidden = v === "ink" || v === "exp"; $("expCanvas").hidden = v !== "exp"; $("stage").classList.toggle("both", v === "both");
  ink.lastT = null; rig.lastT = null;
  updateStageGuide();
}
function updateStageGuide() {
  const point = !!state.intents?.discrete.some((d) => d.intent === "point");
  if (state.view === "exp") {
    $("stageGuideTitle").textContent = "体験表示";
    $("stageGuideText").textContent = point
      ? "左＝低音／右＝高音。にじみの大きさと明るさは推定強度（モデル強度70％＋原曲全体の相対音量30％）。候補の推定であり、各音の実音量や元MIDIのベロシティではありません。映像が遅れて見えるときは「遅れ補正」を正の値に。"
      : "キック＝中央の白い閃光／スネア＝橙の稲妻／ハット＝金色の瞬き／無音＝暗転・戻り＝琥珀の空気光。打点は混合音からの推定です。映像が遅れて見えるときは「遅れ補正」を正の値に。";
    return;
  }
  $("stageGuideTitle").textContent = point ? "ピアノ単音の光" : (state.view === "rig" ? "照明図" : "インクの出力");
  $("stageGuideText").textContent = point
    ? (state.view === "rig" ? "左＝低音／右＝高音。光はモデル強度70％＋原曲全体の相対音量30％。実灯体には未割当です。" : "左＝低音／右＝高音。光の大きさと明るさはモデル強度70％＋原曲全体の相対音量30％。各音の実音量や元MIDIのベロシティではありません。")
    : "再生位置と描画を同期して確認できます。時間軸を押すと移動します。";
}
function setFocus(on) {
  if (on && !state.buffer) return;
  state.focus = on;
  ink.focus = on;
  document.body.classList.toggle("focus-mode", on);
  $("btnFocus").textContent = on ? "編集へ戻る" : "出力を見る";
  $("btnFocus").setAttribute("aria-pressed", String(on));
  $("stageGuide").hidden = !on;
  if (on) setView("exp");
  updateStageGuide();
  requestAnimationFrame(drawTimeline);
}
$("btnFocus").addEventListener("click", () => setFocus(!state.focus));

// ---------- 書き出し ----------
function download(name, obj) { const blob = new Blob([JSON.stringify(obj)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
const base = () => (state.fileName || "track").replace(/\.[^.]+$/, "");
$("btnExportFeatures").addEventListener("click", () => download(`${base()}.features.json`, state.ft));
$("btnExportIntents").addEventListener("click", () => download(`${base()}.${state.mapping.name}.intents.json`, state.intents));
$("fileGammaTemplate").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const doc = JSON.parse(await f.text()); const info = detectTemplate(doc);
    state.gammaTemplate = doc;
    const sel = $("gammaScene"); sel.innerHTML = ""; sel.hidden = false;
    for (const s of info.design.scenes || []) { const o = document.createElement("option"); o.value = s.id; o.textContent = s.name || s.id; sel.appendChild(o); }
    $("gammaSummary").textContent = `${info.kind === "show" ? "ショーJSON" : "照明デザインJSON"}: 灯体 ${(info.design.rig && info.design.rig.fixtures || []).length} 台・シーン ${(info.design.scenes || []).length}`;
    $("btnExportGamma").disabled = !state.intents || state.intents.discrete.some((d) => d.intent === "point");
    if (state.intents?.discrete.some((d) => d.intent === "point")) $("gammaSummary").textContent += "。単音の位置指定はγ下書きへ未対応";
  } catch (err) { alert(err.message); state.gammaTemplate = null; }
});
$("btnExportGamma").addEventListener("click", () => {
  try {
    const { document: out, summary } = buildGammaDraft(state.gammaTemplate, state.ft, state.intents, { sceneId: $("gammaScene").value });
    download(`${base()}.gamma-draft.json`, out);
    $("gammaSummary").textContent = `書き出し: シーン「${summary.sceneName || summary.sceneId}」へ 登録した明かり ${summary.lxqAdded} 件${summary.cuesAdded ? `・ライトキュー ${summary.cuesAdded} 件` : ""}（${summary.times.map((x) => fmt(x.t)).join(", ")}）`;
  } catch (err) { alert(err.message); }
});

// ---------- 共通 ----------
function fmt(t) { if (!Number.isFinite(t)) return "0:00.0"; const m = Math.floor(t / 60), s = (t % 60).toFixed(1).padStart(4, "0"); return `${m}:${s}`; }
function setStatus(s) { $("topStatus").textContent = s; }
function showProgress(p, text) { $("progress").hidden = false; $("progressBar").style.width = `${Math.round(p * 100)}%`; $("progressText").textContent = text; }
loadPreset($("presetSelect").value);
drawTimeline();
