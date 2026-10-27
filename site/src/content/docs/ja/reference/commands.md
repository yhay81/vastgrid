---
title: コマンド
description: グリッドの状態を変えるすべてのコマンドをグループごとに。ディスパッチのしかたと、失敗する理由。
---

コマンドは `{ command: 名前, …引数 }` という JSON オブジェクトです（[§6.1](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#61-applying-a-command)）。グリッドのキー操作、メニュー、ツールバーはすべてコマンドで動いていて、ホストやエージェントも同じコマンドをディスパッチします。並べ替え、フィルター、選択、書き込み、書き出しはそれぞれ一つのコマンドです。コマンドをドキュメントとセッションに適用すると、新しい状態と、ストアがエンジンに送るリクエストと、コマンドによっては出力が得られます。コマンドは決定的で、失敗したコマンドは何も変えません。

```ts
{ command: "sort.set", keys: [{ column: "total", direction: "desc" }] }
{ command: "filter.column", column: "region", where: { fn: "eq", args: [{ col: "region" }, { lit: "EU" }] } }
{ command: "select", row: 0, column: "total" }
{ command: "export", format: "csv", rows: "view" }
```

## ディスパッチ

```tsx
import { DataGrid, type DataGridHandle } from "vastgrid";
import { useRef } from "react";

const grid = useRef<DataGridHandle>(null);
// …
<DataGrid ref={grid} transport={transport} table="orders.csv" />;
// …
const outcome = await grid.current?.dispatch({ command: "search.set", text: "Tokyo" });
```

- グリッドのハンドルの `dispatch`、グリッドの中で使う `useGridDispatch()`、ストアの `store.dispatch` は同じ関数です（[vastgrid/core](/ja/reference/core/#コマンドの適用)）。コマンドのリクエストに応答が返ると `CommandOutcome` で解決し、reject はしません。`{ ok: true, output? }` か `{ ok: false, error }` です。
- `copy` は出力として `{ tsv, html, markdown }` を、`edit.paste` は `{ cutRows, cutColumns }` を返します（`vastgrid-spec` の `CommandOutputs`）。
- まだ読んでいない行が必要なコマンドは、その行を読んでからもう一度適用されます。ホストが先に行を読む必要はありません。
- `GridCommand`（すべてのコマンドの union）、`CommandName`、`CommandOutputs` は `vastgrid` の型です。

## コマンドが失敗するとき

適用できないコマンドは `vastgrid-spec` の `CommandError` で失敗します。形は `{ code: "invalid_command", path, reason, message, details? }` で、`path` はコマンドの中を指す JSON Pointer です（コマンド全体なら `""`）。理由が複数あてはまるときは、この表で先にあるものになります。

| `reason` | いつ |
| --- | --- |
| `unknown_command` | そのようなコマンドがない。 |
| `syntax` | 引数の形が違う、引数が足りない、コマンドが受け取らないメンバーがある。 |
| `unknown_column` | ビューにない列、または表示している列が必要な場面で表示していない列。 |
| `no_editor` | エディターがないのにエディターのコマンドを送った。 |
| `nothing` | 元に戻す・やり直すものがないのに、元に戻す・やり直す。 |
| `unsupported` | エンジンがそれを提供していない（[ケーパビリティ](/ja/reference/engines/#ケーパビリティ)）。 |
| `unknown_state` | 状態がまだわからない行をチェックする・外す。 |
| `last_column` | ビューのすべての列を隠す。 |
| `type` | 列の型に合わない合計。 |
| `copy_layout` | 一緒にコピーできない範囲。 |
| `paste_ranges` | 複数の値を複数の範囲に貼り付ける。 |
| `read_only` | 書き込めないセルへの書き込み。`details.column` に列名が入ります。 |
| `too_many_cells` | 100,000 セル（`WRITE_LIMIT`）を超える書き込み、または 1,000,000 セル（`COPY_LIMIT`）を超えるコピー。 |
| `not_loaded` | コマンドに必要な行を読んでいない。`details.rows` に範囲 `[start, end)`、`details.columns` に列が入ります。ストアはそれを読んでコマンドを適用し直します。 |
| `invalid_value` | 列の型として読めないテキスト。`details` に最初のそのセルの `row`、`column`、`error` が入ります。 |
| `invalid_plan` | コマンドが作るプランが検査を通らない。`details` にプランのエラーの `path` と `reason` が入ります。 |

書き込みの `read_only` や `edit_conflict` のように、エンジンからの `GridError` で失敗することもあります（[エラー](/ja/reference/core/#エラー)）。

## プラン

[§6.2](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#62-the-plan)。ドキュメントの `plan` を変えます。ストアはその後で新しいビューを読み、アクティブな行をできるだけ保ちます。

| コマンド | 引数 | 効果 |
| --- | --- | --- |
| `sort.set` | `keys`：`{ column, direction: "asc" \| "desc" }[]` | 並べ替えを `keys` にします。キーがなければ並べ替えを外します。 |
| `sort.toggle` | `column`、`add`：真偽値 | `add` なしでは、なし → 昇順 → 降順 → なしと切り替え、ほかのキーは外します。`add` ありでは、その列のキーをその位置で切り替えるか、末尾に加えます。 |
| `sort.clear` | | 並べ替えを外します。 |
| `filter.set` | `where`：式か null | 条件を `where` の各部分にします。検索の後に置きます。 |
| `filter.column` | `column`、`where`：式か null | その列の条件を `where` の各部分にします。どの部分もその列だけを参照します。 |
| `filter.clear` | | 条件を外し、検索は残します。 |
| `search.set` | `text` | 検索を `text` にし、`where` の部分の先頭に置きます。空白だけのテキストは検索を外します。 |
| `derive.add` | `name`、`expr`、`before`：派生列 | 派生列を末尾か `before` の前に加えます。 |
| `derive.update` | `name`、`expr`、`rename` | 式を変えるか、使われているすべての場所で列の名前を変えます。 |
| `derive.remove` | `name` | 派生列と、それを使うものを外します。 |
| `group.set` | `aggregate`：`{ keys, measures, pivot? }` | 行をグループにします。合わなくなった `having` の部分と並べ替えのキーは外します。 |
| `group.clear` | | グループと `having` を外します。 |
| `having.set` | `having`：式か null | グループの条件を設定するか外します。 |

式は JSON です（`{ col }`、`{ lit }`、`{ fn, args }`、[§4.3](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#43-expressions)）。グリッドに入力した数式はこれにコンパイルされます（[数式](/ja/guides/formulas/)）。

## 列

[§6.3](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#63-columns)。ドキュメントの `columns` を変えます。

| コマンド | 引数 | 効果 |
| --- | --- | --- |
| `column.resize` | `name`、`width`：ピクセルか null | 幅を設定するか、値に合わせて幅を戻します。 |
| `column.move` | `names`：表示している列、`before`：表示している列か null | 列を `before` の前に動かし、その固定に合わせます。null なら固定していない最後の列の後へ。 |
| `column.hide` | `names` | 列を隠し、固定を外します。一列も残らないときは `last_column` で失敗します。 |
| `column.show` | `names`、または `all: true` | 列を表示します。`all` ならビューのすべての列。 |
| `column.pin` | `name`、`side`：`"left"`、`"right"` か null | 列をその側に固定するか、固定を外します。 |
| `column.format` | `name`、`format`：書式か null | 書式（`label`、`number`、`date`、`align`、`wrap`、`copy`、条件付きの `styles`）を設定するか外します。 |
| `column.total` | `name`、`total`：`{ fn, p? }` か null | 合計行での列の集計を設定するか外します。 |

## 選択、スクロール、チェックした行

[§6.4](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#64-selection-scrolling-and-checked-rows)。セッションを変えます。行はビューの中の位置、列は表示している列の名前です。

| コマンド | 引数 | 効果 |
| --- | --- | --- |
| `select` | `row`、`column`、`mode`：`replace`（既定）、`extend`、`add` | セルをアクティブにし、それだけを選択します。`extend` は最後の範囲をそこまで広げ、`add` は範囲を加えます。 |
| `select.rows` | `from`、`to`、`mode` | 行全体を選択します。 |
| `select.columns` | `from`、`to`：表示している列、`mode` | 列全体を選択します。 |
| `select.all` | | すべてのセルを選択します。 |
| `move` | `direction`：`up`、`down`、`left`、`right`、`extend`、`jump`、`page`：真偽値 | アクティブセルを一つ、1 ページ、または端まで動かします（`extend` なら選択を広げます）。 |
| `move.home`、`move.end` | `extend`、`jump`：真偽値 | 行の最初か最後の列へ。`jump` なら最初か最後の行へも。 |
| `advance` | `axis`：`row` か `column`、`back`：真偽値 | Enter と Tab。複数のセルの選択の中を順に進むか、`move` のように動きます。 |
| `scroll.to` | `row`、`column` | その行と列までスクロールします。 |
| `check`、`uncheck` | `keys`：行のキー | キーで行をチェックする・外します。 |
| `check.all` | | ビューのすべての行をチェックします。 |
| `check.clear` | | すべての行のチェックを外します。 |
| `detail.open`、`detail.close` | | 詳細パネルを開く・閉じます。 |

## 編集

[§6.5](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#65-editing)。書き込みは各セルの元の値を付けた一つの `write` リクエストとしてエンジンに届き、元に戻す履歴の一つのステップになります。

| コマンド | 引数 | 効果 |
| --- | --- | --- |
| `edit.begin` | `text` | アクティブセルでエディターを開きます。`text` か、セルの値を入れて。 |
| `edit.change` | `text` | エディターのテキストを変えます。 |
| `edit.cancel` | | エディターを閉じます。 |
| `edit.commit` | `move`：`up`、`down`、`left`、`right` か null | テキストを列の型として読んで書き込み、アクティブセルを動かします。 |
| `edit.clear` | | 選択したセルのうち書き込めるものに null を書き込みます。 |
| `edit.paste` | | クリップボード（`DispatchOptions.clipboard`、TSV か HTML の表）を選択範囲に貼り付けます。 |
| `edit.fill` | `direction`：`down` か `right` | 各範囲の最初の行（または列）を残りにコピーします。 |
| `history.undo`、`history.redo` | | 最後のステップの前（または後）の値を書き込みます。 |

人の書き込みは `select`、テキストを付けた `edit.begin`、`edit.commit` の順です。エージェントも同じようにセルに書き込みます。[編集](/ja/guides/editing/)を見てください。

## コピー、書き出し、保存

[§6.6](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#66-copying-and-exporting)。

| コマンド | 引数 | 効果 |
| --- | --- | --- |
| `copy` | `headers`：真偽値、`values`：`raw`（既定）か `formatted` | 選択したセルを `{ tsv, html, markdown }` で返します。 |
| `export` | `format`、`columns`：`displayed`（既定）か `all`、`rows`：`view`（既定）か `table`、`target` | ビュー（または書き込んだ値を含む表全体）を、エンジンの `export.formats` にある形式で書き出します。 |
| `save` | | エンジンが対応していれば、書き込んだセルを表のファイルに保存します。 |

[書き出しと保存](/ja/guides/export/)を見てください。

## コアのコマンド

`view.update`、`history.push`、`history.undone`、`history.redone`、`history.clear`（[§6.7](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#67-commands-of-the-core)）は、応答が届いたときにストア自身が適用します。ホストやエージェントが使う必要はありません。

## ドキュメントとセッション

コマンドが変える状態は二つの部分からなり、どちらもバージョンを持つただの JSON です。

- **ドキュメント**（[§5.1](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#51-document)）は、人が保存したり共有したりエージェントに渡したりするものです。`rowKey`、`plan`（派生列、条件、グループ、並べ替え）、列の設定（`width`、`hidden`、`pin`、`format`、`total`）を持ちます。
- **セッション**（[§5.2](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#52-session)）は、人が今いる場所です。アクティブセル、選択、スクロール位置、チェックした行、詳細パネル、エディター、元に戻す履歴を持ちます。

```json
{
  "kind": "vastgrid/document",
  "version": 2,
  "plan": { "sort": [{ "column": "price", "direction": "desc" }] },
  "columns": [{ "name": "id", "pin": "left" }, { "name": "price", "width": 120, "total": { "fn": "sum" } }]
}
```

グリッドはどちらの部分も、制御することも自分に任せることもできます（[状態](/ja/guides/state/)）。別のバージョンのドキュメントは受け付けません。v1 で保存した状態は、`vastgrid-spec` の `migrateGridState` でドキュメントに変換できます（[§5.6](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#56-versions-and-migration)、[v1 からの移行](/ja/migrating-from-v1/)）。

## エージェントとホストのために

- `vastgrid-spec/schema/commands.schema.json` はすべてのコマンドの形（`$defs/command`）を定めています。コマンドを送るエージェントやホスト向けです。ドキュメントとセッションの形は `state.schema.json` にあります。
- `vastgrid-spec` の `COMMANDS` は名前の一覧で、`applyCommand(state, command, context)` はストアなしで、仕様のとおりにコマンドを適用します。
- MCP App の `grid_command` ツールは、人が見ているグリッドにこれらのコマンドを適用します（[MCP App](/ja/apps/mcp/)）。VS Code の拡張機能の API も、vastgrid で開いたファイルに同じことをします（[VS Code](/ja/apps/vscode/)）。
