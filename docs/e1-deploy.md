# E-1（行政界ポリゴン取込基盤）デプロイ手順書

- 作成日：2026-08-28
- 対象：`firestore.rules` / `functions/index.js`（新規 `areaPolygon`）/ `admin.html`
- **実行者：乾**（Claude Code は deploy を実行しない）
- 所要：5〜10分。デプロイ後の動作確認は Claude Code が担当する

前提：作業ディレクトリは常に `akiya-map`。以下のコマンドは PowerShell 前提。

```powershell
cd "C:\Users\user\Documents\ZENSIN Digitals\akiya-map"
```

---

## 0. デプロイ前チェック（3項目）

### 0-1. 変更内容の確認

```powershell
git status
```

```powershell
git diff
```

変更されているのは `admin.html` / `firestore.rules` / `functions/index.js` の3つ。
`index.html` が含まれていたら止めること（今回の変更対象外）。

### 0-2. 本番ルールと repo のルールが一致しているかを目視

**これが一番大事。** 本番の Firestore ルールが repo より新しい（＝コンソールで直接編集された）場合、
このまま deploy すると**その編集が消える**。

1. https://console.firebase.google.com/project/housemarket-map/firestore/rules を開く
2. コンソールに表示されている内容と、下のコマンドの出力（＝**今回の変更を入れる前**のルール）を見比べる

```powershell
git show HEAD:firestore.rules
```

- **一致していれば** そのまま次へ
- **食い違っていたら** deploy せず、先に相談すること（コンソール側の編集を repo に取り込む必要がある）

### 0-3. ルールのバックアップ

```powershell
Copy-Item firestore.rules ("firestore.rules." + (Get-Date -Format "yyyyMMdd-HHmm") + ".bak")
```

> 補足：既存の `firestore.rules.bak` は**古い版**（`survey_rounds` のコメントが areaCode 移行前）なので、
> 上書きしないよう日付つきの名前で取っている。
> なお、ロールバックの本当の拠り所は git（`git show HEAD:firestore.rules`）とコンソールのルール履歴。

---

## 1. Firestore ルールをデプロイ

**functions より先にルールを当てる。** 逆順だと、関数だけ動いて書き込みが権限拒否になり、
「取得は成功するのに保存だけ失敗する」という紛らわしい状態になる。

```powershell
firebase deploy --only firestore:rules
```

期待する出力：`+  Deploy complete!`

追加されるのは `areaPolygons` の1ブロックのみ（read=ログイン全員 / write=管理者）。
既存コレクション（pins / survey_rounds / survey_grids / kouzu_marks 等）のルールは変更していない。

---

## 2. Cloud Functions をデプロイ

**必ず関数名を名指しする。** `--only functions` だけで打つと既存の `zenrin` / `youto` も巻き込んで
再デプロイされる（2026-07-14 に `zenrin` を消した事故と同じ経路）。

```powershell
firebase deploy --only functions:areaPolygon
```

初回デプロイなので、以下を聞かれる可能性がある。いずれも `y` で進めてよい。

- Artifact Registry / Cloud Build の有効化
- Secret `ZENRIN_KEY` へのアクセス許可（既存の `zenrin` と同じシークレットを共有する）

### 2-1. 発行された URL を確認する ★必須

デプロイ完了時に `Function URL (areaPolygon(asia-northeast1)):` としてURLが表示される。
これが `admin.html` に書いてある定数と一致していることを確認する。

```powershell
Select-String -Path admin.html -Pattern "AREAPOLY_API"
```

- 想定：`https://areapolygon-ptddjpvgeq-an.a.run.app`
- **もし違うURLが発行されたら**、Claude Code に実際のURLを伝えること（`admin.html` の1行を直す）

URLは後からでも確認できる：

```powershell
firebase functions:list
```

---

## 3. デプロイ後に Claude Code が実行する検証

デプロイが終わったら「deploy済み」と伝えてください。以下を実施します。

1. ローカルサーバを起動し、管理画面を開く
   ```powershell
   python -m http.server 8000
   ```
   → http://localhost:8000/admin.html に管理者アカウントでログイン
2. `🗾 行政界取込` ボタンが表示されることを確認（管理者のみ表示）
3. **名古屋市緑区（23114）** で「① 件数を確認」→ 105件・約0.59MB が出ること
4. 「② 取込を実行」→ `areaPolygons` に105件のdocが作られること
5. **同じ区でもう一度実行** → doc が105件のまま増えず、`fetchedAt` だけ更新されること
6. Firestore コンソールで `geometryJson` が入っていること・`L.geoJSON()` に渡せる形であることを確認
7. 結果を報告 → `git diff` 最終確認 → 乾の go で commit & push

---

## 4. ロールバック手順

### 4-1. Firestore ルールを戻す

repo を1つ前の状態に戻してから、もう一度デプロイする。

```powershell
git checkout HEAD -- firestore.rules
```

```powershell
firebase deploy --only firestore:rules
```

> コンソール（Firestore → ルール → 履歴）からも過去バージョンに戻せる。
> どちらでもよいが、**戻した後は repo と本番を必ず一致させておくこと**（次回デプロイでの巻き戻し事故を防ぐため）。

### 4-2. Cloud Functions を戻す

`areaPolygon` は**新規追加**なので、戻す＝消すでよい。既存2関数には一切触れない。

```powershell
firebase functions:delete areaPolygon --region asia-northeast1
```

確認プロンプトに `y`。削除後 `firebase functions:list` に `zenrin` と `youto` が残っていることを確認する。

> `admin.html` 側は未pushなので、ワーキングツリーを戻すだけでよい：
> ```powershell
> git checkout HEAD -- admin.html
> ```

---

## 5. やってはいけないこと

- `firebase deploy` （引数なし）… hosting / rules / functions を一括で当ててしまう
- `firebase deploy --only functions` … 既存の `zenrin` / `youto` を巻き込む
- ルールを当てずに functions だけデプロイ … 取得は成功して書き込みだけ失敗する（原因が分かりにくい）
- コンソールで直接ルールを編集 … repo と食い違い、次のデプロイで消える

---

## 参考：今回入る変更の要点

| ファイル | 変更 |
|---|---|
| `functions/index.js` | `areaPolygon` を新規 export（`timeoutSeconds:300` / 上流は280秒で自前打ち切り）。既存2関数は無変更 |
| `firestore.rules` | `areaPolygons` を追加（read=ログイン全員 / write=管理者）。**純キャッシュ**の制約をコメントで明記 |
| `admin.html` | `🗾 行政界取込` ボタン＋モーダル（①件数確認 → ②取込実行）。`index.html` は無変更 |

保存先 `areaPolygons` は doc ID = ZENRIN の `address_code`（大字＝8桁）。
`geometryJson` は GeoJSON を**文字列で**持つ（Firestore が配列の入れ子を保存できないため）。
座標の入れ替えや再構築はしていないので、`JSON.parse()` した値をそのまま `L.geoJSON()` に渡せる
（実データ105件・16,000点で完全一致を実測済み）。
