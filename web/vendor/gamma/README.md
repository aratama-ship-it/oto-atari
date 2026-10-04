# vendor/gamma — 舞台スケッチγの共有部品（無改変複製）

- 複製元: 舞台スケッチγ（GitHub `aratama-ship-it/stage-sketch-gamma`）の origin/main。複製したコミットと各ファイルの SHA-256 は `PROVENANCE.json` が正本。
- ここのファイルは **編集しない**（先頭の注記行も入れない）。直すときはγ側を直してから再複製し、`PROVENANCE.json` を更新する。音アタリ固有の適応は `../../renderers/stage3d.mjs` と `../../lib/mirror-ball-map.mjs` に書く。
- 再複製の手順: `git -C ~/git-repos/gamma-rig fetch origin main` → `git show origin/main:<元パス> > web/vendor/gamma/<ファイル名>`（`rig-engine.js` の元パスだけ `light-design/rig-engine.js`）→ `PROVENANCE.json` の `gammaCommit`・`sha256` を更新 → `node tests/run.mjs`。
- 2026-10-04: 2026-10-01〜02 の複製（先頭に出典1行つき）から γ v0.2.85 へ更新。ミラーボール（kind "mirrorball"・`paintMirrorBalls`・`mirrorBallGlintsAt`）、灯体のレンズ先端から光る点光源、光学（スポット／ウォッシュ）、レーザー・シートの影なし化などが入る。
