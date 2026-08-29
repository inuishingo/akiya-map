/**
 * akiya-map Cloud Functions（asia-northeast1）
 *
 * ┌─ zenrin      : ZENRIN Web API のプロキシ（逆ジオ / 地番検索 / ジオコード）
 * ├─ areaPolygon : ZENRIN 住所検索APIのプロキシ（行政界ポリゴン＝大字(OAZ)の面）
 * └─ youto       : 不動産情報ライブラリ XKT002（用途地域）のプロキシ
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
//   GET ?cityCode=23114          その市区町村の大字を「行政界ポリゴン付き」で返す
//   GET ?cityCode=23114&count=1  件数だけ返す（ポリゴンなし＝軽い。取込前のdry-run表示用）
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
    // JIS5桁以外は上流に投げない。前方一致なので桁が短いと県まるごとを引いてしまう。
    if (!/^\d{5}$/.test(cityCode)) {
      res.status(400).json({ error: "cityCode は JIS5桁で指定してください" });
      return;
    }

    const BASE = "https://test-web.zmaps-api.com";
    const url = `${BASE}/search/address`
      + `?address_code=${cityCode}&code_match_type=2`
      + `&address_level=OAZ`                                  // 本段階は大字のみ（AZCは次段階）
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
        level: "OAZ",
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
