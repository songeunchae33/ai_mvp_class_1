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
