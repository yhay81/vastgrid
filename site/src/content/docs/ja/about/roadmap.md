---
title: 今後
description: vastgrid で予定していること。
---

v1のセル編集・CSV書き戻しは実装済みです。未公開のv2の作り直しは [#33](https://github.com/yhay81/vastgrid/issues/33) で管理しています。

v2では、型の有効範囲を超える値や不正なUnicode文字列を、Arrow変換で別の値へ変えずに拒否します。float32への文字入力は書き込み前に丸め、桁あふれはエラーにします。[v2仕様](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#22-values-in-json) に型の規則を記載しています。

v2のDuckDBエンジンは、ファイルのセルへの書き込みに対応しました。書き込んだ値はファイルと分けて持ち、競合を検出し、取り消せます。CSV・TSVへの保存では、編集していないバイトをそのまま保ちます。グリッドでは ⌘S または Ctrl+S で保存します（[#37](https://github.com/yhay81/vastgrid/issues/37)）。次は、ディスク上のファイルの変更への追従と、ビューの書き出し（[#38](https://github.com/yhay81/vastgrid/issues/38)）です。

アイデアや使い方の例は、[Issues](https://github.com/yhay81/vastgrid/issues) で歓迎します。大きなプルリクエストの前には、[CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md) にあるとおり、まず Issue を立ててください。
