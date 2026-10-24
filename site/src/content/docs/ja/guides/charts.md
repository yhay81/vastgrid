---
title: グラフ
description: グリッドの行のグループを、好きなグラフライブラリで描きます。グリッドの絞り込みと並べ替えに追従させる方法。
---

vastgrid はグラフを描かず、グラフライブラリにも依存しません。その代わりに、グラフに必要なものを渡します。グリッドが表示している行のグループを source が計算し、`limit` で数を抑えて返します。そのため 1 億行の表のグラフでも、届くのは表ではなく 20 個の数値です。アプリですでに使っているライブラリ（Chart.js、ECharts、Vega-Lite、Recharts など）に渡してください。

[playground](https://github.com/yhay81/vastgrid/tree/main/examples/playground) には Chart.js で動く例があります（`examples/playground/src/ChartPanel.tsx`）。「Chart」をオンにして、グリッドを絞り込んだり並べ替えたりしてみてください。

## 1. グリッドに追従する

`onStateChange` は、グリッドの絞り込み・条件・検索・並べ替え・列が変わるたびに状態を知らせます。グループを表示している間も同じで、状態の `query` は行のクエリーのままです。列の番号は状態の `schema` を指すので、`resolveGridState` で表の列に対応させます。

```tsx
const [state, setState] = useState<GridState | null>(null);

<DataGrid source={source} onStateChange={setState} />;

const names = info.columns.map((column) => column.name);
const query: ViewQuery = (state && resolveGridState(state, names).query) || {};
```

## 2. source にグループを求める

同じ行のビューを（グループは変わらないので並べ替えなしで）作り、グループ化します。`vastgrid-duckdb` のようにビューを保つエンジンは、グリッドが作ったビューをそのまま使います。グリッドがグラフの列で並べ替えているときはその順にし、グラフが描く数より多くのグループは求めません。クエリーが変わったら前の要求を取り消します。

```ts
useEffect(() => {
  if (!info.capabilities.group || !source.group) return; // グループ化できない source
  const abort = new AbortController();
  const { sort, ...rows } = query;
  const first = sort?.[0];
  const order: SortKey[] =
    first?.column === key ? [{ column: 0, direction: first.direction }] // 棒の見出しの順
    : first?.column === value ? [{ column: 1, direction: first.direction }] // 棒の高さの順
    : [{ column: 1, direction: "desc" }]; // 大きい順
  (async () => {
    const view = isEmptyQuery(rows) ? null : (await source.createView(rows, abort.signal)).id;
    return source.group({ view, keys: [key], aggregates: [{ fn: "sum", column: value }], sort: order, limit: 20 }, abort.signal);
  })().then(setResult, (error) => {
    if (!isAbortError(error)) setError(error);
  });
  return () => abort.abort();
}, [source, info, JSON.stringify(query), key, value]);
```

表そのものの変更（ファイルへの行の追記など）にも追従するには、`source.subscribe` が変更を知らせたときにもグループを読み直します（[任意のメソッド](/ja/guides/custom-source/#任意のメソッド)を参照）。

## 3. 描く

`result.rows` には、グループごとに `[キー, 値]` の配列が入っています。グラフには数値が必要です。2^53 を超える整数と decimal は（[型](/ja/guides/grouping/#グループの意味)のとおり正確な）文字列で届くので、`Number` で変換します。棒の高さには十分な精度です。null と空の文字列のキーもそれぞれ 1 つのグループなので、見出しを付けてください。

```ts
import { BarController, BarElement, CategoryScale, Chart, LinearScale } from "chart.js";
Chart.register(BarController, BarElement, CategoryScale, LinearScale);

const chart = new Chart(canvas, { type: "bar", data: { labels: [], datasets: [{ data: [] }] } });

// 結果が届くたびに:
chart.data.labels = result.rows.map(([key]) => (key === null ? "(null)" : String(key)));
chart.data.datasets[0].data = result.rows.map(([, value]) => (value === null ? null : Number(value)));
chart.update();
```

ほかのライブラリにも同じ行が使えます。たとえば Vega-Lite や Recharts のデータには `result.rows.map(([label, value]) => ({ label, value: Number(value) }))` です。`result.truncated` と `result.groups` で、グラフが多くのグループの先頭だけを表示しているか（「1,234 グループのうち 20」）がわかります。軸の名前には `result.columns[1].name`（`sum(amount)`）が使えます。

## 補足

- グラフの数値は、画面に見えている行ではなく、グリッドが残しているすべての行から source が計算したものです。ブラウザーに届くのは `limit` までです。
- クロス集計（`pivot`）では、列軸の値ごとに系列ができます。`result.pivot` が、作った列ごとの値を返します。
- グラフを出す前に `capabilities.group`（と `pivot`）を確かめてください。`vastgrid-browser` は `fullScan` のときだけグループ化します。
