---
title: ノートブック
description: DataFrame や、どんな大きさの CSV・TSV・Parquet・JSON Lines・Excel のファイルを、Jupyter ノートブックの表に示します。DuckDB はカーネルで動き、編集した表を DataFrame で受け取れます。
---

Python のパッケージ `vastgrid` は、どんな大きさの表も Jupyter ノートブックの中の vastgrid の表に示します。pandas・Polars の DataFrame、PyArrow の表、DuckDB のリレーション、そして CSV・TSV・Parquet・JSON・JSON Lines・Excel のファイルです。データはカーネルの DuckDB が読みます。セルの出力の表は [anywidget](https://anywidget.dev) で、`DataGrid` を示し、ウィジェットのメッセージで行のブロックを範囲ごとに読みます。編集した表は、ノートブックが DataFrame として受け取るか、書き出します。

## 使い方

```sh
pip install vastgrid
```

Python 3.11 以降と、`anywidget` 0.10 以降、`duckdb` 2.0 以降、`pyarrow` 19 以降が必要で、これらは pip が一緒に入れます。`pandas` と `polars` は、その DataFrame を扱うときと `to_pandas`・`to_polars` を使うときだけ必要です。ノートブックでは次のようにします。

```python
import vastgrid

grid = vastgrid.show(df)  # pandas・Polars の DataFrame、PyArrow の表、DuckDB のリレーション
grid = vastgrid.show("sales.parquet")
grid = vastgrid.show("book.xlsx", sheet="2025", height=600, locale="ja")
grid
```

`show(data, **options)` は `Grid(data, **options)` と同じです。

| オプション | 既定 | 意味 |
| --- | --- | --- |
| `sheet` | 最初のシート | ブックのシート |
| `height` | 480 | 表の高さ（ピクセル） |
| `locale` | `"en"` | 表示の言語と数値の書式の BCP 47 タグ。`"ja"`・`"zh-CN"`・`"zh-TW"`・`"ko"`・`"es"`・`"pt-BR"`・`"fr"`・`"de"`。ほかの言語の文言は英語 |
| `name` | ファイルの名前、または `"table"` | 表の名前。スクリーンリーダーが読み上げる |
| `workers` | 4 | 表の要求に並行して答えるスレッドの数 |

JupyterLab 4.6 と Jupyter Notebook 7.6（ipywidgets 8）で試験しています。anywidget を使えるほかの環境（VS Code のノートブック、Google Colab、marimo）はまだ試験していません。

## ファイルと表

| 形式 | ファイル | 表では |
| --- | --- | --- |
| CSV、TSV | `.csv`、`.txt`、`.tsv`、`.tab`（`.gz`、`.zst` も） | 編集できる |
| JSON、JSON Lines | `.json`、`.jsonl`、`.ndjson`（`.gz`、`.zst` も） | 編集できる |
| Parquet | `.parquet`、`.pq` | 編集できる。その場で行の範囲ごとに読む |
| Excel | `.xlsx`、`.xlsm` | 編集できる。ブックのシートを（隠しシートには印を付けて）示し、`sheet` で選ぶ |
| DataFrame | pandas、Polars、PyArrow の表、DuckDB のリレーション | 編集できる |

DataFrame は、表を開くときに行の順のまま DuckDB に写します。DataFrame そのものは変わりません。Parquet 以外のファイルは DuckDB の表に読み込みます。カーネルのすべての表はメモリー上の 1 つの DuckDB のデータベースを共有するので、DuckDB のメモリーの上限はすべての表にまとめてかかり、収まらない分はデータベースと一緒に消える専用の一時フォルダーに書き出されます。

## 編集と書き出し

グリッドがエンジンとできることはすべて使えます。並べ替え・絞り込み・検索・グループ化・ピボット・数式・統計・セルの検索、そしてセルの編集（入力・貼り付け・消去・フィル・元に戻す・やり直し）です。[グリッドの使い方](/ja/guides/using-the-grid/)を参照してください。

ノートブックはデータを変数として持つので、元のファイルには何も保存しません（エンジンは保存できないと答えます）。代わりに、書き込んだセルをノートブックが読みます。

```python
grid.edits                     # {"version": 3, "cells": 3}：書き込んだセル
grid.plan                      # 表のビューのプラン：絞り込み、並べ替え、グループ、派生列
grid.to_pandas()               # 書き込んだセルを含む表を行の順で（to_polars、to_arrow も）
grid.to_pandas(view=True)      # 表のビュー：その行を、その順と列で
grid.export("view.xlsx")       # ビューをファイルに：拡張子で CSV・TSV・Parquet・JSON・Excel
grid.export("all.parquet", view=False)   # 表全体を行の順で
grid.close()                   # 表とそのテーブル、書き込んだセルを閉じる
```

`export` は書いた行数を返し、既存のファイルは新しいファイルを書き終えてから置き換えます。表の書き出しメニューも同じファイルを作り、ブラウザーがダウンロードします。

## 寿命

- 表はセルの出力がある間だけ生きています。セルをもう一度実行すると前に作った表を閉じ、カーネルが終わるとすべて閉じます。閉じた表の `edits`・`to_pandas`・`export` は `ValueError` を投げます。
- ページの側のテーブルは、出力の表示とともに閉じます（セルの出力を消したとき、ノートブックを閉じたとき、ページを読み込み直したとき）。`Grid` は閉じるまでテーブルと書き込んだセルを持ち、もう一度表示するとそれを含めて開き直します。
- `grid.close()` は表をすぐに閉じます。ページ、テーブル、スレッド、書き込んだセルのすべてです。

## キー

表にフォーカスがある間、キーは表のものです。文字を打つとセルの編集が始まり、矢印キーでセルを移り、Enter と Tab で編集中のセルを書き込んで移り、Esc で取り消します。その間、ノートブックのコマンドモードのキー（A でセルを足す、矢印キーでセルを移る）は働かず、フォーカスが表を離れると戻ります。表は JupyterLab のテーマ（ライトかダーク）に従います。

## まだできないこと

- 読んだファイルには保存しません。表を書き出すか、DataFrame から書いてください。
- 書き込んだセルはカーネルのメモリーにあり、カーネルを再起動すると失われます。

詳しくは GitHub の [notebook.md](https://github.com/yhay81/vastgrid/blob/main/docs/notebook.md)（英語）にあり、メッセージと試験の方法も書いています。
