// app.js — 音源はAudioContext、無音デモだけはperformanceを時計にし、事前計算したIntentを引いて描く。
import { analyzePCM, downmix, refineWithDrums } from "./lib/analyze-core.mjs?v=20261007e";   // 2026-10-07: 変更したので版を付ける（スネア推定の抑止）
import { createDemoFeatures, DEMO_SUSTAIN_SPANS, DEMO_BASS_NOTES } from "./lib/demo.mjs?v=20261007e";
import { loudBarSpans } from "./lib/mirror-ball-map.mjs?v=20261007e";
import { detectSideLayer, addSideLayerEvents } from "./lib/guitar-side.mjs?v=20261007e";
import { compileIntents, discreteBetween, continuousAt, paletteNameAt } from "./lib/mapping-engine.mjs?v=20261007e";
import { validateFeatureTimeline, validateMapping } from "./lib/validate.mjs?v=20261007e";
import { InkRenderer } from "./renderers/ink.mjs";
import { RigRenderer } from "./renderers/rig.mjs";
import { Stage3dRenderer } from "./renderers/stage3d.mjs?v=20261007e";
import { collectExperienceData } from "./renderers/experience.mjs?v=20261007e";
import { buildGammaDraft, detectTemplate } from "./renderers/gamma-export.mjs";

const VERSION = "0.7.7";
const $ = (id) => document.getElementById(id);
const state = {
  audioCtx: null, buffer: null, source: null, startedAt: 0, offset: 0, playing: false,
  ft: null, mapping: null, intents: null, disabledRules: new Set(), lastT: -1, view: "stage3d",
  gammaTemplate: null, fileName: "", focus: false, demo: false,
};
$("version").textContent = `v${VERSION}`;
window.otoAtari = { state }; // 検証用（ブラウザ自動操作から状態を読む。書き換え用ではない）。audio は下で足す
const ink = new InkRenderer($("inkCanvas"));
const rig = new RigRenderer($("rigCanvas"));
// 舞台へ渡す打点・単音・ベースのまとめ（2026-10-07 に「体験」表示を外し、データだけ残した。TOKEN_SHEET §32）。
const exp = { data: null };
// ミラーボールの初期状態: 既定オン。`?mirror=off` で切って開ける（旧来の舞台と見比べる・従来の検査用）。
if (new URLSearchParams(location.search).get("mirror") === "off") $("mirrorBallToggle").checked = false;
const stage3d = new Stage3dRenderer($("stage3dCanvas"), { mirrorBall: $("mirrorBallToggle").checked, bassSources: DEMO_BASS_NOTES });
const phoneMedia = matchMedia("(max-width: 699px), (max-width: 999px) and (max-height: 500px)");
const compactMedia = matchMedia("(max-width: 1199px), (pointer: coarse)");
const ui = { settingsOpen: false, panel: "panelSource", sourceBusy: false };
$("stageViewpoint").addEventListener("change", (e) => { stage3d.setViewpoint(e.target.value); });
$("mirrorBallToggle").addEventListener("change", (e) => { stage3d.setMirrorBall(e.target.checked); updateStageGuide(); });

// ---------- 音源 ----------
function ctx() {
  if (!state.audioCtx) {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx = ac; audio.ctxCreatedMs = performance.now(); audio.ctxCount += 1;
    // Safari対策: contextの生成直後、ユーザー操作と同じ呼び出しスタックの中で
    // 同期的に resume() と「無音1サンプルの再生」を行う。Safariは resume() を呼ぶだけでなく
    // 実際に音を鳴らす操作までがユーザー操作起点でないと、後から再生してもずっと無音のままに
    // なることがある（本人環境2026-09-28実測: Safariのみ無音・Chromeは正常）。
    ac.resume().catch(() => {});
    try { const src = ac.createBufferSource(); src.buffer = ac.createBuffer(1, 1, ac.sampleRate); src.connect(ac.destination); src.start(0); } catch (_) {}
    // OS都合の中断（バックグラウンド化・Bluetooth切替等）で suspended になったまま気付かないと
    // 「再生中の表示なのに音が出ない」状態になる。検知して復帰を試み、UIの表示とずれないようにする。
    ac.addEventListener("statechange", () => {
      diagNote("audioCtx statechange → " + ac.state);
      if (ac.state === "suspended" && state.playing && !state.demo) {
        ac.resume().catch(() => {});
        setTimeout(() => { if (ac.state === "suspended" && state.playing && !state.demo) { setStatus("音声が中断されました。もう一度 ▶ を押してください"); stop(); } }, 800);
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.playing && !state.demo && ac.state === "suspended") ac.resume().catch(() => {});
    });
  }
  return state.audioCtx;
}
async function loadAudio(arrayBuffer, name) {
  // 読み込めないファイルでも、現在の音源や無音デモを失わない。
  const buf = await ctx().decodeAudioData(arrayBuffer.slice(0));
  stop();
  state.demo = false; $("demoBanner").hidden = true; updatePlayButton();
  state.buffer = null; state.mono = null; state.stereo = null; state.offset = 0;
  $("btnPlay").disabled = true; $("btnFocus").disabled = true; $("seek").disabled = true;
  $("seek").value = 0; $("tNow").textContent = $("tDur").textContent = fmt(0);
  $("emptyState").hidden = false;
  state.ft = null; state.ftBase = null; state.intents = null; ink.reset(); rig.reset(); exp.data = null; stage3d.reset();
  ink.pointMode = false;
  $("facts").hidden = true; $("sensRow").hidden = true; $("pianoNotice").hidden = true;
  $("btnExportFeatures").disabled = true; $("btnExportIntents").disabled = true; $("btnExportGamma").disabled = true;
  $("btnNextEvent").disabled = true;
  state.buffer = buf; state.fileName = name; state.offset = 0;
  const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  state.mono = downmix(chans);
  state.stereo = buf.numberOfChannels >= 2 ? { left: chans[0], right: chans[1] } : null;
  state.sideLayer = null;   // 左右に振られた音（ギター想定）の打点。音源ごとに1回だけ求める（§36）
  $("tDur").textContent = fmt(buf.duration);
  $("btnPlay").disabled = false;
  $("btnFocus").disabled = false;
  $("seek").max = String(buf.duration); $("seek").disabled = false;
  $("emptyState").hidden = true;
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
function setFeatures(ft, { detectDrums = !ft.events?.some((e) => e.type === "note" && e.instrumentCandidate !== "bass") } = {}) {
  const errs = validateFeatureTimeline(ft);
  if (errs.length) { alert("解析JSONが仕様に合いません:\n" + errs.join("\n")); return; }
  // 打楽器判定は感度で何度でもやり直せるよう、判定前の形を控えておく
  state.ftBase = detectDrums && !ft.drums ? JSON.parse(JSON.stringify(ft)) : null;
  if (detectDrums && !ft.drums && state.mono && state.buffer && Math.abs(ft.source.durationSec - state.buffer.duration) <= 1.0) {
    setStatus("打楽器（キック／スネア／ハット）を判定中…");
    refineWithDrums(ft, state.mono, state.buffer.sampleRate, { stereo: state.stereo, sensitivity: currentSensitivity(), reinforce: currentReinforce() });
  }
  // 左右に振られた音（ギター想定）の打点を足す（2026-10-07・TOKEN_SHEET §36）。ステレオ音源があり、長さが合う時だけ。
  // 2026-10-07 夜: ミックスの左右差だけではクラップやピアノの広がりと区別できない（§39 の実測）ので既定オフの任意機能。解析JSONに #guitar があれば足さない。
  if ($("sideGuitar").checked && state.stereo && state.buffer && Math.abs(ft.source.durationSec - state.buffer.duration) <= 1.0) {
    state.sideLayer = state.sideLayer || detectSideLayer(state.stereo.left, state.stereo.right, state.buffer.sampleRate);
    addSideLayerEvents(ft, state.sideLayer);
  }
  state.ft = ft;
  $("pianoNotice").hidden = !ft.events.some((e) => e.type === "note" && e.instrumentCandidate !== "bass");
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
$("sideGuitar").addEventListener("change", redetectDrums);

// ---------- 割り振り ----------
async function loadPreset(url) {
  // 規則を足した版が古いキャッシュに隠れないように、版を付けて読む（2026-10-07）。
  const res = await fetch(`../${url}?v=${VERSION}`); const m = await res.json();
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
  $("btnExportIntents").disabled = state.demo;
  $("btnNextEvent").disabled = !hasPlayback() || !state.intents.discrete.some((d) => d.intent !== "pulse");
  $("btnExportGamma").disabled = state.demo || !state.gammaTemplate || state.intents.discrete.some((d) => d.intent === "point" && d.srcInstrument !== "bass");
  if (state.gammaTemplate && state.intents.discrete.some((d) => d.intent === "point" && d.srcInstrument !== "bass")) $("gammaSummary").textContent = "単音の位置指定はγ下書きへ未対応";
  renderRules();
  ink.setSurface(state.mapping.palettes[state.mapping.startPalette]?.surface);
  ink.reset(); rig.reset();
  ink.pointMode = rig.pointMode = state.intents.discrete.some((d) => d.intent === "point" && d.srcInstrument !== "bass");
  exp.data = collectExperienceData(state.intents.discrete, state.ft.events, { beats: state.ft.tempo && state.ft.tempo.confidence >= 0.3 ? state.ft.tempo.beats : null, sections: state.ft.sections || [] });
  // ミラーボールが出て回る区間（音圧の高い小節のまとまり・小節の頭で出入り・2026-10-07 夜・TOKEN_SHEET §37）。拍が取れない曲は1秒ならしの音量。無音デモは合成パターンの明示した区間。
  // 無音デモのベースは合成パターンを舞台へ直接渡す（note 候補を装わない）。実音源は解析JSONの bass note から。
  if (state.demo) {
    const bassRuleOn = state.mapping.rules.some((r) => r.id === "bass-floor-wash") && !state.disabledRules.has("bass-floor-wash");
    exp.data.bassSources = DEMO_BASS_NOTES; exp.data.bassNotes = bassRuleOn ? DEMO_BASS_NOTES : [];
  }
  stage3d.setData(exp.data, { spans: state.demo ? DEMO_SUSTAIN_SPANS : loudBarSpans(state.ft), durationSec: state.ft.source.durationSec });
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
    const id = document.createElement("label"); id.className = "id"; id.textContent = r.id;
    cb.id = `rule-${ul.children.length}`; id.htmlFor = cb.id;
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
function hasPlayback() { return state.demo || !!state.buffer; }
function duration() { return state.demo ? state.ft.source.durationSec : (state.buffer?.duration || 0); }
function now() {
  if (!hasPlayback()) return 0;
  if (!state.playing) return state.offset;
  const clock = state.demo ? performance.now() / 1000 : state.audioCtx.currentTime;
  return Math.min(duration(), state.offset + clock - state.startedAt);
}
function updatePlayButton() {
  $("btnPlay").textContent = state.playing ? "❚❚" : "▶";
  $("btnPlay").setAttribute("aria-label", `${state.demo ? "光のデモを" : ""}${state.playing ? "一時停止" : "再生"}`);
}
async function play() {
  if (!hasPlayback() || state.playing) return;
  if (state.offset >= duration()) state.offset = 0;
  if (state.demo) {
    state.startedAt = performance.now() / 1000; state.playing = true;
    state.lastT = state.offset - 0.001; updatePlayButton(); return;
  }
  // 2026-10-07 夜: Safari は、Mac の出力先が切り替わった後も古い AudioContext を使い続けて無音になる（running のまま・時計も進む）。
  // 一時停止からの再生で AudioContext が rebuildAfterMs より古ければ作り直す（復号済みの音源はそのまま使える）。TOKEN_SHEET §41。
  if (state.audioCtx && performance.now() - audio.ctxCreatedMs > audio.rebuildAfterMs) rebuildAudio("context older than 10 min at play", { restart: false });
  const buffer = state.buffer, ac = ctx();
  if (ac.state !== "running") { try { await ac.resume(); } catch (_) {} }
  if (ac.state !== "running") { armAudioRecovery(`play: state=${ac.state}`); return; }
  if (state.playing || state.demo || state.buffer !== buffer) return; // resume待ちの間の読込・デモ復帰・二重再生を除く
  const src = ac.createBufferSource(); src.buffer = state.buffer; src.connect(ac.destination);
  src.onended = () => { if (state.source === src && state.playing && now() >= buffer.duration - 0.05) { stop(); state.offset = 0; } };
  state.startedAt = ac.currentTime; src.start(0, state.offset); state.source = src; state.playing = true; resetAudition();
  updatePlayButton();
  // 2026-10-07 夜: Safari で「再生中の表示なのに音が出ない」対策。開始から0.7秒たっても音源時計が進まない／running でないなら、次のタップで立て直す。
  const startedCtxTime = ac.currentTime;
  setTimeout(() => {
    if (state.source !== src || !state.playing) return;
    const advanced = ac.currentTime - startedCtxTime;
    if (ac.state !== "running" || advanced < 0.05) armAudioRecovery(`after start: state=${ac.state} advanced=${advanced.toFixed(3)}s`);
    else { audio.blocked = false; diagNote(`audio ok: advanced ${advanced.toFixed(3)}s`); }
  }, 700);
  // 再生開始位置より前の Intent は捨てる
  state.lastT = state.offset;
}
function stop() {
  if (state.source) { try { state.source.stop(); } catch (_) {} state.source.disconnect(); state.source = null; }
  if (state.playing) state.offset = now();
  state.playing = false; updatePlayButton();
}
function seedActivePoints(t) {
  if (!state.intents) return;
  for (const d of state.intents.discrete) if (d.intent === "point" && d.srcInstrument !== "bass" && d.t <= t && t < d.t + d.dur) { ink.receive(d, t); rig.receive(d, t); }
}
function seek(t) { const was = state.playing; stop(); state.offset = Math.max(0, Math.min(duration(), t)); ink.reset(); rig.reset(); rig.pointMode = !!state.intents?.discrete.some((d) => d.intent === "point" && d.srcInstrument !== "bass"); seedActivePoints(state.offset); state.lastT = state.offset; if (was) play(); drawTimeline(); }
$("btnPlay").addEventListener("click", () => (state.playing ? stop() : play()));
window.addEventListener("keydown", (e) => { if (e.code === "Space" && !["INPUT", "SELECT", "BUTTON", "TEXTAREA", "SUMMARY"].includes(document.activeElement.tagName)) { e.preventDefault(); state.playing ? stop() : play(); } });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.focus) setFocus(false); });
$("btnNextEvent").addEventListener("click", () => {
  if (!state.intents || !hasPlayback()) return;
  const next = state.intents.discrete.find((d) => d.intent !== "pulse" && d.t > now() + 0.05);
  if (!next) { setStatus("この先に反応はありません"); return; }
  seek(next.t);
  if (next.intent !== "point") { ink.receive(next, next.t); rig.receive(next, next.t); }
  setStatus(`次の反応 ${fmt(next.t)} — ${next.intent}`);
});

// ---------- 診断（?diag=1 で画面左下に表示）と、音が出ない時の立て直し（2026-10-07 夜） ----------
const DIAG = new URLSearchParams(location.search).has("diag");
const diag = { log: [], lastError: "", el: null };
function diagNote(text) { diag.log.push(`${(performance.now() / 1000).toFixed(1)}s ${text}`); if (diag.log.length > 8) diag.log.shift(); }
window.addEventListener("error", (e) => { diag.lastError = String(e.message || e.error || e); diagNote("error: " + diag.lastError); });
window.addEventListener("unhandledrejection", (e) => { diag.lastError = String(e.reason?.message || e.reason); diagNote("rejection: " + diag.lastError); });
if (DIAG) {
  diag.el = document.createElement("pre"); diag.el.id = "diag";
  diag.el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:9999;margin:0;padding:8px 10px;background:rgba(0,0,0,.85);color:#9fe;font:12px/1.4 ui-monospace,Menlo,monospace;max-width:92vw;white-space:pre-wrap;pointer-events:none;border:1px solid #2c2c30;border-radius:6px";
  document.body.appendChild(diag.el);
}
function updateDiag() {
  if (!diag.el) return;
  const ac = state.audioCtx, ua = navigator.userAgent;
  diag.el.textContent = [
    `v${VERSION}  ${/Safari/.test(ua) && !/Chrome|Chromium|CriOS/.test(ua) ? "Safari" : "other browser"}  ${ua.slice(0, 60)}`,
    `audioCtx: ${ac ? ac.state : "(まだ作られていない)"}  currentTime=${ac ? ac.currentTime.toFixed(2) : "-"}  sampleRate=${ac ? ac.sampleRate : "-"}  age=${ac ? ((performance.now() - audio.ctxCreatedMs) / 1000).toFixed(0) + "s" : "-"}  built=${audio.ctxCount}`,
    `playing=${state.playing} demo=${state.demo} offset=${state.offset.toFixed(2)} now=${now().toFixed(2)} source=${!!state.source} buffer=${state.buffer ? state.buffer.duration.toFixed(1) + "s" : "-"} file=${state.fileName || "-"}`,
    `blocked=${audio.blocked}  status: ${$("topStatus").textContent}`,
    `lastError: ${diag.lastError || "-"}`,
    ...diag.log,
  ].join("\n");
}
const audio = { blocked: false, armed: false, ctxCreatedMs: 0, ctxCount: 0, rebuildAfterMs: 10 * 60 * 1000 };
window.otoAtari.audio = audio;
/** AudioContext を作り直す（古いものは閉じる）。再生中なら同じ位置から再開する。ユーザー操作の中で呼ぶと Safari の解錠も兼ねる。 */
function rebuildAudio(reason, { restart = true } = {}) {
  const old = state.audioCtx;
  const at = hasPlayback() && !state.demo ? now() : state.offset, was = state.playing && !state.demo;
  if (was) stop();
  if (old) { state.audioCtx = null; try { old.close().catch(() => {}); } catch (_) {} }
  diagNote(`audio rebuilt (${reason})`);
  const ac = ctx();
  if (!state.demo) state.offset = at;
  if (was && restart) play().then(() => { if (state.playing) setStatus("音を出し直しました"); });
  return ac;
}
$("btnAudioReset").addEventListener("click", () => { if (state.demo || !state.buffer) { setStatus("音源を読み込んでから押してください"); return; } audio.blocked = false; rebuildAudio("button"); if (!state.playing) setStatus("音を出し直しました。▶ で再生します"); });
/** 音源時計が進まない時（Safari の自動再生制限・出力先の切替など）、次のタップ／キーで AudioContext を起こし、同じ位置から再生し直す。 */
function armAudioRecovery(reason) {
  audio.blocked = true;
  diagNote("blocked: " + reason);
  setStatus("音が出ていません。画面をどこか一度タップ（クリック）すると、その位置から再開します");
  if (audio.armed) return;
  audio.armed = true;
  const once = () => {
    for (const ev of ["pointerdown", "keydown", "touchend"]) document.removeEventListener(ev, once, true);
    audio.armed = false;
    if (!state.audioCtx) return;
    // ユーザー操作と同じ呼び出しの中で AudioContext を作り直す（古い出力先に縛られたものを捨てる）＋無音1サンプルの再生（Safari の解錠）
    const at = now(); stop(); state.offset = at;
    const ac = rebuildAudio("gesture after blocked", { restart: false });
    try { ac.resume().catch(() => {}); const s = ac.createBufferSource(); s.buffer = ac.createBuffer(1, 1, ac.sampleRate); s.connect(ac.destination); s.start(0); } catch (_) {}
    diagNote("gesture → new context, state=" + ac.state);
    play().then(() => { if (state.playing && ac.state === "running") setStatus("再開しました"); });
  };
  for (const ev of ["pointerdown", "keydown", "touchend"]) document.addEventListener(ev, once, true);
}

// ---------- 描画ループ ----------
const meterIds = ["sub", "bass", "lowmid", "mid", "high", "air", "loud"];
(function buildMeters() { const m = $("meters"); for (const id of meterIds) { const d = document.createElement("div"); d.className = "m"; d.innerHTML = `<i></i><b>${id === "loud" ? "L" : id.slice(0, 2)}</b>`; d.dataset.id = id; m.appendChild(d); } })();
const logItems = [];
function pushLog(d) { logItems.unshift(`<b>${fmt(d.t)}</b> ${d.intent} @${[].concat(d.zone).join("+")}${d.color ? ` <span style="color:${d.color}">■</span>` : ""} <span class="sub">${d.ruleId}${d.srcPattern ? " 復元" : ""}${typeof d.srcConfidence === "number" ? ` ${Math.round(d.srcConfidence * 100)}%` : ""}</span>`); if (logItems.length > 6) logItems.length = 6; $("log").innerHTML = logItems.map((x) => `<li>${x}</li>`).join(""); }

function frame() {
  requestAnimationFrame(frame);
  if (!hasPlayback()) return;
  if (state.demo && state.playing && now() >= duration()) seek(0);
  const latency = (parseFloat($("latencyMs").value) || 0) / 1000;
  const t = now() + latency;
  const it = state.intents;
  const cont = it ? continuousAt(it, t) : [];
  const palName = it ? paletteNameAt(it, t) : null;
  const surface = it && palName && it.palettes[palName] ? it.palettes[palName].surface : null;
  if (palName && $("paletteRow").dataset.current !== palName) renderPalette(palName);
  if (it && state.playing && !state.demo && $("audition").checked) scheduleAudition(it, t);
  if (it && state.playing && t > state.lastT) {
    const suppress = $("suppressStrobe").checked;
    for (let d of discreteBetween(it, state.lastT, t)) {
      if (d.intent === "point" && d.srcInstrument === "bass") continue;
      if (suppress && d.intent === "strobe") d = { ...d, intent: "pulse", level: 0.5, decaySec: 0.3 };
      if (d.intent === "point" || state.view !== "rig") ink.receive(d, t);
      if (d.intent === "point" || state.view !== "ink") rig.receive(d, t);
      if (d.intent !== "pulse" && d.intent !== "point") pushLog(d);
    }
    state.lastT = t;
  }
  if ($("preview").hidden) { /* 設定中も音源時計と時間軸は維持し、隠れたcanvasは描かない。 */ }
  else if (state.view === "stage3d") stage3d.frame(t, { playing: state.playing });
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
  updateDiag();
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
const seekInput = $("seek");
let scrubbing = false, resumeAfterScrub = false;
seekInput.addEventListener("pointerdown", () => {
  if (!hasPlayback()) return;
  scrubbing = true; resumeAfterScrub = state.playing;
  if (resumeAfterScrub) stop();
});
seekInput.addEventListener("input", () => { if (hasPlayback()) seek(Number(seekInput.value)); });
function finishScrub() {
  if (!scrubbing) return;
  scrubbing = false;
  const resume = resumeAfterScrub; resumeAfterScrub = false;
  if (resume) play();
}
seekInput.addEventListener("change", finishScrub);
seekInput.addEventListener("blur", finishScrub);
window.addEventListener("pointerup", finishScrub);
window.addEventListener("pointercancel", finishScrub);
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
    ft.sections.forEach((s, k) => {
      c.fillStyle = k % 2 ? "rgba(236,230,218,0.08)" : "rgba(236,230,218,0.04)";
      c.fillRect(x(s.start), 0, x(s.end) - x(s.start), h);
      c.fillStyle = "#a39d92"; c.font = `${10 * dpr}px system-ui`;
      if (c.measureText(s.label).width + 8 * dpr <= Math.min(w, x(s.end)) - x(s.start)) c.fillText(s.label, x(s.start) + 4 * dpr, 12 * dpr);
    });
    // loudness 波形
    c.fillStyle = "rgba(236,230,218,0.35)";
    const L = ft.curves.loudness, step = Math.max(1, Math.floor(L.length / w));
    for (let i = 0; i < L.length; i += step) { const v = L[i]; c.fillRect(x(i * ft.clock.hopSec), h * (0.95 - v * 0.6), Math.max(1, w / (L.length / step)), h * v * 0.6); }
    // ピアノ単音候補（低い音ほど下、高い音ほど上）
    for (const e of ft.events) if (e.type === "note" && e.instrumentCandidate !== "bass") { c.fillStyle = "rgba(143,212,201,0.72)"; c.fillRect(x(e.t), h * (0.72 - e.position01 * 0.48), Math.max(1.5 * dpr, x(e.t + e.dur) - x(e.t)), 2 * dpr); }
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
  if (!scrubbing) seekInput.value = String(t);
  const valueText = `${fmt(t)} / ${fmt(dur)}`;
  if (seekInput.getAttribute("aria-valuetext") !== valueText) seekInput.setAttribute("aria-valuetext", valueText);
}
window.addEventListener("resize", drawTimeline);

// ---------- 入力 ----------
async function loadSample({ autoplay = false } = {}) {
  if (ui.sourceBusy) return;
  // Safari対策: AudioContextの生成・resume()はユーザー操作から同期的に呼ばないと
  // 「無音のまま一時停止状態で固まる」ことがある。await の手前で必ず先に呼ぶ。
  ctx();
  setSourceBusy(true);
  try {
    setStatus("サンプル曲を読み込み中…");
    const [audioRes, ftRes] = await Promise.all([fetch("../samples/gensan-extend.mp3"), fetch(`../samples/gensan-extend.features.json?v=${VERSION}`)]);
    if (!audioRes.ok) throw new Error("サンプル音源を取得できません。もう一度お試しください");
    if (autoplay || $("presetSelect").value === "presets/mapping-piano-notes.json") {
      $("presetSelect").value = "presets/mapping-drums-only.json";
      await loadPreset($("presetSelect").value);
    }
    await loadAudio(await audioRes.arrayBuffer(), "gensan-extend.mp3");
    if (ftRes.ok) { setFeatures(await ftRes.json()); setStatus(`gensan-extend.mp3 — Python版の解析JSONを使用（analysis/analyze.py）`); }
    else await analyzeInBrowser();
    showLoadedPreview();
    if (autoplay) { await play(); if (state.playing) setStatus("音楽付きデモ — gensan-extend.mp3"); }
  } catch (err) { setStatus("サンプルの読み込みに失敗: " + err.message); }
  finally { setSourceBusy(false); }
}
$("btnSample").addEventListener("click", () => loadSample());
$("btnDemoMusic").addEventListener("click", () => loadSample({ autoplay: true }));
$("btnLightDemo").addEventListener("click", () => startLightDemo());
$("btnPianoSample").addEventListener("click", async () => {
  ctx();
  setSourceBusy(true);
  try {
    setStatus("B曲のピアノ候補を読み込み中…");
    const [audioRes, ftRes] = await Promise.all([fetch("../samples/B.mp3"), fetch(`../samples/B-piano.features.v2.json?v=${VERSION}`)]);
    if (!audioRes.ok || !ftRes.ok) throw new Error("B曲の試験ファイルを取得できません");
    await loadAudio(await audioRes.arrayBuffer(), "B.mp3");
    const ft = await ftRes.json();
    if (ft.source.file !== "B.mp3" || Math.abs(ft.source.durationSec - state.buffer.duration) > 0.05) throw new Error("音源と解析JSONが一致しません");
    $("presetSelect").value = "presets/mapping-piano-notes.json";
    await loadPreset($("presetSelect").value);
    setFeatures(ft, { detectDrums: false });
    setView("rig");
    setStatus("B.mp3 — 推定ピアノ単音493件。音高→左右位置、モデル強度＋原曲の相対音量→光量");
    showLoadedPreview();
  } catch (err) { setStatus("B曲の読み込みに失敗: " + err.message); }
  finally { setSourceBusy(false); }
});
$("fileAudio").addEventListener("change", async (e) => {
  ctx(); // 同上（Safari対策）
  const f = e.target.files[0]; if (!f) return;
  setSourceBusy(true);
  try {
    setStatus(`${f.name} を読み込み中…`);
    await loadAudio(await f.arrayBuffer(), f.name);
    await analyzeInBrowser();
    setStatus(`${f.name} — 解析が完了しました`);
    showLoadedPreview();
  } catch (err) { setStatus("音源を読み込めません: " + err.message); }
  finally { setSourceBusy(false); }
});
$("fileFeatures").addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { setFeatures(JSON.parse(await f.text())); } catch (err) { alert("JSONを読めません: " + err.message); } });
$("presetSelect").addEventListener("change", (e) => loadPreset(e.target.value));
$("fileMapping").addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { setMapping(JSON.parse(await f.text())); } catch (err) { alert("JSONを読めません: " + err.message); } });
document.querySelectorAll(".views .view").forEach((b) => b.addEventListener("click", () => {
  setView(b.dataset.view);
  if (phoneMedia.matches) { ui.settingsOpen = false; syncResponsiveUI(); }
}));
function setView(v) {
  state.view = v;
  document.querySelectorAll(".views .view").forEach((b) => { const on = b.dataset.view === v; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  $("inkCanvas").hidden = v === "rig" || v === "stage3d"; $("rigCanvas").hidden = v === "ink" || v === "stage3d"; $("stage").classList.toggle("both", v === "both");
  $("stage3dCanvas").hidden = v !== "stage3d";
  $("stageViewpointControl").hidden = v !== "stage3d";
  $("stage").classList.toggle("stage3d", v === "stage3d");
  ink.lastT = null; rig.lastT = null;
  updateStageGuide();
}
function updateStageGuide() {
  $("stageGuide").hidden = state.demo || !state.buffer || (!state.focus && !compactMedia.matches && state.view !== "stage3d");
  if (state.view === "stage3d") {
    $("stageGuideTitle").textContent = "舞台（3D）";
    const spots = stage3d.rig.fixtures.filter((f) => f.soundRole === "point").length;
    const bassWashes = stage3d.rig.fixtures.filter((f) => f.soundRole === "bass").length;
    $("stageGuideText").textContent = `転がし＝キック（白青のウォッシュを客席側へ）／SS＝スネア・クラップ（橙・広め）／LEDバー20本＝ハイハット（金・バーだけ）／横の細いビーム6台＝左右に振られたギター（マゼンタ・左の音は下手、右の音は上手から・一打ごとに順送り）／吊りスポット${spots}台・2列＝ピアノ・プラックなどのアタック（水緑・音程ごとに別の灯、低音は左・高音は右）。${bassWashes ? `床奥のウォッシュ${bassWashes}台＝ベース（藍紫・音程ごとに別の灯・音量の減り方で消える）。` : ""}${$("mirrorBallToggle").checked ? "ミラーボール＝音圧の高い小節のまとまり（小節の頭で出入り）の間だけ現れて回り、ピン2灯が拍（キック・スネア）で瞬いて反射の粒が空間を流れます。ピンの色は区間に入るたびと2小節ごとに変わります。" : ""}戻りは未対応。ドラッグで見回し。`;
    return;
  }
  const point = !!state.intents?.discrete.some((d) => d.intent === "point" && d.srcInstrument !== "bass");
  $("stageGuideTitle").textContent = point ? "ピアノ単音の光" : (state.view === "rig" ? "照明図" : "インクの出力");
  $("stageGuideText").textContent = point
    ? (state.view === "rig" ? "左＝低音／右＝高音。光はモデル強度70％＋原曲全体の相対音量30％。実灯体には未割当です。" : "左＝低音／右＝高音。光の大きさと明るさはモデル強度70％＋原曲全体の相対音量30％。各音の実音量や元MIDIのベロシティではありません。")
    : "再生位置と描画を同期して確認できます。時間軸を押すと移動します。";
}
function setFocus(on) {
  if (on && !hasPlayback()) return;
  state.focus = on;
  ink.focus = on;
  document.body.classList.toggle("focus-mode", on);
  $("btnFocus").textContent = on ? "編集へ戻る" : "出力を見る";
  $("btnFocus").setAttribute("aria-pressed", String(on));
  $("stageGuide").hidden = !on;
  if (on) setView("stage3d");
  updateStageGuide();
  syncResponsiveUI();
  requestAnimationFrame(drawTimeline);
}
$("btnFocus").addEventListener("click", () => setFocus(!state.focus));

// ---------- スマホ・タブレット（既存の入力と音源時計を共有する） ----------
function syncResponsiveUI() {
  const phone = phoneMedia.matches, compact = compactMedia.matches;
  if (phone && state.focus) { state.focus = false; ink.focus = false; }
  document.body.classList.toggle("phone-layout", phone);
  document.body.classList.toggle("compact-layout", compact);
  document.body.classList.toggle("focus-mode", state.focus);
  $("btnFocus").hidden = phone;
  $("btnFocus").textContent = state.focus ? "編集へ戻る" : "出力を見る";
  $("btnFocus").setAttribute("aria-pressed", String(state.focus));
  $("btnSettings").hidden = !phone;
  $("btnSettings").textContent = ui.settingsOpen ? "映像を見る" : "設定";
  $("btnSettings").setAttribute("aria-expanded", String(ui.settingsOpen));
  $("settings").hidden = phone ? !ui.settingsOpen : state.focus;
  $("preview").hidden = phone && ui.settingsOpen;
  $("settingsNav").hidden = !compact;
  for (const panel of document.querySelectorAll(".side .panel")) panel.hidden = compact && panel.id !== ui.panel;
  for (const button of $("settingsNav").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.panel === ui.panel));
  updateStageGuide();
  requestAnimationFrame(drawTimeline);
}
function showLoadedPreview() {
  if (phoneMedia.matches) { ui.settingsOpen = false; syncResponsiveUI(); }
}
function setSourceBusy(busy) {
  ui.sourceBusy = busy;
  for (const id of ["btnSample", "btnPianoSample", "btnLightDemo", "btnDemoMusic", "fileAudio"]) $(id).disabled = busy;
  $("fileFeatures").disabled = busy || state.demo;
  $("btnDemoMusic").textContent = busy ? "読込中…" : "音楽も再生";
  $("panelSource").setAttribute("aria-busy", String(busy));
  if (!busy) $("progress").hidden = true;
}
$("btnSettings").addEventListener("click", () => { ui.settingsOpen = !ui.settingsOpen; syncResponsiveUI(); });
$("btnChooseSource").addEventListener("click", () => {
  ui.settingsOpen = true; ui.panel = "panelSource";
  if (state.focus) setFocus(false);
  syncResponsiveUI(); $("settings").scrollTop = 0; $("btnSample").focus();
});
for (const button of $("settingsNav").querySelectorAll("button")) button.addEventListener("click", () => {
  ui.panel = button.dataset.panel; syncResponsiveUI(); $("settings").scrollTop = 0;
});
for (const [id, direction] of [["btnLatencyMinus", -1], ["btnLatencyPlus", 1]]) $(id).addEventListener("click", () => {
  const input = $("latencyMs");
  if (!Number.isFinite(input.valueAsNumber)) input.value = "0";
  direction > 0 ? input.stepUp() : input.stepDown();
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
phoneMedia.addEventListener("change", syncResponsiveUI);
compactMedia.addEventListener("change", syncResponsiveUI);
window.visualViewport?.addEventListener("resize", () => requestAnimationFrame(drawTimeline));
new ResizeObserver(() => requestAnimationFrame(drawTimeline)).observe($("timeline"));

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
    $("btnExportGamma").disabled = state.demo || !state.intents || state.intents.discrete.some((d) => d.intent === "point" && d.srcInstrument !== "bass");
    if (state.intents?.discrete.some((d) => d.intent === "point" && d.srcInstrument !== "bass")) $("gammaSummary").textContent += "。単音の位置指定はγ下書きへ未対応";
  } catch (err) { alert(err.message); state.gammaTemplate = null; }
});
$("btnExportGamma").addEventListener("click", () => {
  try {
    // 段階1では bass point に出力先が無い。ピアノ point の既存拒否は維持する。
    const gammaIntents = { ...state.intents, discrete: state.intents.discrete.filter((d) => !(d.intent === "point" && d.srcInstrument === "bass")) };
    const { document: out, summary } = buildGammaDraft(state.gammaTemplate, state.ft, gammaIntents, { sceneId: $("gammaScene").value });
    download(`${base()}.gamma-draft.json`, out);
    $("gammaSummary").textContent = `書き出し: シーン「${summary.sceneName || summary.sceneId}」へ 登録した明かり ${summary.lxqAdded} 件${summary.cuesAdded ? `・ライトキュー ${summary.cuesAdded} 件` : ""}（${summary.times.map((x) => fmt(x.t)).join(", ")}）`;
  } catch (err) { alert(err.message); }
});

// ---------- 共通 ----------
function fmt(t) { if (!Number.isFinite(t)) return "0:00.0"; const m = Math.floor(t / 60), s = (t % 60).toFixed(1).padStart(4, "0"); return `${m}:${s}`; }
function setStatus(s) { $("topStatus").textContent = s; $("topStatus").title = s; $("settingsStatus").textContent = s; }
function showProgress(p, text) { $("progress").hidden = false; $("progressBar").style.width = `${Math.round(p * 100)}%`; $("progressText").textContent = text; }
async function startLightDemo() {
  if (ui.sourceBusy) return;
  stop();
  state.demo = true; state.buffer = null; state.mono = null; state.stereo = null; state.sideLayer = null;
  state.ft = createDemoFeatures(); state.ftBase = null; state.intents = null;
  state.fileName = ""; state.offset = 0.06; state.lastT = -1;
  ink.reset(); rig.reset(); exp.data = null; stage3d.reset();
  ink.pointMode = rig.pointMode = false;
  for (const id of ["facts", "sensRow", "pianoNotice", "emptyState"]) $(id).hidden = true;
  for (const id of ["btnExportFeatures", "btnExportIntents", "btnExportGamma", "btnNextEvent"]) $(id).disabled = true;
  $("demoBanner").hidden = false;
  $("btnPlay").disabled = false; $("btnFocus").disabled = false;
  $("seek").disabled = false; $("seek").max = String(duration());
  $("tDur").textContent = fmt(duration()); $("tempoBox").textContent = "120 BPM";
  $("presetSelect").value = "presets/mapping-drums-notes.json";
  setSourceBusy(true);
  setView("stage3d"); showLoadedPreview();
  setStatus("光のデモ · 無音 — 「音楽も再生」でサンプル曲が流れます");
  try {
    await loadPreset($("presetSelect").value);
    // OSの低モーション指定は自動再生にも反映。通常は開いた直後から反復する。
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) play();
    else updatePlayButton();
  } catch (err) { setStatus("デモの準備に失敗しました。「光だけのデモに戻る」で再試行できます: " + err.message); }
  finally { setSourceBusy(false); drawTimeline(); }
}
if (compactMedia.matches) $("stageGuide").open = false;
syncResponsiveUI();
startLightDemo();
