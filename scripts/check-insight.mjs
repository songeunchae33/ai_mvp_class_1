// 3단계 AI 인사이트 서버(api/receipts.js의 insight 모드) 테스트 — 진짜 AI는 부르지 않고 가짜 답으로 확인
// 실행: node scripts/check-insight.mjs
//  1) facts의 숫자만 쓴 답 → 그대로 통과
//  2) 없는 숫자(지어낸 금액·퍼센트)가 섞인 답 → 쓰지 않고 fallback
//  3) facts에 가게 이름·거래 목록을 섞어 보내도 AI에 가는 글에는 들어가지 않음
process.env.GEMINI_API_KEY = "test";
const ROOT = new URL("..", import.meta.url);
let sent = null, reply = null;
globalThis.fetch = async (url, o) => {
  sent = JSON.parse(o.body);
  return new Response(JSON.stringify({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(reply) }] }] }), { status: 200 });
};
const mod = await import(new URL("api/receipts.js", ROOT));
const call = async (body) => {
  let out;
  const res = { setHeader() {}, status(c) { this.c = c; return this; }, json(o) { out = { code: this.c, ...o }; } };
  await mod.default({ method: "POST", headers: {}, body }, res);
  return out;
};

const facts = {
  period: "2026-11-01~2026-11-13", daysLeft: 17, spentToDate: 538500, prevSamePeriod: 312000, fixedToDate: 55000,
  forecast: 836000, budget: 590000, overProb: 1,
  rise: { cat: "카페·간식", diff: 44000 }, recurringCount: 2, unusualCount: 1,
  categories: [{ cat: "식비", toDate: 180000, prev: 50000, forecast: 300000 }],
  // 아래는 보내면 안 되는 정보 — 서버가 걸러야 한다
  merchant: "비밀 가게", transactions: [{ merchant: "비밀 가게", amount: 12345 }],
};
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log("✗", msg); } else console.log("✓", msg); };

reply = { summary: "이번 달 지금까지 53.9만원을 썼고, 월말엔 약 83.6만원이 될 것으로 추정돼요.",
  change: "지난달 같은 기간보다 22.7만원 더 썼고, 카페·간식이 4.4만원 늘었어요.",
  risk: "예산 59만원을 넘을 가능성이 100%예요.", save: "식비가 18만원으로 가장 많아요.", action: "이번 주엔 카페를 하루만 줄여 봐요." };
const ok = await call({ mode: "insight", facts });
check(ok.insight && !ok.fallback, "facts의 숫자만 쓴 답은 통과");
check(!JSON.stringify(sent).includes("비밀 가게") && !JSON.stringify(sent).includes("12345"), "가게 이름·거래 목록은 AI에 보내지 않음");

reply = { ...reply, change: "지난달보다 35% 늘었고 배달이 9만원 늘었어요." };
const bad = await call({ mode: "insight", facts });
check(bad.fallback === true && bad.bad.length >= 1, `지어낸 숫자가 있으면 쓰지 않음 (걸린 숫자: ${bad.bad?.join(", ")})`);

const none = await call({ mode: "insight", facts: {} });
check(none.code === 400, "숫자가 없으면 AI를 부르지 않음");

console.log(fail ? `\n실패 ${fail}개` : "\n통과");
process.exit(fail ? 1 : 0);
