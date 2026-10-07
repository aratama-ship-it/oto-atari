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
├── analysis/      analyze.py（Python・librosa）/ merge_piano_notes.py（B曲候補のv2統合）/ merge_bass_notes.py（ベース候補と余韻のv2統合）/ test_analyze.py / README.md
├── web/
│   ├── lib/       dsp.mjs（FFT等）/ analyze-core.mjs（JS版解析器）/ mapping-engine.mjs（規則→Intent）/ validate.mjs / mirror-ball-map.mjs（舞台のミラーボールの割り振り・純粋関数）
│   ├── renderers/ ink.mjs（塗料）/ rig.mjs（照明図）/ experience.mjs（舞台へ渡す打点・単音・ベースのまとめ。旧「体験」表示は 2026-10-07 に外した）/ stage3d.mjs（舞台3D）/ gamma-export.mjs（γ下書き）/ zones.mjs（zone→幾何）
│   ├── vendor/gamma/ γの照明共有部品5本（本文無改変・複製元のコミットとSHA-256は PROVENANCE.json）
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

1. 開くと「舞台」表示で、音源不要の「光のデモ」が無音で動く。「音楽も再生」を押すと同梱サンプル曲が流れる。OSの低モーション設定がある場合はデモも停止状態から始まる。
2. スマホは右上の「設定」で音源や割り振りを選ぶ。タブレット・PCは映像と設定を並べて表示。手元の曲は「音源ファイル…」から選び、解析JSONが無ければブラウザ内で解析（JS版）。
3. ▶／❚❚ で再生・停止。時間軸は指でも動かせる。「舞台／インク／照明図／両方」を切り替え、割り振りの規則を変更できる。
4. 読み込んだ曲の特徴JSON・意図JSON・γ下書きを書き出せる（γは雛形JSONが必要）。無音デモは合成パターンで、音源解析結果ではないため書き出しは無効。

無音デモの「ドラム＋単音」は、転がし＝キック、SS＝スネア、LEDバー＝ハット、吊りスポット＝単音アタック、舞台奥の床のウォッシュ＝ベース（合成のベース進行・音高ごとに別の灯）を試せる。実音源で単音を表示するときは、対応するnote候補のある特徴JSONとピアノ単音／ドラム＋単音の規則を使う。実音源でベースを表示するときは、`analysis/merge_bass_notes.py` でベース候補（`instrumentCandidate: "bass"`）を入れた特徴JSONを読み込む（舞台表示で床奥のウォッシュが音高ごとに点き、音量の減り方で消える）。

Python版の解析（より正確。拍追跡・区切り）。このMacの `~/.venvs/oto-atari` は SciPy の読み込みエラーで動かないことがある（2026-10-05）。その場合は `~/.venvs/synth-matcher/bin/python` で実行する:

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

「舞台」では、ピアノ・プラックなどのアタックを最低24台・2列の吊りスポットへ割り当てる。音程の種類が多い曲では必要台数へ増え、B曲は40台。低音は左、高音は右で、半音差やオクターブ差も別の灯、同じ音程は同じ灯になる。曲全体から担当を決めるため、シークやルールのON/OFFでも配置は変わらない。打点ですぐ光り、0.6秒で消える。和音は個別に同時点灯し、同音程の重複は強い方を採る。保持時間の長い音も舞台では短い光にするが、元の音価・打点は維持する。音程のない合成デモでは指定した位置ごとに灯を分ける。新たな音色・楽器の認識は追加していない。「次の反応」で停止したまま点灯を確認できる。

灯体は舞台スケッチγの共有部品 `stage-fixture-body.js` を無改変で使用。転がしは土台・ヨーク・ヘッドのあるムービング、SSと吊りスポットは筒型の固定灯で表示する。音アタリ側で床置きの向きとレンズからの照射を接続し、ムービングの光は直径20cmのレンズ面全体から広がる。LEDバーは明るい発光面と周囲の柔らかいにじみを重ね、打点から0.42秒で滑らかに消灯する。

舞台には**ミラーボール1つとピン2灯**があり（操作帯の「ミラーボール」で切り替え・既定はオン）、舞台スケッチγの共有部品（γ v0.2.85）で描く。割り振りは「**持続音の間だけ球が回る**（途切れず鳴り続ける中域の帯が1秒以上続く区間と、ピアノ推定の長い音の余韻。回り始め・止まりは約0.8秒で加減速し、止まっても角度は保つ）／**拍でピンが瞬く**（キック→1灯目・スネア→2灯目。ドラムの無い曲は拍の表・裏）」。回っている間はピンが半分の明るさで点き続け、拍で最大まで光る。床・奥の壁・天井・袖に反射の粒が落ち、球の回転に合わせて空間を流れる。回る区間は特徴JSONの連続量から決めるヒューリスティックで、楽器名の判定ではない。ミラーボール以外の割り振り（転がし=キック、SS=スネア、LEDバー=ハット、吊りスポット=アタック）は変えていない。

再生成する場合は `analysis/merge_piano_notes.py FEATURES NOTES AUDIO OUTPUT` を実行する。音源と二つの解析JSONのSHA-256を照合し、一致しなければ止まる。元データは `knowledge/research/audio-stem-feasibility-2026-09-28/test-tracks-20260928/results/` に保存されている。

## 既知の限界（2026-09-28）

- 楽器名（kick/snare 等）は混ざった音源からの推定で、確定情報ではない。ステム分離は未対応（Suno の12ステム書き出し・Demucs が候補）。
- 区切りラベル（intro/build/drop…）はヒューリスティック。小節頭（downbeat）の確からしさは低い。
- γ下書きは構造を γ の書き出し実物に合わせてあるが、**γ本体での読み込みは未確認**。
- 実機の照明（DMX/Art-Net）への送出は未実装（設計計画に段階を記載）。
