/**
 * アカウント管理（U-1）検証用のダミーデータを「エミュレータにだけ」投入する。
 *
 *   前提：npm run emu:auth（auth,firestore,functions）が起動していること。
 *   実行：
 *     $env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
 *     $env:FIRESTORE_EMULATOR_HOST     = "127.0.0.1:8080"
 *     node scripts/seed-accounts-emu.mjs
 *
 * 【安全装置】
 *   - FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST が無ければ即終了する。
 *   - その値がループバック（127.0.0.1 / localhost）でなければ即終了する。
 *   - 通信先はこの2つのホストだけ。本番のエンドポイント（googleapis.com）へ向ける経路をコードに持たない。
 *
 * 【このリポジトリは Public】
 *   ここに置くのはダミーのメール・ダミーのパスワードだけ。本番の実アカウント・実パスワードは書かない。
 *   ※ emu-dummy-allstore@housemarket.com は「@housemarket.com かつ kyoto を含まない＝全店扱い」の
 *     分岐を検証するためのダミー。実在しないアドレスで、エミュレータ以外には存在しない。
 *
 * 【破壊的】実行のたびに Auth エミュレータの全アカウントと Firestore エミュレータの全データを消してから入れ直す
 *   （エミュレータのデータは元々プロセス終了で消える前提。verify-e1-emulator.mjs と同じ運用）。
 */
import { pathToFileURL } from "node:url";

export const PROJECT = "housemarket-map";
export const DUMMY_PASSWORD = "emu-dummy-pass-0000";   // エミュレータ専用のダミー

// uid は固定（再実行しても同じ uid になり、admins の docID と突き合わせやすい）
export const ACCOUNTS = [
  { uid: "emu-allstore",    email: "emu-dummy-allstore@housemarket.com", name: "全店 管理者(ダミー)",   branch: "名古屋", admin: true },
  { uid: "emu-ngy-admin",   email: "nagoya-admin@example.test",          name: "名古屋 管理者(ダミー)", branch: "名古屋", admin: true },
  { uid: "emu-kyo-admin",   email: "kyoto-admin@example.test",           name: "京都 管理者(ダミー)",   branch: "京都",   admin: true },
  { uid: "emu-ngy-a",       email: "nagoya-surveyor-a@example.test",     name: "名古屋 調査員A(ダミー)", branch: "名古屋" },
  { uid: "emu-ngy-retired", email: "nagoya-retired@example.test",        name: "名古屋 退職者(ダミー)", branch: "名古屋", disabled: true },
  { uid: "emu-kyo-a",       email: "kyoto-surveyor-a@example.test",      name: "京都 調査員A(ダミー)",   branch: "京都" },
  // メールに kyoto を含まないが displayNames.branch=京都 → displayNames 優先の検証用
  { uid: "emu-transfer",    email: "transfer-surveyor@example.test",     name: "異動 調査員(ダミー)",   branch: "京都" },
  // displayNames 無し → 氏名空・拠点はメール判定（名古屋）にフォールバックする検証用
  { uid: "emu-nodn",        email: "no-displayname@example.test",        name: null,                    branch: null },
];

export function emulatorHosts() {
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!authHost || !fsHost) {
    console.error("✖ FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST が未設定です。エミュレータ以外には実行しません。");
    process.exit(1);
  }
  const isLoopback = h => /^(127\.0\.0\.1|localhost):\d+$/.test(h);
  if (!isLoopback(authHost) || !isLoopback(fsHost)) {
    console.error(`✖ エミュレータのホストがループバックではありません（auth=${authHost} / firestore=${fsHost}）。実行しません。`);
    process.exit(1);
  }
  return { authHost, fsHost };
}

// ---- 冒頭チェック（import された場合も含めて、何か通信する前に必ず通す）----
const { authHost: AUTH_HOST, fsHost: FS_HOST } = emulatorHosts();

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };   // エミュレータ専用の管理トークン

async function req(url, init, okStatuses = [200]) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!okStatuses.includes(res.status)) throw new Error(`${init.method || "GET"} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const AUTH = `http://${AUTH_HOST}`;
const FS = `http://${FS_HOST}`;
const FS_DOCS = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;

export async function setFsDoc(path, fields) {
  const f = {};
  for (const [k, v] of Object.entries(fields)) f[k] = { stringValue: String(v) };
  const segs = path.split("/").map(encodeURIComponent).join("/");
  return req(`${FS_DOCS}/${segs}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields: f }) });
}

export async function seed({ quiet = false } = {}) {
  // 1. 全消去（エミュレータ専用の管理エンドポイント）
  await req(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  await req(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });

  // 2. Auth アカウント
  for (const a of ACCOUNTS) {
    await req(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
      method: "POST", headers: OWNER,
      body: JSON.stringify({ localId: a.uid, email: a.email, password: DUMMY_PASSWORD }),
    });
    if (a.disabled) {
      await req(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
        method: "POST", headers: OWNER, body: JSON.stringify({ localId: a.uid, disableUser: true }),
      });
    }
  }

  // 3. Firestore：admins / displayNames（rules をバイパスする owner トークンで書く）
  for (const a of ACCOUNTS) {
    if (a.admin) await setFsDoc(`admins/${a.uid}`, { note: "emulator seed" });
    if (a.name) await setFsDoc(`displayNames/${a.email}`, { name: a.name, branch: a.branch });
  }

  if (!quiet) {
    console.log(`✔ エミュレータに投入しました（auth=${AUTH_HOST} / firestore=${FS_HOST}）`);
    console.log(`  パスワード（全員共通・ダミー）: ${DUMMY_PASSWORD}`);
    for (const a of ACCOUNTS) {
      console.log(`  ${a.email.padEnd(38)} ${a.admin ? "管理者" : "調査員"}  ${a.branch || "(displayNames無)"}${a.disabled ? "  [無効]" : ""}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch(e => { console.error("✖", e.message); process.exit(1); });
}
