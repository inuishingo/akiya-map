/**
 * verify-e1-batching.js ―― E-1 の純ロジック単体検証（2026-08-28）
 *
 * 目的: admin.html の「スキップ閾値(900,000B)」と「バッチ分割(400件 / 4MB)」を、
 *       実データで Firestore に一切書かずに検証する。
 *
 * 方式: admin.html の
 *         // ── ここから E-1 純ロジック ──
 *         // ── ここまで E-1 純ロジック ──
 *       で挟まれた区間を "そのまま" 抜き出して実行する。
 *       コピーではなく出荷されるソース自体を検証するため、写し間違いが起こらない。
 *
 * 実行:
 *   DATA=<midori-oaz.json のパス> node scripts/verify-e1-batching.js
 *     DATA は ZENRIN /search/address のレスポンス全文（address_code=23114 / OAZ / polygon付き）。
 */

const fs = require("fs");
const path = require("path");

const ADMIN = path.join(__dirname, "..", "admin.html");
const DATA = process.env.DATA || path.join(__dirname, "_probe_out", "midori-oaz.json");

// ── admin.html から純ロジック区間を抜き出してロードする ──
function loadPureLogic() {
  const html = fs.readFileSync(ADMIN, "utf8");
  const BEGIN = "// ── ここから E-1 純ロジック";
  const END = "// ── ここまで E-1 純ロジック";
  const i = html.indexOf(BEGIN);
  const j = html.indexOf(END);
  if (i < 0 || j < 0) throw new Error("admin.html に E-1 純ロジックのマーカーが見つからない");
  const src = html.slice(i, j);
  // TextEncoder は Node にもグローバルで存在するのでそのまま動く
  const factory = new Function(
    src + "\nreturn { areaPolyCountPoints, areaPolyBuildRows, areaPolySplitBatches,"
        + " AREAPOLY_MAX_DOC_BYTES, AREAPOLY_BATCH_MAX_DOCS, AREAPOLY_BATCH_MAX_BYTES };"
  );
  return factory();
}

const M = loadPureLogic();
const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
const items = raw.result.item;

const ok = [];
const ng = [];
const check = (cond, label) => (cond ? ok : ng).push(label);

console.log("=".repeat(78));
console.log("E-1 純ロジック検証（admin.html から抜き出したソースをそのまま実行）");
console.log("=".repeat(78));
console.log(`定数: MAX_DOC=${M.AREAPOLY_MAX_DOC_BYTES}B / BATCH_MAX_DOCS=${M.AREAPOLY_BATCH_MAX_DOCS}`
  + ` / BATCH_MAX_BYTES=${M.AREAPOLY_BATCH_MAX_BYTES}B (${(M.AREAPOLY_BATCH_MAX_BYTES / 1048576).toFixed(0)}MB)`);
console.log(`入力: ${path.basename(DATA)} … ${items.length}件\n`);

// ── ① 実データ105件の仕分け ──
console.log("── ① 実データ105件の仕分け ──");
const { rows, skipped } = M.areaPolyBuildRows(items, "23114");
const total = rows.reduce((n, r) => n + r.bytes, 0);
const max = rows.reduce((a, r) => (r.bytes > a.bytes ? r : a), rows[0]);
console.log(`保存対象 ${rows.length}件 / スキップ ${skipped.length}件`);
console.log(`合計 ${total}B (${(total / 1048576).toFixed(2)}MB) / 平均 ${Math.round(total / rows.length)}B`
  + ` / 最大 ${max.bytes}B（${max.data.name}）`);
console.log(`最大docでも上限の ${(max.bytes / M.AREAPOLY_MAX_DOC_BYTES * 100).toFixed(1)}% ＝ 実データではスキップが発火しない`);
check(rows.length === 105 && skipped.length === 0, "実データ105件が全件保存対象（スキップ0件）");
check(max.bytes < M.AREAPOLY_MAX_DOC_BYTES, "実データの最大docが 900,000B 未満");
check(rows.every(r => r.data.level === "OAZ" && r.data.cityCode === "23114" && r.data.parentCode === null),
  "level/cityCode/parentCode が全件仕様どおり");
check(rows.every(r => r.code.length === 8), "doc ID（address_code）が全件8桁");
check(rows.every(r => r.data.pointCount > 0), "pointCount が全件1以上");
const sample = rows.find(r => r.data.name === "鳴海町");
console.log(`鳴海町: ${sample.bytes}B / ${sample.data.pointCount}点 / ${sample.data.fullAddress}`);

// ── ② スキップ閾値(900,000B)が実際に発火するか ──
// 実データには94KB級までしか無く閾値に届かないため、境界をまたぐ合成データで確認する。
console.log("\n── ② スキップ閾値 900,000B の発火確認（境界値）──");
function inflate(item, targetBytes) {
  // 実データのポリゴンの座標を複製して膨らませる。構造はそのまま（MultiPolygon）。
  const clone = JSON.parse(JSON.stringify(item));
  const ring = clone.address_polygon.coordinates[0][0];
  while (new TextEncoder().encode(JSON.stringify(clone.address_polygon)).length < targetBytes) {
    clone.address_polygon.coordinates[0][0] = ring.concat(clone.address_polygon.coordinates[0][0]);
  }
  return clone;
}
const under = JSON.parse(JSON.stringify(items.find(i => i.address4 === "鳴海町")));  // 93,778B
const over = inflate(items.find(i => i.address4 === "鳴海町"), 900001);
const overBytes = new TextEncoder().encode(JSON.stringify(over.address_polygon)).length;
const r2 = M.areaPolyBuildRows([under, over], "23114");
console.log(`93,778B（閾値未満）→ ${r2.rows.length}件が保存対象`);
console.log(`${overBytes}B（閾値超過）→ スキップ: ${r2.skipped.map(k => k.reason).join(", ")}`);
check(r2.rows.length === 1 && r2.skipped.length === 1, "閾値未満は保存・超過はスキップに分かれる");
check(/上限超過/.test(r2.skipped[0].reason || ""), "スキップ理由が「1docの上限超過」として記録される");

// ポリゴンが null のケース（岐阜市司町のAZCのような未整備）も仕分けられるか
const nullCase = M.areaPolyBuildRows([{ address_code: "23114999", address4: "架空町", address_polygon: null }], "23114");
console.log(`address_polygon=null → スキップ: ${nullCase.skipped[0].reason}`);
check(nullCase.rows.length === 0 && /未整備/.test(nullCase.skipped[0].reason), "ポリゴン未整備(null)はスキップされる");
const badCode = M.areaPolyBuildRows([{ address_code: "231149", address4: "桁不正", address_polygon: { type: "MultiPolygon", coordinates: [[[[136, 35]]]] } }], "23114");
check(badCode.rows.length === 0 && /8桁/.test(badCode.skipped[0].reason), "住所コードが8桁でない行はスキップされる");

// ── ③ バッチ分割（400件 / 4MB の早い方）──
console.log("\n── ③ バッチ分割 ──");
function show(label, rs) {
  const bs = M.areaPolySplitBatches(rs);
  const lines = bs.map((b, i) => {
    const by = b.reduce((n, r) => n + r.bytes, 0);
    return `  batch${i + 1}: ${String(b.length).padStart(3)}件 / ${(by / 1048576).toFixed(2)}MB`;
  });
  console.log(`${label}: ${rs.length}件 → ${bs.length}バッチ`);
  lines.forEach(l => console.log(l));
  return bs;
}
// (a) 実データそのまま＝0.59MB / 105件 → 1バッチで収まるはず
const bA = show("(a) 実データ105件", rows);
check(bA.length === 1 && bA[0].length === 105, "実データ105件は1バッチ（400件・4MB のどちらにも当たらない）");

// (b) 実データを5倍に複製＝525件 → 件数上限400で切れるはず（合計2.95MBなのでサイズでは切れない）
const rowsB = [];
for (let k = 0; k < 5; k++) rows.forEach(r => rowsB.push({ ...r, code: r.code + "_" + k }));
const bB = show("(b) 実データ×5＝525件（合計2.95MB）", rowsB);
check(bB.length === 2 && bB[0].length === 400, "件数上限400で分割される");
check(bB.every(b => b.reduce((n, r) => n + r.bytes, 0) <= M.AREAPOLY_BATCH_MAX_BYTES), "(b)各バッチが4MB以内");

// (c) 大きいdocだけを並べる＝件数は少ないがサイズで切れるはず（鳴海町94KB × 100件＝9.4MB）
const big = rows.find(r => r.data.name === "鳴海町");
const rowsC = Array.from({ length: 100 }, (_, k) => ({ ...big, code: big.code + "_c" + k }));
const bC = show("(c) 94KB級×100件＝9.16MB", rowsC);
check(bC.length >= 3, "件数400未満でもサイズ上限4MBで分割される");
check(bC.every(b => b.reduce((n, r) => n + r.bytes, 0) <= M.AREAPOLY_BATCH_MAX_BYTES), "(c)各バッチが4MB以内");
check(bC.every(b => b.length <= M.AREAPOLY_BATCH_MAX_DOCS), "(c)各バッチが400件以内");
// 分割しても1件も落ちない／重複しない
const flat = bC.flat();
check(flat.length === rowsC.length && new Set(flat.map(r => r.code)).size === rowsC.length,
  "分割で件数の欠落・重複が起きない");

// ── 結果 ──
console.log("\n" + "=".repeat(78));
ok.forEach(l => console.log("  ✅ " + l));
ng.forEach(l => console.log("  ❌ " + l));
console.log(`合格 ${ok.length} / 不合格 ${ng.length}`);
console.log("※ Firestore への書き込みは1件も行っていない（純ロジックのみ）");
process.exit(ng.length ? 1 : 0);
