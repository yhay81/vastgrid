---
title: 書き出し
description: 書き出しパネル、ファイルの行き先、Excel ファイルの書き方。
---

ツールバーの **書き出し** ボタンで、何をどの形式で書き出すかを選ぶパネルが開きます。source が書き出せるとき（`capabilities.export` と `exportView`）に表示され、`info().exports` の形式を選べます。

| source | 形式 | ファイルの行き先 |
| --- | --- | --- |
| `RemoteSource` ＋ `vastgrid-duckdb` | CSV・TSV・Parquet・JSON・Excel（`.xlsx`） | サーバーが新しいファイルを書きます（`delivery: "file"`）。ハンドラーに `resolveTarget` があるときだけ。 |
| `ArraySource` | CSV・TSV・JSON・Excel | ブラウザーでダウンロードします（`delivery: "data"`）。 |
| `BrowserSource`（`vastgrid-browser`） | なし | まだ提供していません。[下記](#vastgrid-browser)を参照。 |

## 書き出す内容

- **行**：現在のビュー（表示中の絞り込み・検索・並べ替えのとおり）か、表全体（元の順）。並べ替え中のビューは、終わってから書き出せます。
- **列**：表示中の列（表示順）か、すべての列（スキーマの順）。
- **列の設定**：既定では、`columnFormats` の表示名を CSV・TSV・Excel の見出しにし、Excel のセルには列の数値・日時の書式を付けます（`excelNumberFormat` で変換。`format` 関数、compact 表記、`Intl` の日時オプションは型の既定の書式になります）。Parquet と JSON はスキーマの列名のままです。値を表示用の文字に置き換えることはありません。
- **ファイル名**：利用者が入力した名前に、形式の拡張子を付けます。

パネルは進行中を表示し、**キャンセル**（またはパネルを閉じる）で書き出しを止めます。サーバーはクエリーを中断し、書きかけのファイルを消します。失敗はパネルに表示します。Excel の上限は実行前に確かめます。

## ファイルの行き先

`exportOptions` でパネルとアプリをつなぎます。各コールバックは `ExportContext`（利用者の `choice`、`exportView` に渡す `request`、`delivery`、`rowCount`、`signal`）を受け取ります。

```tsx
<DataGrid
  source={source}
  exportOptions={{
    fileName: "orders",                 // 拡張子なしの既定のファイル名
    formats: ["xlsx", "csv"],           // source の形式のうち、これだけを出す
    // target を決める：サーバーならパス、データならダウンロード名。null で取り消し。
    target: ({ request, delivery }) => (delivery === "file" ? `exports/${request.target}` : request.target),
    // ファイルができたら呼ばれる。なければ、返されたデータはダウンロードし、サーバーのファイルは知らせるだけ。
    onExported: (result, { delivery }) => {
      if (delivery === "file") window.location.assign(`/downloads/${encodeURIComponent(result.target)}`);
    },
  }}
/>
```

### サーバーに保存してダウンロードする

サーバーの source はデータの近くにファイルを書き、`{ target, rows }` だけを返します。大きな結果がブラウザーを通ることはありません。`target` の置き場所はサーバーが `resolveTarget` で決め、エンジンが使えるフォルダーの中に収めます。

```ts
createTableHandler({
  engine,
  resolve: (ref) => resolveInside(dataRoot, ref),
  // 書き出しは専用のフォルダーに、利用者が選んだ名前で置く
  resolveTarget: (target) => path.join(exportRoot, path.basename(target)),
});
```

利用者のブラウザーに渡すには、そのフォルダーをアプリから配信し、上の例のように `onExported` で URL を開きます。リポジトリの playground は `/data/exports/` でこれをしています。

### ブラウザーのデータをダウンロードする

`ArraySource` はファイルを `Blob` として `result.data` に返します。`onExported` がなければグリッドがダウンロードします（`downloadBlob`）。`onExported` があれば、File System Access API やアップロードなど、別の場所に保存できます。

### パネルを使わない

`exportOptions={false}` でパネルを隠します。`ref.current.openExport()` は、ツールバーを隠していてもパネルを開きます。独自の画面を作るには、`runExport(controller, choice, options, signal)` でパネルと同じように書き出すか、`exportRequest(controller, choice)` で要求だけを作ります。`source.exportView(request)` を直接呼んでもかまいません。

## Excel ファイル

Excel ファイルは依存なしで（ZIP と SpreadsheetML を自前で）ストリームとして書きます。DuckDB エンジンは行をまとまりごとに読み、圧縮しながら書くので、表が大きくてもサーバーのメモリーは増えません。8 列 100 万行で約 7 秒、58 MB です。

- シートは 1 枚で、見出し行は太字、スクロールしても見える位置に固定します。
- 数値は数値のセルです。倍精度で正確に持てない数値の文字（2^53 を超える 64 bit の ID、有効数字 15 桁を超える decimal）は、桁が変わらないよう文字のままにします。
- 日付・時刻・日時は日付の書式付きの Excel の日付です。タイムゾーン付きの日時は UTC で書きます。1900-03-01 より前の日付は文字のままです。
- 文字は常に文字で、`=`・`+`・`-`・`@` で始まっても数式にはなりません。Excel の上限 32,767 文字を超える文字は切ります。
- `null` は空のセル、真偽値は TRUE と FALSE です。
- 1,048,575 行または 16,384 列を超えるとシートに収まりません。パネルがそう表示し、source は `export_too_large` で断ります。行を絞り込むか、CSV や Parquet で書き出してください。複数のシートへの分割は、Excel で扱いにくいためしません。

詳しい規則は[プロトコル](/reference/protocol/#excel-export-rules)にあります。CSV と TSV は値をそのまま書くので、表計算アプリが開くときに `=` で始まる文字を数式と読むことがあります。表計算アプリで使う人には Excel ファイルを勧めます。

## vastgrid-browser

`BrowserSource` はまだ書き出せません（`capabilities.export` は `false`）。書き出すには Worker で全行を読み、ファイル全体をメモリーに持つか、一部のブラウザーにしかない File System Access API で書く必要があるためです。今後は、アプリが渡すストリームへ Worker から `writeTableFile` で書き、ファイル全体をメモリーに載せない方式を予定しています。それまではサーバーか `ArraySource` から書き出してください。
