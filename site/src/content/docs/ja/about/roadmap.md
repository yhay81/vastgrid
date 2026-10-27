---
title: 今後
description: vastgrid で予定していること。
---

v1のセル編集・CSV書き戻しは実装済みです。未公開のv2の作り直しは [#33](https://github.com/yhay81/vastgrid/issues/33) で管理しています。

v2では、型の有効範囲を超える値や不正なUnicode文字列を、Arrow変換で別の値へ変えずに拒否します。float32への文字入力は書き込み前に丸め、桁あふれはエラーにします。[v2仕様](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#22-values-in-json) に型の規則を記載しています。

v2のDuckDBエンジンは、ファイルのセルへの書き込みに対応しました。書き込んだ値はファイルと分けて持ち、競合を検出し、取り消せます。CSV・TSVへの保存では、編集していないバイトをそのまま保ちます。グリッドでは ⌘S または Ctrl+S で保存します。ディスク上でファイルが変更されると読み直し、未保存の編集があれば破棄するまで残します（[#37](https://github.com/yhay81/vastgrid/issues/37)）。ビューと表全体を、サーバー側でCSV・TSV・Parquet・JSON・Excelに書き出せます（[#38](https://github.com/yhay81/vastgrid/issues/38)）。v1の計算式はプランの式に変換され、保存済みの計算式も移行します。ツールバーの「計算列」メニューで計算列を追加・変更・改名・削除できます（[#39](https://github.com/yhay81/vastgrid/issues/39)）。標準のパネルとメニュー（[#42](https://github.com/yhay81/vastgrid/issues/42)）に取りかかっています。列ごとのメニューで、その列での並べ替え、値の一覧（件数つき）や条件での絞り込み、統計の表示、集計行、グループ化、幅の調整・固定・非表示ができます。ツールバーの「グループ」メニューでグループ化する列・集計・ピボットの列を、「条件」メニューで列をまたぐ AND・OR の条件を、「列」メニューで列の表示・非表示と並べ替えを扱えます。列メニューの「書式…」で、表示名・配置・折り返し・数値や日付の書式・条件付きの色を設定できます。行のチェックと、現在の行のすべての列を出す詳細パネルにも対応しました。列グループ、セルのリンク・ボタン、独自描画、フィルも入り、v1 の機能との対応を [v2-from-v1.md](https://github.com/yhay81/vastgrid/blob/main/docs/v2-from-v1.md) にまとめました。検索（⌘F）、セルのメニュー、見出しのドラッグでの列の移動も入りました。メニューとパネルは開いたときに読み込み、最初に読み込む量は CI で gzip 後 200 KB 以内に保ちます。電文はプランや値の内側まで上限を検査し、エラーはどんな要求に対しても上限内に収めます（[#46](https://github.com/yhay81/vastgrid/issues/46)）。MCP App（[#40](https://github.com/yhay81/vastgrid/issues/40)）では、どんな大きさのファイルもチャットの中のグリッドで開き、エージェントと人が同じ状態を同じコマンドで操作します（[mcp-app.md](https://github.com/yhay81/vastgrid/blob/main/docs/mcp-app.md)）。VS Code（[#41](https://github.com/yhay81/vastgrid/issues/41)）では、どんな大きさのファイルもエディターとしてグリッドで開き、拡張機能の中の DuckDB で読みます。CSV・TSV は編集でき、VS Code の保存・名前を付けて保存・元に戻すで扱えます（[vscode.md](https://github.com/yhay81/vastgrid/blob/main/docs/vscode.md)）。JavaScript エンジンは、仕様のすべての関数と集計で、計算列・条件・検索・グループ・ピボットとその条件を計算し、適合ケースをすべて通ります。生成したプランでは DuckDB エンジンと同じ答えを返します。表を Arrow でも受け取り、列を型付きのまま持つので、JSON の行の半分のメモリーで済みます。このエンジンで次に取り組むのは（[#43](https://github.com/yhay81/vastgrid/issues/43)）、ブラウザーでのファイルの読み込みです。

アイデアや使い方の例は、[Issues](https://github.com/yhay81/vastgrid/issues) で歓迎します。大きなプルリクエストの前には、[CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md) にあるとおり、まず Issue を立ててください。
