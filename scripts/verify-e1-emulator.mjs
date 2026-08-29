/**
 * verify-e1-emulator.mjs ―― E-1（行政界ポリゴン取込）のエミュレータ実走検証
 *
 * 目的: 本番にデプロイする前に「取込 → 再取込で doc が増えない」を実データで確認する。
 *       これまでは本番デプロイ後にしか確認できなかった工程。
 *
 * 何を通しで確かめるか:
 *   1. Functions エミュレータの areaPolygon が ZENRIN から緑区(23114)を取れる
 *   2. admin.html の E-1 純ロジック（抜き出して実行）が rows / batches を作れる
 *   3. firestore.rules（エミュレータが読み込んだ実物）の下で、管理者は areaPolygons に書ける
 *   4. 2回実行しても doc 件数が増えず、fetchedAt だけが更新される  ★本題
 *   5. 非管理者は書けない / ログイン済みなら読める（ルールの境界確認）
 *
 * 前提: 別ターミナルで `npm run emu` が起動していること。
 * 実行: node scripts/verify-e1-emulator.mjs
 *
 * ※ 書き込み先はエミュレータのみ。本番 Firestore には一切触れない
 *   （接続先は 127.0.0.1 固定で、本番エンドポイントを一度も呼ばない）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "housemarket-map";
const FS_HOST = "127.0.0.1:8080";                       // firebase.json の emulators.firestore.port
const FN_HOST = "127.0.0.1:5001";                       // 同 emulators.functions.port
const DOCS = `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const AREAPOLY = `http://${FN_HOST}/${PROJECT}/asia-northeast1/areaPolygon`;
const CITY = "23114";                                   // 名古屋市緑区
const ADMIN_UID = "emu-admin-uid";
const OTHER_UID = "emu-surveyor-uid";

let ng = 0;
const ok = (label) => console.log(`  ✔ ${label}`);
const fail = (label, detail) => { ng++; console.log(`  ★NG ${label}${detail ? `\n       ${detail}` : ""}`); };
const check = (cond, label, detail) => (cond ? ok(label) : fail(label, detail));

// ───────── エミュレータ用の偽IDトークン ─────────
// Firestore エミュレータは署名を検証しない（alg:none の JWT を受け付ける）。
// 本番の Auth には一切通用しない＝この検証はエミュレータ内に閉じている。
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function fakeIdToken(uid, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "none", kid: "fakekid", typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT, sub: uid, user_id: uid, email, email_verified: true,
    auth_time: now, iat: now, exp: now + 3600,
    firebase: { identities: { email: [email] }, sign_in_provider: "password" },
  };
  return `${b64u(header)}.${b64u(payload)}.`;
}
const AS_ADMIN = fakeIdToken(ADMIN_UID, "admin@example.test");
const AS_OTHER = fakeIdToken(OTHER_UID, "surveyor@example.test");
const AS_OWNER = "owner";   // ルールを迂回する管理用トークン（シード投入に使う）

async function fsApi(url, { method = "GET", body, token } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 空応答など */ }
  return { status: res.status, json, text };
}

// ───────── Firestore REST の値エンコード ─────────
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  throw new Error(`未対応の型: ${typeof v}`);
}
const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)]));

// ───────── admin.html から E-1 純ロジックを抜き出す ─────────
// verify-e1-batching.js と同じ方式。コピーではなく出荷されるソース自体を動かす。
function loadPureLogic() {
  const html = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  const i = html.indexOf("// ── ここから E-1 純ロジック");
  const j = html.indexOf("// ── ここまで E-1 純ロジック");
  if (i < 0 || j < 0) throw new Error("admin.html に E-1 純ロジックのマーカーが見つからない");
  return new Function(
    html.slice(i, j) + "\nreturn { areaPolyBuildRows, areaPolySplitBatches };"
  )();
}

/** admin.html の execAreaPolyImport と同じ順序で書き込む（batch単位 / 全上書き / fetchedAt はサーバ時刻）。 */
async function importOnce(M, items) {
  const { rows, skipped } = M.areaPolyBuildRows(items, CITY);
  const batches = M.areaPolySplitBatches(rows);
  for (const b of batches) {
    const writes = b.map(r => ({
      // updateMask を付けない＝全置換。admin.html の setDoc(merge なし) と同じ意味。
      update: {
        name: `projects/${PROJECT}/databases/(default)/documents/areaPolygons/${r.code}`,
        fields: toFields(r.data),
      },
      updateTransforms: [{ fieldPath: "fetchedAt", setToServerValue: "REQUEST_TIME" }],
    }));
    const res = await fsApi(
      `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`,
      { method: "POST", token: AS_ADMIN, body: { writes } }
    );
    if (res.status !== 200) {
      throw new Error(`commit 失敗 status=${res.status} ${res.text.slice(0, 400)}`);
    }
  }
  return { rows, skipped, batches };
}

/** admin.html の where("cityCode","==",CITY) と同じ絞り込みで件数と fetchedAt を取る。 */
async function queryCity(token = AS_ADMIN) {
  const res = await fsApi(`${DOCS}:runQuery`, {
    method: "POST", token,
    body: {
      structuredQuery: {
        from: [{ collectionId: "areaPolygons" }],
        where: {
          fieldFilter: { field: { fieldPath: "cityCode" }, op: "EQUAL", value: { stringValue: CITY } },
        },
      },
    },
  });
  if (res.status !== 200) return { status: res.status, docs: null, raw: res.text };
  const docs = (res.json || []).filter(r => r.document).map(r => ({
    id: r.document.name.split("/").pop(),
    name: r.document.fields.name && r.document.fields.name.stringValue,
    fetchedAt: r.document.fields.fetchedAt && r.document.fields.fetchedAt.timestampValue,
    pointCount: r.document.fields.pointCount && Number(r.document.fields.pointCount.integerValue),
    geometryJson: r.document.fields.geometryJson && r.document.fields.geometryJson.stringValue,
  }));
  return { status: 200, docs };
}

// ───────────────────────────── 面積 ─────────────────────────────
/**
 * GeoJSON の面積を km² で返す（球面ではなく局所平面近似。数十km四方なら誤差0.1%未満）。
 * リング index 0 を外環、以降を穴として引く。
 * 「点が範囲内にある」だけでは順序が壊れていても気づけないが、面積が公称値と合えば
 * 座標が正しい順序で閉じた面を成していることの裏が取れる。
 */
function areaKm2(g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let sum = 0;
  for (const poly of polys) {
    poly.forEach((ring, ri) => {
      // shoelace（度²）。緯度は中央値で経度方向を補正してから km に直す。
      let lat0 = 0;
      for (const [, lat] of ring) lat0 += lat;
      lat0 /= ring.length;
      const kx = 111.32 * Math.cos(lat0 * Math.PI / 180);   // 経度1度の km
      const ky = 110.57;                                    // 緯度1度の km
      let s = 0;
      for (let i = 0, n = ring.length - 1; i < n; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky);
      }
      sum += (ri === 0 ? 1 : -1) * Math.abs(s / 2);
    });
  }
  return sum;
}

// ───────────────────────────── 描画 ─────────────────────────────
/** Polygon / MultiPolygon のリングを順に渡す。 */
function eachRing(g, fn) {
  if (g.type === "Polygon") for (const r of g.coordinates) fn(r);
  else if (g.type === "MultiPolygon") for (const p of g.coordinates) for (const r of p) fn(r);
  else throw new Error(`想定外の GeoJSON type: ${g.type}`);
}

/**
 * 読み戻した GeoJSON だけで SVG を組む。地図ライブラリを介さずに
 * 「この座標列がそのまま面として描けるか」を確かめるのが目的。
 * 経度→X / 緯度→Y（上下反転）。緯度に cos 補正をかけて見た目の縦横比を合わせる。
 */
function writeSvg(geoms, outPath) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const x of geoms) {
    eachRing(x.g, ring => {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    });
  }
  const W = 1000, PAD = 12;
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);   // 経度1度は緯度1度より短い
  const spanX = (maxLng - minLng) * kx, spanY = maxLat - minLat;
  const scale = (W - PAD * 2) / spanX;
  const H = Math.round(spanY * scale + PAD * 2);
  const px = (lng) => (PAD + (lng - minLng) * kx * scale).toFixed(2);
  const py = (lat) => (PAD + (maxLat - lat) * scale).toFixed(2);

  const HUES = [200, 20, 140, 280, 45, 320, 100, 250];
  let points = 0, paths = 0, body = "";
  geoms.forEach((x, i) => {
    let d = "";
    eachRing(x.g, ring => {
      d += ring.map(([lng, lat], k) => `${k ? "L" : "M"}${px(lng)},${py(lat)}`).join(" ") + " Z ";
      points += ring.length;
    });
    const h = HUES[i % HUES.length];
    const label = String(x.name || x.id).replace(/[<>&]/g, "");
    body += `<path d="${d.trim()}" fill="hsl(${h} 70% 62% / 0.45)" stroke="hsl(${h} 70% 32%)" stroke-width="0.7">`
          + `<title>${label}（${x.id}）</title></path>\n`;
    paths++;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#f8fafc"/>
<g fill-rule="evenodd">
${body}</g>
<text x="${PAD}" y="${H - 6}" font-family="sans-serif" font-size="11" fill="#475569">名古屋市緑区(23114) 大字${paths}件 / ${points.toLocaleString()}点 — Firestoreエミュレータから読み戻した geometryJson のみで描画</text>
</svg>
`;
  fs.writeFileSync(outPath, svg, "utf8");
  return { paths, points, width: W, height: H };
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  console.log("=".repeat(74));
  console.log("E-1 エミュレータ実走検証（書き込み先は 127.0.0.1 のエミュレータのみ）");
  console.log("=".repeat(74));

  // 0) エミュレータの生存確認
  const ping = await fetch(`http://${FS_HOST}/`).catch(() => null);
  if (!ping) {
    console.error(`\n✖ Firestore エミュレータ(${FS_HOST})に繋がりません。別ターミナルで npm run emu を起動してください。`);
    process.exit(1);
  }

  // 1) 前の実行の残りを消してから始める（件数比較の前提を揃える）
  console.log("\n── 0. 準備 ──");
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  ok("エミュレータのデータを初期化");
  // 管理者シード。rules は admins/{uid} に allow write:false なので、ルールを迂回する owner で入れる。
  const seed = await fsApi(`${DOCS}/admins?documentId=${ADMIN_UID}`, {
    method: "POST", token: AS_OWNER, body: { fields: toFields({ note: "emulator seed" }) },
  });
  check(seed.status === 200, `admins/${ADMIN_UID} をシード`, `status=${seed.status} ${seed.text.slice(0, 200)}`);

  // 2) Functions エミュレータから緑区を取得
  console.log("\n── 1. Functions エミュレータ areaPolygon（緑区 23114） ──");
  const t0 = Date.now();
  const res = await fetch(`${AREAPOLY}?cityCode=${CITY}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`\n✖ areaPolygon が失敗しました status=${res.status} ${JSON.stringify(j).slice(0, 300)}`);
    console.error("  ZENRIN_KEY を解決できていない可能性があります。docs/local-dev.md を参照。");
    process.exit(1);
  }
  const items = j.item || [];
  console.log(`  hit=${j.hit} count=${j.count} bytes=${j.bytes} 取得 ${(Date.now() - t0) / 1000}秒`);
  check(items.length === 105, `緑区の大字が105件取れた（実測値と一致）`, `実際=${items.length}件`);

  // 3) 1回目の取込
  console.log("\n── 2. 1回目の取込 ──");
  const M = loadPureLogic();
  const r1 = await importOnce(M, items);
  const q1 = await queryCity();
  console.log(`  rows=${r1.rows.length} skipped=${r1.skipped.length} batches=${r1.batches.length}`);
  check(q1.status === 200 && q1.docs.length === r1.rows.length,
    `areaPolygons に ${r1.rows.length}件 書き込めた（ルール allow write: isAdmin を通過）`,
    `status=${q1.status} docs=${q1.docs && q1.docs.length}`);

  // 4) 2回目の取込 ★本題（doc が増えないこと / fetchedAt が更新されること）
  console.log("\n── 3. 2回目の取込（重複チェック） ──");
  await new Promise(r => setTimeout(r, 1100));   // fetchedAt の差を秒単位で見えるようにする
  const r2 = await importOnce(M, items);
  const q2 = await queryCity();
  check(q2.docs.length === q1.docs.length,
    `doc 件数が増えていない（${q1.docs.length} → ${q2.docs.length}）`,
    `1回目=${q1.docs.length} 2回目=${q2.docs.length}`);
  check(r2.rows.length === r1.rows.length, `取込対象の件数も同じ（${r2.rows.length}件）`);

  const before = new Map(q1.docs.map(d => [d.id, d.fetchedAt]));
  const updated = q2.docs.filter(d => before.get(d.id) !== d.fetchedAt).length;
  check(updated === q2.docs.length, `全 ${q2.docs.length}件の fetchedAt が更新された`, `更新されたのは ${updated}件`);

  const sameGeom = q2.docs.every(d => {
    const b = q1.docs.find(x => x.id === d.id);
    return b && b.geometryJson === d.geometryJson && b.pointCount === d.pointCount;
  });
  check(sameGeom, "geometryJson / pointCount は2回とも同一（純キャッシュとして冪等）");

  // 5) 読み出しと描画 ★E-1 の出口。ここが通れば地図に載せられる
  console.log("\n── 4. 読み出しと描画 ──");

  // a. 全件 JSON.parse できるか（1件でも壊れていれば地図が落ちる）
  const geoms = [];
  let parseNg = 0;
  for (const d of q2.docs) {
    try { geoms.push({ id: d.id, name: d.name, pointCount: d.pointCount, g: JSON.parse(d.geometryJson) }); }
    catch { parseNg++; }
  }
  check(parseNg === 0 && geoms.length === q2.docs.length,
    `全${q2.docs.length}件が JSON.parse できる`, `失敗 ${parseNg}件`);

  // b. GeoJSON として成立しているか（type / リング閉合 / 座標の並びと範囲）
  const types = new Set(geoms.map(x => x.g.type));
  check([...types].every(t => t === "Polygon" || t === "MultiPolygon"),
    `type は Polygon / MultiPolygon のみ（${[...types].join(", ")}）`);

  let openRing = 0, shortRing = 0, outOfBox = 0, ptTotal = 0, mismatchCount = 0;
  // 緑区(23114)が入る範囲。ここを外れる＝[lat,lng] 逆転や桁落ちが起きている。
  const BOX = { minLng: 136.8, maxLng: 137.2, minLat: 34.9, maxLat: 35.3 };
  for (const x of geoms) {
    let n = 0;
    eachRing(x.g, ring => {
      if (ring.length < 4) shortRing++;
      const a = ring[0], b = ring[ring.length - 1];
      if (!a || !b || a[0] !== b[0] || a[1] !== b[1]) openRing++;
      for (const [lng, lat] of ring) {
        n++;
        if (lng < BOX.minLng || lng > BOX.maxLng || lat < BOX.minLat || lat > BOX.maxLat) outOfBox++;
      }
    });
    ptTotal += n;
    if (n !== x.pointCount) mismatchCount++;
  }
  check(openRing === 0, "全リングが閉じている（先頭座標＝末尾座標）", `未閉合 ${openRing}リング`);
  check(shortRing === 0, "全リングが4点以上", `4点未満 ${shortRing}リング`);
  check(outOfBox === 0, `全${ptTotal.toLocaleString()}点が [経度, 緯度] の順で緑区の範囲内`, `範囲外 ${outOfBox}点`);
  check(mismatchCount === 0, "保存した pointCount と実際の点数が全件一致", `不一致 ${mismatchCount}件`);

  // c. 往復無損失。ZENRIN の生レスポンスと、Firestore から読み戻した値が完全一致すること。
  //    admin.html は座標に一切手を加えない設計なので、ここがズレたら設計違反。
  const upstream = new Map(items.map(it => [String(it.address_code), it.address_polygon]));
  const lossy = geoms.filter(x => JSON.stringify(upstream.get(x.id)) !== JSON.stringify(x.g));
  check(lossy.length === 0,
    "ZENRIN の生レスポンスと読み戻した GeoJSON が完全一致（往復無損失）",
    `食い違い ${lossy.length}件（例 ${lossy[0] && lossy[0].id}）`);

  // d. 面積と外形。座標が「正しい順序で閉じた面」を成しているかの裏取り。
  const total = geoms.reduce((n, x) => n + areaKm2(x.g), 0);
  const bbox = geoms.reduce((b, x) => {
    eachRing(x.g, ring => {
      for (const [lng, lat] of ring) {
        b.minLng = Math.min(b.minLng, lng); b.maxLng = Math.max(b.maxLng, lng);
        b.minLat = Math.min(b.minLat, lat); b.maxLat = Math.max(b.maxLat, lat);
      }
    });
    return b;
  }, { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity });
  const MIDORI_KM2 = 37.91;   // 名古屋市緑区の公称面積
  const diff = Math.abs(total - MIDORI_KM2) / MIDORI_KM2;
  console.log(`    合計面積 ${total.toFixed(2)}km²（公称 ${MIDORI_KM2}km² / 差 ${(diff * 100).toFixed(1)}%）`);
  console.log(`    外接矩形 経度 ${bbox.minLng.toFixed(4)}〜${bbox.maxLng.toFixed(4)} / 緯度 ${bbox.minLat.toFixed(4)}〜${bbox.maxLat.toFixed(4)}`);
  check(diff < 0.05, `105件の合計面積が緑区の公称面積と一致（誤差5%以内）`, `差 ${(diff * 100).toFixed(1)}%`);

  // e. 実際に描く。読み戻した座標だけで緑区の形になることを目視できるようにする。
  const svgPath = path.join(ROOT, "tmp", "e1-midori-preview.svg");
  fs.mkdirSync(path.dirname(svgPath), { recursive: true });
  const drawn = writeSvg(geoms, svgPath);
  check(drawn.paths === geoms.length && drawn.points === ptTotal,
    `${drawn.paths}件・${drawn.points.toLocaleString()}点を SVG に描画`, JSON.stringify(drawn));
  console.log(`    → ${path.relative(ROOT, svgPath)}（ブラウザで開くと緑区の形が見える。ホバーで大字名）`);

  // 6) ルールの境界
  console.log("\n── 5. firestore.rules の境界確認 ──");
  const writeAsOther = await fsApi(
    `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`,
    { method: "POST", token: AS_OTHER,
      body: { writes: [{ update: { name: `projects/${PROJECT}/databases/(default)/documents/areaPolygons/99999999`, fields: toFields({ code: "99999999" }) } }] } }
  );
  check(writeAsOther.status === 403, "非管理者は areaPolygons に書けない（403）", `status=${writeAsOther.status}`);
  const readAsOther = await queryCity(AS_OTHER);
  check(readAsOther.status === 200 && readAsOther.docs.length === q2.docs.length,
    "ログイン済みなら管理者でなくても読める", `status=${readAsOther.status}`);

  console.log("\n" + "=".repeat(74));
  console.log(ng === 0 ? "✔ 全項目 合格" : `✖ ${ng}件 不合格`);
  console.log("=".repeat(74));
  process.exit(ng === 0 ? 0 : 1);
}

main().catch(e => { console.error("\n✖", e.stack || e.message); process.exit(1); });
