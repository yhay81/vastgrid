---
title: セルの編集
description: セルを書き込める source、セルのエディター、値の検証、保存の流れ。
---

グリッドは、セルを書き込める source のセルを編集できます。それ以外の source は、これまでどおり読み取り専用です。

| source | 編集 |
| --- | --- |
| `ArraySource` | `editable: true` のとき。値はその配列に書き込まれます。 |
| `RemoteSource` ＋ `vastgrid-duckdb` | エンジンを `editable: true` で作ったとき。書き込んだ値はファイルとは別に、エンジンが保持します。 |
| `BrowserSource`（`vastgrid-browser`） | 読み取り専用です。 |
| 独自の `TableSource` | `capabilities.edit` を報告し、`updateCells` を持つとき。 |

`readOnly` を指定すると、グリッドを読み取り専用のままにできます。スキーマで `readOnly` の列と、入力できない型の列（リスト・構造体・マップ・バイナリ・期間）も読み取り専用です。

```tsx
const source = useMemo(() => new ArraySource({ columns, rows, editable: true }), [rows]);

<DataGrid
  source={source}
  validateCell={(cell) => (cell.schema.name === "age" && Number(cell.value) < 0 ? "年齢は 0 以上です。" : null)}
  onCellsChange={(event) => {
    if (event.status === "saved") console.log(`${event.changes.length} セルを保存しました`);
  }}
/>
```

## キーボードとポインターでの編集

| キー | 操作 |
| --- | --- |
| 文字の入力（IME を含む） | アクティブセルの値を置き換える。入力した文字はエディターに入る |
| F2・ダブルクリック | 値を編集する（カーソルは末尾） |
| Enter・Shift + Enter | 確定して下・上へ移動 |
| Tab・Shift + Tab | 確定して右・左へ移動 |
| Alt + Enter（Mac では ⌃↩ も） | エディター内で改行 |
| Esc | 取り消して元の値に戻す |
| Delete・Backspace | 選択したセル（すべての範囲）を消去 |

ほかの場所をクリックしても確定します。IME の変換を確定する Enter や Esc は IME に任せます。エディターは Canvas ではなくページ上のテキスト欄としてセルの上に重なるため、IME・スペルチェック・スクリーンリーダーがそのまま使えます。ラベルはセルの位置を示し、受け付けない値の理由はその横に表示します。

ダブルクリックと F2 では、先に `onCellDoubleClick` が呼ばれます。`event.preventDefault()` でエディター（とセルのインスペクター）を開かないようにできます。編集できるグリッドでは、インスペクターはコンテキストメニューの「値の全体を表示」から開きます。メニューには「セルを編集」「内容を消去」もあります。読み取り専用のグリッドでは、これまでどおり F2 とダブルクリックでインスペクターが開きます。

## 値の検証

入力した文字列は、`vastgrid-core` の `parseCellInput` で列の型として読みます。source も同じ規則（`normalizeCellValue`）を使うため、グリッドと source が受け付ける値は一致します。

| 型 | 受け付ける文字列 | 書き込む値 |
| --- | --- | --- |
| `integer`・`bigint` | 符号付きの数字。エンジンの型（`TINYINT`〜`UHUGEINT`）の範囲内 | 数値。JS の数値で正確に表せないときは文字列 |
| `decimal` | 小数点付きの数字。`DECIMAL(p,s)` の桁数・小数桁数まで | 入力した桁のままの文字列（丸めない） |
| `float` | 数値・`NaN`・`Infinity` | 数値（`"NaN"`・`"Infinity"` は文字列） |
| `boolean` | `true`・`false`・`1`・`0` | `true` か `false` |
| `date` | `yyyy-mm-dd`（`/` や `.` 区切りも可） | `yyyy-mm-dd` |
| `time` | `hh:mm[:ss[.小数]]`（`TIME WITH TIME ZONE` はオフセット付きも可） | `hh:mm:ss[.小数]` |
| `timestamp`・`timestamptz` | 日付、空白か `T`、時刻（`timestamptz` は `Z` やオフセット付きも可） | `yyyy-mm-dd hh:mm:ss[.小数][オフセット]` |
| `uuid`・`json`・`string` | UUID・正しい JSON・任意の文字列 | 同じ文字列 |

空の文字列（空白だけを含む）は空白（`null`）になります。数値は桁区切りや列の表示書式を付けずに入力します。エディターは書式付きの表示文字列ではなく値そのもので始まり、表示のために省略された長い文字列は全体を読んでから編集します。

型を確認したあと、`validateCell` が値を検証します。拒否するときはメッセージを返し、受け付けるときは何も返しません。Promise を返すこともでき（サーバーへの問い合わせなど）、その間エディターには「確認しています…」と表示します。拒否した値では、エディターはメッセージを表示したまま開いています。

## 保存

変更は `TableSource.updateCells` で1回の要求として送ります。書き込みは作った順に1件ずつ送ります。

- **保存中**：セルには新しい値と、隅に印を表示します。保存に時間がかかるときはステータス行にも表示します。
- **保存済み**：グリッドは行を読み直します（その間は古い値を表示するため、ちらつきません）。ビューの並べ替え・絞り込み・検索が書き込んだ列を使うときは、ビューを作り直して同じ位置に戻ります。それ以外のビューはそのままです。選択範囲の集計、統計、詳細パネル、書き出しは新しい値を読みます。
- **失敗**：セルは source が持つ値に戻り、赤い印が付きます。ステータスバーの上に理由と［再試行］［破棄］を表示します。
- **競合**：各変更は、変更前の値を一緒に送ります。その間に別の利用者がセルを変えていた場合は何も書き込まず（`edit_conflict`）、セルを読み直して［上書き］か［破棄］を選べます。
- **revision の変更**：書き込みには表の `revision` を付けます。ファイルが読み直されると（`revision_changed`）、行の位置が別のレコードを指す可能性があるため、その書き込みは破棄だけができます。

`onCellsChange` は、各書き込みの保存か失敗を、そのセル（`rowId`・`column`・`value`・`previous`）、理由（`edit`・`clear` など）、エラーとともに通知します。

セルは表の中の行の位置（`rowId`）で指定します。ビューを並べ替え・絞り込み直しても、セルを書き込んでも変わらないため、チェックした行もそのまま残ります。書き込みは表の `revision` を変えず、代わりに `info().edits.version` を増やします。同じ source を表示する別のグリッドは `subscribe`（`RemoteSource` は2秒ごとにサーバーに問い合わせます）で書き込みを知り、行を読み直します。

## DuckDB サーバーでの書き込み

```ts
const engine = await TableEngine.create({ allowedDirectories: [dataDir], tempDirectory, editable: true });
```

書き込んだ値は検証して列の DuckDB の型に変換し、編集した列ごとのテーブルとしてエンジン内に保持します。ビューがそれをファイルの行に結合するため、行・並べ替えや絞り込みのビュー・統計・集計・検索・書き出しのすべてが書き込んだ値を読みます。500 万行の表に 1,000 セルを書き込んだ後も、1ブロックの読み込みは書き込み前と同程度（3〜4 ms）です。書き込んだ列に行や順序が依存するビューは削除し、次の要求で作り直します。ファイル自体は変更しません。

セルを書き込んだ表は開いたままにします。`maxTables` を守るために閉じることも、ファイルが変わったときに開き直すこともしません。表を閉じる（`close`）か、エンジンを破棄すると、書き込んだ値は失われます。

## 独自の source

`capabilities.edit` を報告し、書き込まない列に `readOnly` を付け、`updateCells` を実装します。

```ts
async updateCells({ updates, revision }: UpdateRequest): Promise<UpdateResult> {
  if (revision !== undefined && revision !== this.revision) throw new SourceError("revision_changed", "…", 409);
  for (const update of updates) {
    const checked = normalizeCellValue(update.value, this.columns[update.column]);
    if (!checked.ok) throw new SourceError("invalid_value", "…", 422);
    if (update.previous !== undefined && !sameCellValue(this.get(update), update.previous))
      throw new SourceError("edit_conflict", "…", 409);
  }
  // すべてを書き込むか、何も書き込まない。
  return { updated: updates.length, edits: { version: ++this.version, cells: this.edited } };
}
```

[`TableSource`](/ja/reference/table-source/#セルの書き込み)と、`update` 要求の[プロトコル](/ja/reference/protocol/)も参照してください。
