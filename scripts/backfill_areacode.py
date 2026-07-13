#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
areaCode バックフィル移行ツール（一回限り・実行済み）
=====================================================
pins コレクションの各ドキュメントに、住所文字列から判定した
  areaCode : JIS5桁市区町村コード（総務省コード先頭5桁＝ZENRIN reverse の address_code2+code3 と一致）
  areaName : 市区町村名（総務省マスタ形式・政令市は「名古屋市東区」形式・郡名なし）
を updateMask で追記する（既存フィールドは非破壊）。

判定ロジック（Step3 整合性ゲートで reverse と全一致を確認済み）:
  - 都道府県で絞ってから市区町村名の最長前方一致（港区衝突・同名市の誤爆を防止）
  - 郡（三重郡菰野町 等）は除去
  - 都道府県が住所に無い場合は「全国で一意な市名のみ」復元、曖昧なら null（推測しない）
  - 判定不能は areaCode=null として隔離（書き込まない・削除も改変もしない）

※このスクリプトはバックフィル専用の移行ツールであり、アプリ(index.html/admin.html)からは読み込まない。
※新規ピンの areaCode は index.html が ZENRIN reverse から直接取得するため、本ツールもマスタもアプリには不要。

認証（トークンはコードに含めない）:
  環境変数 FIREBASE_REFRESH_TOKEN に Google OAuth refresh token を設定して実行する。
  取得例（firebase CLI ログイン済みの場合）:
    ~/.config/configstore/firebase-tools.json の tokens.refresh_token を環境変数へ。
  ※ refresh token は秘匿情報。ファイルにハードコードしない・commitしない。

使い方:
  FIREBASE_REFRESH_TOKEN=xxxx python backfill_areacode.py --dry-run   # 対応表のみ（書き込みなし）
  FIREBASE_REFRESH_TOKEN=xxxx python backfill_areacode.py --commit    # 本実行（updateMaskで追記）
"""
import sys, os, re, json, csv, time, unicodedata, urllib.request, urllib.parse, ssl, argparse
from collections import defaultdict, Counter

PROJECT = "housemarket-map"
DBASE   = f"projects/{PROJECT}/databases/(default)/documents"
# firebase-tools の公開OAuthクライアント（firebase-tools ソース由来の公開値・秘密ではない）
CLIENT_ID     = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"
ctx = ssl.create_default_context()
HERE = os.path.dirname(os.path.abspath(__file__))

def load_master():
    obj = json.load(open(os.path.join(HERE, "muni_master.json"), encoding="utf-8"))
    m = obj["master"]
    prefs = sorted({x["pref"] for x in m}, key=len, reverse=True)
    by_pref = defaultdict(list); name_codes = defaultdict(set); allm = []
    for x in m:
        by_pref[x["pref"]].append((x["code"], x["name"]))
        name_codes[x["name"]].add(x["code"]); allm.append((x["code"], x["name"]))
    return prefs, by_pref, name_codes, allm

PREFS, BY_PREF, NAME_CODES, ALLM = load_master()
GUN = re.compile(r'^.{1,4}郡')

def strict(a0):
    a = unicodedata.normalize("NFKC", a0 or "").strip()
    if not a: return (None, None)
    pref = next((p for p in PREFS if a.startswith(p)), None)
    if not pref: return (None, None)
    rest = GUN.sub('', a[len(pref):]); best = None
    for c, n in BY_PREF[pref]:
        if n and rest.startswith(n) and (best is None or len(n) > len(best[1])): best = (c, n)
    return best or (None, None)

def lenient(a0):
    r = strict(a0)
    if r[0]: return r
    a = unicodedata.normalize("NFKC", a0 or "").strip()
    if not a: return (None, None)
    a = GUN.sub('', a); best = None
    for c, n in ALLM:
        if n and a.startswith(n) and (best is None or len(n) > len(best[1])): best = (c, n)
    return best if best and len(NAME_CODES[best[1]]) == 1 else (None, None)

def access_token():
    rt = os.environ.get("FIREBASE_REFRESH_TOKEN")
    if not rt:
        sys.exit("環境変数 FIREBASE_REFRESH_TOKEN を設定してください（トークンはコードに埋めない）")
    body = urllib.parse.urlencode({"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
        "refresh_token": rt, "grant_type": "refresh_token"}).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    return json.load(urllib.request.urlopen(req, context=ctx, timeout=30))["access_token"]

def fetch_pins(at):
    pins = []; page = None
    while True:
        q = {"pageSize": "300"}; q.update({"pageToken": page} if page else {})
        url = f"https://firestore.googleapis.com/v1/{DBASE}/pins?" + urllib.parse.urlencode(q)
        d = json.load(urllib.request.urlopen(urllib.request.Request(url,
            headers={"Authorization": "Bearer " + at}), context=ctx, timeout=60))
        for doc in d.get("documents", []):
            f = doc.get("fields", {})
            pins.append({"id": doc["name"].split("/")[-1],
                         "address": f.get("address", {}).get("stringValue", "")})
        page = d.get("nextPageToken")
        if not page: break
    return pins

def commit(at, writes):
    body = json.dumps({"writes": writes}).encode()
    req = urllib.request.Request(f"https://firestore.googleapis.com/v1/{DBASE}:commit",
        data=body, method="POST",
        headers={"Authorization": "Bearer " + at, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, context=ctx, timeout=120))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()
    if not (args.dry_run or args.commit):
        sys.exit("--dry-run か --commit を指定してください")

    at = access_token()
    pins = fetch_pins(at)
    targets = []; nullN = 0
    for p in pins:
        c, n = lenient(p["address"])
        if c: targets.append((p["id"], c, n))
        else: nullN += 1
    print(f"pins {len(pins)} / 付与 {len(targets)} / null隔離 {nullN}")

    if args.dry_run:
        agg = Counter((lenient(p["address"])) for p in pins)
        for (c, n), cnt in agg.most_common():
            print(f"  {cnt:5} {c or 'null'} {n or '未判定'}")
        return

    done = 0
    for i in range(0, len(targets), 450):
        chunk = targets[i:i+450]
        writes = [{"update": {"name": f"{DBASE}/pins/{pid}",
                    "fields": {"areaCode": {"stringValue": c}, "areaName": {"stringValue": n}}},
                   "updateMask": {"fieldPaths": ["areaCode", "areaName"]},
                   "currentDocument": {"exists": True}} for pid, c, n in chunk]
        res = commit(at, writes)
        done += len(res.get("writeResults", []))
        print(f"  commit {i//450+1}: 累計 {done}")
        time.sleep(0.3)
    print(f"完了: {done} / {len(targets)}")

if __name__ == "__main__":
    main()
