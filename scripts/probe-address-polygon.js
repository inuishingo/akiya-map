/**
 * probe-address-polygon.js  ―― 使い捨て調査スクリプト（2026-08-28）
 *
 * 目的: ZENRIN Maps API 住所検索API(/search/address) の address_polygon=true で
 *       行政界ポリゴン（GeoJSON）が取得できるかを実測する。
 *       空家MAPの周回機能で「エリア＝町丁目」を面として扱えるかの判断材料。
 *
 * 前提:
 *   - APIキーは環境変数 ZENRIN_KEY から読む（ファイルには絶対に書かない）。
 *     取得元: Secret Manager
 *       ZENRIN_KEY=$(firebase functions:secrets:access ZENRIN_KEY) node scripts/probe-address-polygon.js
 *   - 認証方式は functions/index.js の zenrin プロキシと同一
 *     （x-api-key + Authorization: referer + Referer 固定）。
 *   - リクエストは必ず直列・1件ごとに 300ms 待機（ゼンリンの指定）。合計20件以内。
 *
 * 出力: OUT_DIR（既定 ./_probe_out）に
 *   - summary.json      … 計測サマリ（キーは含まない）
 *   - raw-<n>.json      … 各レスポンス全文
 *   - sample.geojson    … 描画確認用に1件だけ抜き出したGeoJSON
 */

const fs = require("fs");
const path = require("path");

const BASE = "https://test-web.zmaps-api.com";
const REFERER = "https://inuishingo.github.io/";
const KEY = process.env.ZENRIN_KEY;
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, "_probe_out");

if (!KEY) {
  console.error("ZENRIN_KEY が未設定です。firebase functions:secrets:access ZENRIN_KEY で取得して環境変数で渡してください。");
  process.exit(1);
}

const ADDRESSES = [
  "愛知県名古屋市中区栄三丁目",
  "愛知県名古屋市緑区鳴海町",
  "岐阜県岐阜市司町",
  "三重県桑名市中央町",
];
const LEVELS = ["SHK", "OAZ", "AZC"]; // 市区町村 / 大字 / 字丁目

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GeoJSON の座標を再帰的に全部集める */
function collectCoords(geom) {
  const out = [];
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") { out.push(c); return; }
    c.forEach(walk);
  };
  walk(geom && geom.coordinates);
  return out;
}

/**
 * 座標の並び順を実測で判定する。
 * 日本国内なら 経度≒122〜154 / 緯度≒20〜46 で重ならないため一意に決まる。
 */
function detectAxisOrder(coords) {
  if (!coords.length) return "unknown";
  const [a, b] = coords[0];
  const lonlat = a >= 122 && a <= 154 && b >= 20 && b <= 46;
  const latlon = b >= 122 && b <= 154 && a >= 20 && a <= 46;
  if (lonlat && !latlon) return "[lon,lat]";
  if (latlon && !lonlat) return "[lat,lon]";
  return "ambiguous";
}

function ringCounts(geom) {
  if (!geom) return null;
  if (geom.type === "Polygon") return (geom.coordinates || []).map((r) => r.length);
  if (geom.type === "MultiPolygon") return (geom.coordinates || []).flatMap((p) => p.map((r) => r.length));
  return null;
}

async function probe(address, level, seq) {
  const url = `${BASE}/search/address`
    + `?word=${encodeURIComponent(address)}`
    + `&address_level=${level}`
    + `&address_polygon=true`
    + `&datum=JGD`
    + `&limit=0,5`;

  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url, {
      headers: {
        "x-api-key": KEY,
        "Authorization": "referer",
        "Referer": REFERER,
      },
    });
    text = await res.text();
  } catch (e) {
    return { seq, address, level, error: `fetch_failed: ${e.message}`, latencyMs: Date.now() - t0 };
  }
  const latencyMs = Date.now() - t0;
  const bytes = Buffer.byteLength(text, "utf8");

  let data = null;
  try { data = JSON.parse(text); } catch { /* 非JSON */ }

  fs.writeFileSync(path.join(OUT_DIR, `raw-${seq}-${level}.json`), text);

  const rec = {
    seq, address, level,
    status: res.status,
    latencyMs,
    bytes,
    itemCount: null,
    matchedAddress: null,
    matchedLevel: null,
    polygonPresent: null,
    polygonIsNull: null,
    polygonRaw: null,     // 文字列で来るのか object で来るのか
    geoType: null,
    ringPointCounts: null,
    totalPoints: null,
    axisOrder: null,
    firstCoord: null,
    parseError: null,
    upstreamBody: null,
  };

  if (!data) { rec.parseError = "non_json"; rec.upstreamBody = text.slice(0, 300); return rec; }
  if (res.status !== 200) { rec.upstreamBody = text.slice(0, 300); return rec; }

  const items = (data.result && data.result.item) || [];
  rec.itemCount = items.length;
  if (!items.length) return rec;

  // 要求レベルと一致する item を優先。無ければ先頭。
  const it = items.find((x) => x.address_level === level) || items[0];
  rec.matchedAddress = it.address || it.name || null;
  rec.matchedLevel = it.address_level || null;

  const ap = it.address_polygon;
  rec.polygonPresent = ap !== undefined;
  rec.polygonIsNull = ap === null;
  if (ap == null) return rec;

  rec.polygonRaw = typeof ap; // "string" なら JSON.parse が必要
  let geom = ap;
  if (typeof ap === "string") {
    try { geom = JSON.parse(ap); } catch (e) { rec.parseError = `polygon_parse: ${e.message}`; return rec; }
  }
  // Feature でくるか geometry 単体でくるか
  const g = geom && geom.type === "Feature" ? geom.geometry : geom;
  rec.geoType = (g && g.type) || null;
  rec.topLevelType = (geom && geom.type) || null;
  rec.ringPointCounts = ringCounts(g);
  const coords = collectCoords(g);
  rec.totalPoints = coords.length;
  rec.axisOrder = detectAxisOrder(coords);
  rec.firstCoord = coords[0] || null;
  rec._geom = g; // sample 抽出用（summary からは落とす）
  return rec;
}


/**
 * 追加計測（BULK=1 のときだけ実行）
 * 「区まるごとの字丁目ポリゴンを一括取得したらどれくらいのコストか」を測る。
 * 周回機能でエリアを面として持つ場合の初期取り込みコストの見積り用。
 */
async function bulkProbe() {
  const word = "愛知県名古屋市緑区";
  const out = [];
  for (const withPoly of [true, false]) {
    const url = `${BASE}/search/address?word=${encodeURIComponent(word)}`
      + `&address_level=AZC&address_polygon=${withPoly}&datum=JGD&limit=0,1000`;
    const t0 = Date.now();
    const res = await fetch(url, {
      headers: { "x-api-key": KEY, "Authorization": "referer", "Referer": REFERER },
    });
    const text = await res.text();
    const latencyMs = Date.now() - t0;
    const data = JSON.parse(text);
    const items = (data.result && data.result.item) || [];
    const pts = items.reduce((n, it) => n + collectCoords(it.address_polygon).length, 0);
    const rec = {
      word, address_polygon: withPoly, status: res.status, latencyMs,
      bytes: Buffer.byteLength(text, "utf8"),
      hit: data.result && data.result.info && data.result.info.hit,
      itemCount: items.length, totalPoints: pts,
      bytesPerItem: Math.round(Buffer.byteLength(text, "utf8") / Math.max(items.length, 1)),
    };
    out.push(rec);
    console.log(`[BULK] polygon=${withPoly} status=${rec.status} ${rec.latencyMs}ms ${rec.bytes}B `
      + `hit=${rec.hit} items=${rec.itemCount} points=${rec.totalPoints} bytes/item=${rec.bytesPerItem}`);
    fs.writeFileSync(path.join(OUT_DIR, `raw-bulk-${withPoly}.json`), text);
    await sleep(300);
  }
  fs.writeFileSync(path.join(OUT_DIR, "bulk.json"), JSON.stringify(out, null, 2));
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  let seq = 0;
  let sampleSaved = false;

  for (const address of ADDRESSES) {
    for (const level of LEVELS) {
      seq += 1;
      if (seq > 20) { console.error("20件上限に達したため中断"); break; }
      const rec = await probe(address, level, seq);
      const geom = rec._geom; delete rec._geom;
      results.push(rec);
      console.log(
        `[${String(seq).padStart(2, "0")}] ${level} ${address}\n`
        + `     status=${rec.status} ${rec.latencyMs}ms ${rec.bytes}B items=${rec.itemCount}`
        + ` matched="${rec.matchedAddress}"(${rec.matchedLevel})\n`
        + `     polygon: present=${rec.polygonPresent} null=${rec.polygonIsNull} raw=${rec.polygonRaw}`
        + ` type=${rec.geoType} points=${rec.totalPoints} axis=${rec.axisOrder} first=${JSON.stringify(rec.firstCoord)}`
        + (rec.upstreamBody ? `\n     body: ${rec.upstreamBody}` : "")
        + (rec.parseError ? `\n     parseError: ${rec.parseError}` : "")
      );
      // 描画確認用に AZC のポリゴンを1件だけ保存
      if (!sampleSaved && geom && level === "AZC") {
        fs.writeFileSync(
          path.join(OUT_DIR, "sample.geojson"),
          JSON.stringify({ type: "Feature", properties: { address: rec.matchedAddress, level }, geometry: geom })
        );
        sampleSaved = true;
      }
      await sleep(300); // ゼンリン指定：直列＋間隔を空ける
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(results, null, 2));
  if (process.env.BULK === "1") await bulkProbe(); // +2リクエスト（合計14件）
  console.log(`\n合計 ${seq} リクエスト。出力: ${OUT_DIR}`);
})();
