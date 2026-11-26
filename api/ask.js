// 하단 질문창: 사용자 상황(요약)과 오늘 시세를 붙여 짧게 답한다. Gemini 무료 등급 먼저, 안 되면 OpenAI (api/_ai.js).
// POST /api/ask { question, profile, market }
// POST /api/ask { topic }  → 경제 공부 '기타' 주제: 개념 3개 × OX 3단계를 만든다 (앱이 이 기기에 저장해 다시 부르지 않음)
import { quota, crossSite } from "./_util.js";
import { generate, aiReady } from "./_ai.js";

const SYSTEM = `너는 '나만의 경제' 앱의 금융 길잡이 캐릭터 '루미'(이루미)야. 사용자의 길을 밝혀주는 다정한 친구 같은 말투로. 2030 사용자에게 경제를 친근한 존댓말(~요)로 설명해.
- 4~6문장, 쉬운 말. 어려운 용어는 괄호로 한 번 풀어줘.
- 사용자 정보(나이대, 위험 성향, 선호, 대출·자산 요약)가 주어지면 "당신에게는" 관점으로 연결해서 설명해. 계산이 가능하면 근거와 함께 대략적인 금액을 보여줘.
- 특정 종목 매수·매도 추천이나 수익 보장은 하지 마. 판단은 사용자 몫이라고 자연스럽게 남겨.
- 모르는 최신 사실은 지어내지 말고 모른다고 말해. 시세는 주어진 값만 사용해.
- 사용자 정보의 knowledge(경제 지식)에 맞춰 말해. "처음이에요"면 용어를 모두 풀고 생활 예시를 들고, "뉴스는 보는데 어려워요"면 핵심 용어만 풀고, "어느 정도 알아요"면 기본 풀이 없이 핵심만 짧게, "경제 전공자예요"면 쉬운 풀이·생활 예시 없이 전문 용어로 원인→전달 경로→영향과 반대 위험까지.
- status(지금 상황)·aims(돈 목표)·fields(관심 분야)가 있으면 답을 그 상황과 목표에 이어서 설명해.`;

// 하루 질문 한도 (IP 기준, 서버 인스턴스마다 따로 세는 대략적인 보호).
// 1인 한도(루미의 피드백 하루 1번 + 광고 3번)는 앱이 지키고, 여기는 같은 와이파이를 쓰는 여러 사람을 막지 않게 넉넉히 둔다

// 주제 공부 만들기 한도: 1인 하루 2주제는 앱이 지키고, 여기는 IP마다 넉넉히
const OX = { type: "object", additionalProperties: false, required: ["q", "a", "ex"], properties: {
  q: { type: "string", description: "'~다?'로 끝나는 OX 문제 한 문장" },
  a: { type: "string", enum: ["O", "X"] },
  ex: { type: "string", description: "왜 맞고 틀린지 쉬운 해설 1~2문장" },
} };
const TOPIC_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "concepts", "offTopic"],
  properties: {
    name: { type: "string", description: "사용자가 적은 주제 그대로" },
    concepts: { type: "array", description: "개념 3개 (offTopic이면 빈 배열)", items: {
      type: "object", additionalProperties: false, required: ["term", "kw", "short", "body", "me", "quizzes"],
      properties: {
        term: { type: "string", description: "개념 이름 (15자 이내)" },
        kw: { type: "string", description: "관련 뉴스 검색어 1~2낱말" },
        short: { type: "string", description: "한 줄 설명 (30자 이내)" },
        body: { type: "string", description: "쉬운 설명 3~4문장" },
        me: { type: "string", description: "2030 사회초년생 생활과 연결한 한 문장" },
        quizzes: { type: "array", description: "OX 3문제: 1단계 기본 → 2단계 심화 → 3단계 도전", items: OX },
      },
    } },
    offTopic: { type: "boolean", description: "돈과 분명히 상관없거나 나쁜 뜻의 주제여서 concepts를 비웠을 때만 true. 연금·보험·세금·월급·부동산 같은 생활 속 돈 이야기는 false" },
  },
};
const TOPIC_RULES = `너는 '나만의 경제' 앱의 루미야. 경제를 처음 공부하는 20대가 주제를 하나 적으면, 그 주제의 핵심 개념 3개와 개념마다 OX 퀴즈 3문제를 만들어.
- 존댓말(~요), 쉬운 단어. 어려운 용어는 괄호로 한 번 풀어줘.
- 확실한 사실만 써. 해마다 바뀌는 한도·세율·금리 같은 숫자는 확실하지 않으면 쓰지 말고 '정해진 한도가 있어요'처럼 말해.
- 퀴즈 답은 설명(body) 안에서 알 수 있게 내고, 세 문제의 답이 모두 같지 않게 O와 X를 섞어.
- 특정 종목·상품을 사라고 권하지 마.
- 사용자가 적은 주제를 그대로 다뤄. 비슷한 다른 주제로 바꾸지 마(예: '금리 인하'를 '금리 인상'으로 바꾸지 않기).
- 퇴직연금·보험·세금·월급·전세처럼 생활 속 돈 이야기는 모두 경제 주제야. 돈과 분명히 상관없는 주제(연예, 게임 공략 등)나 나쁜 뜻의 주제일 때만 concepts를 빈 배열로 하고 offTopic을 true로.`;
const cut = (v, n) => String(v || "").trim().slice(0, n);
const TOPIC_MAJOR = `
- 이 사람은 경제·금융 전공자야. 위의 '처음 공부하는 20대'·'쉬운 단어' 대신, 전공 시험 수준의 개념(메커니즘·조건·예외)을 고르고 전문 용어를 그대로 써.
- 퀴즈는 상식으로 맞힐 수 없게, 헷갈리는 조건이나 흔한 오해를 찌르는 문장으로 내.`;
async function makeTopic(topic, lv) {
  const out = await generate({ system: TOPIC_RULES + (Number(lv) === 3 ? TOPIC_MAJOR : ""), text: `[주제]\n${topic}`, schema: TOPIC_SCHEMA, schemaName: "topic", maxTokens: 2600 });
  const j = JSON.parse(out.text);
  const concepts = (j.concepts || []).slice(0, 4).map((c) => ({
    term: cut(c.term, 24), kw: cut(c.kw, 20), short: cut(c.short, 60), body: cut(c.body, 600), me: cut(c.me, 200),
    quizzes: (c.quizzes || []).filter((q) => q && q.q && (q.a === "O" || q.a === "X")).slice(0, 3).map((q) => ({ q: cut(q.q, 200), a: q.a, ex: cut(q.ex, 300) })),
  })).filter((c) => c.term && c.body && c.quizzes.length === 3);
  // 쓸 만한 개념이 나왔으면 받아들이고, 비었을 때만 주제 거절(offTopic) 또는 실패로 본다
  if (!concepts.length) { if (j.offTopic) return { ok: false }; throw new Error("빈 주제"); }
  return { ok: true, name: topic, concepts, ai: out.ai }; // 이름은 AI가 바꾸지 않게 적은 그대로
}

// 영어 버전 번역: IP마다 하루 400번(한 번에 최대 40줄)
const trCache = new Map();
const TR_SCHEMA = { type: "object", additionalProperties: false, required: ["en"], properties: { en: { type: "array", items: { type: "string" } } } };
const TR_RULES = `You translate the screen text of a Korean personal-finance app for people in their 20s-30s into natural, short, friendly English.
- The input is a JSON array of Korean strings. Return {"en": [...]} with exactly the same number of items, in the same order.
- The app is "나만의 경제" = "My Economy". The mascot 루미/이루미 = "Lumi". 모의투자 = "Mock Investing". 가계부 = "Budget book". 경제 공부 = "Learn". 내 돈 = "My Money".
- Keep markers like [[1]]...[[/1]] and [[br]] exactly as they are, wrapped around the matching translated words. Never drop or renumber them.
- Keep numbers, %, emoji and symbols (›, ▲, ▼, ·, +, -) as they are. Won amounts: "1,000원" → "₩1,000", "300만원"/"300만 원" → "₩3M", "1억" → "₩100M".
- Use common English names for Korean companies and institutions (삼성전자 → Samsung Electronics, 한국은행 → Bank of Korea, 코스피 → KOSPI).
- Short UI labels stay short. Do not add explanations or quotes. If a string has no Korean meaning to translate, return it unchanged.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원해요" });
  if (!aiReady()) return res.status(503).json({ error: "AI 질문 기능이 아직 설정되지 않았어요" });
  if (crossSite(req)) return res.status(403).json({ error: "다른 사이트에서는 쓸 수 없어요" });

  // 영어 버전: 화면 글자 번역 (제미나이만, 서버가 같은 글자를 기억해 다시 쓴다)
  if (Array.isArray(req.body?.translate)) {
    const list = [...new Set(req.body.translate.filter((s) => typeof s === "string" && s.trim() && s.length <= 1500))].slice(0, 40);
    if (!(await quota(req, "tr", 150, 600))) return res.status(429).json({ error: "too many" });
    const tr = {}, need = [];
    for (const s of list) if (trCache.has(s)) tr[s] = trCache.get(s); else need.push(s);
    if (need.length) {
      try {
        const out = await generate({ system: TR_RULES, text: JSON.stringify(need), schema: TR_SCHEMA, schemaName: "tr", maxTokens: 6000, geminiOnly: true });
        const en = JSON.parse(out.text).en || [];
        if (en.length === need.length) need.forEach((s, i) => { if (typeof en[i] === "string" && en[i].trim()) { tr[s] = en[i]; trCache.set(s, en[i]); } });
        if (trCache.size > 20000) trCache.clear();
      } catch (e) { console.error("translate", e.message); return res.status(502).json({ error: "번역하지 못했어요", tr }); }
    }
    return res.status(200).json({ tr });
  }

  if (req.body?.topic !== undefined) {
    const topic = String(req.body.topic || "").replace(/\s+/g, " ").trim();
    if (!topic || topic.length > 20) return res.status(400).json({ error: "주제는 20자 이내로 적어 주세요" });
    if (!(await quota(req, "topic", 6, 30))) return res.status(429).json({ error: "오늘은 주제를 다 만들었어요. 내일 다시 해 주세요!" });
    try {
      const r = await makeTopic(topic, req.body?.lv);
      return res.status(200).json(r.ok ? r : { ok: false, error: "경제·돈과 관련된 주제로 적어 주세요" });
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: "주제 공부를 만들지 못했어요. 잠시 후 다시 해 주세요" });
    }
  }

  const { question, profile, market, lang } = req.body || {};
  if (typeof question !== "string" || !question.trim() || question.length > 300) {
    return res.status(400).json({ error: "질문은 300자 이내로 적어주세요" });
  }
  if (!(await quota(req, "ask", 10, 60))) return res.status(429).json({ error: "오늘 질문은 다 썼어요. 내일 다시 물어봐 주세요!" });
  const context = JSON.stringify({ profile: profile || {}, market: market || {} }).slice(0, 2000);

  try {
    const out = await generate({ system: SYSTEM + (lang === "en" ? "\n- 모든 답을 자연스럽고 쉬운 영어로 써. 한국어를 섞지 마. 돈은 ₩ 기호로." : ""), text: `[내 상황]\n${context}\n\n[질문]\n${question.trim()}`, maxTokens: 700 });
    res.status(200).json({ answer: out.text, ai: out.ai });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "답변을 만들지 못했어요. 잠시 후 다시 시도해 주세요" });
  }
}
