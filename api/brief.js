// 뉴스 쉽게 풀이: 여러 언론사의 오늘 기사(제목 + 짧은 요약 문구)를 모아 AI가 공통 흐름을 분석해
// 쉬운 말로 짧게 다시 써준다. 기사 문장을 옮기지 않고, 근거 기사는 링크로만 붙인다.
// GET  /api/brief?interests=삼성전자,여행   → 오늘 뉴스 풀이 (1시간 동안 같은 결과를 재사용해 비용 절약)
// POST /api/brief { text }                  → 붙여넣은 뉴스레터 풀이 (저장하지 않음)
import OpenAI from "openai";
import { cache } from "./_util.js";
import { PREF_QUERY, naver, dedupe } from "./_news.js";

const MODEL = "gpt-6.1-sol";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mood", "points"],
  properties: {
    mood: { type: "string", description: "오늘 경제 분위기 한 줄 (30자 이내)" },
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "easy", "forMe", "sources"],
        properties: {
          title: { type: "string", description: "쉬운 제목 (18자 이내)" },
          easy: { type: "string", description: "무슨 일인지 쉬운 말 1~2문장" },
          forMe: { type: "string", description: "나에게 어떤 의미인지 1문장" },
          sources: { type: "array", items: { type: "integer" }, description: "근거가 된 기사 번호들" },
        },
      },
    },
  },
};

const RULES = `너는 경제를 처음 공부하는 20대에게 설명하는 친구야. 존댓말(~요), 쉬운 단어만 써.
- 기사 문장을 그대로 옮기지 말고, 여러 기사에 공통으로 나오는 흐름을 네 말로 정리해.
- 숫자는 기사에 나온 것만 쓰고, 모르면 쓰지 마. 추측이나 투자 추천(사라/팔아라)은 하지 마.
- 어려운 용어는 괄호로 한 번 풀어줘. 각 문장은 짧게.`;

async function ask(input) {
  const client = new OpenAI();
  const r = await client.responses.create({
    model: MODEL,
    reasoning: { effort: "low" },
    max_output_tokens: 900,
    text: { format: { type: "json_schema", name: "brief", schema: SCHEMA, strict: true } },
    input,
  });
  return JSON.parse(r.output_text);
}

export default async function handler(req, res) {
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ available: false });

  // 뉴스레터 붙여넣기 풀이
  if (req.method === "POST") {
    const text = String(req.body?.text || "").trim();
    if (text.length < 50) return res.status(400).json({ error: "내용을 조금 더 붙여넣어 주세요" });
    try {
      const out = await ask([
        { role: "system", content: RULES + "\n- 사용자가 구독하는 뉴스레터 내용을 붙여넣었어. 핵심 2~3개만 골라 points로 정리하고, sources는 빈 배열로 둬." },
        { role: "user", content: text.slice(0, 6000) },
      ]);
      return res.status(200).json({ available: true, ...out });
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: "풀이를 만들지 못했어요. 잠시 후 다시 시도해 주세요" });
    }
  }

  if (!process.env.NAVER_SEARCH_ID || !process.env.NAVER_SEARCH_SECRET) return res.status(200).json({ available: false });

  const interests = String(req.query.interests || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5);
  try {
    // 오늘의 큰 이슈 + 관심사별 기사를 여러 언론사에서 모은다
    const lists = await Promise.all([
      naver("경제", { display: 30, sort: "sim" }),
      naver("증시 금리 환율", { display: 20, sort: "date" }),
      ...interests.map((i) => naver(PREF_QUERY[i] || i, { display: 6, sort: "date" }).catch(() => [])),
    ]);
    const dayAgo = Date.now() - 36 * 3600e3;
    const pool = dedupe(lists.flat()).filter((n) => new Date(n.at).getTime() > dayAgo).slice(0, 30);
    if (pool.length < 3) return res.status(200).json({ available: true, mood: "", points: [], articles: [] });

    const listText = pool.map((n, i) => `[${i}] (${n.source}) ${n.title} — ${n.desc}`).join("\n");
    const out = await ask([
      { role: "system", content: RULES + `\n- 아래 기사 목록에서 오늘 가장 중요한 흐름 3개를 골라 points로 정리해. 관심사(${interests.join(", ") || "없음"})와 관련된 흐름이 있으면 하나는 꼭 포함해.\n- sources에는 근거 기사 번호를 1~3개 넣어.` },
      { role: "user", content: listText },
    ]);
    const points = (out.points || []).slice(0, 3).map((p) => ({
      ...p,
      sources: (p.sources || []).filter((i) => pool[i]).slice(0, 3).map((i) => ({ title: pool[i].title, url: pool[i].url, source: pool[i].source })),
    }));
    cache(res, 3600);
    res.status(200).json({ available: true, mood: out.mood, points, count: pool.length, at: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(200).json({ available: true, mood: "", points: [], error: "풀이를 만들지 못했어요" });
  }
}
