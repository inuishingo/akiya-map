/**
 * verify-e1-geojson-roundtrip.js ―― E-1 の GeoJSON 往復検証ページを生成する（2026-08-28）
 *
 * 目的: Firestore に入れる形（geometryJson＝文字列）から取り出した GeoJSON が、
 *       ゼンリンのレスポンスと座標レベルで完全一致し、かつ L.geoJSON() に
 *       無加工で渡して描画できることを、実データ全件で確かめる。
 *
 *   ZENRIN の address_polygon
 *     → JSON.stringify（＝admin.html が Firestore に保存する形）
 *     → JSON.parse（＝読み出し側がやること）
 *     → L.geoJSON() にそのまま渡す
 *   の各段で座標が1つもズレていないかを検証する。
 *
 * 使い方:
 *   DATA=<midori-oaz.json> OUT=<出力先ディレクトリ> node scripts/verify-e1-geojson-roundtrip.js
 *   → 生成された HTML をヘッドレスChromeで開き、#out のJSONを読む。
 *
 * 注意: Firestore には接続しない（往復は文字列化/復元のみで再現できる）。
 */

const fs = require("fs");
const path = require("path");

const DATA = process.env.DATA || path.join(__dirname, "_probe_out", "midori-oaz.json");
const OUT = process.env.OUT || path.join(__dirname, "_probe_out");

const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
// 検証に必要な最小限（名前・コード・ポリゴン）だけをページに埋める
const data = raw.result.item.map(it => ({
  code: it.address_code,
  name: it.address4 || it.address,
  polygon: it.address_polygon,
}));

const html = `<!doctype html>
<meta charset="utf-8">
<title>E-1 geometryJson 往復検証</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body{margin:0}#map{height:400px}#out{font:12px monospace;white-space:pre-wrap;padding:8px}</style>
<div id="map"></div>
<div id="out">running…</div>
<script>
const ITEMS = ${JSON.stringify(data)};

const map = L.map("map").setView([35.06, 136.95], 12);

// GeoJSON の coordinates を出現順にすべて平坦化する
function flatCoords(geom) {
  const out = [];
  (function walk(c) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") { out.push(c); return; }
    for (const x of c) walk(x);
  })(geom.coordinates);
  return out;
}
// Leaflet が保持している LatLng を出現順にすべて平坦化する
function flatLatLngs(v) {
  const out = [];
  (function walk(x) {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (x && typeof x.lat === "number") out.push(x);
  })(v);
  return out;
}

const fail = [];
let totalPoints = 0, totalLatLngs = 0, rendered = 0, closedRingsDropped = 0;
let biggest = { name: null, bytes: 0 };

for (const it of ITEMS) {
  // ① admin.html が保存する形にする（stringify）→ 読み出し側がやる形に戻す（parse）
  const geometryJson = JSON.stringify(it.polygon);
  const bytes = new TextEncoder().encode(geometryJson).length;
  const restored = JSON.parse(geometryJson);
  if (bytes > biggest.bytes) biggest = { name: it.name, bytes };

  // ② 文字列往復で構造・座標が完全一致するか（型・順序・桁まで）
  if (JSON.stringify(restored) !== JSON.stringify(it.polygon)) fail.push(it.name + ": 往復で不一致");
  if (restored.type !== it.polygon.type) fail.push(it.name + ": type が変化");

  const src = flatCoords(it.polygon);
  const dst = flatCoords(restored);
  totalPoints += src.length;
  if (src.length !== dst.length) fail.push(it.name + ": 点数が変化 " + src.length + "→" + dst.length);
  for (let i = 0; i < src.length; i++) {
    // === で比較。丸めや入れ替えが起きていれば必ず落ちる
    if (src[i][0] !== dst[i][0] || src[i][1] !== dst[i][1]) { fail.push(it.name + ": 座標[" + i + "]が変化"); break; }
  }

  // ③ 復元した geometry を「無加工で」 L.geoJSON() に渡す（座標の入れ替えもFeature化もしない）
  let layer;
  try { layer = L.geoJSON(restored); } catch (e) { fail.push(it.name + ": L.geoJSON() が例外 " + e.message); continue; }
  const layers = layer.getLayers();
  if (!layers.length) { fail.push(it.name + ": レイヤが生成されない"); continue; }
  rendered++;

  // ④ Leaflet が実際に保持している緯度経度が、元の [経度,緯度] と一致するか
  //    （lat=coords[1] / lng=coords[0]。逆に読まれていればここで落ちる）
  const lls = flatLatLngs(layers.map(l => l.getLatLngs()));
  totalLatLngs += lls.length;
  // Leaflet は閉じたリングの最終点（先頭と同一）を捨てる。これは仕様上の正常動作なので、
  // 元座標から同じルールで最終点を落としてから突き合わせる。
  const expect = [];
  (function walkRings(c, depth) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") return;
    if (typeof c[0][0] === "number") {   // ここがリング
      const ring = c.slice();
      if (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
        ring.pop(); closedRingsDropped++;
      }
      expect.push(...ring);
      return;
    }
    for (const x of c) walkRings(x, depth + 1);
  })(restored.coordinates, 0);

  if (lls.length !== expect.length) {
    fail.push(it.name + ": Leaflet の点数が想定外 " + lls.length + " vs " + expect.length);
  } else {
    for (let i = 0; i < expect.length; i++) {
      if (lls[i].lat !== expect[i][1] || lls[i].lng !== expect[i][0]) {
        fail.push(it.name + ": Leaflet の座標[" + i + "] が不一致 "
          + "(" + lls[i].lat + "," + lls[i].lng + ") vs (" + expect[i][1] + "," + expect[i][0] + ")");
        break;
      }
    }
  }
}

// 最大サイズ（鳴海町94KB級）を実際に地図へ描き、SVGパスが出ることまで見る
const big = ITEMS.reduce((a, b) =>
  JSON.stringify(b.polygon).length > JSON.stringify(a.polygon).length ? b : a);
const bigLayer = L.geoJSON(JSON.parse(JSON.stringify(big.polygon)), { style: { color: "#e2402a" } }).addTo(map);
map.fitBounds(bigLayer.getBounds());

document.getElementById("out").textContent = JSON.stringify({
  items: ITEMS.length,
  rendered,
  totalPoints,
  totalLatLngs,
  closedRingsDropped,
  biggest: biggest.name + " " + biggest.bytes + "B",
  drawnOnMap: big.name,
  drawnBounds: bigLayer.getBounds().toBBoxString(),
  svgPaths: document.querySelectorAll("#map path").length,
  failures: fail.length,
  failureDetail: fail.slice(0, 5),
}, null, 1);
</script>
`;

fs.mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, "verify-e1-roundtrip.html");
fs.writeFileSync(outFile, html);
console.log("generated:", outFile, `(${data.length}件 / ${(html.length / 1048576).toFixed(2)}MB)`);
