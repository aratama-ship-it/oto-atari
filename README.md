# 音アタリ OTO-ATARI（仮称）— 楽曲を解析し、塗料・照明・舞台スケッチγへ割り振る

楽曲を事前解析して **時刻付きの特徴（Feature Timeline）** を作り、**割り振り規則（Mapping）** で出力先に依存しない
**演出の意図（Intent）** に写し、複数の出力（インク描画／照明図／舞台スケッチγの照明下書き）で見せるプロジェクト。
中心は解析層と割り振り層。出力は差し替え可能なアダプタとして増やす。

- 設計計画（判断用HTML）: `docs/DESIGN_PLAN.html`
- 契約（正本）: `schema/FEATURE_TIMELINE_SPEC.md`、`schema/MAPPING_SPEC.md`
- 先行事例調査: `docs/COMPETITOR_RESEARCH.md`
- 引き継ぎ: `PROJECT_NOTES.md`

> 公開リポジトリ（GitHub Pages）には `web/`・`presets/`・`schema/`・`samples/` だけを含める。`docs/`・`design/`・`analysis/`・`tests/`・`_delegation/` と上の資料リンク先はローカル作業用で、公開側には無い。

## 構成

```
oto-atari/
├── schema/        FEATURE_TIMELINE_SPEC.md / MAPPING_SPEC.md  … 中間形式の仕様（最重要）
├── analysis/      analyze.py（Python・librosa）/ merge_piano_notes.py（B曲候補のv2統合）/ test_analyze.py / README.md
├── web/
│   ├── lib/       dsp.mjs（FFT等）/ analyze-core.mjs（JS版解析器）/ mapping-engine.mjs（規則→Intent）/ validate.mjs
│   ├── renderers/ ink.mjs（塗料）/ rig.mjs（照明図）/ experience.mjs（体験表示・時刻決定型）/ gamma-export.mjs（γ下書き）/ zones.mjs（zone→幾何）
│   └── index.html / app.js / style.css
├── presets/       既存のv1割り振り / mapping-piano-notes.json（v2）
├── samples/       gensan-extend.mp3＋解析結果 / B.mp3＋B-piano.features.v2.json
├── tests/         run.mjs（node）/ synth.mjs（合成信号）/ fixtures/sample-lightdesign.json（γの照明デザイン書き出し見本）
└── design/        TOKEN_SHEET.md
```

## 使い方（このMac）

```sh
cd "/Users/arata/Library/Mobile Documents/com~apple~CloudDocs/claude code files/apps/utility-app/oto-atari"
python3 -m http.server 8973 --bind 127.0.0.1     # → http://127.0.0.1:8973/web/
```

1. 「サンプル曲を読み込む」か、音源ファイルをドロップ。解析JSONが無ければブラウザ内で解析（JS版）。
2. 割り振りの既定（インク／照明）を選び、規則のチェックで有効・無効を切り替える。
3. ▶ で再生。表示は「インク／照明図／両方」。ストロボは「抑える」で脈に置き換えられる。
4. 書き出し: 特徴JSON・意図JSON・γ下書き（γのショーJSONまたは照明デザインJSONを雛形に指定）。

Python版の解析（より正確。拍追跡・区切り）:

```sh
~/.venvs/oto-atari/bin/python analysis/analyze.py "<音源>" -o "<出力>.features.json" --sr 44100
```

## 検証

```sh
node tests/run.mjs                       # JS解析器（合成信号）・割り振り・γ書き出しの構造
~/.venvs/oto-atari/bin/python analysis/test_analyze.py   # Python解析器（合成信号）
```

## 打楽器の位置（キック・スネア・ハイハット）

`web/lib/drums.mjs` が混ざった音源から自前で判定する（帯域×立ち上がり×減衰）。割り振り既定「キックだけ（検証用）」と、
出力パネルの「合図音」（splat の位置でクリック音）で耳で確かめられる。時間軸の下段にも kick（紺）・snare（赤）・hat（水色）の目印が出る。判定の感度（1〜5）で拾い方を変えられる。
ステレオ音源では打楽器ごとにパン位置を測り、キック（中央）は画面中央、左右に振られたハイハット等は左右へ出る。

## B曲の推定ピアノ単音

「B曲・ピアノ単音を読み込む」を押すと、本人が試験画面で現段階の合格とした493件の候補を本体へ読み込み、「照明図」に切り替える。各音の**推定音高**を左（低）から右（高）の光点位置へ、Basic Pitchの**モデル強度**を光量へ写す。和音中の候補も個別に光り、時間軸を移動しても持続中の光点は表示される。インク面にも同じ光点を出し、特徴JSON・意図JSONを書き出せる。既存の打楽器用サンプルとv1規則は従来どおり。

候補は元MIDIの確定音符ではない。モデル強度は一音の音圧や元MIDIベロシティではなく、音抜けの改善と精度測定は未実施。B曲では打楽器を再判定せず、BPMの確からしさ8%なので拍目盛も抑えている。位置指定の光点はγ下書きに未対応のため、該当割り振りでは書き出しを停止する。

再生成する場合は `analysis/merge_piano_notes.py FEATURES NOTES AUDIO OUTPUT` を実行する。音源と二つの解析JSONのSHA-256を照合し、一致しなければ止まる。元データは `knowledge/research/audio-stem-feasibility-2026-09-28/test-tracks-20260928/results/` に保存されている。

## 既知の限界（2026-09-28）

- 楽器名（kick/snare 等）は混ざった音源からの推定で、確定情報ではない。ステム分離は未対応（Suno の12ステム書き出し・Demucs が候補）。
- 区切りラベル（intro/build/drop…）はヒューリスティック。小節頭（downbeat）の確からしさは低い。
- γ下書きは構造を γ の書き出し実物に合わせてあるが、**γ本体での読み込みは未確認**。
- 実機の照明（DMX/Art-Net）への送出は未実装（設計計画に段階を記載）。
