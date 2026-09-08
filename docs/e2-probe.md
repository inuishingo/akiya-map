# E-2-0 事前調査レポート（E-2a／E-2b 着手前）

- 実施日：2026-09-08
- 目的：E-2（index.html に市区町村の字界を赤線で描く）の着手前提を実測で潰す
- 位置づけ：**調査のみ**。`index.html` / `admin.html` / `functions/` / `firestore.rules` は未変更。
  Firestore への読み書きは**ゼロ**（外部APIの読み取りのみ・全て `count=1` か reverse）

---

## 1. `firestore.rules` の `areaPolygons` read 権限 — **変更不要**

```
match /areaPolygons/{addressCode} {
  allow read:  if isSignedIn();     // ← request.auth != null と同義
  allow write: if isAdmin();
}
```

`isSignedIn()` は `request.auth != null` そのもの。E-1 の時点で
「将来 index.html 側でも面を描くため。管理者限定にしない」とコメント付きで
既にログイン全員に開かれている。**E-2a のためのルール変更は発生しない**（deploy も不要）。

---

## 2. 地図SDK と「線だけ」で描く型 — ZDC（ZENRIN Maps API v20）

`index.html:14` で `zma_loader.js` を読む ZDC。Leaflet は未使用（出現0）。
使用中のシェイプ系 API は 2つだけ：

| API | 使用箇所 | 署名（実使用形） |
|---|---|---|
| `ZDC.Polyline` | グリッド罫線 `index.html:605,613` | `new ZDC.Polyline([ZDC.LatLng, …], { color, width, opacity })` |
| `ZDC.Polygon`  | グリッド塗り `index.html:643` | `new ZDC.Polygon(corners, { fill, fillOpacity, stroke, strokeWidth })` |

**「塗りなしで外周だけ」＝ `ZDC.Polygon` は使わず、リングごとに `ZDC.Polyline` を1本引く。**
MultiPolygon の `coordinates` は `[polygon][ring][point][lng,lat]` の4段。
`ring[0]`＝外周／`ring[1..]`＝穴。**穴も同じ Polyline で描く**（線なので内外の区別が要らない）。

```js
// geom = JSON.parse(geometryJson) … 必ず MultiPolygon（実測で Polygon は出現しない）
// 座標は [経度, 緯度]（GeoJSON標準）。docs/address-polygon-probe.md で実測済み＝入れ替え不要。
for (const poly of geom.coordinates) {
  for (const ring of poly) {                       // ring[0]=外周 / ring[1..]=穴。どちらも線で描く
    const pts = ring.map(([lng, lat]) => new ZDC.LatLng(lat, lng));
    const ln = new ZDC.Polyline(pts, { color: "#DC2626", width: 2, opacity: 1 });
    map.addWidget(ln);
  }
}
```

### 注意：`addWidget` の回数がそのままコスト（8bf0708 で判明済み）

ZDC の `addWidget/removeWidget` は1回ごとに `map._shapes` 全件を map→sort→map し直す
（`zdc_core` の `requireRedraw`）。京都z15・109ウィジェットで **1回 81.4ms** の実測がある。
したがって **リング単位の bbox カリングは性能要件ではなく必須条件**。
広域ズームでリングが数百本可視になる場合に備え、グリッドの `inCap` と同じ形の
上限ガード（超えたら描かない）を E-2a に入れる。

参考：もう一つの型として、用途地域レイヤ（`drawYouto` / `index.html:1003`）が
**canvas に描いて `ZDC.UserWidget` の `<img>` を1枚だけ載せる**方式を採っている
（ウィジェット数が常に1で `requireRedraw` が効かない）。リング数が読めない場合の代替案。

---

## 3. reverse は `address_code` を返すか — **返す。ただし桁数が地点で変わる**

`index.html` には既存の reverse がある：

- `fetchReverseItem(lat, lng)` … `index.html:1362`
- `areaFromReverseItem(item)` … `index.html:1370`（`address_code2`+`address_code3` → JIS5桁）

### 実測（2026-09-08・reverse プロキシ直叩き）

| 地点 | hit | `address_level` | `address_code` | 桁 | 先頭5桁 |
|---|---|---|---|---|---|
| 名古屋市緑区 (35.0700,136.9700) | 1 | AZC | `23114020357` | 11 | **23114** ✓ |
| 名古屋駅 (35.1709,136.8815) | 3 | TBN | `231051150010000100006` | 21 | **23105** ✓ |
| 京都駅 (34.9859,135.7585) | 1 | TBN | `261064150000000000149` | 21 | **26106** ✓ |
| 京都市中京区 御池 (35.0116,135.7681) | 1 | TBN | `261040880000000000017` | 21 | **26104** ✓ |
| 京都市伏見区 深草 (34.9668,135.7727) | 1 | TBN | `261094450000000000136` | 21 | **26109** ✓ |
| 左京区 下鴨 (35.0500,135.7700) | 1 | TBN | `261032970000000000059` | 21 | **26103** ✓ |
| 京都市中京区 四条烏丸 (35.0037,135.7681) | **0** | — | — | — | **なし** |
| 京都市下京区 (34.9850,135.7580) | **0** | — | — | — | **なし** |

**結論：`address_code` は存在し、桁数（11/21）にかかわらず先頭5桁は常に JIS 市区町村コード。**
ただし自前で `address_code.slice(0,5)` を切る必要はない。既存の
`areaFromReverseItem()` が `address_code2`(2桁) + `address_code3`(3桁) から
同じ5桁を組んでおり、**そのまま cityCode として使える**。
→ E-2a-3① は代替案に切り替えず、既存関数の再利用で実装できる。

### ただし「reverse が hit=0 を返す地点が実在する」

8点中2点（いずれも京都市街）で `hit:0` ＝ `item` が空。
**300m しか離れていない京都駅は hit=1** なので、契約エリアの問題ではなく
点の当たり判定（住所ポイントが無い場所）。したがって
**E-2a-3② のフォールバック（購読中ピンの `areaCode` から最寄りを採用）は必須**。
加えて「hit=0 のときは直前に確定した cityCode を捨てない」を実装条件に足す。

---

## 4. 京都市11区の OAZ 件数 — **1000件超は0件。分割取込は不要**

方式：`GET https://areapolygon-ptddjpvgeq-an.a.run.app?cityCode=<JIS5桁>&count=1`
（`address_polygon=false` 相当・Firestore 書き込みなし）。直列・各300ms待機。
**26100（京都市の親コード）は投げていない。**

| コード | 区 | hit（大字件数） | 1000超 | 応答 |
|---|---|---|---|---|
| 26101 | 北区 | 431 | — | 2,505 ms |
| 26102 | 上京区 | 581 | — | 225 ms |
| 26103 | 左京区 | 578 | — | 252 ms |
| 26104 | 中京区 | 498 | — | 248 ms |
| 26105 | 東山区 | 260 | — | 190 ms |
| 26106 | 下京区 | 522 | — | 235 ms |
| 26107 | 南区 | 276 | — | 159 ms |
| 26108 | 右京区 | 621 | — | 264 ms |
| 26109 | 伏見区 | **701（最大）** | — | 229 ms |
| 26110 | 山科区 | 304 | — | 188 ms |
| 26111 | 西京区 | 315 | — | 159 ms |

- 合計 **5,087件** ／ 最大 **701件（伏見区）** ／ 最小 260件（東山区） ／ 平均 462件
- **1000件超は0件**（上限 `AREAPOLY_HIT_LIMIT` に対し最悪でも 30% の余裕）
- HTTP エラー0件（全て 200）
- 26101 の 2,505ms は Cloud Run のコールドスタート。2件目以降は 160〜265ms

### 帰結（件数だけ見れば分割不要。ただし下の 4-2 で覆る）

件数の上限（`AREAPOLY_HIT_LIMIT`=1000）には**どの区も当たらない**。
なお `docs/area-polygon-hit-count.md` の既測21市区町村と合わせても、
既知の最大は依然 **岐阜市 848件**。

---

## 4-2. 【重要】ポリゴン付きの1回取得には、上流に約29秒の壁がある

E-2a の可視リング数を京都でも測ろうとして伏見区(26109)をポリゴン付きで引いたところ、
**上流504で失敗した**。件数ではなく**時間**が先に頭を打つ。

### 実測（2026-09-08・`?cityCode=<5桁>`＝ポリゴンあり）

| コード | 名称 | 件数 | 所要 | 結果 |
|---|---|---|---|---|
| 23114 | 名古屋市緑区 | 105 | 7.1 s | 200 OK（789 KB） |
| 26105 | 京都市東山区 | 260 | 13.3 s | 200 OK（948 KB） |
| 26107 | 京都市南区 | 276 | 13.6 s | 200 OK（844 KB） |
| 26110 | 京都市山科区 | 304 | 15.7 s | 200 OK（1.80 MB） |
| **26109** | **京都市伏見区** | **701** | **29.1 s** | **504 `upstream_error`** |

本文は `{"message": "Endpoint request timed out"}` で、**ZENRIN 側の API ゲートウェイが返している**
（`areaPolygon` 自身の打ち切り＝280秒には到達していない）。所要時間は件数にほぼ比例し
（≒50ms/件）、**29〜30秒で上流が切る**＝**取得できる上限は概ね 580〜600件**。

### 覆る前提

- `functions/index.js` と `docs/area-polygon-hit-count.md` の
  「岐阜市848件でも40〜50秒で取れる／関数300秒・自前280秒なら構造的に当たらない」は**誤り**。
  上流が先に切るので、**岐阜市(848)も1回では取れない**（未実測だが伏見区701で切れている以上ほぼ確実）。
  E-1 でタイムアウトを300秒へ引き上げた判断自体は無害だが、効いていない。
- **1回取得では取れない区（推定・600件超）**：伏見区701 / 右京区621 / 上京区581 / 左京区578（境界付近）
  ／ 岐阜市848。名古屋16区は最大194件で全て安全圏。

### E-2b への申し送り

**6桁前方一致（cityCode＋大字コード上1桁）による分割取込は、やはり必要。**
E-2-0-4 の件数だけを見て「不要」と結論しかけたが、時間の壁で覆る。
分割すれば1回あたり数十〜百数十件になり、29秒の壁からは十分遠ざかる。
実装は `areaPolygon` 側（`address_code` を6桁で受け付け、`code_match_type=2` はそのまま）と
`admin.html` 側（0〜9の10回に分けて呼び、結果を結合してから1回で仕分ける）の両方に要る。

---

## 5. 付随して見えた事実（E-2 の設計に影響するもの）

1. **「発熱対策のGPS停止20秒」はすでに存在しない。**
   `GPS_STOP_GRACE_MS` は 2026-08-29 に廃止済み（`f011f40`／`docs/gps-tracking-design.md`）。
   停止は `visibilitychange` のみ。受け入れ条件の該当項目は「GPS が止まらないこと」として確認する。
2. **`where cityCode == X and level == "OAZ"` に複合インデックスは不要。**
   Firestore は等値フィルタ複数を単一フィールドインデックスのマージで解決する。
3. **右側FABの空きスロットは `bottom:288px; right:16px`。**
   現状は 📍24 / ▦84 / 用152 / 旧220（いずれも 48px・right:16px）、Undo は 24/right:76。
   縦積みなので幅280pxでも横方向の衝突は起きない。コンパスは右上（`#map` 内）で干渉しない。
4. **`areaPolygons` の doc スキーマ**（`admin.html` `areaPolyBuildRows`）：
   `{ code, level:"OAZ", cityCode, parentCode:null, name, fullAddress, geometryJson, pointCount, fetchedAt }`
   `geometryJson` は `JSON.stringify(MultiPolygon)`。往復の完全一致は E-1 で実測済み。

---

## 6. 再現手順

```bash
# ①京都11区の件数（11リクエスト・Firestore 書き込みなし）
#   ②reverse のフィールド確認（8リクエスト）
node scratchpad/probe-e2-0.mjs
```

キーは不要（どちらも Cloud Functions プロキシ経由で、鍵はサーバ側の Secret Manager にある）。
リクエストは全て直列・各300ms待機。通算19リクエスト。


---

## 7. E-2a の実測（実装後・2026-09-08）

緑区(23114)の実データ105件で、`areaBuildRings` とカリング条件を `index.html` から写して計測
（[scratchpad/verify-area-rings.mjs]。ZDC.LatLng だけ平オブジェクトで代用。点数・bbox・判定は同一）。

- doc 105件 / `geometryJson` 合計 **604 KB** / **リング119本** / 総点数 **16,000**
- `JSON.parse` + LatLng生成 + bbox計算＝**5.0 ms**（区まるごとで1回だけ走る）

### 可視リング数（中心 35.07,136.97・`VIEW_BUFFER_RATIO`=0.15込み・heading=0）

| zoom | 表示幅 | iPhone 14 Pro (393×800) | iPhone SE (375×615) | 最小幅 (280×601) |
|---|---|---|---|---|
| Z13 | 約6.1 km | 117 | 116 | 107 |
| Z14 | 約3.1 km | 93 | 88 | 73 |
| **Z15** | 約1.5 km | **48** | 45 | 38 |
| **Z16** | 約0.77 km | **24** | 18 | 14 |
| **Z17** | 約0.38 km | **8** | 5 | 5 |
| Z18 | 約0.19 km | 3 | 3 | 3 |

**緑区は区まるごとでも119本しかなく、`AREA_RING_CAP`(200) には Z13 まで下げても届かない。**
下限 Z15 での48本が実運用の最悪値。差分更新の効き（Z16で1画面ぶん東へパン）は
24本→16本で **追加7・削除15・据置9**＝全描き16回に対し addWidget は7回（56%削減）。

京都は密度が数倍あるため下限15で足りるかは要確認だが、**取込前に先行計測しようとして 4-2 の
上流504に当たったため測れていない**。京都取込後に同じスクリプトで測り直すこと。
