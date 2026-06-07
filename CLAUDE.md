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
chiban              // 地番 (lot number) — auto-fetched on tap in index.html (ZENRIN bm, nearest by distance); also editable via admin.html inline edit
```

`createdAt` being an ISO string matters: admin filtering/sorting relies on string operations (`createdAt.slice(0,10)` for the date, `orderBy("createdAt", "desc")` for sort). Keep it as an ISO string for new writes.

### STATUS taxonomy (shared, keep in sync across pages)

Seven keys, each with a Japanese label and a color. The same set is redefined independently in `index.html`, `admin.html`, and must stay consistent:

`tochi`(土地/green) · `tatemono`(建物/red) · `rentou`(連棟/orange) · `shintiku`(新築/gray) · `souko`(倉庫/yellow) · `shueki`(収益/purple) · `hansha`(反社/black)

Markers display the first character of the label (`s.label[0]`) on a colored pin.

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
