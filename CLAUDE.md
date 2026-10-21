# 脱ツンドク（datsu-tsundoku）

きーぼー氏の積ん読解消用 PWA。仕様と使い方は [README.md](README.md)。将来の一般公開も視野に入れている。

## 構成

- Vite + 素の JavaScript（フレームワークなし）+ vite-plugin-pwa
- `src/dropbox.js` Dropbox API（PKCE ログイン、トークンは IndexedDB）。試験モードでは PC のフォルダを読むだけの「もどき」
- `src/library.js` 登録フォルダ → 本の一覧（1 フォルダ＝1 冊、拡張子と名前で中身を判定）
- `src/store.js` 端末内の保存（状態・表紙・ダウンロード＝OPFS・2 週間の自動削除）
- `src/sync.js` 状態を `_脱ツンドク.json` と同期（本ごとに updated が新しい方を残す）
- `src/memo.js` `⑥メモ_書名.md` の読み書き（オフライン中の操作は溜めて後で反映）
- `src/player.js` 音声（概要版 / 網羅版の連続再生、位置記録、Media Session）
- `src/pdf.js` pdf.js（範囲読み込みで巨大 PDF も軽く開く）
- `src/mindmap.js` markmap を sandbox iframe で表示（部品は同梱してオフライン対応）
- `src/main.js` 画面と操作

## このプロジェクトでのルール

- **版の管理は git のタグ（v1.00, v1.01 …）で行う**。親フォルダの「ファイルを複製して番号を上げる」ルールの代わりとして本人了承済み（2026-10-21）。旧タグは消さない
- 動作確認はまず `npm run dev:mock`（試験モード）。本物の Dropbox に書き込む確認は、事前に本人の了承を取る
- Dropbox の App key は `.env` に置く（公開されても困らない値だが、ルールに合わせる）
- 本人の自炊フォルダは `C:\Users\keygr\Dropbox\■31.自炊`（ファイル名は jisui-book スキルの命名：①音声網羅N / ①音声要約 / ②MP / ③要約 / ④PDF / ⑤本文）
