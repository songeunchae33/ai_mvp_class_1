// 내 돈 기록: 은행·카드 앱 '이용내역' 캡처를 AI가 읽어 거래 목록으로 바꾼다 + 소비 요약 피드백
// POST /api/receipts { images: [dataURL...] }              → { transactions, usage }
// POST /api/receipts { mode: "feedback", summary: {...} }   → { text, usage }
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
