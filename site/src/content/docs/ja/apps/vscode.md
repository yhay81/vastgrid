---
title: VS Code
description: どんな大きさの CSV・TSV・Parquet・JSON Lines・Excel のファイルも VS Code の表で開き、CSV と TSV は VS Code の保存で編集・保存します。
---

拡張機能 `vastgrid-vscode` は、どんな大きさの CSV・TSV・Parquet・JSON Lines・Excel のファイルも、VS Code のエディターとして表で開きます。ファイルは拡張機能のプロセスの DuckDB（Node.js）が読み、エディターの Webview が `DataGrid` を示して、Webview のメッセージで行を読みます。CSV と TSV のファイルのセルは編集でき、VS Code の保存で、編集していないバイトをそのまま残して保存します。

## インストール

[GitHub Release](https://github.com/yhay81/vastgrid/releases/tag/v0.2.0) から OS と CPU に合う
`vastgrid-vscode-0.2.0-<target>.vsix` をダウンロードし、VS Code の **Extensions: Install from VSIX…**
で選択します。ターミナルからも導入できます。次は Apple シリコンの例です。

```sh
code --install-extension vastgrid-vscode-0.2.0-darwin-arm64.vsix
```

0.2.0 の Marketplace 掲載は後日対応します。VS Code 1.100 以降が必要です。macOS（Apple シリコン・Intel）、Linux（x64・arm64、Alpine は x64）、Windows（x64・arm64）にそれぞれのパッケージがあります。バインディングが動かない vscode.dev と 32 ビットの Arm の Linux では動きません。

## ファイルを開く

Parquet と Excel のファイルは、開くと vastgrid で開きます。CSV・TSV・JSON Lines のファイルはこれまでどおりテキストで開くので、「Open With…」、エディターの「Open in vastgrid」ボタン、エクスプローラーの「Open in vastgrid」で vastgrid に開いてください。

| 形式 | ファイル | vastgrid では |
| --- | --- | --- |
| CSV、TSV | `.csv`、`.tsv`、`.tab` | 編集と保存 |
| 圧縮した CSV、TSV | `.csv.gz`、`.csv.zst`、`.tsv.gz`、`.tsv.zst` | 読むだけ |
| JSON Lines | `.jsonl`、`.ndjson`（`.gz` も） | 読むだけ |
| Parquet | `.parquet`、`.pq` | 読むだけ。既定で vastgrid で開く |
| Excel | `.xlsx`、`.xlsm` | 読むだけ。既定で vastgrid で開く。表の上のバーか「vastgrid: Choose Sheet」でシートを選ぶ |

グリッドは VS Code のテーマの色とフォント、言語（英語か日本語）に従います。

## 編集と保存

- セルはほかの場所と同じように書き込めます。入力・貼り付け・消去・フィル（[セルの編集](/ja/guides/editing/)を参照）。それぞれの操作は VS Code の編集のスタックに積まれるので、編集メニューの元に戻す・やり直しや、⌘Z・⇧⌘Z・Ctrl+Y で、その操作をしたグリッドで取り消し・やり直しができます。エディターは、スタックが保存した時点から離れている間だけ未保存になり、書き込みをすべて取り消すと未保存でなくなります。
- VS Code の保存（⌘S か Ctrl+S。セルの編集中でも、編集中の値を先に書き込みます）は、書き込んだセルをファイルに保存し、編集したフィールドだけを書き直します。読んだ後にほかの誰かがディスク上で変えたファイルには上書きしません。エディターはセルを持ったまま未保存のままになるので、名前を付けて保存でほかの場所に書くか、元に戻す（Revert）かツールバーの「編集を破棄して再読み込み」で、ファイルをいまの内容で読み直してください。
- 名前を付けて保存は、書き込んだセルを含む表全体を、新しい名前の拡張子に合わせて CSV・TSV・Parquet・JSON・Excel で書きます。読むだけのファイルに書き込んだセルを残す方法でもあります。
- 元に戻す（Revert）は書き込んだセルを捨てます。エディターはファイルを開き直し、並べ替え・絞り込み・列の設定は残ります。
- グリッドの書き出しメニューは、ビューか表全体を保存ダイアログで選んだ場所に書きます。
- グリッドには自分の保存ボタンはありません。保存するのは VS Code で、未保存の状態がファイルに合うようにしています。

## エディターとその寿命

- 1 つのファイルにエンジンは 1 つです。エディターが最初に行を求めたときに作り、VS Code がそのファイルを閉じるときに、一時ファイルと一緒に閉じます。エンジンが読めるのはそのファイルだけです。
- 同じファイルのエディター（分割したもの、ほかのグループのもの）は、それぞれ自分のビューと選択を持つ、同じエンジンのクライアントです。1 つが書いたものは、ほかにも表示されます。
- タブが隠れている間もグリッドは行と位置を保ち、Webview が読み込み直されても同じビュー・選択・シートを示します。
- 未保存のセルを残して VS Code を閉じると（ホットエグジット）、バックアップに残します。そこから戻したエディターはセルを書き直します。ただし、その間にファイルが変わっていれば書きません。

## 信頼とページ

- VS Code が信頼していないワークスペースでは、ファイルを読み取り専用で開きます。グリッドはセルを書かず、何も保存しません。ワークスペースを信頼すると、CSV と TSV のファイルはビューを保ったまま編集できる状態で開き直します。
- 拡張機能が開くのはディスク上のファイル（`file:`。リモートのウィンドウでは、拡張機能が動くリモートのディスク）だけです。
- ページが読み込むのは拡張機能自身のスクリプトとスタイルだけで、Content Security Policy は `default-src 'none'` です。ネットワーク・WebAssembly・Worker は使いません。

## ほかの拡張機能から

拡張機能は API を返します。`dispatch(uri, command)` は、vastgrid で開いているファイルのグリッド（アクティブなエディター、なければ最初のもの）で、人のキーやメニューと同じように[コマンド](/ja/reference/commands/)を適用し、その出力を返します。

```ts
const vastgrid = vscode.extensions.getExtension("yhay81.vastgrid-vscode");
const api = await vastgrid?.activate();
await api?.dispatch(uri, { command: "sort.set", keys: [{ column: "price", direction: "desc" }] });
```

## まだできないこと

- Open VSX にはありません。
- `file:` 以外のスキームのファイル（ほかの拡張機能のリモートのファイルシステム、vscode.dev）は開きません。

詳しくは GitHub の [vscode.md](https://github.com/yhay81/vastgrid/blob/main/docs/vscode.md)（英語）にあり、ページと拡張機能の間のメッセージ、パッケージの作り方、試験の方法も書いています。
