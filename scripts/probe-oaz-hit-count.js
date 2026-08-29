/**
 * probe-oaz-hit-count.js  ―― E-1 事前調査（2026-08-28）
 *
 * 目的: 取込対象の市区町村について、大字(OAZ)が何件あるかを実測する。
 *       areaPolygon プロキシは limit=0,1000 の1回取得なので、
 *       1000件を超える市区町村が実在するなら分割取得の実装が要る。その判断材料。
 *
 * 方式: scripts/probe-address-polygon.js と同じ直叩き（Functions を経由しない）。
 *       address_polygon=false・limit=0,1 で「hit件数だけ」を取る＝1市区町村あたり1リクエスト。
 *       hit はlimitに関係なく総件数を返すため、これで足りる（レスポンスも数百バイトで済む）。
 *
 * 実行:
 *   ZENRIN_KEY=$(firebase functions:secrets:access ZENRIN_KEY) node scripts/probe-oaz-hit-count.js
 */

const fs = require("fs");
const path = require("path");

const BASE = "https://test-web.zmaps-api.com";
const REFERER = "https://inuishingo.github.io/";
const KEY = process.env.ZENRIN_KEY;
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, "_probe_out");

if (!KEY) {
  console.error("ZENRIN_KEY が未設定です。firebase functions:secrets:access ZENRIN_KEY で渡してください。");
  process.exit(1);
}

// 対象: 名古屋市16区（23101〜23116）＋ 岐阜市/大垣市/桑名市/四日市市/いなべ市。
// ※ 本来は Firestore の pins.areaCode から抽出する指示だが、本段階は Firestore 読み取りを
//    行わない方針のため、指示書のフォールバック一覧をそのまま対象にしている。
const CITY_CODES = [
  ...Array.from({ length: 16 }, (_, i) => String(23101 + i)),
  "21201", // 岐阜市
  "21202", // 大垣市
  "24205", // 桑名市
  "24202", // 四日市市
  "24214", // いなべ市
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hitCount(cityCode) {
  // address_polygon は付けない（false）。limit=0,1 でも info.hit は総件数が返る。
  const url = `${BASE}/search/address`
    + `?address_code=${cityCode}&code_match_type=2`
    + `&address_level=OAZ&address_polygon=false&datum=JGD&limit=0,1`;
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { "x-api-key": KEY, "Authorization": "referer", "Referer": REFERER },
  });
  const text = await res.text();
  const latencyMs = Date.now() - t0;
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非JSON */ }
  if (!res.ok || !data) {
    return { cityCode, status: res.status, latencyMs, error: text.slice(0, 200) };
  }
  const item = (data.result && data.result.item) || [];
  const hit = (data.result && data.result.info && data.result.info.hit) || 0;
  return {
    cityCode,
    status: res.status,
    latencyMs,
    bytes: Buffer.byteLength(text, "utf8"),
    hit,
    over1000: hit > 1000,
    // 表示名は先頭itemから拾う（address3＝市区町村名。政令市は「名古屋市緑区」形式）
    name: item[0] ? (item[0].address3 || item[0].address || "") : "",
    pref: item[0] ? (item[0].address2 || "") : "",
    sample: item[0] ? item[0].address : "",
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const code of CITY_CODES) {
    const r = await hitCount(code);
    rows.push(r);
    console.log(
      `${code} ${String(r.name || "?").padEnd(12, "　")} hit=${String(r.hit ?? "-").padStart(5)} `
      + `${r.over1000 ? "★1000超" : "      "} ${r.latencyMs}ms ${r.bytes ?? "-"}B`
      + (r.error ? `  ERROR: ${r.error}` : "")
    );
    await sleep(300); // 直列＋300ms（ゼンリン指定）
  }
  fs.writeFileSync(path.join(OUT_DIR, "oaz-hit-count.json"), JSON.stringify(rows, null, 2));
  const over = rows.filter((r) => r.over1000);
  console.log(`\n${rows.length}市区町村 / 1000件超 ${over.length}件`
    + (over.length ? `：${over.map((r) => `${r.name}(${r.hit})`).join(", ")}` : ""));
})();
