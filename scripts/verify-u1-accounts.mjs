/**
 * アカウント管理の自動検証
 *   U-1：listAccounts / setAccountDisabled / account_audit_logs の rules
 *   U-2：createSurveyorAccount / resetSurveyorPassword（店縛り・重複・ロールバック・PW個別化・監査ログ）
 *   U-3：updateSurveyorName / resetSurveyorPassword の手入力パスワード（検査 a〜f・method・回帰）
 *
 *   前提：npm run emu:auth（auth,firestore,functions）が起動していること。
 *   実行：
 *     $env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
 *     $env:FIRESTORE_EMULATOR_HOST     = "127.0.0.1:8080"
 *     $env:SHARED_PASSWORDS            = "<実運用の共通パスワードをカンマ区切りで>"
 *     node scripts/verify-u1-accounts.mjs
 *
 * 【共通パスワードはファイルに書かない】このリポジトリは Public。
 *   「共通パスワードでは入れない／設定できない」ことの検証値は SHARED_PASSWORDS（実行するシェルの中だけ）から読む。
 *   未設定なら該当の検査は不合格として数える（黙って飛ばさない）。
 *
 * 【安全装置】FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST が無い、またはループバックでなければ即終了。
 *   Functions の呼び先も 127.0.0.1 固定。本番のエンドポイントへ向ける経路をコードに持たない。
 *
 * 【破壊的】冒頭で seed-accounts-emu.mjs の seed() を呼び、エミュレータのデータを全消去して入れ直す。
 *
 * ※ Functions エミュレータは ID トークンの署名を検証しない。ここで確かめているのは
 *   「admins 判定・ガード順・監査ログ」のロジックまでで、署名検証は本番の Firebase 側が担う。
 */
import { emulatorHosts, seed, ACCOUNTS, GHOST_DISPLAYNAMES, DUMMY_PASSWORD, PROJECT } from "./seed-accounts-emu.mjs";

// ---- 冒頭チェック（seed-accounts-emu.mjs 側でも import 時に同じチェックが走る）----
const { authHost: AUTH_HOST, fsHost: FS_HOST } = emulatorHosts();

const REGION = "asia-northeast1";
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/${REGION}`;   // firebase.json emulators.functions.port
const AUTH = `http://${AUTH_HOST}`;
const FS_DOCS = `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

// 実運用の共通パスワード（ファイルに書かない。実行時の環境変数からだけ読む）
const SHARED_PASSWORDS = String(process.env.SHARED_PASSWORDS || "").split(",").map(s => s.trim()).filter(Boolean);

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

async function signIn(email, password = DUMMY_PASSWORD) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
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
async function authUserByEmail(email) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, {
    method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ email: [email] }),
  });
  return ((await res.json()).users || [])[0];
}
async function authUserCount() {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
    method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ returnUserInfo: false }),
  });
  return Number((await res.json()).recordsCount || 0);
}
async function fsDoc(path) {
  const segs = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${FS_DOCS}/${segs}`, { headers: { Authorization: "Bearer owner" } });
  return res.status === 200 ? res.json() : null;
}
async function fsCount(collection) {
  const res = await fetch(`${FS_DOCS}/${collection}?pageSize=300`, { headers: { Authorization: "Bearer owner" } });
  return ((await res.json()).documents || []).length;
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

  // ════════════════════ U-2 ════════════════════
  const PW_RE = /^[a-km-np-z2-9]{10}$/;      // 英小文字＋数字10桁・0 o 1 l を含まない（i は可）
  const issued = [];                          // 発行されたパスワード（監査ログに含まれていないことの確認用）
  const create = (u, data) => callFn("createSurveyorAccount", data, tokens[u.uid]);
  for (const u of [U.allstore, U.ngyAdmin, U.kyoAdmin, U.ngyA]) await tokenOf(u);

  console.log("\n■ U-2 createSurveyorAccount：認証・入力検証");
  r = await callFn("createSurveyorAccount", { localPart: "u2none", domain: "hm.com", name: "未ログイン" }, null);
  check("未ログイン → unauthenticated", !r.ok && r.status === "UNAUTHENTICATED", JSON.stringify(r));
  r = await create(U.ngyA, { localPart: "u2surveyor", domain: "hm.com", name: "調査員が作る" });
  check("admins に無い uid → permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  for (const [label, data] of [
    ["ローカルパートに大文字", { localPart: "Yamada", domain: "hm.com", name: "山田" }],
    ["ローカルパートが記号始まり", { localPart: "-yamada", domain: "hm.com", name: "山田" }],
    ["ローカルパートが32文字", { localPart: "a".repeat(32), domain: "hm.com", name: "山田" }],
    ["ローカルパートに @ を混ぜる", { localPart: "yamada@kyoto-hm.com", domain: "hm.com", name: "山田" }],
    ["許可リスト外のドメイン", { localPart: "yamada", domain: "gmail.com", name: "山田" }],
    ["ドメインに @ 付き", { localPart: "yamada", domain: "@hm.com", name: "山田" }],
    ["氏名が空", { localPart: "yamada", domain: "hm.com", name: "   " }],
    ["氏名が21文字", { localPart: "yamada", domain: "hm.com", name: "あ".repeat(21) }],
  ]) {
    r = await create(U.ngyAdmin, data);
    check(`${label} → invalid-argument`, !r.ok && r.status === "INVALID_ARGUMENT", JSON.stringify(r));
  }
  check("入力検証で弾いた分は Auth に作られていない", !(await authUserByEmail("yamada@hm.com")));

  console.log("\n■ U-2 店縛り（受け入れ条件2〜4）");
  const users0 = await authUserCount();
  r = await create(U.ngyAdmin, { localPart: "u2cross", domain: "kyoto-hm.com", name: "越境(ダミー)" });
  check("名古屋管理者 → @kyoto-hm.com は permission-denied「他店のアカウントは作成できません」",
    !r.ok && r.status === "PERMISSION_DENIED" && r.message === "他店のアカウントは作成できません", JSON.stringify(r));
  r = await create(U.kyoAdmin, { localPart: "u2cross", domain: "hm.com", name: "越境(ダミー)" });
  check("京都管理者 → @hm.com は permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  check("  → どちらも Auth に作られていない", (await authUserCount()) === users0);

  r = await create(U.allstore, { localPart: "u2all-ngy", domain: "hm.com", name: "全店作成 名古屋(ダミー)" });
  check("全店管理者 → @hm.com を作成できる", r.ok && r.result.email === "u2all-ngy@hm.com", JSON.stringify(r));
  if (r.ok) issued.push(r.result.password);
  r = await create(U.allstore, { localPart: "u2all-kyo", domain: "kyoto-hm.com", name: "全店作成 京都(ダミー)" });
  check("全店管理者 → @kyoto-hm.com を作成できる", r.ok && r.result.email === "u2all-kyo@kyoto-hm.com", JSON.stringify(r));
  if (r.ok) issued.push(r.result.password);
  const kyoDn = await fsDoc("displayNames/u2all-kyo@kyoto-hm.com");
  check("  → 京都ドメインの displayNames.branch は 京都", kyoDn && kyoDn.fields.branch.stringValue === "京都");

  console.log("\n■ U-2 作成（名古屋管理者 → @hm.com）：受け入れ条件5〜7・12");
  r = await create(U.ngyAdmin, { localPart: "u2.yamada", domain: "hm.com", name: "  山田 太郎(ダミー)  " });
  check("作成が ok（返り値に uid / email / password）", r.ok && r.result.ok === true && r.result.uid && r.result.email === "u2.yamada@hm.com" && typeof r.result.password === "string", JSON.stringify(r && r.message));
  const created = r.ok ? r.result : {};
  if (r.ok) issued.push(created.password);
  check("パスワードが英小文字＋数字10桁・紛らわしい文字なし・英字と数字を両方含む",
    PW_RE.test(created.password || "") && /[a-z]/.test(created.password) && /[0-9]/.test(created.password), created.password);
  check("表示されたパスワードでログインできる", !!(await signIn(created.email, created.password)).idToken);
  const wrong = await signIn(created.email, "wrongpass22");
  check("それ以外のパスワードでは失敗する", !wrong.idToken, JSON.stringify(wrong));
  let sharedFail = SHARED_PASSWORDS.length > 0;
  for (const p of SHARED_PASSWORDS) if ((await signIn(created.email, p)).idToken) sharedFail = false;
  check(`共通パスワード（環境変数 SHARED_PASSWORDS・${SHARED_PASSWORDS.length}件）では失敗する`, sharedFail,
    SHARED_PASSWORDS.length ? "" : "SHARED_PASSWORDS が未設定のため未検証");
  const dn = await fsDoc(`displayNames/${created.email}`);
  const dnKeys = dn ? Object.keys(dn.fields).sort() : [];
  check("displayNames に name（前後空白を除去）と branch=名古屋", dn && dn.fields.name.stringValue === "山田 太郎(ダミー)" && dn.fields.branch.stringValue === "名古屋");
  check("displayNames のフィールドは name / branch だけ（order が無い）", JSON.stringify(dnKeys) === JSON.stringify(["branch", "name"]), JSON.stringify(dnKeys));
  check("admins に対象 uid が作られていない", !(await fsDoc(`admins/${created.uid}`)));
  check("Auth 上で有効（disabled でない）", !(await authUser(created.uid)).disabled);
  r = await callFn("listAccounts", {}, tokens[U.ngyAdmin.uid]);
  const listed = r.ok ? r.result.find(x => x.uid === created.uid) : null;
  check("一覧に「有効」・氏名・拠点が正しく出る", listed && listed.disabled === false && listed.displayName === "山田 太郎(ダミー)" && listed.branch === "名古屋" && listed.isAdmin === false, JSON.stringify(listed));
  const pw2 = issued.filter(Boolean);
  check("発行ごとにパスワードが異なる", new Set(pw2).size === pw2.length, JSON.stringify(pw2));

  console.log("\n■ U-2 重複（受け入れ条件8）");
  let u0 = await authUserCount(), d0 = await fsCount("displayNames");
  r = await create(U.ngyAdmin, { localPart: "u2.yamada", domain: "hm.com", name: "二重登録" });
  check("Auth に既存のメール → already-exists「このメールアドレスは既に使われています」",
    !r.ok && r.status === "ALREADY_EXISTS" && r.message === "このメールアドレスは既に使われています", JSON.stringify(r));
  const ghost = GHOST_DISPLAYNAMES[0];
  const [ghostLocal, ghostDomain] = ghost.email.split("@");
  r = await create(U.kyoAdmin, { localPart: ghostLocal, domain: ghostDomain, name: "残骸に上書き" });
  check("displayNames だけ残っているメール → already-exists", !r.ok && r.status === "ALREADY_EXISTS", JSON.stringify(r));
  check("  → Auth のアカウント数が増えていない", (await authUserCount()) === u0);
  check("  → displayNames の件数が増えていない", (await fsCount("displayNames")) === d0);
  check("  → 残骸の displayNames は上書きされていない", (await fsDoc(`displayNames/${ghost.email}`)).fields.name.stringValue === ghost.name);
  check("  → 残骸メールの Auth は作られていない", !(await authUserByEmail(ghost.email)));

  console.log("\n■ U-2 ロールバック（受け入れ条件9・displayNames 書込を故障注入で失敗させる）");
  u0 = await authUserCount(); d0 = await fsCount("displayNames");
  const auditBeforeFault = (await auditLogs()).docs.length;
  r = await create(U.ngyAdmin, { localPart: "u2rollback", domain: "hm.com", name: "__FAULT_DN__" });
  check("internal「氏名の登録に失敗したため、アカウントの作成を取り消しました」",
    !r.ok && r.status === "INTERNAL" && r.message === "氏名の登録に失敗したため、アカウントの作成を取り消しました", JSON.stringify(r));
  check("  → Auth にアカウントが残っていない（deleteUser が通った）", !(await authUserByEmail("u2rollback@hm.com")) && (await authUserCount()) === u0);
  check("  → displayNames も増えていない", (await fsCount("displayNames")) === d0 && !(await fsDoc("displayNames/u2rollback@hm.com")));
  check("  → 監査ログも増えていない", (await auditLogs()).docs.length === auditBeforeFault);

  console.log("\n■ U-2 resetSurveyorPassword のガード（U-1 と同じ3つ・同じ順序）");
  const reset = (u, data) => callFn("resetSurveyorPassword", data, tokens[u.uid]);
  r = await callFn("resetSurveyorPassword", { uid: U.ngyA.uid }, null);
  check("未ログイン → unauthenticated", !r.ok && r.status === "UNAUTHENTICATED", JSON.stringify(r));
  r = await reset(U.ngyA, { uid: U.nodn.uid });
  check("admins に無い uid → permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  r = await reset(U.ngyAdmin, { uid: 123 });
  check("uid が文字列でない → invalid-argument", !r.ok && r.status === "INVALID_ARGUMENT", JSON.stringify(r));
  r = await reset(U.ngyAdmin, { uid: U.ngyAdmin.uid });
  check("自分自身 → failed-precondition「自分のアカウントは操作できません」", !r.ok && r.status === "FAILED_PRECONDITION" && r.message === "自分のアカウントは操作できません", JSON.stringify(r));
  r = await reset(U.ngyAdmin, { uid: U.kyoAdmin.uid });
  check("管理者アカウント → failed-precondition（他店より先）", !r.ok && r.status === "FAILED_PRECONDITION" && r.message === "管理者アカウントはこの画面からパスワードを再発行できません", JSON.stringify(r));
  r = await reset(U.ngyAdmin, { uid: U.kyoA.uid });
  check("名古屋管理者 → 京都の調査員は permission-denied「他店のアカウントです（京都店）」", !r.ok && r.status === "PERMISSION_DENIED" && r.message === "他店のアカウントです（京都店）", JSON.stringify(r));
  r = await reset(U.ngyAdmin, { uid: "no-such-uid" });
  check("存在しない uid → not-found", !r.ok && r.status === "NOT_FOUND", JSON.stringify(r));
  check("  → 拒否された対象の PW は変わっていない（共通ダミーPWでログインできる）", !!(await signIn(U.kyoA.email)).idToken && !!(await signIn(U.kyoAdmin.email)).idToken);

  console.log("\n■ U-2 PW再発行（受け入れ条件10）");
  r = await reset(U.ngyAdmin, { uid: created.uid });
  check("再発行が ok（返り値に email / password）", r.ok && r.result.ok === true && r.result.uid === created.uid && r.result.email === created.email && PW_RE.test(r.result.password), JSON.stringify(r && r.message));
  const newPw = r.ok ? r.result.password : "";
  if (newPw) issued.push(newPw);
  check("新PWは旧PWと異なる", newPw && newPw !== created.password);
  check("旧PWではログインできない", !(await signIn(created.email, created.password)).idToken);
  check("新PWでログインできる", !!(await signIn(created.email, newPw)).idToken);
  r = await reset(U.allstore, { uid: U.kyoA.uid });
  check("全店管理者 → 京都の調査員を再発行できる", r.ok, JSON.stringify(r));
  if (r.ok) issued.push(r.result.password);

  console.log("\n■ U-2 監査ログ（受け入れ条件11）");
  const all = (await auditLogs()).docs;
  const createLogs = all.filter(x => fv(x, "action") === "create");
  const resetLogs = all.filter(x => fv(x, "action") === "reset_password");
  check("create が3件（全店×2・名古屋×1）", createLogs.length === 3, String(createLogs.length));
  check("reset_password が2件", resetLogs.length === 2, String(resetLogs.length));
  const yamadaCreate = createLogs.find(x => fv(x, "targetUid") === created.uid);
  check("create ログのフィールド（target/by/branch/at）", yamadaCreate && fv(yamadaCreate, "targetEmail") === created.email
    && fv(yamadaCreate, "byUid") === U.ngyAdmin.uid && fv(yamadaCreate, "branch") === "名古屋" && !!yamadaCreate.fields.at.timestampValue);
  const BASE_KEYS = ["action", "at", "branch", "byEmail", "byUid", "targetEmail", "targetUid"];
  const keysOk = createLogs.every(x => JSON.stringify(Object.keys(x.fields).sort()) === JSON.stringify(BASE_KEYS))
    // U-3 で reset_password に method（auto / manual）が加わった。それ以外は増えていない
    && resetLogs.every(x => JSON.stringify(Object.keys(x.fields).sort()) === JSON.stringify([...BASE_KEYS, "method"].sort())
      && fv(x, "method") === "auto");
  check("ログのフィールド：create は U-1 と同じ7つ・reset_password は＋method(auto) だけ（password フィールドが無い）", keysOk);
  const dump = JSON.stringify(all);
  check(`発行したパスワード（${issued.length}件）の文字列がどのログにも含まれていない`, issued.length >= 5 && issued.every(p => !dump.includes(p)));

  // ════════════════════ U-3 ════════════════════
  const rename = (u, data) => callFn("updateSurveyorName", data, tokens[u.uid]);
  const dnOf = async email => (await fsDoc(`displayNames/${email}`));
  const auditCount = async () => (await auditLogs()).docs.length;
  // 本番の displayNames には order 等の残存フィールドがある。巻き込まないことを見るため、エミュレータの doc に足しておく
  await fetch(`${FS_DOCS}/displayNames/${encodeURIComponent(U.ngyA.email)}?updateMask.fieldPaths=order&updateMask.fieldPaths=memo`, {
    method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { order: { integerValue: "3" }, memo: { stringValue: "残存フィールド" } } }),
  });

  console.log("\n■ U-3 updateSurveyorName：認証・入力検証（受け入れ条件5）");
  r = await callFn("updateSurveyorName", { uid: U.ngyA.uid, name: "未ログイン" }, null);
  check("未ログイン → unauthenticated", !r.ok && r.status === "UNAUTHENTICATED", JSON.stringify(r));
  r = await rename(U.ngyA, { uid: U.nodn.uid, name: "調査員が変える" });
  check("admins に無い uid → permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  const beforeInvalid = await dnOf(U.ngyA.email);
  for (const [label, data] of [
    ["氏名が21文字", { uid: U.ngyA.uid, name: "あ".repeat(21) }],
    ["氏名が空（空白のみ）", { uid: U.ngyA.uid, name: "   " }],
    ["氏名に改行", { uid: U.ngyA.uid, name: "山田" + String.fromCharCode(10) + "太郎" }],
    ["氏名にタブ", { uid: U.ngyA.uid, name: "山田" + String.fromCharCode(9) + "太郎" }],
    ["氏名が文字列でない", { uid: U.ngyA.uid, name: 123 }],
    ["uid が無い", { name: "山田" }],
  ]) {
    r = await rename(U.ngyAdmin, data);
    check(`${label} → invalid-argument`, !r.ok && r.status === "INVALID_ARGUMENT", JSON.stringify(r));
  }
  const afterInvalid = await dnOf(U.ngyA.email);
  check("  → 既存値は変わっていない（updateTime も同じ）", afterInvalid.updateTime === beforeInvalid.updateTime
    && afterInvalid.fields.name.stringValue === U.ngyA.name);

  console.log("\n■ U-3 updateSurveyorName：変更（受け入れ条件1・7）");
  let audit0 = await auditCount();
  r = await rename(U.ngyAdmin, { uid: U.ngyA.uid, name: "  名古屋 調査員A改(ダミー)  " });
  check("変更が ok（返り値に uid / email / name＝前後空白除去）", r.ok && r.result.ok === true && r.result.uid === U.ngyA.uid
    && r.result.email === U.ngyA.email && r.result.name === "名古屋 調査員A改(ダミー)", JSON.stringify(r));
  const renamed = await dnOf(U.ngyA.email);
  check("displayNames.name だけが変わった", renamed.fields.name.stringValue === "名古屋 調査員A改(ダミー)");
  check("branch・order・memo は無傷", renamed.fields.branch.stringValue === "名古屋" && renamed.fields.order.integerValue === "3"
    && renamed.fields.memo.stringValue === "残存フィールド" && Object.keys(renamed.fields).length === 4, JSON.stringify(renamed.fields));
  const nameLog = (await auditLogs()).docs.find(x => fv(x, "action") === "update_name" && fv(x, "targetUid") === U.ngyA.uid);
  check("監査ログ update_name が1件増え、oldName / newName / by / branch が入っている", (await auditCount()) === audit0 + 1 && nameLog
    && fv(nameLog, "oldName") === U.ngyA.name && fv(nameLog, "newName") === "名古屋 調査員A改(ダミー)"
    && fv(nameLog, "byUid") === U.ngyAdmin.uid && fv(nameLog, "branch") === "名古屋", JSON.stringify(nameLog && nameLog.fields));
  r = await callFn("listAccounts", {}, tokens[U.ngyAdmin.uid]);
  check("一覧の氏名も新しい氏名", r.ok && r.result.find(x => x.uid === U.ngyA.uid).displayName === "名古屋 調査員A改(ダミー)");

  console.log("\n■ U-3 updateSurveyorName：変更なし（受け入れ条件6）");
  audit0 = await auditCount();
  const beforeSame = await dnOf(U.ngyA.email);
  r = await rename(U.ngyAdmin, { uid: U.ngyA.uid, name: " 名古屋 調査員A改(ダミー) " });
  const afterSame = await dnOf(U.ngyA.email);
  check("同一文字列（前後空白だけ違う）→ ok", r.ok && r.result.name === "名古屋 調査員A改(ダミー)", JSON.stringify(r));
  check("  → 書き込みが発生していない（updateTime が同じ）", afterSame.updateTime === beforeSame.updateTime);
  check("  → 監査ログも増えていない", (await auditCount()) === audit0);

  console.log("\n■ U-3 updateSurveyorName：ガードは他店チェックだけ（受け入れ条件2・3）");
  const kyoBefore = await dnOf(U.kyoA.email);
  r = await rename(U.ngyAdmin, { uid: U.kyoA.uid, name: "越境変更" });
  check("名古屋管理者 → 京都の調査員は permission-denied「他店のアカウントです（京都店）」",
    !r.ok && r.status === "PERMISSION_DENIED" && r.message === "他店のアカウントです（京都店）", JSON.stringify(r));
  r = await rename(U.ngyAdmin, { uid: U.transfer.uid, name: "越境変更" });
  check("名古屋管理者 → displayNames.branch=京都 の調査員も permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  r = await rename(U.kyoAdmin, { uid: U.ngyA.uid, name: "越境変更" });
  check("京都管理者 → 名古屋の調査員は permission-denied", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  check("  → 京都の調査員の氏名は変わっていない", (await dnOf(U.kyoA.email)).updateTime === kyoBefore.updateTime);
  r = await rename(U.ngyAdmin, { uid: U.ngyAdmin.uid, name: "名古屋 管理者改(ダミー)" });
  check("自分自身の氏名は変更できる（ガード1を適用しない）", r.ok && (await dnOf(U.ngyAdmin.email)).fields.name.stringValue === "名古屋 管理者改(ダミー)", JSON.stringify(r));
  r = await rename(U.ngyAdmin, { uid: U.allstore.uid, name: "全店 管理者改(ダミー)" });
  check("同じ店の管理者の氏名は変更できる（ガード2を適用しない）", r.ok && (await dnOf(U.allstore.email)).fields.name.stringValue === "全店 管理者改(ダミー)", JSON.stringify(r));
  r = await rename(U.allstore, { uid: U.kyoAdmin.uid, name: "京都 管理者改(ダミー)" });
  check("全店管理者 → 京都の管理者の氏名も変更できる", r.ok, JSON.stringify(r));
  r = await rename(U.ngyAdmin, { uid: "no-such-uid", name: "存在しない" });
  check("存在しない uid → not-found「対象のアカウントが見つかりません」", !r.ok && r.status === "NOT_FOUND" && r.message === "対象のアカウントが見つかりません", JSON.stringify(r));

  console.log("\n■ U-3 updateSurveyorName：displayNames が無い（受け入れ条件4）");
  audit0 = await auditCount();
  const dnCount0 = await fsCount("displayNames");
  r = await rename(U.ngyAdmin, { uid: U.nodn.uid, name: "新規に作られては困る" });
  check("not-found「氏名の登録がありません」", !r.ok && r.status === "NOT_FOUND" && r.message === "氏名の登録がありません", JSON.stringify(r));
  check("  → displayNames が新規作成されていない", !(await dnOf(U.nodn.email)) && (await fsCount("displayNames")) === dnCount0);
  check("  → 監査ログも増えていない", (await auditCount()) === audit0);

  console.log("\n■ U-3 パスワード手入力：検査 a〜f（受け入れ条件8）");
  const target = U.ngyA;   // ローカルパート = nagoya-surveyor-a
  const setPw = (u, uid, password) => callFn("resetSurveyorPassword", { uid, password }, tokens[u.uid]);
  const pwCases = [
    ["a 7文字", "abc1234", "8文字以上"],
    ["a 65文字", "a1".repeat(32) + "b", "64文字以下"],
    ["b 空白を含む", "abcd 1234", "半角"],
    ["b 全角文字を含む", "ａｂｃｄ1234", "半角"],
    ["b タブを含む", "abcd" + String.fromCharCode(9) + "1234", "半角"],
    ["c 英字だけ", "gtrkwqmz", "英字と数字"],
    ["c 数字だけ", "38472916", "英字と数字"],
    ["d 拒否リスト password1", "password1", "推測されやすい"],
    ["d 拒否リスト 大文字小文字を無視 PassW0rd", "PassW0rd", "推測されやすい"],
    ["d 拒否リスト 12345678", "12345678", "推測されやすい"],
    ["d 拒否リスト houseneko", "houseneko", "推測されやすい"],
    ["e 同じ文字の繰り返し", "aaaaaaaa", "繰り返し"],
    ["e 連番（英字）", "abcdefgh", "連番"],
    ["e 逆順の連番（数字）", "87654321", "連番"],
    ["f ローカルパートと同一", "nagoya-surveyor-a", "@より前"],
    ["f ローカルパートを含む", "x9nagoya-surveyor-a1", "@より前"],
  ];
  for (const [label, pw, keyword] of pwCases) {
    r = await setPw(U.ngyAdmin, target.uid, pw);
    check(`${label} → invalid-argument（「${keyword}」を含むメッセージ）`, !r.ok && r.status === "INVALID_ARGUMENT" && r.message.includes(keyword), JSON.stringify(r));
  }
  let sharedRejected = SHARED_PASSWORDS.length > 0;
  for (const p of SHARED_PASSWORDS) {
    r = await setPw(U.ngyAdmin, target.uid, p);
    if (r.ok || r.status !== "INVALID_ARGUMENT") sharedRejected = false;
  }
  check(`d 共通パスワード（環境変数 SHARED_PASSWORDS・${SHARED_PASSWORDS.length}件）はすべて invalid-argument`, sharedRejected,
    SHARED_PASSWORDS.length ? "" : "SHARED_PASSWORDS が未設定のため未検証");
  r = await setPw(U.ngyAdmin, target.uid, 12345678);
  check("password が文字列でない → invalid-argument", !r.ok && r.status === "INVALID_ARGUMENT", JSON.stringify(r));
  check("  → 弾かれた間、パスワードは変わっていない（共通ダミーPWでログインできる）", !!(await signIn(target.email)).idToken);

  console.log("\n■ U-3 パスワード手入力：ガードは3つ全部のまま（受け入れ条件12）");
  r = await setPw(U.ngyAdmin, U.ngyAdmin.uid, "Genba2026x");
  check("自分自身 → failed-precondition（手入力でも）", !r.ok && r.status === "FAILED_PRECONDITION" && r.message === "自分のアカウントは操作できません", JSON.stringify(r));
  r = await setPw(U.ngyAdmin, U.allstore.uid, "Genba2026x");
  check("管理者アカウント → failed-precondition（手入力でも乗っ取れない）", !r.ok && r.status === "FAILED_PRECONDITION", JSON.stringify(r));
  r = await setPw(U.ngyAdmin, U.allstore.uid, "short");
  check("管理者アカウント＋不正なPW → パスワード検査より先にガードで弾く", !r.ok && r.status === "FAILED_PRECONDITION", JSON.stringify(r));
  r = await setPw(U.ngyAdmin, U.kyoA.uid, "Genba2026x");
  check("他店 → permission-denied（手入力でも）", !r.ok && r.status === "PERMISSION_DENIED", JSON.stringify(r));
  check("  → 管理者・他店のパスワードは変わっていない", !(await signIn(U.allstore.email, "Genba2026x")).idToken && !!(await signIn(U.allstore.email)).idToken
    && !(await signIn(U.kyoA.email, "Genba2026x")).idToken);

  console.log("\n■ U-3 パスワード手入力：設定（受け入れ条件9）");
  const manualPw = "Genba2026x";
  r = await setPw(U.ngyAdmin, target.uid, manualPw);
  check("正当な手入力PW → ok・返り値の password が入力値そのもの", r.ok && r.result.password === manualPw && r.result.email === target.email, JSON.stringify(r));
  check("手入力したPWでログインできる", !!(await signIn(target.email, manualPw)).idToken);
  check("旧PW（共通ダミーPW）ではログインできない", !(await signIn(target.email)).idToken);

  console.log("\n■ U-3 password 省略は U-2 と同じ自動生成（受け入れ条件10）");
  r = await callFn("resetSurveyorPassword", { uid: target.uid }, tokens[U.ngyAdmin.uid]);
  const autoPw = r.ok ? r.result.password : "";
  check("password 省略 → 英小文字＋数字10桁の自動生成", r.ok && PW_RE.test(autoPw), JSON.stringify(r && r.message));
  check("自動生成PWでログインでき、直前の手入力PWでは失敗する", !!(await signIn(target.email, autoPw)).idToken && !(await signIn(target.email, manualPw)).idToken);
  r = await callFn("resetSurveyorPassword", { uid: target.uid, password: null }, tokens[U.ngyAdmin.uid]);
  check("password: null も自動生成として扱う", r.ok && PW_RE.test(r.result.password), JSON.stringify(r && r.message));
  const autoPw2 = r.ok ? r.result.password : "";

  console.log("\n■ U-3 監査ログ（受け入れ条件11）");
  const u3logs = (await auditLogs()).docs;
  const targetResets = u3logs.filter(x => fv(x, "action") === "reset_password" && fv(x, "targetUid") === target.uid);
  check("対象の reset_password が3件（manual 1・auto 2）", targetResets.length === 3
    && targetResets.filter(x => fv(x, "method") === "manual").length === 1
    && targetResets.filter(x => fv(x, "method") === "auto").length === 2, JSON.stringify(targetResets.map(x => fv(x, "method"))));
  const u3dump = JSON.stringify(u3logs);
  // f のケースはメールアドレス（targetEmail）の一部そのものなのでログに現れて当然。照合から外す
  const allPws = [...issued, manualPw, autoPw, autoPw2, ...pwCases.filter(c => !c[0].startsWith("f ")).map(c => c[1])]
    .filter(p => p && p.length >= 8);
  check(`手入力・自動・却下したパスワード（${allPws.length}件）の文字列がどのログにも含まれていない`, allPws.every(p => !u3dump.includes(p)));
  check("ログに password という名前のフィールドが無い", u3logs.every(x => !Object.keys(x.fields).some(k => k.toLowerCase().includes("password"))));

  console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("✖", e.stack || e.message); process.exit(1); });
