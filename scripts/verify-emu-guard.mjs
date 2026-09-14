/**
 * admin.html のエミュレータ分岐が「本番で絶対に発火しない」ことを、
 * ホスト名と URL パラメータを偽装して検証する。
 *
 * admin.html の該当行を実ファイルから抜き出してそのまま評価する（写しではない）ので、
 * ソースを書き換えればこの検証も追随する。
 *
 * 【守る性質】（2026-09-08 の opt-in 化・U-1 の Auth エミュレータ追加に追随）
 *   - IS_LOCALHOST は location.hostname だけで決まる
 *   - IS_EMULATOR = IS_LOCALHOST「かつ」?emu=1。URL パラメータは条件を「狭める」ためだけに使う
 *     ＝本番のホスト名では、どんなパラメータを付けても true にならない
 *   - IS_AUTH_EMULATOR = IS_EMULATOR「かつ」?authEmu=1（IS_EMULATOR が false なら必ず false）
 *   - 判定式に OR（||）や、本番URLでも成立しうる条件（localStorage・cookie・hash・referrer 等）を混ぜない
 *   - connectFirestoreEmulator / connectFunctionsEmulator は if (IS_EMULATOR) の中の1箇所だけ、
 *     connectAuthEmulator は if (IS_AUTH_EMULATOR) の中の1箇所だけ
 *   - AREAPOLY_API は本番ホストでは必ず本番URL
 */
import fs from "node:fs";

const SRC = process.argv[2];
if (!SRC) { console.error("使い方: node scripts/verify-emu-guard.mjs admin.html"); process.exit(1); }
const html = fs.readFileSync(SRC, "utf8");
let ng = 0;
const fail = msg => { console.error(`✖ ${msg}`); ng++; };

// ---- 1. 判定式を実ファイルから抜く ----
function exprOf(name) {
  const m = html.match(new RegExp(`^\\s*const ${name} = (.+);\\s*$`, "m"));
  if (!m) { console.error(`✖ ${name} の定義行が見つかりません`); process.exit(1); }
  return m[1];
}
const exprLocal = exprOf("IS_LOCALHOST");
const exprEmu = exprOf("IS_EMULATOR");
const exprAuth = exprOf("IS_AUTH_EMULATOR");
console.log("IS_LOCALHOST     :", exprLocal);
console.log("IS_EMULATOR      :", exprEmu);
console.log("IS_AUTH_EMULATOR :", exprAuth);

const apiM = html.match(/const AREAPOLY_API = IS_EMULATOR\s*\n\s*\?\s*(`[^`]+`)\s*\n\s*:\s*("[^"]+")/);
if (!apiM) { console.error("✖ AREAPOLY_API の三項が見つかりません"); process.exit(1); }

// ---- 2. 判定式の形（静的チェック）----
// IS_LOCALHOST は「location.hostname === "固定文字列"」を || でつないだ形だけを許す（部分一致・パラメータ等は不可）
const HOST_EQ = String.raw`location\.hostname\s*===\s*"[^"]+"`;
if (!new RegExp(String.raw`^${HOST_EQ}(\s*\|\|\s*${HOST_EQ})*$`).test(exprLocal.trim())) {
  fail("IS_LOCALHOST が「location.hostname === \"固定文字列\"」の OR だけになっていません（hostname の完全一致だけで決めること）");
}
// IS_EMULATOR / IS_AUTH_EMULATOR は AND で狭めるだけ。OR や本番URLでも成立しうる条件を混ぜない
const FORBIDDEN = ["localStorage", "sessionStorage", "cookie", "hash", "href", "referrer", "navigator", "process.env", "||", "??"];
for (const [name, expr] of [["IS_EMULATOR", exprEmu], ["IS_AUTH_EMULATOR", exprAuth]]) {
  const leaked = FORBIDDEN.filter(k => expr.includes(k));
  if (leaked.length) fail(`${name} に本番でも成立しうる条件／OR が混ざっています: ${leaked.join(", ")}`);
}
if (!/^IS_LOCALHOST\s*&&/.test(exprEmu)) fail("IS_EMULATOR が「IS_LOCALHOST && …」の形になっていません（パラメータは絞り込みにだけ使う）");
if (!/^IS_EMULATOR\s*&&/.test(exprAuth)) fail("IS_AUTH_EMULATOR が「IS_EMULATOR && …」の形になっていません");
if (!ng) console.log("✔ 判定式の形：hostname で決めた IS_LOCALHOST を、パラメータで AND 絞り込みしているだけ");

// ---- 3. connect*Emulator の呼び出し位置（静的チェック）----
function blockAfter(marker) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + marker.length - 1; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}
const emuBlock = blockAfter("if (IS_EMULATOR) {");
const authBlock = blockAfter("if (IS_AUTH_EMULATOR) {");
if (!emuBlock) fail("if (IS_EMULATOR) { … } ブロックが見つかりません");
for (const [fn, block, where] of [
  ["connectFirestoreEmulator", emuBlock, "if (IS_EMULATOR)"],
  ["connectFunctionsEmulator", emuBlock, "if (IS_EMULATOR)"],
  ["connectAuthEmulator", authBlock, "if (IS_AUTH_EMULATOR)"],
]) {
  const calls = [...html.matchAll(new RegExp(`${fn}\\s*\\(`, "g"))].length;
  if (calls !== 1) { fail(`${fn} の呼び出しが ${calls} 箇所（1箇所であること）`); continue; }
  if (!block || !new RegExp(`${fn}\\s*\\(`).test(block)) fail(`${fn} が ${where} ブロックの外にあります`);
}
if (authBlock && !emuBlock.includes(authBlock)) fail("if (IS_AUTH_EMULATOR) が if (IS_EMULATOR) の内側にありません");
if (!ng) console.log("✔ connectFirestoreEmulator / connectFunctionsEmulator は IS_EMULATOR 内、connectAuthEmulator は IS_AUTH_EMULATOR 内の各1箇所");

// ---- 4. ホスト名 × URL パラメータを偽装して評価 ----
const HOSTS = [
  // [hostname, ローカル扱いか, 説明]
  ["inuishingo.github.io",    false, "本番（GitHub Pages）"],
  ["housemarket-map.web.app", false, "Firebase Hosting"],
  ["localhost",               true,  "ローカル"],
  ["127.0.0.1",               true,  "ローカル(IP)"],
  ["localhost.evil.com",      false, "localhost を接頭辞に持つ攻撃的ホスト名"],
  ["evil-localhost",          false, "localhost を接尾辞に持つホスト名"],
  ["mylocalhost",             false, "部分一致狙い"],
  ["127.0.0.1.nip.io",        false, "IPを接頭辞に持つ公開ホスト名"],
  ["localhost:8000",          false, "ポート付き（hostname にポートは入らない＝異常値）"],
  ["[::1]",                   false, "IPv6 ループバック（対象外・繋がない）"],
  ["0.0.0.0",                 false, "0.0.0.0（対象外）"],
  ["",                        false, "file:// で開いた場合（hostname は空）"],
];
const SEARCHES = [
  // [search, emu=1 か, authEmu=1 か]
  ["",                    false, false],
  ["?emu=1",              true,  false],
  ["?emu=1&authEmu=1",    true,  true],
  ["?authEmu=1",          false, true],
  ["?emu=0&authEmu=1",    false, true],
  ["?emu=true",           false, false],
  ["?EMU=1",              false, false],
  ["?emu=1&emu=0",        true,  false],   // URLSearchParams.get は最初の値
];
const evalFlags = (hostname, search) => {
  const location = { hostname, search };
  const IS_LOCALHOST = Function("location", `return (${exprLocal});`)(location);
  const IS_EMULATOR = Function("location", "IS_LOCALHOST", "URLSearchParams", `return (${exprEmu});`)(location, IS_LOCALHOST, URLSearchParams);
  const IS_AUTH_EMULATOR = Function("location", "IS_EMULATOR", "URLSearchParams", `return (${exprAuth});`)(location, IS_EMULATOR, URLSearchParams);
  return { IS_LOCALHOST, IS_EMULATOR, IS_AUTH_EMULATOR };
};

console.log("\nhostname                  search              EMU(期待/実際)  AUTH(期待/実際)  判定");
console.log("─".repeat(96));
let rows = 0;
for (const [hostname, local, note] of HOSTS) {
  for (const [search, emuParam, authParam] of SEARCHES) {
    const wantEmu = local && emuParam;
    const wantAuth = wantEmu && authParam;
    const got = evalFlags(hostname, search);
    const ok = got.IS_LOCALHOST === local && got.IS_EMULATOR === wantEmu && got.IS_AUTH_EMULATOR === wantAuth;
    rows++;
    if (!ok) ng++;
    // 本番ホスト（ローカル扱いでない）は1行目だけ出して、NG の時は全部出す
    if (!ok || search === "" || local) {
      console.log(`${JSON.stringify(hostname).padEnd(25)} ${JSON.stringify(search).padEnd(19)} ${String(wantEmu).padEnd(5)}/${String(got.IS_EMULATOR).padEnd(9)} ${String(wantAuth).padEnd(5)}/${String(got.IS_AUTH_EMULATOR).padEnd(10)} ${ok ? "OK" : "★NG"}  ${search === "" ? note : ""}`);
    }
  }
}
console.log(`（${HOSTS.length} ホスト × ${SEARCHES.length} パラメータ = ${rows} ケースを評価。本番系ホストは NG 以外の行を省略）`);

// ---- 5. AREAPOLY_API が本番ホストでは本番URLになること ----
const emuTpl = apiM[1], prodUrl = apiM[2];
let apiNg = 0;
for (const [hostname, local] of HOSTS) {
  for (const [search, emuParam] of SEARCHES) {
    const { IS_EMULATOR } = evalFlags(hostname, search);
    const location = { hostname, search };
    const url = Function("IS_EMULATOR", "location", "EMU_FUNCTIONS_PORT",
      `return IS_EMULATOR ? ${emuTpl} : ${prodUrl};`)(IS_EMULATOR, location, 5001);
    if (url.startsWith("http://") !== (local && emuParam)) {
      console.error(`✖ AREAPOLY_API が想定外: hostname=${hostname} search=${search} -> ${url}`);
      apiNg++;
    }
  }
}
ng += apiNg;
if (!apiNg) console.log("✔ AREAPOLY_API は本番ホストではパラメータに関わらず全て本番URLを返す");

console.log(ng === 0 ? "\n✔ 全ケース合格" : `\n✖ ${ng}件 不合格`);
process.exit(ng === 0 ? 0 : 1);
