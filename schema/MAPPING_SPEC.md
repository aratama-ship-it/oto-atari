# 割り振り（Mapping）仕様 v1（`oto-atari.mapping`）

> 2026-09-29: 推定単音を扱う `point` Intent は下記の **v2拡張**。既存のv1割り振りは変えない。

Feature Timeline（解析結果）を、出力先に依存しない**演出の意図（Intent）**へ写す規則集。
「ベースの音が下に黒く落ちる」「高域の軽い音は上で薄い色」「落としでストロボ」といった判断はここに書く。
出力（インク・照明図・γ・DMX）は Intent だけを読む。**規則は出力先を知らない。出力先は音を知らない。**

```
Feature Timeline ──(rules)──▶ Intent Timeline ──(renderer)──▶ 画面／照明／γのキュー
```

Intent Timeline は事前にまとめて計算できる（解析が事前処理だから）。再生中は「音源の時計 t に対応する Intent を引く」だけ。
これにより **先読み（拍への吸着・予告）** と **ファイル書き出し（γのキュー、DMXショー、動画）** が同じ経路で可能になる。

## Intent（中間語彙）

| intent | 性質 | フィールド |
|---|---|---|
| `splat` | 一発の飛沫。減衰して消える | `zone`, `color`, `size` 0〜1, `weight` 0〜1（重い=遅く落ち大きく広がる／軽い=速く散る）, `decaySec`, `spread` 0〜1, `x` 0〜1（任意。横位置。通常は事象の `pan` から導出。無ければ横 zone 内でランダム） |
| `pulse` | 拍の脈。面全体または zone が一瞬明るくなる | `zone`, `color`, `level` 0〜1, `decaySec` |
| `wash` | 連続量に追従する面の明るさ（毎フレーム更新） | `zone`, `color`, `level` 0〜1（連続）, `attackSec`, `releaseSec` |
| `strobe` | 点滅 | `zone`, `color`, `hz` 1〜16, `duty` 0.1〜0.9, `dur` 秒 |
| `sweep` | 移動する光・帯 | `zone`（from）, `toZone`, `color`, `dur`, `width` 0〜1 |
| `blackout` | 全消灯 | `dur`, `fadeSec` |
| `palette` | 配色の切替（区切りで色世界を変える） | `name`（mapping.palettes のキー） |
| `haze` | もや・残像の濃さ | `level` 0〜1 |

離散 Intent（splat/pulse/strobe/sweep/blackout/palette）は `t` を持つ。連続 Intent（wash/haze）は `curve` を参照し
`t` を持たず、評価時に `value(t)` を返す。

### zone（出力先が自分の幾何へ翻訳する抽象位置）

縦: `floor` / `low` / `mid` / `high` / `air`　横: `left` / `center` / `right`　奥行き: `back` / `front`　全体: `all`
複合は配列 `["low","left"]`。出力先の翻訳例:
- インク描画: 縦→画面のY帯、横→X帯。
- 照明図・γ: 縦→ 灯体グループ（floor→FL、low→SL/SH、mid→WASH/CL、high→B1〜B3、air→BACK/CY）。横→ u 座標の範囲。
翻訳表は各 renderer の `zoneMap` に置き、規則側には書かない。

## mapping ファイル

```jsonc
{
  "format": "oto-atari.mapping",
  "version": 1,
  "name": "ink-default",
  "palettes": {
    "default": { "sub": "#12100e", "bass": "#1d1a3a", "lowmid": "#5a3b8f", "mid": "#d9483b", "high": "#ffd27a", "air": "#f2ead6", "accent": "#ffffff" },
    "cold":    { … }
  },
  "startPalette": "default",
  "rules": [ … ]
}
```

### rule

```jsonc
{
  "id": "bass-splat",
  "enabled": true,
  "on": { "event": "onset", "band": ["sub","bass"], "minStrength": 0.35, "tags": ["kick"], "tagsMode": "any" },
  "quantize": { "to": "none" },      // "none" | "beat" | "half" | "bar"。事前計算なので「最も近い格子」へ吸着できる
  "emit": {
    "intent": "splat",
    "zone": "low",
    "color": "@palette.bass",          // "@palette.<key>" は現在の palette から解決
    "size":  { "from": "strength", "range": [0.3, 1.0], "curve": "pow2" },
    "weight": 0.9,
    "decaySec": 1.8
  }
}
```

- `on.event`: `onset|accent|drop|build|silence|sectionChange|beat|downbeat`。`beat`/`downbeat` は tempo.beats から生成した仮想事象
  （`strength`=拍の強さ, `beatInBar`）。`on.beatInBar: [0,2]` で拍の位置を絞れる。
- `on.curve`: `"loudness" | "band.<id>" | "centroid" | "flux" | "flatness"`。連続 Intent 用。
- `on.stem`: ステムがある場合の絞り込み。
- `on.section.label`: 区間ラベルで有効/無効を切る（`["drop","build"]`）。
- パラメータ値は **定数** か **導出指定** `{ "from": <source>, "range": [lo, hi], "curve": "linear|pow2|pow0.5|step" , "smooth": {"attackSec":…, "releaseSec":…} }`。
  `from` は事象のフィールド（`strength`, `bands.high`, `pitchHz`, `beatInBar`）か curve 名（連続 Intent）。
- 色は HEX 定数、`@palette.<key>`、または `{ "from": "centroid", "gradient": ["#1d1a3a", "#ffd27a"] }`（連続量から色を引く）。

### 競合の扱い（renderer 共通の約束）

- 同じ zone に複数の level が来たら **HTP（大きい方）**。色は「最後に来た離散 Intent」が勝つ。
- `blackout` は他の全 Intent より優先。`palette` は以後の `@palette.*` 解決だけを変える（既に出た Intent の色は変えない）。
- 1秒あたりの離散 Intent 数は `limits.maxPerSec`（既定 24）で間引く（弱いものから落とす）。

## 入口の設計思想（ここが最重要）

1. **音の「重さ」を縦に、音の「明るさ」を色温度に**を既定の写像とする。低い＝下・重い・暗い色、高い＝上・軽い・明るい色。
   これは音響心理でおおむね共有される連想であり、初見の観客が説明なしで読める。
2. **拍は面全体の脈**、**立ち上がりは点の飛沫**、**持続音は面の明るさ**。時間構造の3層（拍・事象・連続）を別の描き方に割り当て、
   1つの描き方に全部を押し込まない。
3. **区切り（section）で色世界を変える**。曲の大構造を palette の切替で見せ、細部は規則の変更なしで自動的に色が変わる。
4. **drop/build/silence は「例外演出」**（strobe・blackout・sweep）。普段は起きないから効く。頻発する場合は解析閾値側を直す。
5. 規則は**曲を知らない**。曲固有の調整は mapping の複製（`name` を変える）で行い、既定の規則は汎用に保つ。

## v2拡張：位置指定の単音光点（2026-09-29）

`version: 2` の mapping は `on.event: "note"` を選び、離散 `intent: "point"` を出せる。`point` は `t`, `x` 0〜1, `level` 0〜1, `dur` 秒, `color`, `zone` を持ち、同時音を別々の点として保持する。インク面・照明図とも `x=0` が低い音、`x=1` が高い音で、照明図では左右12〜88%の独立レールへ翻訳する。灯体グループの制御値とは別であり、γ下書きへの書き出しは拒否する。

推奨割り振り `presets/mapping-piano-notes.json` はB曲の `position01 → x`, `modelStrength01 × 0.70 + mixLevel01 × 0.30 → level`, `dur → dur` を写す。`secondaryFrom` と `secondaryWeight` は0〜1の事象値を加重合成し、第二値が欠ければ第一値のみを使う。出力Intentはv2で、元の2値を `srcModelStrength` と `srcMixLevel` に保持する。`mixLevel01` は発音時点の原曲全体の相対音量であり、和音内の各音の実音量や元MIDIベロシティではない。拍へ量子化せず、同時発音も1秒32件まで独立に保持する。

### v2追加：note の役割フィルタと由来（2026-10-04）

- `on.instrument: ["piano"]`（または `["bass"]`）は `instrumentCandidate` による絞り込み。`on.stem` と同様に配列または単一文字列を指定でき、未指定なら全 note を対象とする。
- note 由来の point Intent は `srcInstrument` を保持する。元の `soundDur` があれば `srcSoundDur`、`release.envelope` があれば `srcEnvelope` にそのまま渡す。値の丸め・補間・加工は行わない。
- `mapping-piano-notes.json` と `mapping-drums-notes.json` の note ルールは `on.instrument: ["piano"]` に限定する。既存の pitched-attack は保持する。
- 段階1では bass point をピアノの表示・位置レール・モード判定に使わない。体験データでは note の `t`, `soundDur`（未指定なら `dur`）, `pitchMidi`, `strength`, `release.envelope` を `bassNotes: [{ t, soundDur, pitch, level, envelope }]` に保存し、描画には使わない。
- v1 の mapping への point 混入拒否は維持する。
