# 発信用の素材

2026-11-16 作成。以下は未投稿の文案です。媒体の最新ルールと既存投稿を確認し、使うものを選んでください。
Hacker News 向けの生成文案は含めません。理由と投稿前に確認する材料は [計画](README.md)にあります。

## X：日本語

大きな CSV・Parquet を、表計算ソフトの感覚で開く OSS「vastgrid」を作っています。

100 万行をブラウザーで並べ替え・絞り込み。登録不要で、ファイルのアップロードも不要です。
手元の大きなファイルは VS Code や CLI でも開けます。

まずは実物をどうぞ：
https://vastgrid.yhay81.com/ja/open/?sample=1&utm_source=x&utm_medium=social&utm_campaign=first-users

添付する実演は「100 万行 → 最後の行 → 価格の降順 → 範囲の合計」の順にします。
GitHub のリンクはプロフィールや、必要に応じた補足に置きます。

## X：英語

I’m building vastgrid: an MIT-licensed spreadsheet-like viewer for large CSV and Parquet files.

Try 1M rows in your browser. No sign-up or file upload. For larger local files, use the CLI or VS Code extension.

https://vastgrid.yhay81.com/open/?sample=1&utm_source=x&utm_medium=social&utm_campaign=first-users

日本語版と英語版は同じ内容の選択肢です。両方を短時間に連投する必要はありません。

## 既存の r/DuckDB 投稿への返信案

返信先：[複数の表の連携とバージョン管理についてのコメントがある投稿](https://www.reddit.com/r/DuckDB/comments/1xwvka1/built_vastgrid_mit_open_100mrow_parquet_csv/)

Thanks — connecting tables visually and versioning changes would be useful directions. vastgrid currently
focuses on exploring and editing one table at a time; it doesn't provide visual joins or a built-in commit
history. Which would help you more in your own work: joining separate files, or reviewing and restoring edits
to one file? A concrete workflow would help me decide what to tackle next.

返信の目的は、新しい告知を足すことではなく、要望を具体的な作業にすることです。
実際に寄せられているコメントの内容を再確認してから使ってください。

## 技術記事の構成

タイトル案：**大きな CSV・Parquet を、アップロードせずに表計算の感覚で開く**

1. 中身を少し確かめたいだけなのに、コードを書く必要がある場面。
2. [100 万行のサンプル](https://vastgrid.yhay81.com/ja/open/?sample=1)を開き、価格で並べ替える実演。
3. 自分の CSV を開いて範囲の合計を確認。元のファイルは変わらず、編集結果は書き出して残す。
4. ブラウザーのメモリが足りなければ `npx vastgrid-cli ./data/orders.parquet`。
5. 100 万行のブラウザーデモと、1 億行の DuckDB 計測は別物であること。
6. [使い方](https://vastgrid.yhay81.com/ja/guides/open-large-files/)と
   [GitHub](https://github.com/yhay81/vastgrid)。実際のファイルで困った点を聞く。

開発の動機や体験談は作者自身の事実を足してください。競合との速さの比較は、同条件で計測するまで書きません。

## 性能の表現に使える事実

| 伝えること | 条件・出典 |
| --- | --- |
| インストールなしで 100 万行を試せる | ブラウザーで生成した CSV。`vastgrid-js` の Web Worker |
| ローカルのファイルをアップロードせずに開ける | ブラウザーの `/open/`。CLI・拡張機能は手元の DuckDB |
| 1 億行の Parquet の最初のソート結果が 953 ms | M2 Pro、1.38 GB、エンジンの時間。HTTP・描画を含まない。残りのビューにさらに 3 秒 |
| MIT ライセンス | [LICENSE](../../LICENSE) |

性能の一次資料：[計測条件と再現方法](https://vastgrid.yhay81.com/about/performance/)。
「すべてのファイルを 1 秒で完全にソート」「ブラウザーで 1 億行を実測」は、この資料からは言えません。
