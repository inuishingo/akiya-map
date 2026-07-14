/**
 * akiya-map Cloud Functions（asia-northeast1）
 *
 * ┌─ zenrin : ZENRIN Web API のプロキシ（逆ジオ / 地番検索 / ジオコード）
 * └─ youto  : 不動産情報ライブラリ XKT002（用途地域）のプロキシ
 *
 * 【重要】この2つは必ず同じ codebase に置くこと。
 *   片方だけをローカルに置いた状態で `firebase deploy --only functions` を打つと、
 *   ローカルに存在しない関数は「不要」と判定されて削除される。
 *   （2026-07-14 に zenrin を実際に消す事故が発生。GCSのバージョニングから復旧）
 *   関数を個別にデプロイしたい場合は `firebase deploy --only functions:youto` のように名指しする。
 *
 * 【APIキー】コードに直書きしないこと。このリポジトリは Public。
 *   Secret Manager に置き、defineSecret 経由で読む。
 *     firebase functions:secrets:set ZENRIN_KEY
 *     firebase functions:secrets:set REINFOLIB_KEY
 */

const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

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
    const data = await response.json();

    // reverse は住所レベルの粒度順に並べ替える（TBN=地番が先頭に来るように）
    if (type === "reverse" && data.result?.item) {
      const order = ["TBN", "GIK", "AZC", "OAZ", "SHK", "TOD"];
      data.result.item.sort(
        (a, b) => order.indexOf(a.address_level) - order.indexOf(b.address_level)
      );
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
