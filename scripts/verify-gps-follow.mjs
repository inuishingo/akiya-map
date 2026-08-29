/**
 * verify-gps-follow.mjs ―― 測位・追従の状態遷移検証（2026-08-29 第1便）
 *
 * 目的: 実機に持っていく前に「追従OFFでGPSが止まらないこと」「薄化が60秒で入ること」
 *       「visibilitychange の停止は残っていること」を、ブラウザ無しで確認する。
 *
 * 方式: index.html から測位まわりの実関数を "そのまま" 抜き出し、DOM / geolocation /
 *       タイマーをスタブに差し替えて動かす。コピーではなく出荷されるソース自体を
 *       実行するので、写し間違いが起こらない（scripts/verify-e1-batching.js と同じ作法）。
 *       時間は偽タイマーで進めるため、60秒待たずに何度でも回せる。
 *
 * 実行:  node scripts/verify-gps-follow.mjs
 *
 * ★第2便（ウォッチドッグ＋エラーコールバック）を入れるときの回帰テストとして使うこと。
 *   特に「薄化タイマーの二重予約」「多重 watch」は実機では気づけない事故なので、
 *   ここで必ず捕まえる。抜き出しの目印にしているコメント行を消さないこと。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// ── index.html から必要な区間を抜く（定数群 + 測位まわりの関数群） ──
function slice(fromMarker, toMarker) {
  const i = SRC.indexOf(fromMarker);
  const j = SRC.indexOf(toMarker, i);
  if (i < 0 || j < 0) throw new Error(`区間が見つからない: ${fromMarker.slice(0, 40)}`);
  return SRC.slice(i, j);
}

const constants = slice("const FOLLOW_CENTER_MIN_MS", "let myLocationMarker");
const gpsBlock  = slice("    // 測位が入った合図。", "    // 測位のたびに setCenter すると");

// ── 偽タイマー ──
let now = 0;
const timers = new Map();
let nextTimerId = 1;
const setTimeoutStub = (fn, ms) => { const id = nextTimerId++; timers.set(id, { fn, at: now + ms }); return id; };
const clearTimeoutStub = (id) => { timers.delete(id); };
function advance(ms) {
  const target = now + ms;
  for (;;) {
    let due = null;
    for (const [id, t] of timers) if (t.at <= target && (due === null || t.at < timers.get(due).at)) due = id;
    if (due === null) break;
    const t = timers.get(due);
    timers.delete(due);
    now = t.at;
    t.fn();
  }
  now = target;
}

// ── スタブ ──
const state = {
  watches: [],          // 実際に張られた watchPosition
  activeWatchOpts: null,
  markerDrawn: 0,
  recentered: 0,
  hidden: false,
};

const geolocation = {
  watchPosition(cb, err, opts) {
    const id = state.watches.length + 1;
    state.watches.push({ id, cb, opts, cleared: false });
    state.activeWatchOpts = opts;
    return id;
  },
  clearWatch(id) {
    const w = state.watches.find(w => w.id === id);
    if (w) w.cleared = true;
    state.activeWatchOpts = null;
  },
  getCurrentPosition() { /* locateMe 用。ここでは使わない */ },
};

/** 現在生きている watch（clearされていない最後のもの） */
const liveWatch = () => state.watches.filter(w => !w.cleared).slice(-1)[0] || null;

// スタブ環境で実関数を評価する
const factory = new Function("stubs", `
  const { setTimeout, clearTimeout, navigator, document, showMyLocation, requestHeadingApply,
          maybeRecenter, GPS_SPEED_ON, GPS_SPEED_OFF } = stubs;
  ${constants}
  let myLocationMarker = null, lastFixLL = null, myLocationStale = false;
  let followMode = true, watchId = null, watchHighAccuracy = null, staleTimer = null;
  let lastCenterAt = 0, lastCenterLL = null;
  let headingUpMode = false, headingUpPaused = false;
  let useGpsHeading = false, headBufSin = [], headBufCos = [], gpsHeading = null, gpsHeadingAt = 0;
  ${gpsBlock}
  return {
    noteFix, setMyLocationStale, setFollow, needsLocationWatch,
    startLocationWatch, stopLocationWatch,
    peek: () => ({ myLocationStale, followMode, watchId, watchHighAccuracy, staleTimer,
                   lastFixLL, hidden: document.hidden }),
    setHidden: (v) => { document.hidden = v; },
  };
`);

const M = factory({
  setTimeout: setTimeoutStub,
  clearTimeout: clearTimeoutStub,
  navigator: { geolocation },
  document: { hidden: false, querySelector: () => null, addEventListener: () => {} },
  showMyLocation: (lat, lng) => { state.markerDrawn++; },
  requestHeadingApply: () => {},
  maybeRecenter: () => { state.recentered++; },
  GPS_SPEED_ON: 1.2, GPS_SPEED_OFF: 0.6,
});

/** watch のコールバックに位置を1回流す */
function feedFix(lat = 35.05, lng = 136.97) {
  const w = liveWatch();
  if (!w) return false;
  w.cb({ coords: { latitude: lat, longitude: lng, accuracy: 20, speed: 1.4, heading: 90 } });
  return true;
}

let ng = 0;
const check = (c, label, detail) => {
  if (c) console.log(`  ✔ ${label}`);
  else { ng++; console.log(`  ★NG ${label}${detail ? " … " + detail : ""}`); }
};

console.log("=".repeat(72));
console.log("第1便：測位・追従の状態遷移検証（index.html の実関数を実行）");
console.log("=".repeat(72));

// ───────── 1. 起動〜追従ON ─────────
console.log("\n── 1. 起動直後（追従ON）──");
M.startLocationWatch();
feedFix();
check(liveWatch() !== null, "watch が張られている");
check(state.activeWatchOpts.enableHighAccuracy === true, "追従ON＝高精度");
check(M.peek().myLocationStale === false, "青ドットは濃い（stale でない）");

// ───────── 2. パンで追従OFF → 20秒経っても止まらない（本題）─────────
console.log("\n── 2. パンで追従OFF → 20秒経過（旧仕様なら測位停止）──");
M.setFollow(false);
check(state.activeWatchOpts.enableHighAccuracy === false, "追従OFF＝低精度へ張り替え");
check(state.activeWatchOpts.maximumAge === 15000, `maximumAge が 15000（実際 ${state.activeWatchOpts.maximumAge}）`);
advance(20000);
check(liveWatch() !== null, "★20秒経っても watch が生きている（旧仕様ではここで clearWatch）");
check(M.peek().myLocationStale === false, "★20秒時点で薄くなっていない");
const drawnBefore = state.markerDrawn;
check(feedFix(35.051, 136.971), "★追従OFF中でも位置更新を受け取れる");
check(state.markerDrawn > drawnBefore, "★追従OFF中でも青ドットが描き直される（＝動く）");

// ───────── 3. 60秒無更新で薄化 → 更新再開で復帰 ─────────
console.log("\n── 3. 位置更新が途絶えて60秒 ──");
advance(59000);
check(M.peek().myLocationStale === false, "59秒時点ではまだ濃い");
advance(1500);
check(M.peek().myLocationStale === true, "★60秒を過ぎたら薄くなる");
check(M.peek().staleTimer === null, "薄化後はタイマーを掃除している（多重予約なし）");
feedFix(35.052, 136.972);
check(M.peek().myLocationStale === false, "★更新が再開したら濃さが戻る");
check(M.peek().staleTimer !== null, "次の薄化が予約し直されている");

// ───────── 4. visibilitychange の停止は残っている ─────────
console.log("\n── 4. 画面が隠れたとき（発熱対策として残す挙動）──");
M.setHidden(true);
check(M.needsLocationWatch() === false, "hidden なら測位は不要と判定");
M.stopLocationWatch();
check(liveWatch() === null, "★画面が隠れたら測位を止める（visibilitychange の停止は健在）");
check(M.peek().myLocationStale === true, "停止時は薄化して古い位置と分かる");
M.setHidden(false);
M.startLocationWatch();
check(liveWatch() !== null, "★画面復帰で測位が再開する");
feedFix();
check(M.peek().myLocationStale === false, "復帰後に位置が入れば濃さも戻る");

// ───────── 5. 📍で追従ON復帰 ─────────
console.log("\n── 5. 📍で追従ON復帰 ──");
M.setFollow(true);
check(state.activeWatchOpts.enableHighAccuracy === true, "★高精度へ張り替わる");
check(M.peek().followMode === true, "followMode が true");

// ───────── 6. 多重 watch が起きないこと ─────────
console.log("\n── 6. 多重購読の防止 ──");
const before = state.watches.filter(w => !w.cleared).length;
M.startLocationWatch(); M.startLocationWatch(); M.startLocationWatch();
check(state.watches.filter(w => !w.cleared).length === before,
  "同条件で何度呼んでも watch は増えない", `${before} → ${state.watches.filter(w => !w.cleared).length}`);

console.log("\n" + "=".repeat(72));
console.log(ng === 0 ? "✔ 全項目 合格" : `✖ ${ng}件 不合格`);
console.log("=".repeat(72));
process.exitCode = ng === 0 ? 0 : 1;
