#!/usr/bin/env node
/**
 * deploy-rules.mjs — Firestore ルールの「本番との突き合わせ → デプロイ → 一致確認」
 *
 * これまでコンソールを目視して repo と見比べていた作業を機械化する。
 * 目視だと「コンソールで直接編集された行」を見落としたまま deploy し、
 * その手編集を消してしまう事故が起きうる。ここではそれを構造的に止める。
 *
 * 使い方（作業ディレクトリは akiya-map）:
 *   npm run deploy:rules -- --dry-run          差分表示まで。デプロイしない
 *   npm run deploy:rules                       差分OKならバックアップ→デプロイ→一致確認
 *   npm run deploy:rules -- --from-file p.txt  本番ルールをAPIではなくファイルから読む（トークン不要）
 *
 * 終了コード:
 *   0 = 正常（--dry-run で差分あり/なしを問わず、危険が無ければ0）
 *   1 = エラー（取得失敗・デプロイ失敗・デプロイ後の不一致 など）
 *   2 = ★安全装置が作動（本番にあって repo に無い行がある）。デプロイしていない
 *
 * 【鍵は一切ファイルに書かない】アクセストークンは実行のたびに以下の順で解決する:
 *   1. 環境変数 GOOGLE_OAUTH_ACCESS_TOKEN
 *   2. gcloud auth print-access-token                （ユーザー認証情報）
 *   3. gcloud auth application-default print-access-token
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULES_PATH = path.join(ROOT, "firestore.rules");
const RULES_API = "https://firebaserules.googleapis.com/v1";

// ───────────────────────────── 引数 ─────────────────────────────
function parseArgs(argv) {
  const o = { dryRun: false, fromFile: null, project: null, help: false, acceptProdLines: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") o.dryRun = true;
    else if (a === "--accept-prod-lines") o.acceptProdLines = true;
    else if (a === "--from-file") o.fromFile = argv[++i];
    else if (a === "--project" || a === "-P") o.project = argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
    else { console.error(`不明な引数: ${a}`); o.help = true; }
  }
  return o;
}

const USAGE = [
  "使い方: node scripts/deploy-rules.mjs [options]",
  "",
  "  --dry-run, -n          差分の表示までで終了する（デプロイしない）",
  "  --accept-prod-lines    安全装置（本番のみの行）を明示承認して続行する。",
  "                         ただし本番ルールが repo の過去コミットと一致した場合に限る",
  "                         （＝手編集ではないと機械的に確認できたときだけ）",
  "  --from-file <path>     本番ルールを Rules API ではなく指定ファイルから読む",
  "                         （コンソールからコピペ保存した本文。トークン不要）",
  "  --project, -P <id>     プロジェクトID（既定: .firebaserc の projects.default）",
  "  --help, -h             この表示",
].join("\n");

// ───────────────────────────── 色 ─────────────────────────────
// NO_COLOR / 非TTY では色を落とす（ログにエスケープシーケンスを残さないため）
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c(31), green = c(32), yellow = c(33), gray = c(90), bold = c(1), cyan = c(36);

// ───────────────────────────── 小道具 ─────────────────────────────
function die(msg, code = 1) {
  console.error(`\n${red("✖")} ${msg}`);
  process.exitCode = code;
}

function readProjectId(explicit) {
  if (explicit) return explicit;
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(ROOT, ".firebaserc"), "utf8"));
    if (rc.projects && rc.projects.default) return rc.projects.default;
  } catch { /* .firebaserc が無い/壊れている */ }
  return "housemarket-map";
}

/** 改行コードとBOMを揃える。CRLF/LF の違いを差分として出さないため。 */
function normalize(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

// ───────────────────────────── トークン ─────────────────────────────
/**
 * 外部コマンドを1行の文字列として shell に渡す。
 *
 * Windows の gcloud / firebase は .cmd で、Node は .cmd を shell 無しでは実行できない
 * （CVE-2024-27980 の対策以降 EINVAL になる）。かといって shell:true に引数を配列で渡すと
 * Node 24 が DEP0190（引数がエスケープされない）を警告する。
 * → コマンド全体を1つの文字列にして渡す。ここで組み立てる引数は下の assertSafeArg を
 *   通した固定値・検証済み値のみなので、連結してもインジェクションの余地がない。
 */
function shellLine(parts) {
  return parts.join(" ");
}

/** shell に渡してよい値か（英数・ハイフン・アンダースコア・コロン・ドットのみ）。 */
function assertSafeArg(v, label) {
  if (!/^[A-Za-z0-9._:-]+$/.test(String(v))) {
    throw new Error(`${label} に使えない文字が含まれています: ${v}`);
  }
  return v;
}

function tryExec(parts) {
  try {
    return execFileSync(shellLine(parts), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
    }).trim();
  } catch { return null; }
}

function resolveAccessToken() {
  const fromEnv = (process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "").trim();
  if (fromEnv) return { token: fromEnv, source: "環境変数 GOOGLE_OAUTH_ACCESS_TOKEN" };

  const a = tryExec(["gcloud", "auth", "print-access-token"]);
  if (a) return { token: a, source: "gcloud auth print-access-token" };

  const b = tryExec(["gcloud", "auth", "application-default", "print-access-token"]);
  if (b) return { token: b, source: "gcloud auth application-default print-access-token" };

  return null;
}

const TOKEN_HELP = [
  "本番ルールを取得するためのアクセストークンが得られませんでした。",
  "以下のいずれかで解決できます（どれもリポジトリ内に鍵を置きません）。",
  "",
  "  A) gcloud で認証する（推奨・一度きり）",
  "       gcloud auth login",
  "       npm run deploy:rules -- --dry-run",
  "",
  "  B) 既にトークンを持っている場合はシェル変数で渡す（そのセッション限り）",
  "       $env:GOOGLE_OAUTH_ACCESS_TOKEN = \"<token>\"",
  "",
  "  C) トークン無しで差分だけ見る（コンソールから本文をコピペ保存して渡す）",
  "       https://console.firebase.google.com/project/<PROJECT>/firestore/rules",
  "       の内容をファイルに保存し、",
  "       npm run deploy:rules -- --dry-run --from-file <保存したファイル>",
].join("\n");

// ───────────────────────────── Rules API ─────────────────────────────
// 実物の discovery document（firebaserules.googleapis.com/$discovery/rest?version=v1）で確認済み:
//   projects.releases.get  GET v1/{+name}  -> Release { name, rulesetName, updateTime, createTime }
//   projects.rulesets.get  GET v1/{+name}  -> Ruleset { source: { files: [{ name, content }] } }
// 必要スコープ: cloud-platform / firebase / firebase.readonly
async function api(url, token, projectId) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // 【必須】gcloud auth login のトークンには課金先プロジェクトが紐づいていない。
      //   これを送らないと firebaserules.googleapis.com は
      //   403「requires a quota project, which is not set by default」を返す。
      "x-goog-user-project": projectId,
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSONでない＝上流の異常 */ }
  if (!res.ok) {
    const detail = (json && json.error && json.error.message) || text.slice(0, 300);
    const err = new Error(`Rules API ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  if (!json) throw new Error(`Rules API が JSON を返しませんでした: ${text.slice(0, 200)}`);
  return json;
}

/** releases → rulesets の順に辿って、いま本番に当たっている Firestore ルール本文を返す。 */
async function fetchLiveRules(projectId, token) {
  // 既定データベースの attachment point は "cloud.firestore" 固定。
  let release;
  try {
    release = await api(`${RULES_API}/projects/${projectId}/releases/cloud.firestore`, token, projectId);
  } catch (e) {
    if (e.status !== 404) throw e;
    // release 名が cloud.firestore ちょうどでない場合（名前付きDB等）の保険。
    const list = await api(`${RULES_API}/projects/${projectId}/releases`, token, projectId);
    const hit = (list.releases || []).filter(r => /\/releases\/cloud\.firestore(\/|$)/.test(r.name));
    if (hit.length !== 1) {
      const names = (list.releases || []).map(r => r.name).join("\n  ") || "(0件)";
      throw new Error(`Firestore の release を一意に特定できませんでした。候補:\n  ${names}`);
    }
    release = hit[0];
  }
  if (!release.rulesetName) throw new Error("release に rulesetName がありません");

  const ruleset = await api(`${RULES_API}/${release.rulesetName}`, token, projectId);
  const files = (ruleset.source && ruleset.source.files) || [];
  if (!files.length) throw new Error(`ruleset ${release.rulesetName} にファイルがありません`);
  const file = files.find(f => f.name === "firestore.rules")
    || (files.length === 1 ? files[0] : null);
  if (!file) {
    throw new Error(`firestore.rules を特定できませんでした。含まれるファイル: ${files.map(f => f.name).join(", ")}`);
  }
  return {
    content: normalize(file.content || ""),
    rulesetName: release.rulesetName,
    updateTime: release.updateTime || release.createTime || "",
  };
}

// ───────────────────────────── git 照合 ─────────────────────────────
// git.exe は .cmd ではないので shell を挟まずに直接実行できる。
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return null; }
}

/** firestore.rules を変更したコミットを新しい順に取る。 */
function rulesHistory(limit = 80) {
  const log = git(["log", `-n${limit}`, "--format=%H%x09%ad%x09%s",
                   "--date=format:%Y-%m-%d %H:%M", "--", "firestore.rules"]);
  if (!log) return [];
  return log.trim().split("\n").filter(Boolean).map(l => {
    const [sha, date, ...rest] = l.split("\t");
    return { sha, short: sha.slice(0, 7), date, subject: rest.join("\t") };
  });
}

/**
 * 本番ルールが repo のどのコミットの firestore.rules と一致するかを探す。
 *
 * 一致すれば「コンソールで直接編集されたのではなく、単にデプロイが遅れているだけ」と
 * 機械的に断定できる。ここが安全装置を解除してよいかどうかの唯一の根拠になる。
 */
function findMatchingCommit(prodText) {
  const history = rulesHistory();
  const target = prodText.trimEnd();
  for (let i = 0; i < history.length; i++) {
    const body = git(["show", `${history[i].sha}:firestore.rules`]);
    if (body != null && normalize(body).trimEnd() === target) {
      // history[i] より新しい＝未デプロイのコミット
      return { hit: history[i], since: history.slice(0, i), checked: history.length };
    }
  }
  return { hit: null, since: [], checked: history.length };
}

// ───────────────────────────── 権限の差分 ─────────────────────────────
/**
 * match パスごとの allow 文だけを抜き出す。
 * コメントや整形の差に埋もれず「アクセス権限が実際にどう変わるか」を読むために使う。
 */
function extractRules(text) {
  const out = new Map();
  const stack = [];
  let pending = null;   // 複数行にまたがる allow を連結するバッファ
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();   // 行コメントを落とす
    if (!line) continue;

    if (pending !== null) {
      pending += " " + line;
      if (pending.includes(";")) {
        const key = stack.join("");
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(pending.replace(/\s+/g, " ").replace(/;.*$/, "").trim());
        pending = null;
      }
      continue;
    }

    const m = line.match(/^match\s+(\S+)\s*\{/);
    if (m) { stack.push(m[1]); continue; }

    if (/^allow\b/.test(line)) {
      if (line.includes(";")) {
        const key = stack.join("");
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(line.replace(/\s+/g, " ").replace(/;.*$/, "").trim());
      } else {
        pending = line;
      }
      continue;
    }

    const closes = (line.match(/\}/g) || []).length;
    const opens = (line.match(/\{/g) || []).length;
    for (let i = 0; i < closes - opens; i++) stack.pop();
  }
  return out;
}

/** ヘルパー関数（isSignedIn / isAdmin 等）。ここが変わると全パスの判定に波及する。 */
function extractFunctions(text) {
  return (text.match(/function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}/g) || [])
    .map(s => s.replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").trim());
}

/** デプロイすると本番の権限がどう変わるかを、パス単位で表示する。 */
function printPermissionDelta(prodText, repoText) {
  const a = extractRules(prodText), b = extractRules(repoText);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const short = (k) => k.replace("/databases/{database}/documents", "") || "(ルート)";

  let added = 0, removed = 0, modified = 0, same = 0;
  for (const k of keys) {
    const av = a.get(k), bv = b.get(k);
    if (!av) {
      added++;
      console.log(`  ${green("[新規]")} ${short(k)}`);
      bv.forEach(r => console.log(`      ${green("+ " + r)}`));
    } else if (!bv) {
      removed++;
      console.log(`  ${red("[削除]")} ${short(k)}   ${red("★このパスへのアクセスが失われます")}`);
      av.forEach(r => console.log(`      ${red("- " + r)}`));
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      modified++;
      console.log(`  ${yellow("[変更]")} ${short(k)}   ${yellow("★権限の内容が変わります")}`);
      av.forEach(r => console.log(`      ${red("- " + r)}`));
      bv.forEach(r => console.log(`      ${green("+ " + r)}`));
    } else {
      same++;
    }
  }

  const fa = extractFunctions(prodText), fb = extractFunctions(repoText);
  const fnChanged = JSON.stringify(fa) !== JSON.stringify(fb);
  if (fnChanged) {
    console.log(`  ${yellow("[変更]")} ヘルパー関数   ${yellow("★全パスの判定に波及します")}`);
    fa.forEach(f => console.log(`      ${red("- " + f)}`));
    fb.forEach(f => console.log(`      ${green("+ " + f)}`));
  }

  console.log(`\n  既存パス ${same}件は変更なし`
    + ` / 新規 ${added} / 削除 ${removed} / 変更 ${modified}`
    + ` / ヘルパー関数 ${fnChanged ? yellow("変更あり") : "変更なし"}`);
  return { added, removed, modified, same, fnChanged };
}

// ───────────────────────────── 差分 ─────────────────────────────
/** 行単位 LCS。ルールは高々数百行なので O(n*m) で十分。 */
function lcsOps(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: " ", line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", line: a[i] }); i++; }
    else { ops.push({ t: "+", line: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });
  return ops;
}

/**
 * 本番(a) と repo(b) の差分を色つきで表示する。
 *   "-"（赤）= 本番にあって repo に無い行 ← これがあると安全装置が作動する
 *   "+"（緑）= repo にあって本番に無い行 ← これがデプロイで反映される
 * 空行だけの差は数えない（末尾改行や整形の揺れでノイズにしないため）。
 */
function printDiff(prodText, repoText, { context = 3 } = {}) {
  const a = prodText.split("\n");
  const b = repoText.split("\n");
  const ops = lcsOps(a, b);
  const changed = ops.some(o => o.t !== " ");
  if (!changed) return { changed: false, prodOnly: [], repoOnly: [] };

  // 変更点の周辺 context 行だけを出す（全文を毎回流すと肝心の差分が埋もれる）
  const keep = new Set();
  ops.forEach((o, idx) => {
    if (o.t === " ") return;
    for (let k = idx - context; k <= idx + context; k++) if (k >= 0 && k < ops.length) keep.add(k);
  });

  let lastShown = -1;
  ops.forEach((o, idx) => {
    if (!keep.has(idx)) return;
    if (lastShown >= 0 && idx > lastShown + 1) console.log(gray("   ⋮"));
    if (o.t === "-") console.log(red(`  - ${o.line}`));
    else if (o.t === "+") console.log(green(`  + ${o.line}`));
    else console.log(gray(`    ${o.line}`));
    lastShown = idx;
  });

  const prodOnly = ops.filter(o => o.t === "-" && o.line.trim() !== "").map(o => o.line);
  const repoOnly = ops.filter(o => o.t === "+" && o.line.trim() !== "").map(o => o.line);
  return { changed: true, prodOnly, repoOnly };
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }

  // firebase deploy を shell 経由で呼ぶため、ここで一度だけ検証しておく
  const projectId = assertSafeArg(readProjectId(args.project), "プロジェクトID");
  console.log(bold(`\n▶ Firestore ルール突き合わせ  project=${cyan(projectId)}`));

  // --- repo 側 ---
  if (!fs.existsSync(RULES_PATH)) { die(`${RULES_PATH} が見つかりません`); return; }
  const repoText = normalize(fs.readFileSync(RULES_PATH, "utf8"));
  console.log(`  repo   : firestore.rules（${repoText.split("\n").length}行）`);

  // --- 本番側 ---
  let live;
  if (args.fromFile) {
    if (!fs.existsSync(args.fromFile)) { die(`--from-file が見つかりません: ${args.fromFile}`); return; }
    live = {
      content: normalize(fs.readFileSync(args.fromFile, "utf8")),
      rulesetName: `(file) ${args.fromFile}`,
      updateTime: "",
    };
    console.log(`  本番   : ${yellow("ファイルから読込")} ${args.fromFile}`);
  } else {
    const auth = resolveAccessToken();
    if (!auth) { console.error(`\n${red("✖")} ${TOKEN_HELP}`); { process.exitCode = 1; return; } }
    console.log(gray(`  認証   : ${auth.source}`));
    try {
      live = await fetchLiveRules(projectId, auth.token);
    } catch (e) {
      console.error(`\n${red("✖")} 本番ルールの取得に失敗しました: ${e.message}`);
      console.error(`\n${TOKEN_HELP}`);
      { process.exitCode = 1; return; }
    }
    console.log(`  本番   : ${live.rulesetName}${live.updateTime ? gray(`（更新 ${live.updateTime}）`) : ""}`);
  }

  // --- 差分 ---
  console.log(bold("\n── 差分（赤 = 本番のみ / 緑 = repoのみ）───────────────────"));
  const { changed, prodOnly, repoOnly } = printDiff(live.content, repoText);
  if (!changed) console.log(gray("  （差分なし。本番と repo は完全に一致しています）"));
  console.log(bold("──────────────────────────────────────────────────────"));

  // --- デプロイすると本番の権限がどう変わるか ---
  //   上の行差分はコメントも含むので読みづらい。判断に必要なのは「権限がどう変わるか」なので
  //   match パス単位で allow 文だけを突き合わせて出す。
  if (changed) {
    console.log(bold("\n── デプロイすると本番の権限はこう変わる ──────────────────"));
    printPermissionDelta(live.content, repoText);
    console.log(bold("──────────────────────────────────────────────────────"));
  }

  // --- ★安全装置：本番にあって repo に無い行 ---
  if (prodOnly.length) {
    console.log(bold(`\n── 安全装置：本番にあって repo に無い行が ${prodOnly.length}行 ──`));

    // 本番が「repo の過去のコミットそのもの」なら、手編集ではなくデプロイ遅れと断定できる。
    // --from-file のときは本番の実物ではないので照合しない。
    const match = args.fromFile ? { hit: null, since: [], checked: 0 } : findMatchingCommit(live.content);

    if (match.hit) {
      console.log(`  ${green("照合OK")} 本番ルールは repo のコミットと完全一致しました。`);
      console.log(`         ${cyan(match.hit.short)}  ${match.hit.date}  ${match.hit.subject}`);
      console.log(`  → ${green("コンソールでの手編集ではありません。")}デプロイが遅れているだけです。`);
      if (match.since.length) {
        console.log(`\n  そのコミット以降に firestore.rules を変更した未デプロイのコミット（${match.since.length}件）:`);
        match.since.slice().reverse().forEach(c => {
          console.log(`         ${cyan(c.short)}  ${c.date}  ${c.subject}`);
        });
      } else {
        console.log(`\n  そのコミット以降、firestore.rules を変更したコミットはありません`);
        console.log(`  （差分は未コミットの作業ツリー分のみ）`);
      }
    } else if (args.fromFile) {
      console.log(`  ${yellow("--from-file のため過去コミットとの照合は行いません。")}`);
    } else {
      console.log(`  ${red("照合NG")} 本番ルールは repo の直近${match.checked}コミットのどれとも一致しません。`);
      console.log(`  → ${red("コンソールで直接編集された可能性が高いです。")}`);
    }

    if (!match.hit) {
      console.error(`\n${red(bold("✖ デプロイを中止しました（安全装置）"))}`);
      console.error(`  このままデプロイすると、本番にしかない内容が消えます。`);
      console.error(`\n  対処: 本番側の内容を firestore.rules に取り込んでから、もう一度実行してください。`);
      console.error(`        意図した削除である場合も、まず repo を本番に合わせ、そのうえで削除を`);
      console.error(`        コミットする＝2段階に分けること（削除の意図が履歴に残る）。`);
      console.error(`\n  ※ 照合できていないため ${bold("--accept-prod-lines を付けても進みません")}。`);
      console.error(`     どうしても上書きする場合は firebase deploy を直接実行してください。`);
      process.exitCode = 2; return;
    }

    if (!args.acceptProdLines) {
      console.error(`\n${yellow(bold("■ デプロイは行いませんでした（明示承認が必要）"))}`);
      console.error(`  上の「権限はこう変わる」を読んで問題なければ、--accept-prod-lines を付けて再実行してください。`);
      console.error(`\n    npm run deploy:rules -- --accept-prod-lines`);
      process.exitCode = 2; return;
    }
    console.log(`\n  ${yellow("--accept-prod-lines が指定されています。安全装置を解除して続行します。")}`);
  }

  if (!changed) {
    console.log(`\n${green("✔")} 一致済みのためデプロイ不要です。`);
    return;
  }
  console.log(`\n  repo にのみ存在する行: ${green(String(repoOnly.length) + "行")}（これがデプロイで反映されます）`);

  if (args.dryRun) {
    console.log(`\n${yellow("→ --dry-run のためここで終了します。デプロイは行っていません。")}`);
    return;
  }

  // --- バックアップ ---
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const bak = path.join(ROOT, `firestore.rules.${stamp}.bak`);
  fs.writeFileSync(bak, fs.readFileSync(RULES_PATH));
  console.log(`\n  バックアップ: ${path.basename(bak)}`);

  // --- デプロイ ---
  console.log(bold(`\n▶ firebase deploy --only firestore:rules --project ${projectId}`));
  const r = spawnSync(
    shellLine(["firebase", "deploy", "--only", "firestore:rules", "--project", projectId]),
    { cwd: ROOT, stdio: "inherit", shell: true }
  );
  if (r.error) { die(`firebase コマンドを実行できませんでした: ${r.error.message}`); return; }
  if (r.status !== 0) { die(`デプロイに失敗しました（exit ${r.status}）`); return; }

  // --- デプロイ後の一致確認 ---
  if (args.fromFile) {
    console.log(`\n${yellow("→ --from-file 実行のため、デプロイ後の再取得による確認は行えません。")}`);
    console.log("  コンソールで反映を確認してください。");
    return;
  }
  console.log(bold("\n▶ デプロイ後の確認（本番を再取得して repo と比較）"));
  const auth2 = resolveAccessToken();
  if (!auth2) { die("再取得用のトークンが得られませんでした。コンソールで反映を確認してください。"); return; }
  const after = await fetchLiveRules(projectId, auth2.token);
  if (after.content.trimEnd() === repoText.trimEnd()) {
    console.log(`\n${green(bold("✔ 完了"))} 本番と repo が一致しました。 ruleset=${after.rulesetName}`);
    return;
  }
  console.error(`\n${red(bold("✖ デプロイ後も本番と repo が一致していません。"))}`);
  printDiff(after.content, repoText);
  { process.exitCode = 1; return; }
}

main().catch(e => die(e.stack || e.message));
