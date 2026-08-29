/**
 * admin.html のエミュレータ分岐が「本番で絶対に発火しない」ことを、
 * ホスト名を偽装して検証する。
 *
 * admin.html の該当行を実ファイルから抜き出してそのまま評価する（写しではない）ので、
 * ソースを書き換えればこの検証も追随する。
 */
import fs from "node:fs";

const SRC = process.argv[2];
const html = fs.readFileSync(SRC, "utf8");

// ---- 1. 判定式を実ファイルから抜く ----
const m = html.match(/^\s*const IS_EMULATOR = (.+);\s*$/m);
if (!m) { console.error("✖ IS_EMULATOR の定義行が見つかりません"); process.exit(1); }
const expr = m[1];
console.log("判定式:", expr);

const apiM = html.match(/const AREAPOLY_API = IS_EMULATOR\s*\n\s*\?\s*(`[^`]+`)\s*\n\s*:\s*("[^"]+")/);
if (!apiM) { console.error("✖ AREAPOLY_API の三項が見つかりません"); process.exit(1); }

// ---- 2. 発火してはいけない条件が式に混ざっていないか ----
const FORBIDDEN = ["search", "searchParams", "URLSearchParams", "localStorage", "sessionStorage",
                   "cookie", "hash", "href", "referrer", "navigator", "process.env"];
const leaked = FORBIDDEN.filter(k => expr.includes(k));
if (leaked.length) {
  console.error(`✖ 判定式に hostname 以外の条件が混ざっています: ${leaked.join(", ")}`);
  process.exit(1);
}
console.log("✔ 判定式は location.hostname のみを見ている");

// ---- 3. connectFirestoreEmulator の呼び出しが if (IS_EMULATOR) の中だけか ----
const calls = [...html.matchAll(/connectFirestoreEmulator\s*\(/g)].length;
const guardedBlock = html.slice(html.indexOf("if (IS_EMULATOR) {"), html.indexOf("if (IS_EMULATOR) {") + 2000);
if (calls !== 1 || !guardedBlock.includes("connectFirestoreEmulator(db")) {
  console.error(`✖ connectFirestoreEmulator の呼び出しが想定外（${calls}箇所）`);
  process.exit(1);
}
console.log("✔ connectFirestoreEmulator は if (IS_EMULATOR) ブロック内の1箇所のみ");

// ---- 4. ホスト名を偽装して評価 ----
const CASES = [
  // [hostname, 期待値(エミュレータに繋ぐか), 説明]
  ["inuishingo.github.io",       false, "本番（GitHub Pages）"],
  ["housemarket-map.web.app",    false, "Firebase Hosting"],
  ["localhost",                  true,  "ローカル"],
  ["127.0.0.1",                  true,  "ローカル(IP)"],
  ["localhost.evil.com",         false, "localhost を接頭辞に持つ攻撃的ホスト名"],
  ["evil-localhost",             false, "localhost を接尾辞に持つホスト名"],
  ["mylocalhost",                false, "部分一致狙い"],
  ["127.0.0.1.nip.io",           false, "IPを接頭辞に持つ公開ホスト名"],
  ["localhost:8000",             false, "ポート付き（hostname にポートは入らない＝異常値）"],
  ["[::1]",                      false, "IPv6 ループバック（今回は対象外・繋がない）"],
  ["0.0.0.0",                    false, "0.0.0.0（対象外）"],
  ["",                           false, "file:// で開いた場合（hostname は空）"],
];

let ng = 0;
console.log("\nhostname                    期待   実際   判定");
console.log("─".repeat(58));
for (const [hostname, want, note] of CASES) {
  const location = { hostname };
  // 実ファイルから抜いた式をそのまま評価する
  const got = Function("location", `return (${expr});`)(location);
  const ok = got === want;
  if (!ok) ng++;
  console.log(
    `${JSON.stringify(hostname).padEnd(26)} ${String(want).padEnd(6)} ${String(got).padEnd(6)} ${ok ? "OK" : "★NG"}  ${note}`
  );
}

// ---- 5. AREAPOLY_API が本番ホストでは本番URLになること ----
const emuTpl = apiM[1], prodUrl = apiM[2];
for (const [hostname, want] of CASES) {
  const location = { hostname };
  const IS_EMULATOR = Function("location", `return (${expr});`)(location);
  const EMU_FUNCTIONS_PORT = 5001;
  const url = Function("IS_EMULATOR", "location", "EMU_FUNCTIONS_PORT",
    `return IS_EMULATOR ? ${emuTpl} : ${prodUrl};`)(IS_EMULATOR, location, EMU_FUNCTIONS_PORT);
  const isLocal = url.startsWith("http://");
  if (isLocal !== want) {
    console.error(`✖ AREAPOLY_API が想定外: hostname=${hostname} -> ${url}`);
    ng++;
  }
}
if (!ng) console.log("\n✔ AREAPOLY_API も本番ホストでは全て本番URLを返す");

console.log(ng === 0 ? "\n✔ 全ケース合格" : `\n✖ ${ng}件 不合格`);
process.exit(ng === 0 ? 0 : 1);
