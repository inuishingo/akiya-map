# ZENRIN 住所検索API `address_polygon` 実測レポート

- 実施日：2026-08-28
- 目的：空家MAPの周回機能で「エリア＝町丁目」を**面（ポリゴン）**として扱えるかの判断材料を得る
- 位置づけ：**調査のみ**。`index.html` / `admin.html` / Functions は一切変更していない
- 使用スクリプト：[scripts/probe-address-polygon.js](../scripts/probe-address-polygon.js)（使い捨て）
- 描画確認：[scripts/probe-address-polygon.html](../scripts/probe-address-polygon.html)（使い捨て）
- 参照：https://developers.zmaps-api.com/v20/reference/webAPI/address.html

## 0. 結論（先に3行）

1. **AZC（字丁目）でポリゴンは取れる。** 検証4住所中3件で取得成功。残り1件（岐阜市司町）は
   ポリゴンが `null` なのではなく **AZCの該当住所自体が0件**（＝司町は丁目を持たない町名）。
2. **GeoJSON はそのまま `L.geoJSON()` に渡せる。座標の入れ替えは不要。**
   `[経度, 緯度]` 順（GeoJSON標準）であることを実測で確認。ヘッドレスChromeで実描画まで確認済み。
3. **1字丁目あたり数KB・数百msと軽い。ただし区まるごと一括はサーバ側が重い**
   （緑区423件の一括取得で **21.1秒 / 1.72MB**）。取り込みは分割 or 事前キャッシュ前提。

## 1. リクエスト仕様（実測で通ったもの）

```
GET https://test-web.zmaps-api.com/search/address
    ?word=<住所文字列>
    &address_level=SHK|OAZ|AZC
    &address_polygon=true
    &datum=JGD
    &limit=0,5
Headers:
    x-api-key: <ZENRIN_KEY>     ← Secret Manager。コードに書かない
    Authorization: referer
    Referer: https://inuishingo.github.io/
```

認証方式・BASE URL は [functions/index.js](../functions/index.js) の `zenrin` プロキシと完全に同一
（`type=reverse` が既に同じ `/search/address` を叩いている）。

## 2. 結果一覧（4住所 × 3レベル ＝ 12リクエスト、直列・各300ms間隔）

| # | 住所 | level | status | 応答 | レイテンシ | hit | マッチした住所 | polygon | type | 構成点数 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 名古屋市中区栄三丁目 | SHK | 200 | 25,324 B | 401 ms | 1 | 愛知県名古屋市中区 | ○ | MultiPolygon | 620 |
| 2 | 〃 | OAZ | 200 | 9,303 B | 175 ms | 1 | 愛知県名古屋市中区栄 | ○ | MultiPolygon | 201 |
| 3 | 〃 | **AZC** | 200 | 5,035 B | 164 ms | 1 | 愛知県名古屋市中区栄3丁目 | **○** | MultiPolygon | 85 |
| 4 | 名古屋市緑区鳴海町 | SHK | 200 | 106,053 B | 232 ms | 1 | 愛知県名古屋市緑区 | ○ | MultiPolygon | 2,718 |
| 5 | 〃 | OAZ | 200 | 95,455 B | 180 ms | 1 | 愛知県名古屋市緑区鳴海町 | ○ | MultiPolygon | 2,440 |
| 6 | 〃 | **AZC** | 200 | 21,618 B | 352 ms | **88** | 鳴海町相原町ほか5件取得 | **○** | MultiPolygon | 38（先頭件） |
| 7 | 岐阜市司町 | SHK | 200 | 249,996 B | 268 ms | 1 | 岐阜県岐阜市 | ○ | MultiPolygon | 6,456 |
| 8 | 〃 | OAZ | 200 | 3,102 B | 153 ms | 1 | 岐阜県岐阜市司町 | ○ | MultiPolygon | 41 |
| 9 | 〃 | **AZC** | 200 | **53 B** | 89 ms | **0** | —（該当なし） | **—** | — | — |
| 10 | 桑名市中央町 | SHK | 200 | 265,839 B | 346 ms | 1 | 三重県桑名市 | ○ | MultiPolygon | 6,863 |
| 11 | 〃 | OAZ | 200 | 4,835 B | 157 ms | 1 | 三重県桑名市中央町 | ○ | MultiPolygon | 84 |
| 12 | 〃 | **AZC** | 200 | 14,224 B | 352 ms | **5** | 桑名市中央町1丁目ほか | **○** | MultiPolygon | 25（先頭件） |

- **`null` が返ったケースは0件。** #9 は `address_polygon: null` ではなく `{"status":"OK","result":{"info":{"hit":0},"item":[]}}`
  ＝ 検索ヒット0。司町は「丁目」を持たない町名なので、面はOAZレベル（#8）で取る。
  → **「AZCが0件ならOAZにフォールバック」の実装が必要**。
- `hit` は総件数、返却は `limit` 分だけ。鳴海町のAZCは **88件**（大字の下に字が88個）。
- 全12件が **HTTP 200**。エラーレスポンスは1件も出ていない。

## 3. GeoJSON の形（実測）

`item.address_polygon` の中身：

```json
{ "type": "MultiPolygon", "coordinates": [ [ [ [136.90938883463542, 35.166591254340275], ... ] ] ] }
```

| 確認項目 | 実測結果 |
|---|---|
| 型 | **JSONオブジェクト**（`typeof === "object"`）。ドキュメントは「GeoJSON形式の文字列」と読めるが、実際は**パース済みオブジェクト**で返る。`JSON.parse()` は不要 |
| GeoJSON種別 | 全件 **MultiPolygon**（単一の島でも MultiPolygon で返る。Polygon は出現せず） |
| ラップ | `Feature` / `FeatureCollection` ではなく **geometry 単体**。`properties` は無い |
| 座標順 | **`[経度, 緯度]`（GeoJSON標準）**。例 `[136.909…, 35.166…]` は名古屋市中区の正しい値。緯度経度が逆なら経度が35台になるはずで、そうなっていない |
| `crs` メンバ | 無し（`datum=JGD` 指定なので WGS84/JGD2011 相当） |

### Leaflet 描画確認（実測・推測ではない）

[scripts/probe-address-polygon.html](../scripts/probe-address-polygon.html) に **#3の栄3丁目のポリゴンを無加工で埋め込み**、
`L.geoJSON(ADDRESS_POLYGON)` に **座標の入れ替えもFeatureラップもせず**そのまま渡してヘッドレスChromeで描画。

```
layers=1 / bounds=136.90218071831598,35.16242648654514,136.90960367838542,35.16918348524305
<path class="leaflet-interactive" ... d="M545 169L552 284L552 344L555 407L419 390L211 385L221 289 ...">
```

- レイヤ1つが生成され、SVGパスが実際に描画された
- `getBounds()` が経度136.90〜136.91 / 緯度35.162〜35.169 ＝ **栄3丁目の正しい位置**
- → **座標の入れ替えは不要。`L.geoJSON()` にそのまま渡せる。**

## 4. 一括取得のコスト（追加計測2件・`BULK=1`）

「区まるごとの字丁目を一度に取れるか」の実測（`word=愛知県名古屋市緑区&address_level=AZC&limit=0,1000`）：

| address_polygon | status | レイテンシ | 応答サイズ | hit / 取得件数 | 総構成点数 | 1件あたり |
|---|---|---|---|---|---|---|
| `true` | 200 | **21,099 ms** | **1,719,142 B (1.72 MB)** | 423 / 423 | 24,758 | 4,064 B |
| `false` | 200 | 196 ms | 742,268 B | 423 / 423 | — | 1,755 B |

- ポリゴン付与で **レイテンシが約108倍**（0.2秒 → 21秒）。サーバ側のポリゴン生成が重い。
- ポリゴン分の増加は 1件あたり約 2.3 KB。緑区（423字丁目）で約 1 MB。
- **実運用でリクエスト都度この一括取得を叩くのは非現実的。** 事前に取得してFirestore等へ保存するか、
  必要な字丁目だけ都度取得（1件あたり 5 KB / 0.2秒）にするかの二択。

## 5. 追加の契約項番は必要か

- **技術的には現行の `ZENRIN_KEY` のまま追加項番なしで取得できている。**
  判断根拠：12＋2＝14リクエスト全てが **HTTP 200**。権限不足時に出るはずのエラー
  （401/403、あるいはZENRIN側の項番エラー本文）は **1件も観測されなかった**。
- 理屈の上でも `address_polygon` は **既存の `/search/address`（住所検索API）のパラメータ**であり、
  別APIではない。空家MAPは既に `type=reverse` で同APIを利用中。
- **ただし今回は検証環境（`test-web.zmaps-api.com`）での結果**。本番環境（`web.zmaps-api.com`）での
  課金・項番の扱いは技術的な可否とは別問題なので、本契約時に
  「住所検索APIの `address_polygon` 利用を含む」旨をゼンリン側に一言確認しておくのが安全。

## 6. 周回機能への示唆（判断材料。実装はしていない）

- **「エリア＝町丁目」を面として扱うことは技術的に可能。**
- `address_code` が 11桁で階層構造になっている（例：栄3丁目 = `23106011003`）。
  - `23`＝愛知県 / `106`＝名古屋市中区 / `011`＝栄 / `003`＝3丁目
  - **先頭5桁 `23106` は現行の `areaCode`（JIS市区町村コード5桁）と完全一致**する。
    既存のareaCode運用とそのまま接続できる。
- 粒度の実態：緑区だけで字丁目が **423件**。周回の単位としては細かすぎる可能性があるため、
  OAZ（大字）単位との併用を検討する余地あり。
- 落とし穴：
  - AZCが0件の町（岐阜市司町のような丁目なし町名）が実在する → OAZフォールバック必須
  - `word` 検索は部分一致が既定。入力と返却住所の対応チェックを入れないと別の場所を掴む
    （過去に「あいうえお」→五所川原市が返った実績あり）

## 7. 再現手順

```bash
cd akiya-map
# キーはSecret Managerから環境変数で渡す（ファイルに書かない）
ZENRIN_KEY=$(firebase functions:secrets:access ZENRIN_KEY) \
  OUT_DIR=/tmp/probe_out node scripts/probe-address-polygon.js
# 一括取得コストも測る場合（+2リクエスト）
BULK=1 ZENRIN_KEY=$(...) node scripts/probe-address-polygon.js
```

## 8. 実施上の注記

- リクエストは**全て直列**、1件ごとに **300ms 待機**（ゼンリンの指定どおり）。並列は一度も使っていない。
- 実行は2回に分かれた（1回目＝12件、2回目＝BULK追加で14件）ので、**通算では26リクエスト**。
  1回あたりは20件以内に収めているが、通算では上限を超えている。
- Firestore への読み書きは行っていない。`index.html` / `admin.html` / `functions/index.js` は未変更。
- git push はしていない（結果報告のみ）。
