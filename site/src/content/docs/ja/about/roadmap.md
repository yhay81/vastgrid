---
title: 今後
description: vastgrid のバージョン 0.2 の後に予定していることと、入れないこと。
---

バージョン 0.2 では、vastgrid を仕様を中心に作り直しました。JSON のドキュメントとセッション、API としてのコマンド、同じメッセージに答えるエンジンです。そのロードマップ [#33](https://github.com/yhay81/vastgrid/issues/33) は、Marketplace 掲載を除いて終わりました。vastgrid 0.1 の機能は、すべて入っているか、理由を添えて外しています（[migrating-from-0.1.md](https://github.com/yhay81/vastgrid/blob/main/docs/migrating-from-0.1.md)）。

## 次に行うこと

- **Marketplace 掲載。** 0.2.0 は npm・PyPI・GitHub で提供し、VS Code 拡張は GitHub の VSIX から導入します。Marketplace への掲載が残っています（[#45](https://github.com/yhay81/vastgrid/issues/45)）。
- **メモリエンジン。** DuckDB のエンジンと同じように、大きなテキストのファイルを読み込む間に最初の行を返します。
- **アプリ。** MCP App からの書き出しのダウンロード、コマンドのページを読み込み直したときの表示の設定の保持、ノートブックでの `.xlsm` のブック、Open VSX での VS Code の拡張機能です。
- **仕様。** 未解決の問い（[§12](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#12-open-questions)）です。リスト・構造体・マップをテキストではなくそれ自身の型として扱うこと、日本語の読みの順のような照合順序、日付と時刻での `quantile` と `count_distinct` などがあります。

## 入れないもの

- 行の木構造。階層が列にあるデータは、複数のキーでグループ化して表示します。
- グリッドの中のグラフ。グラフはグリッドのビューを読みます（[グラフ](/ja/guides/charts/)）。
- 複数の列の幅をまとめて変えること。列ごとに幅を変えるか、列のメニューから値に合わせます。

アイデアや使い方は [Issue](https://github.com/yhay81/vastgrid/issues) で歓迎します。大きなプルリクエストの前には、[CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md) のとおり、まず Issue を立ててください。
