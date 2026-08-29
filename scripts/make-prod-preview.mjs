/**
 * make-prod-preview.mjs ―― admin.html の「本番接続固定」コピーを作る
 *
 * 用途：デプロイ後に、ローカルのブラウザから本番の Cloud Functions / Firestore を
 *       相手にして動作確認したいとき。
 *
 * admin.html は localhost で開くと必ずエミュレータに繋がる（hostname 判定・本番で発火しない
 * ための仕様）。この判定に「本番URLでも成立しうる条件」を足すのは禁止しているので、
 * 代わりに判定式を false に固定したコピーを1枚作る。
 *
 * 変更するのは IS_EMULATOR の1行だけ。それ以外は出荷物と完全に同じなので、
 * 「本番相手に admin.html が動くか」の確認として意味を持つ。
 *
 * 実行:  npm run prod-preview
 * 生成:  admin.prod.html（.gitignore 済み。リポジトリ直下＝index.html への相対リンクが壊れない）
 *
 * ★このコピーは本番データを読み書きします。確認が終わったら消してください。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "admin.html");
const OUT = path.join(ROOT, "admin.prod.html");

const src = fs.readFileSync(SRC, "utf8");

// 判定式の行をまるごと差し替える。行の形が変わったら気づけるよう、必ず1箇所であることを確認する。
const RE = /^([ \t]*)const IS_EMULATOR = .+;[ \t]*$/m;
const hits = src.match(new RegExp(RE.source, "gm")) || [];
if (hits.length !== 1) {
  console.error(`✖ admin.html の IS_EMULATOR 定義行が ${hits.length} 箇所見つかりました（1箇所のはず）。`);
  console.error("  admin.html の構造が変わっています。このスクリプトを直してください。");
  process.exitCode = 1;
} else {
  const out = src.replace(RE,
    "$1const IS_EMULATOR = false;   // 【本番確認用コピー】admin.prod.html 専用。出荷物は admin.html");
  fs.writeFileSync(OUT, out, "utf8");

  // ── 検証 ──
  let ng = 0;
  const check = (c, l, d) => { if (c) console.log(`  ✔ ${l}`); else { ng++; console.log(`  ★NG ${l}${d ? " … " + d : ""}`); } };

  console.log(`生成: ${path.basename(OUT)}`);
  console.log("");

  // 差し替えた1行以外に違いが無いこと
  const a = src.split("\n"), b = out.split("\n");
  const diffLines = a.length === b.length ? a.reduce((n, l, i) => n + (l === b[i] ? 0 : 1), 0) : -1;
  check(diffLines === 1, "出荷物との違いは IS_EMULATOR の1行だけ", `違う行数=${diffLines}`);

  // 本番向きになっていること
  check(/const IS_EMULATOR = false;/.test(out), "IS_EMULATOR が false 固定");
  const emuBlockReachable = /if \(IS_EMULATOR\) \{/.test(out);
  check(emuBlockReachable, "エミュレータ分岐は残っている（false なので実行されない）");

  // AREAPOLY_API が本番URLに落ちること。三項を実ファイルから抜いて評価する。
  const m = out.match(/const AREAPOLY_API = IS_EMULATOR\s*\n\s*\?\s*(`[^`]+`)\s*\n\s*:\s*("[^"]+")/);
  if (!m) { check(false, "AREAPOLY_API の三項が見つかる"); }
  else {
    const url = Function("IS_EMULATOR", "location", "EMU_FUNCTIONS_PORT",
      `return IS_EMULATOR ? ${m[1]} : ${m[2]};`)(false, { hostname: "localhost" }, 5001);
    check(url.startsWith("https://"), `AREAPOLY_API が本番URLになる（${url}）`);
  }

  console.log("");
  console.log(ng === 0
    ? `→ http://localhost:8000/${path.basename(OUT)} で開いてください（★本番データを触ります）`
    : `✖ ${ng}件 不合格`);
  if (ng) process.exitCode = 1;
}
