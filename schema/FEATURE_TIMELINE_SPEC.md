# Feature Timeline 仕様 v1（`oto-atari.feature-timeline`）

> 2026-09-29: B曲の推定ピアノ単音は下記の **v2拡張**。既存のJS/Python解析器と旧サンプルはv1のまま読み込める。

このプロジェクトの**中心契約**。解析器（JS版・Python版・将来のステム版）はすべてこの形式を出力し、
割り振り（mapping）と各出力（インク描画・照明図・舞台スケッチγ書き出し・DMX等）はこの形式だけを読む。
解析器を差し替えても下流が壊れないこと、下流を増やしても解析器を触らないことが目的。

- 時刻 `t` はすべて **音源ファイルの先頭からの秒**（サンプル0＝0秒）。オフセット補正は出力側の責務。
- STFT は**中心揃え**（librosa `center=True` と同じ。フレーム i の窓の中心がサンプル `i*hop`）。片側揃えだと数十msずれる。
  `clock.frames` は `ceil(サンプル数 / hop)` 前後で解析器により±1 してよい（読み手は curves の長さを正とする）。
- 解析サンプルレートは **44100 Hz 以上を既定**にする。22050 Hz だと `air` 帯域の上半分（11k〜16kHz）が観測できない。
- 連続量（curves）は 0〜1 に正規化した数値配列。1フレーム＝`clock.hopSec` 秒、フレーム i の時刻＝ `i * hopSec`。
- 離散事象（events）は時刻付きの配列。並びは時刻昇順。
- 「楽器」の判定は**ヒューリスティック**（混ざった音源から推定）。`tags` に候補を書き、`confidence` を付ける。
  ステム分離（Demucs等）を使った場合だけ `stem` を確定情報として書く。推測を確定として書かない。

## トップレベル

```jsonc
{
  "format": "oto-atari.feature-timeline",
  "version": 1,
  "source": {
    "file": "gensan-extend.mp3",          // ファイル名（パスは書かない）
    "durationSec": 84.888,
    "sampleRate": 48000,                    // 解析に使ったレート（原音と違ってよい）
    "channels": 2,
    "sha256": "…",                          // 任意。音源との対応確認用
    "analyzedAt": "2026-09-28T03:00:00.000Z",
    "analyzer": { "name": "oto-atari-js", "version": "0.1.0", "params": { /* 解析器固有 */ } },
    "stems": null                           // ステム分離時: { "engine": "demucs:htdemucs_6s", "names": ["drums","bass","vocals","other","guitar","piano"] }
  },
  "clock": { "hopSec": 0.01, "frames": 8489 },
  "bands": [                                 // 帯域の定義。curves の "band.<id>" と events.band が参照する
    { "id": "sub",    "hz": [20, 60] },
    { "id": "bass",   "hz": [60, 160] },
    { "id": "lowmid", "hz": [160, 500] },
    { "id": "mid",    "hz": [500, 2000] },
    { "id": "high",   "hz": [2000, 6000] },
    { "id": "air",    "hz": [6000, 16000] }
  ],
  "tempo": { … },       // 下記
  "sections": [ … ],    // 下記
  "curves": { … },      // 下記
  "events": [ … ],      // 下記
  "streams": { … }      // 任意。ステム別の curves/events
}
```

## tempo

```jsonc
{
  "bpm": 128.0,
  "confidence": 0.82,               // 0〜1。自己相関ピークの鋭さ等。低いときは出力側で拍依存の演出を弱める
  "beatsPerBar": 4,                 // 推定できないときは 4 を書き "barConfidence": 0
  "barConfidence": 0.5,
  "grid": "tracked",                // "fixed"=一定BPMで敷いた格子 / "tracked"=拍追跡の結果
  "beats": [                        // 全拍。時刻昇順
    { "t": 0.468, "index": 0, "bar": 0, "beatInBar": 0, "strength": 0.71 }
  ],
  "downbeats": [0.468, 2.343, …]    // beats のうち beatInBar==0 の t（利便のため重複して持つ）
}
```

## sections（曲の区切り）

```jsonc
{
  "id": "S1", "start": 0.0, "end": 15.02, "label": "intro",  // label は heuristic: intro/verse/build/drop/break/outro/A/B…
  "energy": 0.32,          // 区間平均 loudness
  "brightness": 0.41,      // 区間平均 centroid
  "dominantBand": "bass",  // 区間で最も相対的に強い帯域
  "novelty": 0.87,         // 境界の強さ 0〜1（start 側）
  "confidence": 0.6
}
```

## curves（連続量・全て 0〜1・長さ = clock.frames）

必須:
- `loudness` — 知覚寄りの音量（RMS を dB 化して曲全体の分布で正規化。無音=0）
- `band.<id>` — 各帯域のエネルギー（帯域ごとに曲全体で正規化。帯域間の絶対比は `bandGain` に別記）
- `centroid` — スペクトル重心（log周波数を 20Hz〜16kHz で 0〜1 に）
- `flux` — スペクトル変化量（トランジェント感）
任意:
- `flatness` — 雑音性（0=音程的、1=ノイズ的）
- `stereoWidth` — ステレオ幅（モノなら省略）
- `pitchHz` は curves に入れない（0〜1 でないため）。必要なら `pitch: { "hz": [...], "confidence": [...] }` を別キーで持つ

```jsonc
"curves": {
  "loudness": [0, 0, 0.012, …],
  "band.sub": […], "band.bass": […], …,
  "centroid": […], "flux": […],
  "bandGain": { "sub": 0.9, "bass": 1.0, "lowmid": 0.7, "mid": 0.6, "high": 0.4, "air": 0.25 }  // 帯域間の平均レベル比（最大帯域=1）
}
```
数値は小数3桁で丸める。ファイルサイズ目安: 85秒・hop 10ms・10本 ≈ 0.5MB。

## events（離散事象・時刻昇順）

共通フィールド: `t`（秒）, `type`, `strength`（0〜1）, 任意 `dur`（秒）, `confidence`（0〜1）。

| type | 意味 | 追加フィールド |
|---|---|---|
| `onset` | 音の立ち上がり | `band`（最も寄与した帯域）, `bands`（寄与 {id: 0〜1}）, `tags`（下記）, `pitchHz`（任意）, `stem`（ステム時のみ） |
| `accent` | 帯域をまたぐ強い一撃（onset の中で特に強いもの） | `bands` |
| `drop` | 静→動のエネルギー急増（ブレイク明け・落とし） | `fromEnergy`, `toEnergy` |
| `build` | 上昇（ライザー等。centroid と flux が数秒かけて単調増加） | `dur`, `endT` |
| `silence` | 無音・ほぼ無音の区間 | `dur` |
| `sectionChange` | sections の境界（利便のため events にも重複して置く） | `sectionId`, `label` |

`tags` は **`[{ "name": "kick", "confidence": 0.7 }, …]` の配列**（2026-09-28 確定。文字列配列は不可）。
名前（ヒューリスティック。確定ではない）: `kick`（sub/bass 主体・短い減衰）, `snare`（lowmid＋high の広帯域・雑音的）,
`hat`（high/air だけ・小さい）, `stab`（mid 主体・音程あり）, `noise`（flatness 高い）。
ステム分離時は `stem` を優先し tags は補助。

## drums（自前の打楽器判定・2026-09-28 追加）

混ざった音源から「拍を担う打楽器」だけを判定する層（`web/lib/drums.mjs`）。楽器の音色を取り出すのではなく、
帯域×立ち上がりの速さ×減衰の短さだけを見る。結果は onset の `tags` に `source: "drums-v1"` 付きで統合し、
拍格子（tempo.beats／bpm の倍・半分／小節頭）も打楽器の位置で補正する。

```jsonc
"drums": { "version": 1, "counts": { "kick": 114, "snare": 74, "hat": 175 },
           "grid": { "shiftSec": -0.14, "mult": 1, "agreement": 0.75, "applied": true } }
```
- kick: 40〜120Hz が 30ms で +6dB 以上立ち上がり、200ms で −6dB 以上減衰（持続するベース音を除外）。
- snare: 150〜400Hz（胴）と 2〜8kHz（響き線）が同時に立ち上がり、キックと重なるときは響き線が胴に匹敵する場合だけ。
- hat: 7〜16kHz の立ち上がりで、直前 20ms に 2kHz 以下が動かず、キック／スネアの ±30ms に無い。
- `sensitivity` 1〜5（既定 3、アプリの既定は 4）: 閾値をまとめて緩める／厳しくする。`thresholdsFor()` 参照。
- **`pan`（−1=左 … 0=中央 … +1=右）**: ステレオ音源のとき、判定した打楽器の onset に、その帯域の L/R エネルギー比を付ける（2026-09-28 追加）。
  モノ音源や不明なら 0。割り振りでは `x: { "from": "pan", "domain": [-1, 1], "range": [0, 1] }` で横位置へ写せる（低域＝キックはほぼ中央に出る。実曲で低域の中央成分は側成分より 20dB 大きかった）。
- `tags[*].source` が `drums-v1` のものが判定結果。無いものは旧ヒューリスティック（drums 判定後は kick/snare/hat 名では残らない）。
- `tempo.gridRefinedBy: "drums-v1"` が付いたら、格子は打楽器で補正済み（一致率 `drums.grid.agreement`）。
- 合成信号での実測（2026-09-28）: kick 19/19・持続ベース誤認 0・snare 19/19・hat 37/38。実曲では本人の耳で検証する（アプリの「合図音」）。

## streams（任意・ステム別）

```jsonc
"streams": {
  "drums": { "curves": { "loudness": […], "band.sub": […] … }, "events": [ … ] },
  "bass":  { … }, "vocals": { … }, "other": { … }
}
```
`streams.<stem>.events[*].stem` は自動的にそのステム名。

## 互換性の規則

- 追加は自由（未知キーは読み手が無視する）。既存キーの意味変更・削除は `version` を上げる。
- 読み手は `format` と `version` を検査し、違えば読み込みを止めて理由を表示する（黙って別解釈しない）。
- 検証: `node tests/run.mjs`（`web/lib/validate.mjs` が形式・値域・順序を検査。JSON Schema ファイルは未作成）。

## v2拡張：推定ピアノ単音（2026-09-29）

`version: 2` はv1の全フィールドを保ち、`events` に `type: "note"` を追加する。時刻は原曲先頭からの秒で、和音の音は別々の事象として同じ時間に並べる。音楽的に確定した単音や元MIDIではなく、モデル候補を保存する。

| フィールド | 意味 |
|---|---|
| `t`, `dur` | 候補の開始時刻と持続秒数。拍格子へ吸着しない |
| `pitchMidi`, `pitchName`, `pitchHz` | 推定音高（MIDI 21〜108） |
| `position01` | 88鍵の左から右への相対位置 `(pitchMidi-21)/87` |
| `modelStrength01`, `strength` | 同じモデル強度 0〜1。実音圧でも元MIDIのベロシティでもない |
| `velocityProxy`, `mixLevel01` | 参考値。前者は強度由来、後者は曲全体の音量で一音ごとには分離できない |
| `status`, `instrumentCandidate` | `unverified_model_candidate`, `piano` を必須とし、確定音符と区別する |

`source.noteAnalysis` に使用モデル、版、候補数、強度の意味を記録する。v1読者はv2を明示的に拒否し、v2読者はv1も受け付ける。B試験ではBasic Pitch 0.4.0のONNX出力493件を元にし、正解MIDIがないため精度は未測定。自動生成は `analysis/merge_piano_notes.py`。

### v2追加：ベースの役割候補と余韻（2026-10-04）

この追加契約では上記の `instrumentCandidate` の値域を `"piano" | "bass"` に広げる（必須、欠落・その他の値は拒否）。`version` は **2 のまま**。`status` と既存フィールドの意味は変えず、`dur` は音高が有効だった長さを表す。

| フィールド | 型・意味 |
|---|---|
| `confidence` | 任意、0〜1。ベースでは pYIN 有声スコアの中央値。正解確率ではない |
| `confidenceKind` | `confidence` がある場合は文字列必須（例 `pyin-voiced-median`）。同じ kind 内のみ比較可 |
| `soundDur` | 任意、正の有限秒数。発音から余韻の終端まで |
| `release` | 任意の object。`{ status: "measured" | "unconfirmed", soundEndSec, reason, envelope }` |
| `release.envelope` | 発音基準の相対RMS `[[dtSec, rel01], …]`。音圧や velocity ではない |
| `source` | 任意の object。`{ method, release, stem, excerpt: [startSec, endSec] }` |

検証規則:

- `soundDur` があれば `soundDur ≥ dur − 0.001`、`t + soundDur ≤ source.durationSec + 0.05`。
- `release` があれば `soundDur` 必須。`status` は `measured` または `unconfirmed`。
- `measured` は有限の `soundEndSec` と `t + soundDur` が ±0.002 秒以内で一致し、`envelope` が必須。
- `envelope` は1〜16点、各点は有限の非負秒数と0〜1の相対値。先頭は `[0, 1]`、dt は厳密な昇順。同じ形式検査を任意の `unconfirmed` の envelope にも適用する。
- `unconfirmed` は `soundDur` と `dur` が ±0.001 秒以内で一致する。保留を固定秒で延長しない。
- bass のみ `t + (soundDur ?? dur)` が次の bass note の `t` を0.01秒より大きく超えたら拒否。ピアノの和音・重なりには適用しない。
- v1 への note 混入拒否は維持する。

## 正規化の定義（解析器間の差を減らすため・2026-09-28 追記）

- `loudness`, `band.<id>`: フレームのエネルギー（振幅二乗和）を dB 化し、曲全体の **99.5 パーセンタイルをピーク**、
  ピーク−50dB（帯域は −45dB）を 0 として線形に 0〜1 へ。無音は 0。曲間の絶対比較はできない（曲ごとの相対値）。
- `flux`: 帯域内の半波整流スペクトル差分の総和を、曲全体の 99 パーセンタイルで割って 0〜1 に切り詰める。
- `centroid`: スペクトル重心（Hz）を log スケールで 20Hz→0、16kHz→1。
- `events[*].strength`: onset は発火フレームの flux を「全 onset の flux の 95 パーセンタイル」で割った値（1 で切り詰め）。

## 下流が欲しいと分かっている追加候補（v2 検討・未実装）

局所テンポ／拍の位相（0〜1）／クロマ・調性／harmonic-percussive 比／減衰時間／ステレオ幅／ステム別 streams。
追加は既存キーを変えずに行う。
