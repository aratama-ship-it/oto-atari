# web/ — ブラウザUI

ES Modules を使うのでローカルHTTPサーバーで開く（プロジェクト直下から。samples/ と presets/ を相対参照する）。

```sh
cd "apps/utility-app/oto-atari"
python3 -m http.server 8971 --bind 127.0.0.1
# → http://127.0.0.1:8971/web/
```
