# ローカル開発ガイド（Firebase エミュレータ／ルールのデプロイ）

- 作成日：2026-08-29
- 目的：**本番にデプロイする前に、手元で検証を終わらせられるようにする**
- 対象：`admin.html`（管理画面）と `functions/`（Cloud Functions）と `firestore.rules`

これまでは「乾がデプロイ → Claude Code が動作確認 → 直す → また乾がデプロイ」の往復が必要だった。
エミュレータを使うと、本番に一切触れずに同じ検証が回せる。

> **`index.html`（現場アプリ）は対象外。** こちらは localhost で開いても**本番の Firestore に繋がる**。
> エミュレータ分岐を入れたのは `admin.html` だけ。現場アプリを触るときは本番データだと思って扱うこと。

---

## 0. 一度きりの準備

### 0-1. JDK（Firestore エミュレータが Java 製のため必須）

```powershell
winget install EclipseAdoptium.Temurin.21.JDK
```

インストール後は **PowerShell を開き直す**（PATH が反映されないため）。確認：

```powershell
java -version
```

> 実績：`openjdk version "21.0.12.1" 2026-08-18 LTS` で動作確認済み。

### 0-2. Firebase CLI にログイン

```powershell
firebase login:list
```

`Logged in as housemarket.gcp@gmail.com` と出れば OK。出なければ `firebase login`。

**このログインが ZENRIN_KEY の解決にも使われる**（後述）。

### 0-3. Firestore エミュレータ本体のダウンロード（初回のみ・自動でも走る）

```powershell
firebase setup:emulators:firestore
```

### 0-4. gcloud CLI（`npm run deploy:rules` を使う場合のみ）

```powershell
winget install Google.CloudSDK
```

PowerShell を開き直してから、**housemarket-map にアクセスできるアカウント**で認証する：

```powershell
gcloud auth login
```

> サービスアカウント鍵は作らない。ユーザー認証だけで足りる。
> 認証しなくても `--from-file`（後述）で差分確認はできる。

---

## 1. 起動する

ターミナルを **2枚** 開く。どちらも作業ディレクトリは `akiya-map`。

```powershell
cd "C:\Users\user\Documents\ZENSIN Digitals\akiya-map"
```

### ターミナル①：エミュレータ

```powershell
npm run emu
```

`✔ All emulators ready!` が出れば成功。使うポートは以下（`localhost:8000` とは衝突しない）。

| 用途 | Host:Port | 備考 |
|---|---|---|
| Functions | `127.0.0.1:5001` | `areaPolygon` / `zenrin` / `youto` |
| Firestore | `127.0.0.1:8080` | データはプロセス終了で消える |
| Emulator UI | `127.0.0.1:4000` | ブラウザでデータを直接見る・編集する |
| Hub / 予約 | 4400 / 4500 / 9150 | 触らない |

### ターミナル②：静的サーバ

```powershell
python -m http.server 8000
```

→ ブラウザで **http://localhost:8000/admin.html**

---

## 2. エミュレータに繋がっていることの確認

画面の一番上に**橙色の縞のバー**が出る：

```
🧪 エミュレータ接続中（Firestore :8080 / Functions :5001）— 本番データではありません
```

ブラウザのタブ名も `🧪[EMU] 空家マップ｜管理画面` になる（タブを何枚も開いたときの取り違え防止）。

**このバーが出ていなければ本番 Firestore に繋がっている。** 書き込み操作をしないこと。

### 切り替え条件（安全装置）

切り替えは `location.hostname` が `localhost` / `127.0.0.1` のときだけ。
URLパラメータ・localStorage 等、**本番URLでも成立しうる条件は一切見ていない**。
本番は `https://inuishingo.github.io/...` で配信されるので、この分岐は構造的に発火しない。

この性質は自動検証できる（ホスト名を偽装した12ケース）：

```powershell
node scripts/verify-emu-guard.mjs admin.html
```

> エミュレータに向くのは **Firestore と `areaPolygon` だけ**。
> **Auth は本番のまま**（＝いつもの実アカウントでログインする）。
> `zenrin` / `youto` も本番のまま（既にデプロイ済みで動いており、localhost は CORS 許可済み）。

---

## 3. 管理者としてログインできるようにする（初回＆エミュレータ再起動のたび）

エミュレータの Firestore は**空**なので、そのままログインすると
`admins/{uid}` が無い＝管理者と判定されず `index.html` に飛ばされる。

1. 一度 http://localhost:8000/admin.html でログインを試す（`index.html` に飛ばされてよい）
2. ブラウザの DevTools コンソールで自分の uid を出す

   ```js
   // Firebase の内部状態から拾う。admin.html を開いた状態で実行
   JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith("firebase:authUser"))[1]).uid
   ```

3. **Emulator UI**（http://127.0.0.1:4000/firestore）で
   - コレクション `admins` を作成
   - ドキュメントID＝**手順2の uid**
   - フィールドは何でもよい（例：`note` = `emulator seed`）

   > Emulator UI からの書き込みは `firestore.rules` を迂回するので、
   > `allow write: if false` の `admins` にも入れられる。

4. `admin.html` を再読み込み → 管理画面が開き、`🗾 行政界取込` ボタンが出る

`displayNames` が空でも動く（自店は「名古屋」にフォールバックする）。
京都アカウントの挙動を見たいときは `displayNames/{メール}` に `branch` を入れる。

---

## 4. E-1（行政界ポリゴン取込）を検証する

### 4-1. 自動検証（推奨・ログイン不要）

エミュレータを起動した状態で：

```powershell
node scripts/verify-e1-emulator.mjs
```

通しで以下を確認する。**書き込み先は 127.0.0.1 のエミュレータのみ**で、本番には触れない。

1. Functions エミュレータの `areaPolygon` が緑区(23114)を **105件** 取れる
2. `admin.html` の E-1 純ロジック（ソースから抜き出して実行）が rows / batches を作れる
3. `firestore.rules` の下で管理者が `areaPolygons` に書ける
4. **2回実行しても doc が増えず、`fetchedAt` だけ更新される**（本題）
5. 非管理者は書けない（403）／ログイン済みなら読める

実測（2026-08-29）：`hit=105 / bytes=788,748 / 取得5.3秒 / batches=1` で全項目合格。

### 4-2. 画面から手で確認する

1. `🗾 行政界取込` → 市区町村に **名古屋市緑区(23114)** を選ぶ
2. 「① 件数を確認」→ **105件・約0.59MB** と出る
3. 「② 取込を実行」→ 105件 書き込み
4. もう一度 ①→② → **doc は105件のまま**、`fetchedAt` だけ更新
5. Emulator UI（http://127.0.0.1:4000/firestore）で `areaPolygons` の中身と `geometryJson` を見る

### 4-3. デプロイ後に「本番相手」で確認する

`admin.html` は localhost で開くと**必ず**エミュレータに繋がる（hostname 判定・本番で発火させない
ための仕様）。この判定に「本番URLでも成立しうる条件」を足すのは禁止しているので、
本番相手に確認したいときは**判定式を `false` に固定したコピーを1枚作る**。

```powershell
npm run prod-preview
```

→ `admin.prod.html` が生成される（`.gitignore` 済み）。
出荷物との違いは `IS_EMULATOR` の**1行だけ**で、それをスクリプトが毎回検証する。

```
http://localhost:8000/admin.prod.html
```

- **橙色のバーが出ない** ＝ 本番に繋がっている、という約束にしている
- `localhost:8000` のまま開くので、ZENRIN の referer 認証も Firebase の設定も従来どおり
- 相対リンク（`index.html`）を壊さないよう、リポジトリ直下に生成している

> ★このコピーは**本番の Firestore を読み書きします**。確認が終わったら削除すること。
> 常用しないこと（常用すると「バナーが出ない＝本番」の約束が形骸化する）。

---

## 5. ZENRIN_KEY はどこから来るか（★ファイルに書かない）

`functions/index.js` は `defineSecret("ZENRIN_KEY")` を使っている。
**エミュレータは、`firebase login` した認証情報で Secret Manager から実物を取ってくる。**
起動ログに出るのがその証拠：

```
i  functions: Trying to access secret ZENRIN_KEY@latest
```

つまり **`.env` も `.env.local` も作らなくてよい**。鍵はディスク上のどこにも増えない。

うまくいかない場合（`upstream_error` や 401 が返るとき）：

- `firebase login:list` で、Secret Manager にアクセスできるアカウントか確認する
- どうしても解決できないときだけ、**そのシェルの中だけ**に環境変数を置く：

  ```powershell
  $env:ZENRIN_KEY = (firebase functions:secrets:access ZENRIN_KEY --project housemarket-map).Trim()
  npm run emu
  ```

  ターミナルを閉じれば消える。**この値をファイルに貼らないこと。**

---

## 6. Firestore ルールのデプロイ（`npm run deploy:rules`）

コンソールを目視で見比べる作業を機械化したもの。

### 6-1. まず差分だけ見る（デプロイしない）

```powershell
npm run deploy:rules -- --dry-run
```

出力は3段になっている。

**① 行差分**

- **緑の `+`** … repo にあって本番に無い行。これがデプロイで反映される
- **赤の `-`** … 本番にあって repo に無い行。**コンソールで直接編集された疑い**

**② デプロイすると本番の権限はこう変わる**

行差分はコメントも含むので読みづらい。判断に必要なのは権限の変化なので、
`match` パス単位で `allow` 文だけを突き合わせた要約も出す。

```
  [新規] /areaPolygons/{addressCode}
      + allow read: if isSignedIn()
      + allow write: if isAdmin()

  既存パス 7件は変更なし / 新規 1 / 削除 0 / 変更 0 / ヘルパー関数 変更なし
```

`[削除]` と `[変更]`、それに `ヘルパー関数 変更あり` は**現場の権限が動く**という意味なので、
必ず中身を読むこと（`isSignedIn` / `isAdmin` は全パスの判定に波及する）。

**③ 安全装置**

### 6-2. 安全装置と `--accept-prod-lines`

赤い `-` が1行でもあると、**デプロイせずに終了する（終了コード 2）**。
バックアップも取らないし `firebase deploy` も呼ばない。

このとき、**本番ルールが `firestore.rules` の過去コミットのどれかと一致するかを自動照合する**。
これが「コンソールで手編集されたのか、単にデプロイが遅れているだけなのか」の判定になる。

**照合OK（＝手編集ではない）** の場合は、一致したコミットと、それ以降の未デプロイコミットを出す：

```
  照合OK 本番ルールは repo のコミットと完全一致しました。
         e55debb  2026-07-27 12:14  管理画面: 公図取得済みマーク(kouzu_marks)を追加…
  → コンソールでの手編集ではありません。デプロイが遅れているだけです。

  そのコミット以降に firestore.rules を変更した未デプロイのコミット（1件）:
         c991a92  2026-08-14 14:39  chore(round): C-2着手前の火種除去 …
```

②の権限変化を読んで問題なければ、明示承認を付けて再実行する：

```powershell
npm run deploy:rules -- --accept-prod-lines
```

**照合NG** の場合は、本番が repo のどのコミットとも一致しない＝本当にコンソールで編集された
可能性が高い。この場合は **`--accept-prod-lines` を付けても進まない**。
対処は「本番側の内容を `firestore.rules` に取り込む」。意図した削除の場合も、
**まず repo を本番に合わせ、次に削除をコミットする**の2段階にする（削除の意図が git 履歴に残る）。
それでも上書きしたいときは `firebase deploy` を直接実行すること（＝意識的な操作にする）。

> `--from-file` のときは本番の実物ではないので照合しない（＝安全装置は解除できない）。

### 6-3. デプロイする

```powershell
npm run deploy:rules
```

処理順：本番取得 → 差分表示 → 安全装置 → `firestore.rules.YYYYMMDD.bak` にバックアップ →
`firebase deploy --only firestore:rules --project housemarket-map` → **本番を再取得して一致確認**。

### 6-4. gcloud を使わずに差分だけ見る

コンソール（https://console.firebase.google.com/project/housemarket-map/firestore/rules）の
本文をコピーしてファイルに保存し、

```powershell
npm run deploy:rules -- --dry-run --from-file .\prod-rules.txt
```

（`--from-file` はトークン不要。ただしデプロイ後の自動確認はできない）

### 6-5. Cloud Functions のデプロイはスクリプト化していない

`--only functions` は**ローカルに無い関数を削除する**（2026-07-14 に `zenrin` を消した事故）。
関数名を人が意識して名指しする余地を残すため、意図的に自動化していない。

```powershell
firebase deploy --only functions:areaPolygon
```

---

## 7. よくあるつまずき

| 症状 | 原因と対処 |
|---|---|
| `npm run emu` が Java で落ちる | JDK 未インストール、または PowerShell を開き直していない（0-1） |
| 橙色のバーが出ない | `127.0.0.1:8000` や `localhost:8000` 以外で開いている。**本番に繋がっているので書き込まない** |
| ログインすると `index.html` に飛ばされる | エミュレータに `admins/{uid}` が無い（手順3）。エミュレータを再起動すると消えるので都度必要 |
| `areaPolygon` が `upstream_error` | ZENRIN_KEY を解決できていない（手順5） |
| ポートが使用中 | `firebase.json` の `emulators` を直す。**直したら `admin.html` の `EMU_FIRESTORE_PORT` / `EMU_FUNCTIONS_PORT` も合わせる** |
| エミュレータのデータが消えた | 仕様（永続化していない）。`verify-e1-emulator.mjs` は毎回まっさらにしてから走る |
| `deploy:rules` がトークン無しと言う | `gcloud auth login`（0-4）、または `--from-file`（6-4） |

---

## 8. やらないこと

- `index.html` にエミュレータ分岐を足さない（現場アプリは常に本番）
- 切り替え条件に hostname 以外を足さない（URLパラメータ・localStorage 等）
- 鍵・トークンをリポジトリ内のファイルに書かない
- `firebase deploy`（引数なし）と `--only functions`（名指しなし）を打たない
