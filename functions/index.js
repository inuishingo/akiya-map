/**
 * akiya-map Cloud Functions（asia-northeast1）
 *
 * ┌─ zenrin      : ZENRIN Web API のプロキシ（逆ジオ / 地番検索 / ジオコード）
 * ├─ areaPolygon : ZENRIN 住所検索APIのプロキシ（行政界ポリゴン＝大字(OAZ)の面）
 * ├─ youto       : 不動産情報ライブラリ XKT002（用途地域）のプロキシ
 * ├─ listAccounts       : 調査員アカウント一覧（callable・管理者専用）
 * ├─ setAccountDisabled : アカウントの無効化／再有効化（callable・管理者専用・監査ログ付き）
 * ├─ createSurveyorAccount : 調査員アカウントの新規作成（callable・管理者専用・自店ドメインのみ）
 * └─ resetSurveyorPassword : 調査員アカウントのパスワード再発行（callable・管理者専用）
 *
 * 【重要】この3つは必ず同じ codebase に置くこと。
 *   一部だけをローカルに置いた状態で `firebase deploy --only functions` を打つと、
 *   ローカルに存在しない関数は「不要」と判定されて削除される。
 *   （2026-07-14 に zenrin を実際に消す事故が発生。GCSのバージョニングから復旧）
 *   関数を個別にデプロイしたい場合は `firebase deploy --only functions:youto` のように名指しする。
 *
 * 【APIキー】コードに直書きしないこと。このリポジトリは Public。
 *   Secret Manager に置き、defineSecret 経由で読む。
 *     firebase functions:secrets:set ZENRIN_KEY
 *     firebase functions:secrets:set REINFOLIB_KEY
 */

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
// ※ admin.firestore.FieldValue はこの構成では undefined になる（U-1 のエミュレータ検証で実測）。modular から取る。
const { FieldValue } = require("firebase-admin/firestore");

setGlobalOptions({ maxInstances: 10, region: "asia-northeast1" });

const ZENRIN_KEY = defineSecret("ZENRIN_KEY");
const REINFOLIB_KEY = defineSecret("REINFOLIB_KEY");

admin.initializeApp();

// ═══════════════════════════════════════════════════════════════
// zenrin : ZENRIN Web API プロキシ
//
//   GET ?type=reverse&lat=..&lon=..     逆ジオコーディング（住所・親番）
//   GET ?type=bm&lat=..&lon=..          地番検索（親番・枝番・distance）
//   GET ?type=chiban&address=..         ジオコード（住所→座標）
//
//   ※ 2026-07-14 の復旧時点で、挙動は復元前と完全に同一。
//      変更点は APIキーを直書き → Secret に移しただけ。
// ═══════════════════════════════════════════════════════════════
exports.zenrin = onRequest({ cors: true, secrets: [ZENRIN_KEY] }, async (req, res) => {
  const { type, lat, lon, address } = req.query;
  const BASE = "https://test-web.zmaps-api.com";

  let url = "";
  if (type === "reverse") {
    url = `${BASE}/search/address?position=${lon},${lat}&datum=JGD&limit=0,10&address_level=TBN,GIK,AZC`;
  } else if (type === "chiban") {
    url = `${BASE}/geocode/address?address=${encodeURIComponent(address)}&word_match=1`;
  } else if (type === "bm") {
    // limit を 5→80 に拡大。ZENRIN の bm_address は既定が距離順でないため、
    // 5件キャップだと近傍の地番（枝番含む）が先頭に入らず取りこぼす。
    // 半径50m内の全候補（実測 hit≈25）を返し、距離選定はクライアント側で行う。
    url = `${BASE}/search/bm_address?proximity=${lon},${lat},50&datum=JGD&limit=0,80&address_level=TBN,EBN`;
  } else {
    res.status(400).json({ error: "typeパラメータが必要です" });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "x-api-key": ZENRIN_KEY.value(),
        "Authorization": "referer",
        "Referer": "https://inuishingo.github.io/",
      },
    });
    // 【重要】上流のステータスを握り潰さないこと。
    // 以前は response.ok を見ずに res.json(data) していたため、ZENRIN の 429/500/503 が
    // すべて 200＋中身なしに化け、クライアントは「該当なし(0件)」と解釈していた。
    // 現地で地番が取れない事象の原因究明に3便かかったのは、この握り潰しでログも痕跡も
    // 残らなかったため。ステータスは必ずそのまま返す。
    //
    // ただし本文は「常にJSON」を保証する。呼び出し側（index.html 4箇所 / admin.html 1箇所）は
    // いずれも res.ok を見ずに await res.json() しており、非JSONを流すと例外に化けて
    // ステータスが読めなくなる＝この修正の目的が失われる。
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 上流がJSONを返さなかった */ }

    if (!response.ok) {
      // Cloud Logging に残す。ピン側の chibanDiag と突き合わせて事後追跡できるようにする。
      console.error("zenrin upstream error", {
        type, status: response.status, body: text.slice(0, 300),
      });
      res.status(response.status).json(
        (data && typeof data === "object")
          ? { ...data, error: "upstream_error", _upstreamStatus: response.status }
          : { error: "upstream_error", _upstreamStatus: response.status, _body: text.slice(0, 300) }
      );
      return;
    }
    if (!data) {
      // 200 なのに JSON でない＝上流の仕様外。502 にして中身を残す。
      console.error("zenrin upstream non-json", { type, body: text.slice(0, 300) });
      res.status(502).json({ error: "upstream_non_json", _upstreamStatus: 200, _body: text.slice(0, 300) });
      return;
    }

    // reverse は住所レベルの粒度順に並べ替える（TBN=地番が先頭に来るように）
    if (type === "reverse" && data.result?.item) {
      const order = ["TBN", "GIK", "AZC", "OAZ", "SHK", "TOD"];
      data.result.item.sort(
        (a, b) => order.indexOf(a.address_level) - order.indexOf(b.address_level)
      );
    }

    res.status(200).json(data);
  } catch (e) {
    console.error("zenrin fetch failed", { type, message: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// areaPolygon : 行政界ポリゴン（大字＝OAZ）取得プロキシ
//
//   GET ?cityCode=23114              その市区町村の大字(OAZ)を「行政界ポリゴン付き」で返す
//   GET ?cityCode=23114&level=SHK    その市区町村そのものの面を返す（1件。E-2a' の市区境用）
//   GET ?cityCode=23114&count=1      件数だけ返す（ポリゴンなし＝軽い。取込前のdry-run表示用）
//
//   ZENRIN 住所検索API の address_code 前方一致(code_match_type=2)で JIS5桁配下を丸ごと引く。
//   word 検索と違い曖昧一致が構造的に起きない（word だと無関係な語でも別県を返す実績あり）。
//
//   【実測 2026-08-28】
//     23114 名古屋市緑区 / OAZ / ポリゴンあり … 105件 5.4〜6.0秒 789KB（1件平均5.9KB・最大93.8KB）
//     同             / ポリゴンなし          … 0.1秒 1.6KB
//     対象21市区町村の最大は岐阜市848件（→ limit=0,1000 の1回取得で足りる。docs/area-polygon-hit-count.md）
//   【タイムアウトの根拠】
//     取得時間は件数にほぼ比例する（105件＝6.0秒 ≒ 57ms/件）。最大の岐阜市848件なら40〜50秒の
//     見込みで、既定値のままではマージンが5秒しかない。上限いっぱいの1000件（≒1分）を引いても
//     構造的に当たらないよう、timeoutSeconds=300 / 上流の自前打ち切り280秒と実測の5倍以上を取る。
//     待たされるのは管理者が押した取込操作のときだけなので、長くても現場（index.html）には影響しない。
// ═══════════════════════════════════════════════════════════════
exports.areaPolygon = onRequest(
  { cors: true, secrets: [ZENRIN_KEY], timeoutSeconds: 300, memory: "512MiB" },
  async (req, res) => {
    const cityCode = String(req.query.cityCode || "");
    const countOnly = req.query.count === "1";
    // 取得する住所レベル。OAZ=大字（E-1）／SHK=市区町村そのもの（E-2a'）。
    // 上流にそのまま渡す値なので、想定外の文字列は素通しさせない。
    const level = String(req.query.level || "OAZ").toUpperCase();
    if (level !== "OAZ" && level !== "SHK") {
      res.status(400).json({ error: "level は OAZ か SHK を指定してください" });
      return;
    }
    // JIS5桁以外は上流に投げない。前方一致なので桁が短いと県まるごとを引いてしまう。
    if (!/^\d{5}$/.test(cityCode)) {
      res.status(400).json({ error: "cityCode は JIS5桁で指定してください" });
      return;
    }

    const BASE = "https://test-web.zmaps-api.com";
    const url = `${BASE}/search/address`
      + `?address_code=${cityCode}&code_match_type=2`
      + `&address_level=${level}`                             // OAZ=大字 / SHK=市区町村そのもの（AZCは対象外）
      + `&address_polygon=${countOnly ? "false" : "true"}`
      + `&datum=JGD&limit=0,1000`;

    // Cloud Run の打ち切り(300秒)に食われて 504 になると本文が残らず、原因が追えなくなる。
    // 手前(280秒)で自分から打ち切り、必ず JSON で理由を返す。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 280000);
    const t0 = Date.now();
    try {
      const response = await fetch(url, {
        signal: ac.signal,
        headers: {
          "x-api-key": ZENRIN_KEY.value(),
          "Authorization": "referer",
          "Referer": "https://inuishingo.github.io/",
        },
      });
      // zenrin と同じ方針：上流ステータスは握り潰さない。ただし本文は常にJSONを保証する。
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* 上流がJSONを返さなかった */ }

      if (!response.ok) {
        console.error("areaPolygon upstream error", {
          cityCode, status: response.status, body: text.slice(0, 300),
        });
        res.status(response.status).json({
          error: "upstream_error", _upstreamStatus: response.status, _body: text.slice(0, 300),
        });
        return;
      }
      if (!data) {
        console.error("areaPolygon upstream non-json", { cityCode, body: text.slice(0, 300) });
        res.status(502).json({ error: "upstream_non_json", _upstreamStatus: 200, _body: text.slice(0, 300) });
        return;
      }

      const items = (data.result && data.result.item) || [];
      res.status(200).json({
        cityCode,
        level,
        hit: (data.result && data.result.info && data.result.info.hit) || items.length,
        count: items.length,
        bytes: Buffer.byteLength(text, "utf8"),
        elapsedMs: Date.now() - t0,
        // count=1 は件数確認が目的。中身を返さない（無駄に数百KBを流さない）。
        // 通常時は ZENRIN の item をそのまま透過する。address_polygon には一切手を加えない
        // ＝クライアントが受け取る GeoJSON は上流と完全に同一（座標の並べ替えもしない）。
        item: countOnly ? [] : items,
      });
    } catch (e) {
      const aborted = e.name === "AbortError";
      console.error("areaPolygon fetch failed", { cityCode, aborted, message: e.message });
      res.status(aborted ? 504 : 500).json({
        error: aborted ? "upstream_timeout" : e.message,
        _hint: aborted ? "件数が多く280秒で取得しきれなかった。分割取得が必要。" : undefined,
      });
    } finally {
      clearTimeout(timer);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// youto : 不動産情報ライブラリ XKT002（都市計画決定GISデータ＝用途地域）プロキシ
//
//   GET /youto?z={11..15}&x={int}&y={int}
//   Header: Authorization: Bearer <Firebase ID token>
//   → GeoJSON（FeatureCollection）
//
//   ZENRIN の用途地域 WMS（test-web.zmaps-api.com/map/wms/youto）を置き換える目的。
//   XKT002 は APIキーを HTTPヘッダで送る方式のため、ブラウザ直叩き不可。
// ═══════════════════════════════════════════════════════════════
const XKT002 = "https://www.reinfolib.mlit.go.jp/ex-api/external/XKT002";

// CORS 許可オリジン。※本番URLが変わったら（Organization移行等）ここも直すこと。
const ALLOWED_ORIGINS = [
  "https://inuishingo.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

// インスタンス内キャッシュ。用途地域は年単位でしか変わらないので長めでよい。
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
const CACHE_MAX = 800;
const cache = new Map(); // "z/x/y" -> { body, at }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit); // LRU 風に詰め直す
  return hit.body;
}

function cacheSet(key, body) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { body, at: Date.now() });
}

exports.youto = onRequest(
  {
    secrets: [REINFOLIB_KEY],
    memory: "256MiB",
    timeoutSeconds: 30,
    cors: false, // オリジンを絞るため自前で処理
  },
  async (req, res) => {
    // ---- CORS ----
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
    }
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Max-Age", "3600");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    // ---- 認証（ログイン済みユーザーのみ）----
    // これが無いと、URLさえ知られれば誰でも国交省APIのクォータを使えてしまう。
    const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (!m) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      await admin.auth().verifyIdToken(m[1]);
    } catch (e) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // ---- パラメータ検証 ----
    const z = Number(req.query.z);
    const x = Number(req.query.x);
    const y = Number(req.query.y);

    if (!Number.isInteger(z) || z < 11 || z > 15) {
      res.status(400).json({ error: "z は 11〜15 の整数", z: req.query.z });
      return;
    }
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
      res.status(400).json({ error: "x / y は 0 以上の整数" });
      return;
    }
    const n = 2 ** z;
    if (x >= n || y >= n) {
      res.status(400).json({ error: `x / y は 0〜${n - 1} の範囲` });
      return;
    }

    const key = `${z}/${x}/${y}`;

    // ---- キャッシュヒット ----
    const cached = cacheGet(key);
    if (cached) {
      res.set("Content-Type", "application/geo+json; charset=utf-8");
      res.set("Cache-Control", "public, max-age=604800");
      res.set("X-Cache", "HIT");
      res.status(200).send(cached);
      return;
    }

    // ---- 上流（不動産情報ライブラリ）----
    try {
      const r = await fetch(`${XKT002}?response_format=geojson&z=${z}&x=${x}&y=${y}`, {
        headers: { "Ocp-Apim-Subscription-Key": REINFOLIB_KEY.value() },
      });

      if (!r.ok) {
        console.error("XKT002 error", r.status, key);
        res.status(502).json({ error: "upstream_error", status: r.status });
        return;
      }

      const body = await r.text();
      cacheSet(key, body);

      res.set("Content-Type", "application/geo+json; charset=utf-8");
      res.set("Cache-Control", "public, max-age=604800");
      res.set("X-Cache", "MISS");
      res.status(200).send(body);
    } catch (e) {
      console.error("XKT002 fetch failed", key, e);
      res.status(502).json({ error: "upstream_unreachable" });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// アカウント管理（U-1）: listAccounts / setAccountDisabled
//
//   admin.html の「👤 アカウント管理」から呼ぶ callable。
//   Firebase 側が disabledUserSignup / disabledUserDeletion のため、クライアントSDKから Auth は触れない。
//   Admin SDK を持つここが唯一の経路になる。
//
//   U-1 は「可逆な操作だけ」。作成・PW発行・削除・admins付け外し・displayNames編集はしない。
//   退職者は Auth 無効化のみ。displayNames は消さない（過去ピンの担当者名が displayNames.name 引きのため）。
//
//   【権限境界はすべてここで持つ】admin.html 側のボタン制御は見た目だけで、迂回されても通さない。
// ═══════════════════════════════════════════════════════════════

// 拠点判定：メールに "kyoto" を含む → 京都、それ以外 → 名古屋（index.html の branchOfEmail と同一）
function branchOfEmail(email) {
  return String(email || "").toLowerCase().includes("kyoto") ? "京都" : "名古屋";
}
// 全店扱い：@housemarket.com かつ "kyoto" を含まない（inui＝全店の運用に合わせる）
function isAllStoreEmail(email) {
  const e = String(email || "").toLowerCase();
  return e.endsWith("@housemarket.com") && !e.includes("kyoto");
}
function branchFromDisplayName(data, email) {
  const b = data && data.branch;
  return (b && String(b).trim()) ? String(b).trim() : branchOfEmail(email);
}

// 【安全装置】エミュレータ上で Auth エミュレータが起動していないときは拒否する。
//   Functions エミュレータの Admin SDK は、Auth エミュレータが無いと「本番の Auth」に繋がる。
//   `npm run emu`（firestore,functions のみ）から呼ぶと本番アカウントを書き換える事故になるので、
//   URLパラメータ（?authEmu=1）の付け忘れを前提に、サーバー側で構造的に止める。
//   本番（Cloud Run）では FUNCTIONS_EMULATOR が立たないので影響しない。
function assertNotProdAuthFromEmulator() {
  if (process.env.FUNCTIONS_EMULATOR === "true" && !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new HttpsError("failed-precondition",
      "Auth エミュレータが起動していません（本番の Auth に繋がるため拒否しました）。npm run emu:auth で起動してください");
  }
}

// 認証必須＋ admins/{uid} の存在チェック（fail-closed：読めなければ拒否）
async function assertAdminCaller(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "ログインが必要です");
  }
  let isAdmin = false;
  try {
    isAdmin = (await admin.firestore().doc(`admins/${request.auth.uid}`).get()).exists;
  } catch (e) {
    console.error("admins check failed", { uid: request.auth.uid, message: e.message });
    isAdmin = false;
  }
  if (!isAdmin) {
    throw new HttpsError("permission-denied", "管理者権限がありません");
  }
  return { uid: request.auth.uid, email: String(request.auth.token.email || "") };
}

exports.listAccounts = onCall(async (request) => {
  assertNotProdAuthFromEmulator();
  await assertAdminCaller(request);

  const db = admin.firestore();
  const [users, dnSnap, adminsSnap] = await Promise.all([
    (async () => {
      const all = [];
      let pageToken;
      do {
        const page = await admin.auth().listUsers(1000, pageToken);
        all.push(...page.users);
        pageToken = page.pageToken;
      } while (pageToken);
      return all;
    })(),
    db.collection("displayNames").get(),
    db.collection("admins").get(),
  ]);

  const dnByEmail = new Map();
  dnSnap.forEach(d => dnByEmail.set(d.id, d.data()));
  const adminUids = new Set(adminsSnap.docs.map(d => d.id));

  const rows = users.map(u => {
    const email = u.email || "";
    const dn = dnByEmail.get(email);
    return {
      uid: u.uid,
      email,
      displayName: (dn && dn.name) || "",
      branch: branchFromDisplayName(dn, email),
      disabled: !!u.disabled,
      isAdmin: adminUids.has(u.uid),   // 画面側で操作ボタンを押せなくするため（判定の本体は setAccountDisabled）
      lastSignInTime: u.metadata.lastSignInTime || null,
      creationTime: u.metadata.creationTime || null,
    };
  });
  // 並び：branch → email の昇順（ロケール非依存の単純比較で順序を固定する）
  rows.sort((a, b) =>
    a.branch < b.branch ? -1 : a.branch > b.branch ? 1 :
    a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
  return rows;
});

// 呼び出し元の拠点：displayNames/{email}.branch を正とし、無ければメール判定にフォールバック
async function callerBranchOf(caller) {
  const snap = caller.email ? await admin.firestore().doc(`displayNames/${caller.email}`).get() : null;
  return branchFromDisplayName(snap && snap.exists ? snap.data() : null, caller.email);
}

// 既存アカウントを操作する前のガード（U-1 のガード1〜3。setAccountDisabled / resetSurveyorPassword 共通）
//   順序とメッセージは U-1 から変えない。verb は「管理者アカウントはこの画面から{verb}できません」にだけ使う。
async function assertOperableTarget(caller, uid, verb) {
  // ガード1：自分自身は不可
  if (uid === caller.uid) {
    throw new HttpsError("failed-precondition", "自分のアカウントは操作できません");
  }

  const db = admin.firestore();
  // ガード2：管理者アカウントは不可（ロックアウト防止）
  if ((await db.doc(`admins/${uid}`).get()).exists) {
    throw new HttpsError("failed-precondition", `管理者アカウントはこの画面から${verb}できません`);
  }

  let target;
  try {
    target = await admin.auth().getUser(uid);
  } catch (e) {
    if (e.code === "auth/user-not-found") throw new HttpsError("not-found", "対象のアカウントが見つかりません");
    throw e;
  }
  const targetEmail = target.email || "";

  // ガード3：他店のアカウントは不可（全店扱いのメールはこのチェックのみスキップ）
  const [callerBranch, targetDn] = await Promise.all([
    callerBranchOf(caller),
    targetEmail ? db.doc(`displayNames/${targetEmail}`).get() : Promise.resolve(null),
  ]);
  const targetBranch = branchFromDisplayName(targetDn && targetDn.exists ? targetDn.data() : null, targetEmail);
  if (!isAllStoreEmail(caller.email) && callerBranch !== targetBranch) {
    throw new HttpsError("permission-denied", `他店のアカウントです（${targetBranch}店）`);
  }
  return { targetEmail, targetBranch };
}

// 監査ログ。Auth の変更は既に確定しているので、ここで失敗しても呼び出し元は ok を返す
// （失敗を返すと画面と実態がズレる）。取りこぼしは Cloud Logging で追えるようにする。
// ★パスワードは渡さない・残さない。
async function writeAuditLog(action, { targetUid, targetEmail, caller, branch }) {
  try {
    await admin.firestore().collection("account_audit_logs").add({
      action,
      targetUid,
      targetEmail,
      byUid: caller.uid,
      byEmail: caller.email,
      branch,
      at: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("account_audit_logs write failed", { action, targetUid, byUid: caller.uid, message: e.message });
  }
}

exports.setAccountDisabled = onCall(async (request) => {
  assertNotProdAuthFromEmulator();
  const caller = await assertAdminCaller(request);

  const uid = request.data && request.data.uid;
  const disabled = request.data && request.data.disabled;
  if (typeof uid !== "string" || !uid || typeof disabled !== "boolean") {
    throw new HttpsError("invalid-argument", "uid(string) と disabled(boolean) が必要です");
  }

  const { targetEmail, targetBranch } = await assertOperableTarget(caller, uid, "無効化");

  await admin.auth().updateUser(uid, { disabled });
  await writeAuditLog(disabled ? "disable" : "enable", { targetUid: uid, targetEmail, caller, branch: targetBranch });

  return { ok: true, uid, disabled };
});

// ═══════════════════════════════════════════════════════════════
// アカウント管理（U-2）: createSurveyorAccount / resetSurveyorPassword
//
//   調査員アカウントの新規作成と、パスワードの再発行。管理者アカウントの発行・admins の付け外しはしない。
//   パスワードは自動生成し、返り値で1回だけ返す（Firestore にもログにも残さない）。
//   共通PW（既存アカウント）は据え置き。新規・再発行からパスワードを個別化する。
//
//   【店縛りの本体】メールのドメインは許可リストから選ばせ、生成したメールの拠点（branchOfEmail）が
//   呼び出し元の拠点と一致しなければ拒否する。全店扱いのメールだけがこのチェックをスキップする。
// ═══════════════════════════════════════════════════════════════
const { randomInt } = require("node:crypto");

// 拠点ごとに作成を許すドメイン。キーは branchOfEmail の戻り値と一致させること
// （食い違うと createSurveyorAccount が internal で止まる＝黙って他店のアカウントを作らない）。
const ALLOWED_DOMAINS = { "名古屋": ["hm.com"], "京都": ["kyoto-hm.com"] };
const LOCAL_PART_RE = /^[a-z0-9][a-z0-9._-]{0,30}$/;
const NAME_MAX = 20;

function branchOfAllowedDomain(domain) {
  return Object.keys(ALLOWED_DOMAINS).find(b => ALLOWED_DOMAINS[b].includes(domain)) || null;
}

// 英小文字＋数字の10桁。紛らわしい文字（0 o O 1 l I）は除外（大文字はそもそも使わない）。
// 英字と数字を最低1文字ずつ含める（口頭・手書きで伝えるときに「全部数字？」の取り違えを防ぐ）。
const PW_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function generatePassword(length = 10) {
  for (;;) {
    let s = "";
    for (let i = 0; i < length; i++) s += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
    if (/[a-z]/.test(s) && /[0-9]/.test(s)) return s;
  }
}

// 【検証専用】受け入れ条件9（displayNames 書込失敗時のロールバック）を再現するための故障注入。
//   エミュレータ上で、氏名が FAULT_NAME_DISPLAYNAMES のときだけ displayNames の書込を失敗させる。
//   本番（Cloud Run）では FUNCTIONS_EMULATOR が立たないので構造的に発火しない。
const FAULT_NAME_DISPLAYNAMES = "__FAULT_DN__";
function injectDisplayNamesFaultForEmulator(name) {
  if (process.env.FUNCTIONS_EMULATOR === "true" && name === FAULT_NAME_DISPLAYNAMES) {
    throw new Error("fault injection (emulator only): displayNames write");
  }
}

exports.createSurveyorAccount = onCall(async (request) => {
  assertNotProdAuthFromEmulator();
  const caller = await assertAdminCaller(request);

  // 1. 入力検証
  const d = request.data || {};
  const localPart = d.localPart;
  const domain = d.domain;
  const name = typeof d.name === "string" ? d.name.trim() : d.name;
  if (typeof localPart !== "string" || !LOCAL_PART_RE.test(localPart)) {
    throw new HttpsError("invalid-argument",
      "メールの@より前は、英小文字か数字で始まる31文字以内（英小文字・数字・. _ -）で入力してください");
  }
  const domainBranch = typeof domain === "string" ? branchOfAllowedDomain(domain) : null;
  if (!domainBranch) {
    throw new HttpsError("invalid-argument", "このドメインではアカウントを作成できません");
  }
  if (typeof name !== "string" || !name || Array.from(name).length > NAME_MAX || /[\x00-\x1f\x7f]/.test(name)) {
    throw new HttpsError("invalid-argument", `氏名は1〜${NAME_MAX}文字で入力してください`);
  }

  // 2. メールを組み立て、店縛りを確認
  const email = `${localPart}@${domain}`;
  const newBranch = branchOfEmail(email);
  if (newBranch !== domainBranch) {
    // 許可リストの定義と拠点判定が食い違っている＝設定ミス。作らずに止める。
    console.error("ALLOWED_DOMAINS と branchOfEmail の不一致", { domain, domainBranch, newBranch });
    throw new HttpsError("internal", "拠点の判定に失敗しました（許可ドメインの設定を確認してください）");
  }
  if (!isAllStoreEmail(caller.email) && (await callerBranchOf(caller)) !== newBranch) {
    throw new HttpsError("permission-denied", "他店のアカウントは作成できません");
  }

  // 3. Auth の重複
  try {
    await admin.auth().getUserByEmail(email);
    throw new HttpsError("already-exists", "このメールアドレスは既に使われています");
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    if (e.code !== "auth/user-not-found") throw e;
  }
  // 4. displayNames の残骸（Auth だけ消して displayNames が残っているケース）
  const db = admin.firestore();
  const dnRef = db.doc(`displayNames/${email}`);
  if ((await dnRef.get()).exists) {
    throw new HttpsError("already-exists", "このメールアドレスは既に使われています");
  }

  // 5. パスワード生成 → 6. Auth 作成
  const password = generatePassword();
  let user;
  try {
    user = await admin.auth().createUser({ email, password, disabled: false });
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "このメールアドレスは既に使われています");
    }
    throw e;
  }

  // 7. displayNames（name / branch のみ。order は書かない＝年色化 af519fd で不要になった概念）
  //    create() は既存 doc があると失敗する＝4 と 7 の間に誰かが作っても上書きしない。
  //    失敗したら 6 の Auth を消して戻す（displayNames 無しのアカウントは「（氏名未登録）」になり原因が追えない）。
  try {
    injectDisplayNamesFaultForEmulator(name);
    await dnRef.create({ name, branch: newBranch });
  } catch (e) {
    console.error("displayNames write failed; rolling back auth user", { email, uid: user.uid, message: e.message });
    try {
      await admin.auth().deleteUser(user.uid);
    } catch (e2) {
      console.error("rollback deleteUser failed", { email, uid: user.uid, message: e2.message });
      throw new HttpsError("internal",
        `氏名の登録に失敗し、アカウントの取り消しにも失敗しました。管理者に連絡してください（${email}）`);
    }
    throw new HttpsError("internal", "氏名の登録に失敗したため、アカウントの作成を取り消しました");
  }
  // 8. admins には書かない（本便は調査員アカウントのみ）

  await writeAuditLog("create", { targetUid: user.uid, targetEmail: email, caller, branch: newBranch });
  return { ok: true, uid: user.uid, email, password };
});

exports.resetSurveyorPassword = onCall(async (request) => {
  assertNotProdAuthFromEmulator();
  const caller = await assertAdminCaller(request);

  const uid = request.data && request.data.uid;
  if (typeof uid !== "string" || !uid) {
    throw new HttpsError("invalid-argument", "uid(string) が必要です");
  }

  const { targetEmail, targetBranch } = await assertOperableTarget(caller, uid, "パスワードを再発行");

  const password = generatePassword();
  await admin.auth().updateUser(uid, { password });
  await writeAuditLog("reset_password", { targetUid: uid, targetEmail, caller, branch: targetBranch });

  return { ok: true, uid, email: targetEmail, password };
});
