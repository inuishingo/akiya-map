# scripts/ — areaCode 移行ツール（実行済み・記録用）

市区町村の判定を「住所文字列の正規表現抽出」から **JIS5桁コード（ZENRIN reverse 由来）** へ移行した際の
一回限りのバックフィル移行ツール。**アプリ（index.html / admin.html）からは読み込まない。**

## 背景
旧 `areaKey`（正規表現 `(.+?市市?)` 等）は、市名の内部に市/町/村を含む自治体で誤爆した：
- 四日市市（住所欠落）→「四日市」／小牧市市之久田 →「小牧市市」

恒久対応として `pins` に以下を保存する方式へ変更：
- `areaCode` : JIS5桁市区町村コード（総務省コード先頭5桁＝reverse の `address_code2 + address_code3`）
- `areaName` : 市区町村名（政令市は「名古屋市東区」形式・郡名なし）

新規ピンは index.html が ZENRIN reverse から `areaCode/areaName` を直接取得して保存する。
**マスタもこのスクリプトも新規登録には不要**（本ツールは既存データのバックフィル専用）。

## ファイル
- `muni_master.json` — 総務省 全国地方公共団体コード（localgovjp 由来・1916件）。`{code, name, pref}`。
- `backfill_areacode.py` — 既存 pins の住所から areaCode/areaName を判定して updateMask で追記（非破壊）。

## 判定ロジック（Step3 整合性ゲートで reverse と全一致を確認済み）
1. 都道府県で絞ってから市区町村名の最長前方一致（港区の東京/名古屋衝突や同名市の誤爆を防止）
2. 郡（例「三重郡菰野町」）は除去
3. 都道府県が住所に無い場合は「全国で一意な市名のみ」復元、曖昧なら null（推測しない）
4. 判定不能は `areaCode=null` として隔離（書き込まない・削除も改変もしない）

## 実行方法（認証はトークンをコードに埋めない）
`FIREBASE_REFRESH_TOKEN` に Google OAuth refresh token を設定して実行する。
```
FIREBASE_REFRESH_TOKEN=xxxx python backfill_areacode.py --dry-run   # 対応表のみ（書き込みなし）
FIREBASE_REFRESH_TOKEN=xxxx python backfill_areacode.py --commit    # 本実行
```
※ refresh token は秘匿情報。ファイルに書かない／commit しない。

## 実行記録
- 2026-07-13 実行：全2542件中 **2495件に areaCode/areaName 付与・47件は未判定(null)として隔離**。
- 旧 `areaKey` フィールドはロールバック用に残置（削除しない）。
