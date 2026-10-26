---
title: 今後
description: vastgrid で予定していること。
---

v1のセル編集・CSV書き戻しは実装済みです。未公開のv2の作り直しは [#33](https://github.com/yhay81/vastgrid/issues/33) で管理しています。

v2では、型の有効範囲を超える値や不正なUnicode文字列を、Arrow変換で別の値へ変えずに拒否します。float32への文字入力は書き込み前に丸め、桁あふれはエラーにします。[v2仕様](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#22-values-in-json) に型の規則を記載しています。

v2のDuckDBエンジンは、ファイルのセルへの書き込みに対応しました。書き込んだ値はファイルと分けて持ち、競合を検出し、取り消せます。CSV・TSVへの保存では、編集していないバイトをそのまま保ちます。グリッドでは ⌘S または Ctrl+S で保存します。ディスク上でファイルが変更されると読み直し、未保存の編集があれば破棄するまで残します（[#37](https://github.com/yhay81/vastgrid/issues/37)）。ビューと表全体を、サーバー側でCSV・TSV・Parquet・JSON・Excelに書き出せます（[#38](https://github.com/yhay81/vastgrid/issues/38)）。v1の計算式はプランの式に変換され、保存済みの計算式も移行します。ツールバーの「計算列」メニューで計算列を追加・変更・改名・削除できます（[#39](https://github.com/yhay81/vastgrid/issues/39)）。標準のパネルとメニュー（[#42](https://github.com/yhay81/vastgrid/issues/42)）に取りかかっています。列ごとのメニューで、その列での並べ替え、値の一覧（件数つき）や条件での絞り込み、統計の表示、集計行、グループ化、幅の調整・固定・非表示ができます。ツールバーの「グループ」メニューで、グループ化する列と集計を選べます。次は、列のパネル、ピボット、列をまたぐ条件です。

アイデアや使い方の例は、[Issues](https://github.com/yhay81/vastgrid/issues) で歓迎します。大きなプルリクエストの前には、[CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md) にあるとおり、まず Issue を立ててください。
