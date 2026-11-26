import crypto from "node:crypto";
// API 함수들이 같이 쓰는 도구. 파일명이 _로 시작하면 Vercel이 주소(엔드포인트)로 만들지 않는다.

// 한국 시간 기준 날짜 문자열 (YYYYMMDD). daysAgo만큼 과거로.
export function kstYmd(daysAgo = 0) {
  const t = new Date(Date.now() + 9 * 3600e3 - daysAgo * 86400e3);
  return t.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function fetchJson(url, options = {}, timeoutMs = 6000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}`);
  return res.json();
}

// "1,470.5" 같은 문자열 → 숫자
export function num(v) {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// 공공데이터포털 응답에서 item 배열 꺼내기 (결과가 1개면 객체, 0개면 빈 문자열로 오기도 함)
export function dataGoItems(json) {
  const items = json?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

// 공공데이터포털 키는 "디코딩 키"를 넣는 게 원칙이지만, 인코딩 키를 넣어도 동작하게 처리
export function dataGoKey() {
  const k = process.env.DATA_GO_KR_KEY || "";
  return k.includes("%") ? k : encodeURIComponent(k);
}

export function cache(res, seconds) {
  res.setHeader("Cache-Control", `s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`);
}

// ── Firestore (서버 전용 서비스 계정 FIREBASE_SA). 모의투자 순위·미국 종가·뉴스 모아 두기에 같이 쓴다 ──
let saToken = null;
export async function adminToken() {
  if (saToken && saToken.exp > Date.now() + 60e3) return saToken.v;
  const sa = JSON.parse(process.env.FIREBASE_SA);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`firebase 열쇠 오류 ${String(j.error || "").slice(0, 60)}`);
  saToken = { v: j.access_token, exp: Date.now() + 3500e3 };
  return saToken.v;
}
export function adminReady() { return !!(process.env.FIREBASE_SA && process.env.FIREBASE_PROJECT_ID); }
export async function fsReq(path, opt = {}) {
  const t = await adminToken();
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`, {
    ...opt, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`firestore ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}
export function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
}
export function fromFs(x) {
  if (!x) return null;
  if ("stringValue" in x) return x.stringValue;
  if ("integerValue" in x) return Number(x.integerValue);
  if ("doubleValue" in x) return x.doubleValue;
  if ("booleanValue" in x) return x.booleanValue;
  if ("timestampValue" in x) return x.timestampValue;
  if ("arrayValue" in x) return (x.arrayValue.values || []).map(fromFs);
  if ("mapValue" in x) return Object.fromEntries(Object.entries(x.mapValue.fields || {}).map(([k, v]) => [k, fromFs(v)]));
  return null;
}
export async function fsList(coll) {
  const out = [];
  let token = "";
  do {
    const j = await fsReq(`${coll}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    out.push(...(j?.documents || []));
    token = j?.nextPageToken || "";
  } while (token);
  return out.map((d) => ({ id: d.name.split("/").pop(), ...fromFs({ mapValue: { fields: d.fields || {} } }) }));
}
export const fsSet = (path, data) => fsReq(path, { method: "PATCH", body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
// 여러 문서를 한 번에, 정한 칸만 읽는다 → { 경로: 칸들 | null }
export async function fsGetMany(paths, fields) {
  if (!paths.length) return {};
  const t = await adminToken(), root = `projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const r = await fetch(`https://firestore.googleapis.com/v1/${root}:batchGet`, {
    method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ documents: paths.map((p) => `${root}/${p}`), mask: { fieldPaths: fields } }),
  });
  if (!r.ok) throw new Error(`firestore batchGet ${r.status}`);
  const out = Object.fromEntries(paths.map((p) => [p, null]));
  for (const x of await r.json()) if (x.found) out[x.found.name.slice(root.length + 1)] = fromFs({ mapValue: { fields: x.found.fields || {} } });
  return out;
}

// ── AI 남용 막기: 하루 횟수를 Firestore(aiQuota)에 센다 ──
// 서버가 여러 대이거나 새로 켜져도 같이 센다. IP·기기 표시는 그대로 적지 않고 알아볼 수 없게 바꿔(해시) 적는다.
// 기기 표시(X-Dev)는 앱이 이 기기에서 만든 무작위 글자. 앱 밖에서(기기 표시 없이) 부르면 IP 한도를 기기 한도만큼으로 줄인다.
export function clientIp(req) { return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local"; }
// 다른 사이트의 화면이 우리 AI 주소를 부르면(브라우저가 cross-site라고 알려 줌) 받지 않는다
export function crossSite(req) { return String(req.headers["sec-fetch-site"] || "") === "cross-site"; }
const qid = (s) => crypto.createHash("sha256").update(`${s}|${process.env.FIREBASE_PROJECT_ID || "myeco"}`).digest("hex").slice(0, 20);
const memQ = new Map();
function memIncr(id, n) {
  const day = kstYmd(0), h = memQ.get(id), v = (h && h.day === day ? h.v : 0) + n;
  memQ.set(id, { day, v });
  if (memQ.size > 5000) memQ.clear();
  return v;
}
async function fsIncr(ids, n) {
  const t = await adminToken(), root = `projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const r = await fetch(`https://firestore.googleapis.com/v1/${root}:commit`, {
    method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(6000),
    body: JSON.stringify({ writes: ids.map((id) => ({ transform: { document: `${root}/aiQuota/${id}`, fieldTransforms: [{ fieldPath: "n", increment: { integerValue: String(n) } }] } })) }),
  });
  if (!r.ok) throw new Error(`firestore commit ${r.status}`);
  return (await r.json()).writeResults.map((w) => Number(fromFs(w.transformResults?.[0]) ?? 0));
}
async function incr(ids, n) {
  if (adminReady()) {
    try { return await fsIncr(ids, n); } catch (e) { console.error("quota", e.message); } // Firestore가 막히면 이 서버 기억으로
  }
  return ids.map((id) => memIncr(id, n));
}
// → true면 허락. kind: 기능 이름, perDev: 기기 하나 하루 한도, perIp: 같은 인터넷 주소(학교 와이파이 등) 하루 한도
export async function quota(req, kind, perDev, perIp, n = 1) {
  const day = kstYmd(0), dev = String(req.headers["x-dev"] || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
  const keys = [[`${day}_${kind}_ip_${qid(clientIp(req))}`, dev ? perIp : perDev]];
  if (dev) keys.push([`${day}_${kind}_dev_${qid(dev)}`, perDev]);
  const vals = await incr(keys.map((k) => k[0]), n);
  return vals.every((v, i) => v <= keys[i][1]);
}
// 모두 합친 하루 한도 (유료 OpenAI로 넘어가는 횟수)
export async function quotaAll(kind, max, n = 1) {
  const [v] = await incr([`${kstYmd(0)}_${kind}_all`], n);
  return v <= max;
}
