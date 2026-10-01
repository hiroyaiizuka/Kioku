# Kioku

Kioku は、Obsidian 上の学習メモからフラッシュカードを作り、復習することを目指す **PC 専用**プラグインです。

> 現在は M0 開発基盤だけです。カードの抽出・作成・編集・保存、デッキ、間隔反復、AI 連携はすべて未実装です。ノートの読み取り・書き込みも行いません。

## M0 で確認できること

- 左 ribbon の「フラッシュカード」アイコン、またはコマンドパレットの「Kioku: フラッシュカード（起動確認）」から中央ポップアップを開く。
- ポップアップで Kioku のバージョンと build ID、M0 未実装であることを確認する。
- 「閉じる」または Escape で閉じる。

## 開発ビルドを専用 Vault で確認する

一般利用者向け Release はまだありません。開発者は Node.js 22.22.3 で `npm ci`、`npm run check`、初回だけ `npm run harness:prepare` を実行し、`npm run harness:launch`（macOS）でプロジェクト内の `test-vault/` だけを開く専用 Obsidian を起動します。普段の Obsidian は開いたままで構いません。終了は `npm run harness:quit` です。既存 Vault へ自動導入しないでください。詳しくは [開発手順](docs/development.md) と [ハーネス](docs/harness.md) を参照してください。

## 対応範囲

- Obsidian 1.8.7 以上のデスクトップ版を宣言しています。
- 実機での対応確認が完了するまでは、対応済みとは扱いません。
- モバイル、PDF/OCR、Cloze、双方向カードは M0 の対象外です。

ライセンス: MIT
