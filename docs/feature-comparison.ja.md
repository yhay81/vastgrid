# vastgrid と類似ライブラリの機能差

調査日: **2026-10-23**。vastgrid はローカルの作業ツリー（基点: `14c8fd2`）、比較先は調査日に確認した公式ドキュメントと公式リポジトリを対象としました。性能比較や動作ベンチマークは実施していません。

## 要点

**不足している機能はあります。特に、組み込み先からの表示の拡張、画面状態の保存、複雑な絞り込み、グループ集計に差があります。**

vastgrid は大きなファイルの閲覧に必要な操作をすでに多く備えています。まず検討したいのは、次の順です。優先順位と実装規模は、用途と現在の構造から判断した提案です。

1. **画面状態の保存・復元**: 列幅、列順、非表示、固定、クエリーをまとめて保存する。
2. **列ごとの書式とセル描画の拡張**: 金額・日時の書式、条件付きの色、リンクやバッジを指定できるようにする。
3. **書き出しの画面**: すでにある書き出し処理を、利用者が画面から使えるようにする。
4. **複雑な条件の絞り込み**: 列をまたぐ OR、括弧でまとめた AND / OR を扱う。
5. **用途に応じてエンジンを拡張**: サーバーなしでのファイル閲覧、計算列、グループ集計を検討する。

セル編集も大きな差ですが、読み取り中心の設計に書き込み・検証・履歴を加える変更です。閲覧機能の改善とは別に設計すると進めやすくなります。

## 比較の前提

- 「未対応」は、vastgrid の標準機能・公開インターフェースで提供されていない、という意味です。独自の `TableSource` やアプリ側の実装で補えるものも含みます。
- API があって画面に入口がないもの、既存機能の一部だけ足りないものは、完全な未実装と区別しました。
- 有償版の機能には版を明記しました。TanStack Table のように画面を提供しないライブラリは、完成した操作画面を提供するものとは分けて評価しています。
- 公式リポジトリの既定ブランチには、公開済みパッケージより先の内容が含まれる場合があります。特定バージョンへの導入可否は、採用時に別途確認が必要です。

## 比較した 8 系統

| 対象 | 比較する理由 | vastgrid で参考になる点 | 公式資料 |
| --- | --- | --- | --- |
| Glide Data Grid | React・Canvas のグリッドで構成が近い | セルの種類、独自描画、編集、貼り付け、入力検証 | [セルの種類](https://docs.grid.glideapps.com/api/cells)、[描画 API](https://github.com/glideapps/glide-data-grid/blob/main/packages/core/API.md)、[編集](https://docs.grid.glideapps.com/api/dataeditor/editing) |
| AG Grid | 汎用グリッドの機能範囲を確認できる | 状態保存、複雑なフィルター、グループ化・ピボット、Excel 出力。高度な分析・出力などは Enterprise | [版ごとの機能](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/)、[状態保存](https://www.ag-grid.com/react-data-grid/grid-state/) |
| MUI X Data Grid | React アプリへの組み込み機能を比較できる | Community の状態保存、Pro の行固定・詳細パネル、Premium のグループ集計・ピボット・Excel 出力 | [機能と提供プラン](https://mui.com/x/react-data-grid/features/) |
| react-data-grid | MIT の React グリッドと比べられる | 独自レンダラー、集計行、可変行高、セル編集、キーによる行選択 | [公式 README / API](https://github.com/Comcast/react-data-grid) |
| TanStack Table | アプリ側からの制御の設計を参考にできる | 状態の外部管理、グループ化、集計、行固定。操作画面や仮想化の組み込みは別途必要 | [状態管理](https://tanstack.com/table/latest/docs/framework/react/guide/table-state)、[クライアント・サーバーの役割](https://tanstack.com/table/latest/docs/guide/client-side-vs-server-side) |
| Handsontable | 表計算に近い編集機能の基準になる | 入力検証、オートフィル、Undo / Redo、HyperFormula 連携。商用利用向けライセンスが必要 | [オートフィル](https://handsontable.com/docs/react-data-grid/autofill-values/)、[数式](https://handsontable.com/docs/react-data-grid/formula-calculation/)、[ライセンス](https://handsontable.com/docs/react-data-grid/license-key/) |
| Perspective | 大量データの分析に用途が近い | ピボット、グラフ、式、差分更新、Worker・WebSocket・外部 DB への接続 | [公式ガイド](https://perspective-dev.github.io/guide/) |
| HighTable ＋ hyparquet | ファイルを部分的に読み込む表として近い | 列幅の永続化、選択状態の外部制御、独自セル描画、HTTP Range による Parquet の部分読み込み | [HighTable API](https://github.com/hyparam/hightable#props)、[hyparquet](https://github.com/hyparam/hyparquet#asyncbufferfromurl) |

## 既存機能として確認できたもの

次のものは不足機能に数えていません。

| 機能 | vastgrid の現在の対応 |
| --- | --- |
| 大量データの表示 | Canvas 描画、行・列の部分取得、先読み・キャンセル・LRU キャッシュ、ブラウザーの要素サイズ上限を超えるスクロール |
| 選択と操作 | セル・行・列・複数範囲の選択、キーボード移動、範囲の拡張 |
| 列の操作 | 幅変更・自動調整、ドラッグによる並べ替え、非表示、左端からの連続した列の固定 |
| 絞り込み・検索 | 複数列ソート、値の一覧・比較・範囲・文字列・空白によるフィルター、全列検索、次・前の一致セルへの移動 |
| 集計 | 選択範囲の件数・合計・平均・最小・最大、列統計、分布・四分位・頻出値 |
| コピー | TSV・HTML・Markdown。現在の範囲を対象に、未取得セルも読み込んでコピー |
| 表示と操作補助 | 日英メッセージ、CSS 変数によるテーマ、ARIA grid、キーボード操作、セルの全体値の表示 |
| 拡張 | `TableSource`、`RemoteSource`、`ArraySource`、クエリー取得・設定、再読み込み、指定行への移動 |
| ファイル書き出し | DuckDB 側に CSV・TSV・Parquet・JSON の `exportView`。標準の保存ボタンはない |

根拠: [DataGrid](../packages/react/src/data-grid.tsx)、[GridController](../packages/react/src/controller.ts)、[TableSource](../packages/core/src/source.ts)、[DuckDB エンジン](../packages/duckdb/src/engine.ts)。ARIA の実装があることと、各スクリーンリーダーでの適合性が確認済みであることは別です。今回は読み上げの実機検証はしていません。

## 主な不足・部分対応

### 組み込みと日常操作

| 機能 | 比較先の例 | vastgrid の状態 | 利用者への効果・実装の見通し |
| --- | --- | --- | --- |
| **画面状態の保存・復元** | [AG Grid](https://www.ag-grid.com/react-data-grid/grid-state/)、[MUI Community](https://mui.com/x/react-data-grid/features/)、[HighTable の列幅保存](https://github.com/hyparam/hightable#props) | **部分対応**。`getQuery` / `setQuery` はある。列幅・列順・非表示・固定・選択・スクロールをまとめて保存復元する API はない | 毎回同じ列設定を作り直さずに済む。まずクエリーと列設定を対象にすれば、エンジンの変更を抑えられる |
| **列ごとの表示書式** | [react-data-grid のセル書式](https://github.com/Comcast/react-data-grid)、[Glide のセル型](https://docs.grid.glideapps.com/api/cells) | **未対応**。標準の数値整形と全体のロケール指定はあるが、列単位の通貨・小数桁・日時・表示名・整形関数を指定する API はない | 元データを加工せずに、金額や日時を読みやすくできる。表示と生の値、コピー時の値を区別して設計する |
| **独自のセル描画・条件付き書式** | [Glide の drawCell / renderers](https://github.com/glideapps/glide-data-grid/blob/main/packages/core/API.md)、[HighTable の renderCellContent](https://github.com/hyparam/hightable#props) | **未対応**。現在は組み込みの文字描画が中心。テーマ全体の色は変えられるが、値ごとの色・バッジ・画像・操作ボタンを差し込む API はない | エラー値の強調や状態表示に使える。Canvas の描画フックと、クリック・キーボード操作を組にする。表示セルごとの DOM 追加は性能を検証する |
| **アプリ向けの操作イベント** | [HighTable の選択・セル操作イベント](https://github.com/hyparam/hightable#props)、[TanStack の状態管理](https://tanstack.com/table/latest/docs/framework/react/guide/table-state) | **部分対応**。`onQueryChange` と controller の購読はあるが、選択変更・列設定変更・セルクリックなどを受け取る専用の DataGrid props はない | 選択に応じた詳細画面や独自メニューを作りやすくする。controller への依存を減らせる |
| **書き出しの画面・ダウンロード連携** | [AG Grid のメニューと出力 API](https://www.ag-grid.com/react-data-grid/excel-export/) | **API のみ対応**。DuckDB の `exportView` はあるが、形式選択・保存・ブラウザーへのダウンロードの標準導線はない。`ArraySource` は export capability が false | 現在の絞り込み結果を画面から持ち出せる。保存先はホストアプリが決めるため、単なるボタン追加だけでなく連携 API を用意する |
| **複数範囲をまとめてコピー** | [AG Grid Enterprise](https://www.ag-grid.com/react-data-grid/clipboard/) | **部分対応**。複数範囲を選択できるが、コピー処理は `selection.current` の 1 範囲を読む | 離れた範囲を一度にコピーできる。結合時の行列の扱いを決める必要がある。AG Grid は範囲を縦に並べ、元の相対位置を維持しない |
| **Excel（.xlsx）出力** | [AG Grid Enterprise](https://www.ag-grid.com/react-data-grid/excel-export/)、[MUI Premium](https://mui.com/x/react-data-grid/features/) | **未対応**。TSV / HTML のコピーはあるが、xlsx ファイルの生成はない。xlsx の入力もロードマップ段階 | Excel へ渡す用途に有効。大容量データは、対象行数や分割方法を含めて設計する |

### データ探索・分析・更新

| 機能 | 比較先の例 | vastgrid の状態 | 利用者への効果・実装の見通し |
| --- | --- | --- | --- |
| **列をまたぐ OR、入れ子の条件** | [AG Grid Enterprise の Advanced Filter](https://www.ag-grid.com/react-data-grid/filter-advanced/) | **未対応**。`Filter[]` は AND 結合。値リスト内の OR と全列検索はあるが、任意の条件木は表現できない。標準画面は列ごとに 1 フィルター | 例: `(地域 = 東京 OR 売上 > 100000) AND 状態 != 取消`。画面だけでなく型・プロトコル・各エンジンの変更が必要 |
| **グループ化・小計・ピボット** | [AG Grid Enterprise](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/)、[MUI Premium](https://mui.com/x/react-data-grid/features/)、[Perspective](https://perspective-dev.github.io/guide/) | **未対応**。現在の `ViewQuery` は sort / filters / search のみ。選択範囲の集計はグループ集計とは異なる | 地域別・月別などで全体を把握できる。集計後の行・列構造、折り畳み、集計用の識別子を設計する |
| **計算列・式の列** | [Perspective の式](https://perspective-dev.github.io/guide/)、[Handsontable ＋ HyperFormula](https://handsontable.com/docs/react-data-grid/formula-calculation/) | **未対応・ロードマップあり**。自作 source が計算値を返すことはできるが、標準画面から式の列を追加する機能はない | 例: `数量 × 単価`。巨大データでは画面に見えるセルだけで計算を完結させず、ソート・統計・出力にも同じ式を適用する必要がある |
| **セル編集と編集支援** | [Glide](https://docs.grid.glideapps.com/api/dataeditor/editing)、[Handsontable のオートフィル](https://handsontable.com/docs/react-data-grid/autofill-values/)、[react-data-grid](https://github.com/Comcast/react-data-grid) | **未対応**。セル編集はロードマップあり。`TableSource` に書き込みメソッドがなく、貼り付け・入力検証・Undo / Redo・フィルもない。F2 は値の表示 | 閲覧中に値を直せる。変更の保存、型の検証、取消、ファイル更新との競合をまとめて設計する |
| **ブラウザーだけで大容量ファイルを開く標準エンジン** | [Perspective の Worker / WASM](https://perspective-dev.github.io/guide/)、[hyparquet](https://github.com/hyparam/hyparquet) | **未対応・ロードマップあり**。`ArraySource` によるブラウザー内表示はできるが、ファイルを部分的に読む標準 source はない。大容量ファイル用の同梱エンジンは Node.js の DuckDB | サーバーを持たないアプリにも組み込める。まず Parquet の部分読み込みなど、対応形式と操作を絞る案がある |
| **URL の Parquet を必要な部分だけ読む** | [hyparquet の HTTP Range](https://github.com/hyparam/hyparquet#asyncbufferfromurl) | **未対応**。`RemoteSource` は表の API に接続するもので、Parquet の URL を直接読むものではない。同梱 DuckDB エンジンは許可したローカルファイルが対象 | 配布済みファイルを全取得せず閲覧できる。source を別に実装し、配信側の Range・CORS・認証条件を扱う |
| **差分更新・リアルタイム反映** | [Perspective の増分更新・ストリーミング](https://perspective-dev.github.io/guide/)、[HighTable の update / numrowschange](https://github.com/hyparam/hightable#data-model) | **未対応**。`reload` / `reloadKey` と revision はあるが、source の更新購読や差分通知はない。標準の情報ポーリングは loading 終了で止まる | 増えるログや更新される一覧に使える。安定した行 ID、キャッシュ無効化、ソート・集計の更新方法が必要 |
| **集計結果からのグラフ** | [AG Grid Enterprise の Integrated Charts](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/)、[Perspective](https://perspective-dev.github.io/guide/)、[MUI Premium](https://mui.com/x/react-data-grid/features/) | **部分対応**。列統計のヒストグラムはあるが、任意の列を軸・系列にするグラフはない | 表全体の傾向を見やすくする。大容量データをすべてブラウザーへ取り出さず、集計結果を描く構成が向く |

### 表のレイアウト・業務画面向け

| 機能 | 比較先の例 | vastgrid の状態 | 優先度の考え方 |
| --- | --- | --- | --- |
| **右側の列固定・行の固定・集計行** | [AG Grid の左右固定](https://www.ag-grid.com/react-data-grid/column-pinning/)、[Glide の末尾行固定](https://docs.grid.glideapps.com/api/dataeditor/important-props)、[react-data-grid の summary rows](https://github.com/Comcast/react-data-grid) | 左側の連続列固定はある。右側の列、上・下の行、集計行の固定はない | 合計や比較対象を見続ける用途があるなら有効 |
| **複数段の列見出し** | [react-data-grid](https://github.com/Comcast/react-data-grid)、[MUI Community](https://mui.com/x/react-data-grid/features/) | 列見出しは 1 段。列グループの定義がない | 多数の列が意味上のグループに分かれる用途で有効 |
| **折り返し表示・可変行高** | [react-data-grid の rowHeight](https://github.com/Comcast/react-data-grid)、[Glide の rowHeight](https://docs.grid.glideapps.com/api/dataeditor/important-props) | 全行共通の高さで 1 行表示。長い値はインスペクターで表示する | 長文データ向け。巨大行数での位置計算に影響するため、固定高を標準に残し、必要な用途から検討する |
| **ツリー・行の詳細展開** | [AG Grid Enterprise の Master / Detail](https://www.ag-grid.com/react-data-grid/master-detail/)、[MUI Pro の tree data / detail panels](https://mui.com/x/react-data-grid/features/) | 標準の行階層・展開状態・詳細パネルはない | 業務一覧では有効。フラットなファイル閲覧が中心なら優先度は下げられる |
| **行 ID による選択の維持・チェックボックス選択** | [react-data-grid の rowKeyGetter / selectedRows](https://github.com/Comcast/react-data-grid) | 行全体の範囲選択はある。選択はビュー上の位置で持ち、クエリー変更時にリセットする。`RowBlock.rowIds` は元ファイルの行位置を表す | 絞り込み後も選んだレコードを保持して操作する用途に有効。既存の範囲選択に別の選択モデルを加える設計になる |

## 実装を検討する順番

| 段階 | 提案 | 理由・注意点 |
| --- | --- | --- |
| 1 | **画面状態 API、列書式・描画フック、専用の操作イベント** | ファイル形式やエンジンを増やさず、組み込み部品としての使いやすさを上げられる。画面状態は保存形式にバージョンを持たせると変更に対応しやすい |
| 2 | **書き出し UI、複数範囲コピー** | すでにある取得・出力処理を活かせる。書き出しはホストアプリとの受け渡しを設計する。xlsx は既存形式の導線を整えた後に別途判断する |
| 3 | **AND / OR の条件木、計算列** | データ探索の幅が増す。型・プロトコル・ArraySource・RemoteSource・DuckDB を一貫して拡張する |
| 4 | **Parquet 向けブラウザー source または Worker エンジン** | サーバーなしの利用を開ける。検索・ソート・統計まで同じ範囲を支援するかは、表示の実装とは分けて決める |
| 5 | **グループ集計・ピボット、編集機能** | 価値は大きいが、行列の構造や読み書きの契約に影響する。目的に応じて別々の機能として設計する |

「巨大ファイルを素早く調べる」という現在の用途なら、まず段階 1〜3 を推します。ブラウザーだけで使いたい需要が強ければ、段階 4 を先にする価値があります。

## 既存調査から見直したい前提

[2026-10-20 の既存調査](research.ja.md)を、今回の結論の根拠としてそのまま使うのは避けたほうがよい箇所があります。

- **Handsontable を「メモリ上のデータだけ」とする記述**: 現在の公式資料には、17.1.0 で追加されたサーバー側データ取得があり、ソート・フィルター・CRUD の連携が説明されています。ファイルを開くエンジンを同梱するかどうかとは別の話です。[公式の server-side data](https://handsontable.com/docs/react-data-grid/server-side-data/)
- **Perspective を「エンジンは強いが表計算の操作は弱い」と一括りにする記述**: 現在の公式ガイドは編集可能なグリッド、React 連携、DuckDB などの外部エンジンへの委譲まで説明しています。操作ごとの比較が必要です。[公式ガイド](https://perspective-dev.github.io/guide/)

また、今回確認した機能一覧から、巨大ファイルでの速さやメモリ使用量の優劣までは判断できません。機能があることと、同じデータ量で実用的に動くことは分けて評価する必要があります。

## vastgrid 側で確認した主な実装

| 確認対象 | 根拠 |
| --- | --- |
| 公開 props と ref API | [data-grid.tsx](../packages/react/src/data-grid.tsx) の `DataGridProps` / `DataGridHandle` |
| フィルター・ビュー・書き出しの型 | [types.ts](../packages/core/src/types.ts) の `Filter` / `ViewQuery` / `ExportRequest` |
| source が提供できる操作 | [source.ts](../packages/core/src/source.ts) の `TableSource` |
| 列操作、単一範囲のコピー、選択リセット、情報ポーリング | [controller.ts](../packages/react/src/controller.ts) の `moveColumn` / `freezeUpTo` / `copySelection` / `setQuery` / `poll` |
| セルの描画と表示書式 | [renderer.ts](../packages/react/src/renderer.ts)、[format.ts](../packages/core/src/format.ts) |
| 各フィルターの AND 結合 | [array-source.ts](../packages/core/src/array-source.ts) の `filters.every`、[engine.ts](../packages/duckdb/src/engine.ts) の `where` |
| 書き出しの実装とホスト側の有効化 | [engine.ts](../packages/duckdb/src/engine.ts) の `exportView`、[handler.ts](../packages/duckdb/src/handler.ts) の `resolveTarget` |
| 既存の開発予定 | [roadmap.md](../site/src/content/docs/ja/about/roadmap.md) |
