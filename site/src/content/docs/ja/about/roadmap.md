---
title: 今後
description: vastgrid のバージョン 0.4 の後に予定していることと、入れないこと。
---

バージョン 0.2 では、vastgrid を仕様を中心に作り直しました。JSON のドキュメントとセッション、API としてのコマンド、同じメッセージに答えるエンジンです。そのロードマップ [#33](https://github.com/yhay81/vastgrid/issues/33) は終わりました。vastgrid 0.1 の機能は、すべて入っているか、理由を添えて外しています（[migrating-from-0.1.md](https://github.com/yhay81/vastgrid/blob/main/docs/migrating-from-0.1.md)）。バージョン 0.3 では、グリッドの表示の文字を 9 つの言語にし、言語ごとに別の import にし（[言語と文言](/ja/guides/localization/)）、VS Code 拡張を Visual Studio Marketplace と Open VSX で公開しました。バージョン 0.4 では、全角・半角とかなの同一視（`fold` と同一視した検索）、DuckDB データベースのファイル、DuckDB の日付の全範囲と `infinity`、ヒストグラム用の `bin`、`vastgrid-js` での大きなテキストファイルの段階的な表示、セルの切り取りが加わりました。

## 次に行うこと

- **仕様。** 未解決の問い（[§12](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#12-open-questions)）です。リスト・構造体・マップをテキストではなくそれ自身の型として扱うこと（それを返す `histogram` の集計も）と、日本語の読みの順のような照合順序が残っています。

## 入れないもの

- 行の木構造。階層が列にあるデータは、複数のキーでグループ化して表示します。
- グリッドの中のグラフ。グラフはグリッドのビューを読みます（[グラフ](/ja/guides/charts/)）。
- 複数の列の幅をまとめて変えること。列ごとに幅を変えるか、列のメニューから値に合わせます。

アイデアや使い方は [Issue](https://github.com/yhay81/vastgrid/issues) で歓迎します。大きなプルリクエストの前には、[CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md) のとおり、まず Issue を立ててください。
