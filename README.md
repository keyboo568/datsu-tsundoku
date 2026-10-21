# 脱ツンドク

Dropbox に置いた PDF と音声で積ん読を崩す、Android 向けの本棚アプリ（PWA）。

- 登録した Dropbox フォルダの「1 フォルダ＝1 冊」を、表紙付きの本棚に並べる
- 状態は 未読 / 読書中 / 既読 と ★お気に入り
- 音声は **概要版**（1 本）と **網羅版**（1→2→3 と連続再生）。版ごとに再生位置を記録
- 速度 0.6〜2.0 倍（0.2 刻み）、15 秒戻し・送り、ロック画面から操作
- 再生中はマインドマップと PDF をワンタッチで切り替え。PDF は最後に開いたページから
- メモは本のフォルダの `⑥メモ_書名.md` に保存。メモ一覧タブで全冊を横断して見られる
- 本ごとにダウンロードしてオフラインで読む・聴く。最後に開いてから 2 週間で端末から自動削除
- サーバーなし。トークンは端末の中だけ、本とメモは各自の Dropbox の中だけ

## フォルダの中身の見分け方

| 種類 | 判定 |
|---|---|
| PDF | `.pdf`（名前に `PDF` を含むものを優先） |
| マインドマップ | `.html`（markmap 形式。名前に `MP` / `マインドマップ` を含むものを優先） |
| 概要版の音声 | `.m4a .mp3 .aac .ogg .opus .wav .flac` のうち、名前に `要約` `概要` `summary` を含むもの |
| 網羅版の音声 | それ以外の音声。名前順に連続再生 |
| 表紙 | 画像（`表紙` / `cover` を優先）。なければ PDF の 1 ページ目 |
| メモ | `⑥メモ_書名.md` |
| 要点 | `🟥` で始まる、または名前に `要点` を含む `.txt` |

フォルダ名の `【既読】` は既読、`★` はお気に入りとして最初に取り込む（アプリはフォルダ名を変えない）。

## Dropbox に書き込むもの

- 登録フォルダ直下の `_脱ツンドク.json`（状態・再生位置。端末間の同期用）
- 本のフォルダの `⑥メモ_書名.md`（メモを書いたときだけ）

## 開発

```bash
npm install
npm run dev:mock   # 試験モード：.env の MOCK_ROOT を読むだけ。書き込みはブラウザ内だけ
npm run dev        # 本物の Dropbox につなぐ（http://localhost:5199/）
npm run build      # dist/ に出力
```

`.env`（`.env.example` をコピー）

| 変数 | 内容 |
|---|---|
| `VITE_DROPBOX_APP_KEY` | Dropbox アプリの App key（App secret は使わない） |
| `BASE_PATH` | GitHub Pages に置くときのパス（例 `/datsu-tsundoku/`） |
| `MOCK_ROOT` | 試験モードで読むフォルダ |

## Dropbox アプリの登録

1. https://www.dropbox.com/developers/apps で **Create app**
2. **Scoped access** → **Full Dropbox** → 名前を付ける
3. **Permissions** タブで `files.metadata.read` `files.content.read` `files.content.write` にチェックして Submit
4. **Settings** タブ
   - **Allow public clients (Implicit Grant & PKCE)** を Allow
   - **OAuth2 Redirect URIs** に `http://localhost:5199/` と、公開先の URL（例 `https://<ユーザー名>.github.io/datsu-tsundoku/`）を追加
5. **App key** を `.env` の `VITE_DROPBOX_APP_KEY` に書く

開発中（Development）のアプリは 50 人まで使える。それを超えて公開するなら Dropbox の本番申請が要る。
