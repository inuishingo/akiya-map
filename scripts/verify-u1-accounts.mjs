/**
 * アカウント管理（U-1）の自動検証：listAccounts / setAccountDisabled / account_audit_logs の rules。
 *
 *   前提：npm run emu:auth（auth,firestore,functions）が起動していること。
 *   実行：
 *     $env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
 *     $env:FIRESTORE_EMULATOR_HOST     = "127.0.0.1:8080"
 *     node scripts/verify-u1-accounts.mjs
 *
 * 【安全装置】FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST が無い、またはループバックでなければ即終了。
 *   Functions の呼び先も 127.0.0.1 固定。本番のエンドポイントへ向ける経路をコードに持たない。
 *
 * 【破壊的】冒頭で seed-accounts-emu.mjs の seed() を呼び、エミュレータのデータを全消去して入れ直す。
 *
 * ※ Functions エミュレータは ID トークンの署名を検証しない。ここで確かめているのは
 *   「admins 判定・ガード順・監査ログ」のロジックまでで、署名検証は本番の Firebase 側が担う。
 */
import { emulatorHosts, seed, ACCOUNTS, DUMMY_PASSWORD, PROJECT } from "./seed-accounts-emu.mjs";

// ---- 冒頭チェック（seed-accounts-emu.mjs 側でも import 時に同じチェックが走る）----
const { authHost: AUTH_HOST, fsHost: FS_HOST } = emulatorHosts();

const REGION = "asia-northeast1";
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/${REGION}`;   // firebase.json emulators.functions.port
const AUTH = `http://${AUTH_HOST}`;
const FS_DOCS = `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const byEmail = Object.fromEntries(ACCOUNTS.map(a => [a.email, a]));
const U = {
  allstore: byEmail["emu-dummy-allstore@housemarket.com"],
  ngyAdmin: byEmail["nagoya-admin@example.test"],
  kyoAdmin: byEmail["kyoto-admin@example.test"],
  ngyA:     byEmail["nagoya-surveyor-a@example.test"],
  retired:  byEmail["nagoya-retired@example.test"],
  kyoA:     byEmail["kyoto-surveyor-a@example.test"],
  transfer: byEmail["transfer-surveyor@example.test"],
  nodn:     byEmail["no-displayname@example.test"],
};

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? "  … " + detail : ""}`); }
}

async function signIn(email) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: DUMMY_PASSWORD, returnSecureToken: true }),
  });
  const j = await res.json();
  return { status: res.status, idToken: j.idToken, error: j.error && j.error.message };
}
const tokens = {};
async function tokenOf(u) {
  if (!tokens[u.uid]) {
    const r = await signIn(u.email);
    if (!r.idToken) throw new Error(`サインイン失敗 ${u.email}: ${r.error}`);
    tokens[u.uid] = r.idToken;
  }
  return tokens[u.uid];
}

// callable を素の HTTP で叩く（クライアントを迂回した呼び出し＝受け入れ条件7の形）
async function callFn(name, data, idToken) {
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: "POST", headers, body: JSON.stringify({ data }) });
  const j = await res.json().catch(() => ({}));
  if (j.error) return { ok: false, status: j.error.status, message: j.error.message };
  return { ok: true, result: j.result };
}

async function auditLogs(idToken) {
  const headers = idToken ? { Authorization: `Bearer ${idToken}` } : { Authorization: "Bearer owner" };
  const res = await fetch(`${FS_DOCS}/account_audit_logs?pageSize=100`, { headers });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, docs: j.documents || [] };
}
const fv = (doc, k) => { const v = doc.fields[k]; return v && (v.stringValue ?? v.timestampValue ?? v.booleanValue); };

async function authUser(uid) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, {
    method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ localId: [uid] }),
  });
  return ((await res.json()).users || [])[0];
}

async function main() {
  console.log(`エミュレータ: auth=${AUTH_HOST} / firestore=${FS_HOST} / functions=${FUNCTIONS}`);
  await seed({ quiet: true });
  console.log("✔ シード投入（全消去→入れ直し）\n");

  console.log("■ 認証・管理者判定（受け入れ条件7）");
  let r = await callFn("listAccounts", {}, null);
  check("未ログインの listAccounts は unauthenticated", !r.ok && r.status === "UNAUTHENTICATED", JSON.stringify(r));
  r = await callFn("listAccounts", {}, await tokenOf(U.ngyA));
  check("admins に無い uid の listAccounts は permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: U.nodn.uid, disabled: true }, await tokenOf(U.ngyA));
  check("admins に無い uid の setAccountDisabled は permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  check("  → 対象は無効化されていない", !(await authUser(U.nodn.uid)).disabled);

  console.log("\n■ listAccounts（名古屋管理者）");
  r = await callFn("listAccounts", {}, await tokenOf(U.ngyAdmin));
  const rows = r.ok ? r.result : [];
  check("取得できる", r.ok, JSON.stringify(r));
  check(`件数がシードと一致（${ACCOUNTS.length}件）＝Auth エミュレータを読んでいる`, rows.length === ACCOUNTS.length, `実際 ${rows.length}`);
  check("全行がシードのメール（本番アカウントが混ざっていない）", rows.every(x => byEmail[x.email]));
  const keys = ["uid", "email", "displayName", "branch", "disabled", "isAdmin", "lastSignInTime", "creationTime"];
  check("要素のフィールドが揃っている", rows.every(x => keys.every(k => k in x)));
  const sorted = [...rows].sort((a, b) => a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
  check("並びが branch → email の昇順", JSON.stringify(rows.map(x => x.uid)) === JSON.stringify(sorted.map(x => x.uid)));
  const row = uid => rows.find(x => x.uid === uid) || {};
  check("既に無効のアカウントが disabled:true（退職者の想定）", row(U.retired.uid).disabled === true);
  check("有効なアカウントは disabled:false", row(U.ngyA.uid).disabled === false);
  check("氏名・拠点が displayNames と一致", ACCOUNTS.filter(a => a.name).every(a => row(a.uid).displayName === a.name && row(a.uid).branch === a.branch));
  check("displayNames.branch を優先（メールに kyoto 無しでも 京都）", row(U.transfer.uid).branch === "京都");
  check("displayNames 無し → 氏名空・拠点はメール判定（名古屋）", row(U.nodn.uid).displayName === "" && row(U.nodn.uid).branch === "名古屋");
  check("isAdmin が admins と一致", ACCOUNTS.every(a => row(a.uid).isAdmin === !!a.admin));

  console.log("\n■ setAccountDisabled のサーバー側ガード");
  const before = (await auditLogs()).docs.length;
  r = await callFn("setAccountDisabled", { uid: U.ngyAdmin.uid, disabled: true }, await tokenOf(U.ngyAdmin));
  check("自分自身 → failed-precondition「自分のアカウントは操作できません」", !r.ok && r.status === "FAILED_PRECONDITION" && r.message === "自分のアカウントは操作できません", JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: U.kyoAdmin.uid, disabled: true }, await tokenOf(U.ngyAdmin));
  check("管理者アカウント → failed-precondition（他店より先に判定）", !r.ok && r.status === "FAILED_PRECONDITION" && r.message === "管理者アカウントはこの画面から無効化できません", JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: U.kyoA.uid, disabled: true }, await tokenOf(U.ngyAdmin));
  check("名古屋管理者 → 京都の調査員は permission-denied「他店のアカウントです（京都店）」", !r.ok && r.status === "PERMISSION_DENIED" && r.message === "他店のアカウントです（京都店）", JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: U.transfer.uid, disabled: true }, await tokenOf(U.ngyAdmin));
  check("名古屋管理者 → displayNames.branch=京都 の調査員も permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: U.ngyA.uid, disabled: true }, await tokenOf(U.kyoAdmin));
  check("京都管理者（kyoto を含む＝全店扱いではない）→ 名古屋の調査員は permission-denied", !r.ok && r.status === "PERMISSION_DENIED" && r.message === "他店のアカウントです（名古屋店）", JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: U.ngyA.uid, disabled: "true" }, await tokenOf(U.ngyAdmin));
  check("引数不正（disabled が文字列）→ invalid-argument", !r.ok && r.status === "INVALID_ARGUMENT", JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: "no-such-uid", disabled: true }, await tokenOf(U.ngyAdmin));
  check("存在しない uid → not-found", !r.ok && r.status === "NOT_FOUND", JSON.stringify(r));
  check("拒否された操作では監査ログが増えない", (await auditLogs()).docs.length === before);
  const stillEnabled = await Promise.all([U.ngyAdmin, U.kyoAdmin, U.kyoA, U.transfer, U.ngyA].map(async u => !(await authUser(u.uid)).disabled));
  check("拒否された対象は無効化されていない", stillEnabled.every(Boolean));

  console.log("\n■ 無効化 → 再有効化（受け入れ条件6・名古屋管理者 → 名古屋の調査員A）");
  r = await callFn("setAccountDisabled", { uid: U.ngyA.uid, disabled: true }, await tokenOf(U.ngyAdmin));
  check("無効化が ok", r.ok && r.result.ok === true && r.result.uid === U.ngyA.uid && r.result.disabled === true, JSON.stringify(r));
  check("Auth 上で disabled になった", (await authUser(U.ngyA.uid)).disabled === true);
  const si = await signIn(U.ngyA.email);
  check("無効化されたアカウントはサインインできない（USER_DISABLED）", !si.idToken && si.error === "USER_DISABLED", JSON.stringify(si));
  r = await callFn("listAccounts", {}, await tokenOf(U.ngyAdmin));
  check("一覧でも disabled:true", r.ok && r.result.find(x => x.uid === U.ngyA.uid).disabled === true);
  r = await callFn("setAccountDisabled", { uid: U.ngyA.uid, disabled: false }, await tokenOf(U.ngyAdmin));
  check("再有効化が ok", r.ok && r.result.disabled === false, JSON.stringify(r));
  check("Auth 上で有効に戻った", !(await authUser(U.ngyA.uid)).disabled);
  check("再びサインインできる", !!(await signIn(U.ngyA.email)).idToken);

  const logs = (await auditLogs()).docs;
  check(`監査ログが2件積まれた（${before} → ${logs.length}）`, logs.length === before + 2);
  const disableLog = logs.find(d => fv(d, "action") === "disable");
  const enableLog = logs.find(d => fv(d, "action") === "enable");
  const okLog = d => d && fv(d, "targetUid") === U.ngyA.uid && fv(d, "targetEmail") === U.ngyA.email
    && fv(d, "byUid") === U.ngyAdmin.uid && fv(d, "byEmail") === U.ngyAdmin.email
    && fv(d, "branch") === "名古屋" && !!d.fields.at.timestampValue;
  check("disable ログのフィールド（target/by/branch/at=timestamp）", okLog(disableLog), JSON.stringify(disableLog && disableLog.fields));
  check("enable ログのフィールド", okLog(enableLog), JSON.stringify(enableLog && enableLog.fields));

  console.log("\n■ 全店扱い（@housemarket.com かつ kyoto 無し）は他店チェックのみスキップ");
  r = await callFn("setAccountDisabled", { uid: U.kyoA.uid, disabled: true }, await tokenOf(U.allstore));
  check("全店管理者 → 京都の調査員を無効化できる", r.ok, JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: U.kyoA.uid, disabled: false }, await tokenOf(U.allstore));
  check("全店管理者 → 再有効化できる", r.ok, JSON.stringify(r));
  r = await callFn("setAccountDisabled", { uid: U.kyoAdmin.uid, disabled: true }, await tokenOf(U.allstore));
  check("全店管理者でも管理者アカウントは不可", !r.ok && r.status === "FAILED_PRECONDITION", JSON.stringify(r));
  const kyoLogs = (await auditLogs()).docs.filter(d => fv(d, "targetUid") === U.kyoA.uid);
  check("京都アカウントのログは branch=京都 / by=全店管理者", kyoLogs.length === 2 && kyoLogs.every(d => fv(d, "branch") === "京都" && fv(d, "byUid") === U.allstore.uid));

  console.log("\n■ firestore.rules：account_audit_logs");
  let a = await auditLogs(await tokenOf(U.ngyAdmin));
  check("管理者は read できる", a.status === 200 && a.docs.length > 0, `status ${a.status}`);
  a = await auditLogs(await tokenOf(U.nodn));
  check("調査員は read できない（403）", a.status === 403, `status ${a.status}`);
  const w = await fetch(`${FS_DOCS}/account_audit_logs?documentId=forged`, {
    method: "POST", headers: { Authorization: `Bearer ${await tokenOf(U.ngyAdmin)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { action: { stringValue: "disable" } } }),
  });
  check("管理者でもクライアントからは write できない（403）", w.status === 403, `status ${w.status}`);

  console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("✖", e.stack || e.message); process.exit(1); });
