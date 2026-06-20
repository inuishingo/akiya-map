# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A mobile-first web app for field surveying of vacant houses (空家マップ) in Japan, used by a real-estate company ("HOUSE MARKET"). Field staff drop status-coded pins on a map during on-site visits; an admin dashboard reviews, edits, filters, and exports the collected data.

## プロジェクトの背景・運用方針

- **拠点展開とSaaS化**: 名古屋店発のシステム。将来は京都・大阪・神戸を加えた**4拠点展開**、さらに**SaaS化**を見据えている。現状ハードコードされている `branch: "名古屋"` や単一の `pins` コレクション設計は、いずれ複数拠点・複数テナントを前提とした構造へ拡張する必要がある点を意識すること。
- **ZENRIN Maps API の本契約移行中**: 現在ソース内で使っているのは**検証環境**のキー（`test-js.zmaps-api.com` / `test-web.zmaps-api.com`）。**本契約申請**へ移行中で、本番では**地番検索・住宅地図・用途地域**の利用を想定している。エンドポイントとキーは本番移行時に差し替わる前提で扱う。
- **逆ジオコーディングのプロキシ**: `index.html` が叩く Cloud Run プロキシ（`zenrin-ptddjpvgeq-an.a.run.app`）は **Firebase Functions 経由**で運用している。このリポジトリには含まれない別管理のコードである。
- **コード提示の形式**: ユーザーはコード編集を**メモ帳や GitHub の Edit 画面での全文差し替え**で反映することを好む。変更を提示する際は差分パッチ（一部のみ）ではなく、**ファイル全文（置換後の完成形）**で提示すること。

## Architecture

There is **no build system, no framework, no package manager, and no test suite**. Each page is a single self-contained `.html` file with all JavaScript (ES modules, loaded inline) and CSS embedded. Dependencies are loaded from CDNs at runtime:

- **ZENRIN Maps JavaScript API** (`zma_loader.js`) — the map engine. The global is `ZMALoader`; map primitives live under the `ZDC.*` namespace (`ZDC.Map`, `ZDC.LatLng`, `ZDC.Marker`, `ZDC.ZoomButton`, `ZDC.ScaleBar`). Maps are created via `ZMALoader.setOnLoad(cb)`, which is the mandatory entry point before any `ZDC` use. **Note: the API key in the source is a ZENRIN _test_ environment key** (`test-js.zmaps-api.com`), referer-authenticated.
- **Firebase v10.12.0** (modular SDK, imported directly from `gstatic.com`) — Auth (email/password) and Firestore. Project: `housemarket-map`. The `firebaseConfig` block is duplicated in each app page.

### Pages

- `index.html` — **field-survey app** (the main pin-dropping PWA-style mobile UI). Tap the map → modal → save a pin to Firestore. Loads **only the current user's own pins** (`where("uid", "==", currentUser.uid)`).
- `admin.html` — **admin dashboard** (desktop, two-column grid: pin list + map). Subscribes to **all** pins in realtime via `onSnapshot`, with status/staff/date filters, inline editing, bulk delete, and CSV export.
- `zenrin_test.html` — standalone scratchpad for testing the ZENRIN Web API address lookup (`test-web.zmaps-api.com/search/address`). Not part of the app.
- `zenrin_js_test.html` — currently a byte-for-byte **duplicate of `index.html`** (despite its name). Treat `index.html` as the source of truth; this file is stale.

### Firestore data model

Single collection: **`pins`**. Documents are written by `index.html` with these fields:

```
uid, email          // owner (Firebase auth user)
lat, lng            // ZENRIN map coordinates
address             // reverse-geocoded string
status              // one of the STATUS keys below
memo                // free text
branch              // hardcoded "名古屋" (Nagoya)
createdAt           // new Date().toISOString()  — a STRING, not a Firestore timestamp
chiban              // 地番 (lot number) — auto-fetched on tap in index.html (reverse=親番 + bm=枝番補完); editable in BOTH index.html (pin modal input) and admin.html (inline edit)
chibanManual        // boolean — true when chiban was hand-edited. Manual edits WIN: any future auto re-fetch/re-process MUST NOT overwrite chiban when chibanManual===true
needsReview         // boolean — flags ambiguous auto-results for clerk review (連棟/残地併存 等). Cleared (set false) on manual chiban edit. ※auto-flagging logic is a later phase; only the clear-on-edit side is implemented now
reviewReason        // string — short JP label for why needsReview was set; removed (deleteField) on manual chiban edit
```

**地番の手修正は最優先**: 地番は現場(index.html のピンモーダル)・事務所(admin.html のインライン)どちらでも編集可。手修正すると `chibanManual:true` が立ち、`needsReview` 解除＋`reviewReason` 削除。`chibanManual===true` の doc は、今後の自動再取得・再処理で**自動値で上書きしてはならない**（コードで必ずガードする）。

`createdAt` being an ISO string matters: admin filtering/sorting relies on string operations (`createdAt.slice(0,10)` for the date, `orderBy("createdAt", "desc")` for sort). Keep it as an ISO string for new writes.

### STATUS taxonomy (shared, keep in sync across pages)

**12 keys in 3 groups**, each with a Japanese label and a color. `STATUS` and `STATUS_GROUPS` are redefined independently in `index.html` and `admin.html` and MUST stay consistent (same keys/labels/colors/order):

- **建物系 (building)**: `akiya`(空家/#3B82F6) · `chikuko`(築古/#6366F1) · `haikyo`(廃墟/#A855F7) · `renpei`(連棟/#8B5CF6) · `shueki`(収益/#0EA5E9) · `souko`(倉庫/#64748B)
- **土地系 (land)**: `sarachi`(更地/#10B981) · `zasshu`(雑種地/#84CC16) · `parking`(駐車場/#14B8A6) · `tahata`(田・畑/#65A30D)
- **NG系 (ng)**: `hansha`(反社/#1F2937) · `ng`(NG/#6B7280)

`STATUS_GROUPS` drives the grouped pin-picker (index.html modal), the grouped filter dropdown + group subtotals (admin.html), nothing flat. Markers show the first character of the label (`s.label[0]`) on a colored pin.

**Undefined-status guard (required)**: old/unknown `status` values must not break the UI. Marker color falls back to `FALLBACK_COLOR` (#9CA3AF) with text `?`; admin badge shows the raw value; legacy keys appear only under the "すべて" filter and are kept (non-destructive) in the per-card status `<select>`. The pre-2026-06 keys (`tochi/tatemono/rentou/shintiku/souko/shueki/hansha`) are retired — note `souko/shueki/hansha` are REUSED keys with new colors, and old `souko/shueki/hansha` pins were test data (no migration).

### Reverse geocoding

`index.html` does not call ZENRIN directly for addresses — it hits a **Cloud Run proxy**: `https://zenrin-ptddjpvgeq-an.a.run.app?type=reverse&lat=..&lon=..`, reading `json.result.item[0].address`. The same proxy also serves **地番検索** via `?type=bm&lat=..&lon=..`, returning `result.item[]` where each candidate has `address`, `address_detail2` (親番/parent lot), `address_branch2` (枝番/branch, may be null), and `distance`. This proxy is external to this repo.

**地番取得ロジック (`fetchChiban()`)**: 親番は **reverse を主ソース**にする（`address_level==="TBN"` のときの `address_detail2`）。bm の `distance` 最小だと**区画境界でひとつ隣の地番を拾う**（reverse は point-in-polygon で正しく当てる）ため。枝番は reverse が返さないので **bm の候補から親番一致のものを探して補完**し、`親番-枝番` の形に結合する。数値は ZENRIN が**全角**で返すので `normalize("NFKC")` で半角化してから保存する。

**【次フェーズ課題】bm 候補のキャップ**: bm は `info.hit` が多くても `item[]` を**上位5件にキャップ**して返す（`count` パラメータは無効）。このため親番が5件圏外だと枝番が補完できず**親番止まり**になる（例: `23-2` → `23`）。枝番まで確実に取るには**プロキシ側（別リポジトリ）で件数上限の緩和**が必要。`type=bm` の `address`/`address_detail2`/`address_branch2` 等は ZENRIN が Shift-JIS の全角で返すが、現状プロキシは正しい UTF-8 全角で返せている（取り違えは無し。NFKC 正規化はアプリ側で実施済み）。

### Offline support (index.html only)

Writes fall back to a `localStorage` queue (`offlineQueue`) when `navigator.onLine` is false or `addDoc` throws; the queue is flushed by `syncOfflineQueue()` on the `online` event and at login. Edits and deletes are **not** queued — they require connectivity.

## Conventions

- UI strings, comments, labels, and toasts are in **Japanese**. Match this when editing.
- Functions invoked from inline `onclick=` handlers are attached to `window.*` (e.g. `window.savePin`, `window.setFilter`). New handler-called functions must be assigned to `window` or they won't be reachable from the HTML.
- State is plain module-level `let` variables (`map`, `markers`, `allPins`, etc.) — no reactive framework. After mutating data you must manually call the relevant re-render (`renderList()`, `renderMapMarkers()`, `loadMyPins()`).

## Running & deploying

No commands to build or run. Open the `.html` files directly in a browser, or serve the folder statically (e.g. `python -m http.server`) — a server is preferable so ZENRIN referer-auth and Firebase auth behave. Geolocation and the camera/StreetView links need HTTPS or `localhost`.

Deployment is via the GitHub repo `inuishingo/akiya-map` (static hosting). Commits to `main` are the unit of change; there is no CI.

## 【未実装・要件メモ】グリッド アーカイブ機能

目的：1年サイクルの再調査時に、過去の調査済みグリッドをエリア単位/日付単位で一斉に「現役表示から外す」。ただし調査履歴はデータとして残す（復元可能）。

設計方針：
- survey_grids に status フィールド追加：active（表示）/ archived（非表示・記録保持）
- 「解除」は削除ではなく active→archived への変更
- 地図の青塗りは status=active のマスのみ

機能：
A. 範囲アーカイブ（管理画面）：範囲選択モード→矩形ドラッグ→中のactiveマスを選択→「N件をアーカイブしますか？」確認ダイアログ（件数表示）→OKで一括archived化
B. 日付アーカイブ（管理画面）：「指定日以前に調査したマスをアーカイブ」→該当件数表示→確認→一括archived化
C. 復元（保険）：アーカイブ済みを見る履歴表示モード→個別/範囲で archived→active に戻せる

注意：
- 一括操作は必ず件数表示＋確認ダイアログ（誤操作防止）
- status未設定の既存マスはactive扱いで後方互換（フィールド無し＝active と解釈。これをやらないと既存の塗りが全部消えて見える事故になる）
- 別ブランチ（feature/grid-archive）で実装、グリッド本体の本番安定を確認後に着手
