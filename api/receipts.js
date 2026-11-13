// 내 돈 기록: 은행·카드 앱 '이용내역' 캡처를 AI가 읽어 거래 목록으로 바꾼다 + 소비 요약 피드백
// POST /api/receipts { images: [dataURL...] }              → { transactions, usage }
// POST /api/receipts { mode: "feedback", summary: {...} }   → { text, usage }
// POST /api/receipts { mode: "insight", facts: {...} }       → { insight } | { fallback: true }  (소비 인텔리전스 3단계)
// 사진은 저장하지 않고 읽는 데만 쓴다. Gemini 무료 등급 먼저, 안 되면 OpenAI (api/_ai.js)
import { generate, aiReady } from "./_ai.js";
export const CATS = ["식비", "카페·간식", "쇼핑", "교통", "주거·통신", "구독", "의료·건강", "문화·여가", "여행", "교육", "경조사·선물",
  "금융·수수료", "급여·수입", "내부이체", "기타"];

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["transactions"],
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["date", "merchant", "amount", "dir", "cat", "src"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD. 연도가 안 보이면 오늘 기준으로 가장 최근 날짜" },
          merchant: { type: "string", description: "가게/거래처 이름 (계좌번호·카드번호는 쓰지 말 것)" },
          amount: { type: "integer", description: "금액(원), 양수" },
          dir: { type: "string", enum: ["out", "in"], description: "out=나간 돈, in=들어온 돈" },
          cat: { type: "string", enum: CATS },
          src: { type: "string", description: "화면에 보이는 은행·카드·앱 이름, 모르면 빈 문자열" },
        },
      },
    },
  },
};

const READ_RULES = `너는 한국 은행·카드·간편결제 앱의 '이용내역' 캡처를 읽는 도우미야.
- 화면에 보이는 거래만 하나씩 뽑아. 없는 거래를 지어내지 마. 잘려서 금액이 안 보이는 줄은 빼.
- 승인 취소·환불은 dir="in"으로.
- 카드대금 결제, 내 다른 계좌로 보낸 돈, 저축·적금 이체, 충전(토스머니·카카오페이머니 등)은 cat="내부이체"로 표시해. (지출로 두 번 세지 않으려는 것)
- 월급·용돈·이자 입금 등 들어온 돈은 cat="급여·수입".
- 계좌번호, 카드번호, 잔액, 이름 같은 개인정보는 어떤 칸에도 쓰지 마.`;

const FEEDBACK_RULES = `너는 '나만의 경제' 앱의 금융 길잡이 캐릭터 '루미'(이루미)야. 2030 사용자의 소비 요약을 보고, 경제 뉴스레터의 '머니 프로필' 사연 풀이처럼 피드백해. 쉬운 존댓말(~요).
- good: 이번 기간에 잘하고 있는 점 1~2문장. 지난 기간(previous*)과 달라진 점이나 남는 돈 흐름을 숫자로.
- worry: 지금 가장 큰 돈 걱정 딱 한 문장. 쓴 돈이 수입보다 많음, 한 분류에 너무 몰림(guidePercentOfIncome 기준보다 큼), 비상금 부족, 목표 저축이 모자람, 이자 부담 중 실제로 해당하는 것 하나. 해당하는 게 없으면 빈 문자열.
- actions: 루미의 처방 2~3개. 각각 title은 '무엇을 얼마나'(예: "배달 한 달 6만원 줄이기"), detail은 내 숫자로 된 이유와 방법 한두 문장(예: "이번 달 배달이 8번이라 2번만 줄이면 돼요"). 기준 비율은 이유로만 짧게.
- 주어진 숫자만 쓰고 새 숫자를 지어내지 마. 금액은 원 단위 값을 '만원'으로 읽기 쉽게. 주어지지 않은 항목은 말하지 마.
- 혼내지 말고 응원하는 말투로. 특정 투자 상품·종목 추천은 하지 마.`;

const FB_SCHEMA = {
  type: "object", additionalProperties: false, required: ["good", "worry", "actions"],
  properties: {
    good: { type: "string" },
    worry: { type: "string" },
    actions: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: "string" } } } },
  },
};

// ── 소비 인텔리전스 3단계: 앱이 계산한 숫자(facts)를 루미가 설명만 한다 ──
// facts에는 집계 숫자만 들어온다(가게 이름·개별 거래 없음). 서버에서 한 번 더 걸러 정해진 칸만 AI에 보낸다.
const INSIGHT_RULES = `너는 '나만의 경제' 앱의 금융 길잡이 캐릭터 '루미'(이루미)야. 앱이 계산한 이번 달 소비 숫자(facts)를 2030 사용자에게 쉬운 존댓말(~요)로 설명해.
- summary: 이번 달 소비 핵심 한 문장 (지금까지 쓴 돈과 월말 예상).
- change: 지난달 같은 기간과 비교한 변화 한 문장. 가장 많이 늘어난 분류가 있으면 그 이름과 늘어난 금액.
- risk: 예산을 넘을 가능성 한 문장. 예산 정보가 없으면 빈 문자열.
- save: 줄이면 좋은 분류 하나와 이유 한 문장 (facts에 있는 분류·숫자로만).
- action: 이번 주에 할 수 있는 작은 실천 한 문장.
규칙: facts에 있는 숫자만 그대로 써. 숫자를 새로 계산하거나(더하기·빼기·비율), 반올림 단위를 바꾸거나, 지어내지 마. 금액은 facts의 '…_man'(만원) 값을 '○만원'으로 쓰면 돼.
예측은 '추정'이라고 말해. 혼내지 말고 응원하는 말투로. 투자 상품·종목 추천은 하지 마. 각 칸은 한 문장, 60자 안쪽.`;

const INSIGHT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "change", "risk", "save", "action"],
  properties: { summary: { type: "string" }, change: { type: "string" }, risk: { type: "string" }, save: { type: "string" }, action: { type: "string" } },
};

// 받은 facts에서 정해진 칸만 숫자로 남긴다 (다른 정보가 섞여 와도 AI에 보내지 않음)
export function cleanFacts(f = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const man = (v) => (n(v) === null ? null : Math.round(n(v) / 1000) / 10); // 원 → 만원(소수 한 자리)
  const cats = (Array.isArray(f.categories) ? f.categories : []).slice(0, 5)
    .filter((c) => typeof c?.cat === "string" && CATS.includes(c.cat))
    .map((c) => ({ cat: c.cat, to_date_man: man(c.toDate), prev_same_period_man: man(c.prev), forecast_man: man(c.forecast) }));
  const out = {
    period: typeof f.period === "string" ? f.period.slice(0, 23) : "",
    days_left: n(f.daysLeft),
    spent_to_date_man: man(f.spentToDate),
    prev_same_period_man: man(f.prevSamePeriod),
    diff_vs_prev_man: f.prevSamePeriod ? man(f.spentToDate - f.prevSamePeriod) : null,
    diff_vs_prev_pct: f.prevSamePeriod ? n(((f.spentToDate - f.prevSamePeriod) / f.prevSamePeriod) * 100) : null,
    fixed_to_date_man: man(f.fixedToDate),
    month_end_forecast_man: man(f.forecast),
    budget_man: man(f.budget),
    forecast_minus_budget_man: f.budget && f.forecast ? man(f.forecast - f.budget) : null,
    over_budget_prob_pct: f.overProb === null || f.overProb === undefined ? null : n(f.overProb * 100),
    top_rise: f.rise && CATS.includes(f.rise.cat) ? { cat: f.rise.cat, rise_man: man(f.rise.diff) } : null,
    categories: cats,
    recurring_count: n(f.recurringCount),
    unusual_count: n(f.unusualCount),
  };
  return out;
}

// AI 답에 나온 숫자가 facts에 있는 숫자인지 확인한다. 없는 숫자가 하나라도 있으면 그 답은 쓰지 않는다.
// 허용: facts의 모든 숫자(만원·원·%·일 등)와 그 원 단위 값, 그리고 문장에 흔한 작은 수(1~7: 한 주, 이번 주 같은 말)
export function numbersOk(text, facts) {
  const allowed = new Set();
  const walk = (v) => {
    if (v && typeof v === "object") return Object.values(v).forEach(walk);
    if (typeof v === "number" && Number.isFinite(v)) {
      allowed.add(+Math.abs(v).toFixed(1)); allowed.add(Math.round(Math.abs(v)));
      allowed.add(Math.round(Math.abs(v) * 10000)); // 만원 → 원
    }
  };
  walk(facts);
  for (let i = 1; i <= 7; i++) allowed.add(i);
  const bad = [];
  // "12.3만원", "1,234원", "45%", "18일", "3번" … 숫자 덩어리를 모두 꺼낸다 (날짜 '11/13' 같은 기간 표기는 facts.period에서 허용)
  const periodNums = String(facts.period || "").match(/\d+/g) || [];
  periodNums.forEach((x) => allowed.add(Number(x)));
  for (const m of String(text).matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(만\s*원|만원|원|%|퍼센트|일|번|건|개|달|주|배)?/g)) {
    const raw = Number(m[1].replace(/,/g, ""));
    const unit = (m[2] || "").replace(/\s/g, "");
    const v = unit === "만원" ? raw : raw;
    const ok = allowed.has(+v.toFixed(1)) || allowed.has(Math.round(v)) || (unit === "원" && allowed.has(Math.round(raw)));
    if (!ok) bad.push(m[0]);
  }
  return { ok: bad.length === 0, bad };
}

// 아주 단순한 남용 방지 (서버 인스턴스마다 IP별 하루 사진 수 제한)
const hits = new Map();
function allow(ip, n) {
  const day = new Date().toISOString().slice(0, 10);
  const h = hits.get(ip);
  const cur = h && h.day === day ? h.count : 0;
  if (cur + n > 20) return false; // 1인 최대 캡처 12장(무료 3 + 광고 9) + 피드백 4번에 여유분. 1인 한도는 앱이 지킨다
  hits.set(ip, { day, count: cur + n });
  return true;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원해요" });
  if (!aiReady()) return res.status(503).json({ error: "AI 기능이 아직 설정되지 않았어요" });
  const body = req.body || {};
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "local";

  try {
    if (body.mode === "feedback") {
      const summary = JSON.stringify(body.summary || {}).slice(0, 3000);
      if (!allow(ip, 1)) return res.status(429).json({ error: "오늘은 더 이상 요청할 수 없어요. 내일 다시 해주세요" });
      const r = await generate({ system: FEEDBACK_RULES, text: summary, schema: FB_SCHEMA, schemaName: "money_feedback", maxTokens: 900 });
      const fb = JSON.parse(r.text);
      // 예전 화면용 글도 함께 (고민 → 처방 순서)
      const text = [fb.good, fb.worry, ...fb.actions.map((x, i) => `${i + 1}. ${x.title} — ${x.detail}`)].filter(Boolean).join("\n");
      return res.status(200).json({ fb, text, ai: r.ai });
    }

    if (body.mode === "insight") {
      const facts = cleanFacts(body.facts);
      if (facts.spent_to_date_man === null) return res.status(400).json({ error: "소비 숫자가 없어요" });
      if (!allow(ip, 1)) return res.status(429).json({ error: "오늘은 더 이상 요청할 수 없어요. 내일 다시 해주세요" });
      const r = await generate({ system: INSIGHT_RULES, text: JSON.stringify({ facts }), schema: INSIGHT_SCHEMA, schemaName: "spend_insight", maxTokens: 700 });
      const insight = JSON.parse(r.text);
      const check = numbersOk(Object.values(insight).join(" "), facts);
      // 없는 숫자를 만들어 냈으면 쓰지 않고, 앱이 규칙으로 만든 문장을 보여주게 한다
      if (!check.ok) return res.status(200).json({ fallback: true, reason: "숫자 확인 실패", bad: check.bad.slice(0, 5), ai: r.ai });
      return res.status(200).json({ insight, ai: r.ai });
    }

    const images = Array.isArray(body.images) ? body.images.filter((x) => typeof x === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(x)) : [];
    if (!images.length) return res.status(400).json({ error: "사진이 없어요" });
    if (images.length > 8) return res.status(400).json({ error: "한 번에 8장까지 올릴 수 있어요" });
    if (images.reduce((s, x) => s + x.length, 0) > 4_000_000) return res.status(400).json({ error: "사진이 너무 커요" });
    if (!allow(ip, images.length)) return res.status(429).json({ error: "오늘 읽을 수 있는 사진 수를 넘었어요. 내일 다시 해주세요" });

    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const text = `오늘은 ${today}이야. 아래 캡처 ${images.length}장의 거래를 모두 뽑아줘.` + (body.pieces
      ? ` 이 사진들은 스크롤해서 길게 찍은 캡처 한 장을 위에서 아래로 순서대로 자른 조각이야. 조각끼리 조금 겹쳐 있으니 겹친 거래는 한 번만 적어. 날짜 머리글이 앞 조각에 있으면 그 날짜를 다음 조각 거래에도 이어서 써.${/^\d{4}-\d{2}-\d{2}$/.test(String(body.lastDate || "")) ? ` 바로 앞 조각의 마지막 거래 날짜는 ${body.lastDate}였어.` : ""}`
      : "");
    const r = await generate({ system: READ_RULES, text, images, schema: SCHEMA, schemaName: "transactions", maxTokens: 4000 });
    const out = JSON.parse(r.text);
    const transactions = (out.transactions || []).filter((t) => t.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date)).slice(0, 300);
    res.status(200).json({ transactions, ai: r.ai });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "읽지 못했어요. 글씨가 잘 보이게 다시 캡처해 주세요" });
  }
}
