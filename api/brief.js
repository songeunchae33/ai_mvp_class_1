// 쉽게 풀이: 최근 3일 정부 경제 보도자료(정책브리핑, 공공저작물)를 모아 AI가 쉬운 말로 짧게 정리한다.
// 네이버 뉴스 검색 결과는 약관상 AI 요약에 쓸 수 없어서 쓰지 않는다. 근거 보도자료는 링크로 붙인다.
// GET  /api/brief?interests=삼성전자,여행   → 오늘 경제 정책 풀이 (1시간 동안 같은 결과를 재사용해 비용 절약)
// POST /api/brief { text }                  → 붙여넣은 뉴스레터 풀이 (저장하지 않음)
import OpenAI from "openai";
import { cache } from "./_util.js";
import { pressReleases, isEcon } from "./_policy.js";

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

// 뉴스레터 붙여넣기 풀이: 하루 5번 (IP 기준)
const letterHits = new Map();

export default async function handler(req, res) {
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ available: false });

  // 뉴스레터 붙여넣기 풀이
  if (req.method === "POST") {
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "local";
    const day = new Date().toISOString().slice(0, 10);
    const h = letterHits.get(ip);
    const used = h && h.day === day ? h.n : 0;
    if (used >= 5) return res.status(429).json({ error: "오늘 풀이는 다 썼어요. 내일 다시 해주세요!" });
    const text = String(req.body?.text || "").trim();
    if (text.length < 50) return res.status(400).json({ error: "내용을 조금 더 붙여넣어 주세요" }); // 짧은 글은 횟수를 깎지 않는다
    letterHits.set(ip, { day, n: used + 1 });
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

  if (!process.env.DATA_GO_KR_KEY) return res.status(200).json({ available: false });

  const interests = String(req.query.interests || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5);
  try {
    const pool = (await pressReleases(3)).filter(isEcon).slice(0, 30);
    if (pool.length < 3) return res.status(200).json({ available: true, mood: "", points: [] });

    const listText = pool.map((n, i) => `[${i}] (${n.org}) ${n.title} — ${n.sub} ${n.body.slice(0, 200)}`).join("\n");
    const out = await ask([
      { role: "system", content: RULES + `
- 아래는 최근 3일 정부 보도자료야. 생활과 돈에 영향이 큰 흐름 3개를 골라 points로 정리해. 관심사(${interests.join(", ") || "없음"})와 관련된 게 있으면 하나는 꼭 포함해.
- sources에는 근거 보도자료 번호를 1~3개 넣어.` },
      { role: "user", content: listText },
    ]);
    const points = (out.points || []).slice(0, 3).map((p) => ({
      ...p,
      sources: (p.sources || []).filter((i) => pool[i]).slice(0, 3).map((i) => ({ title: pool[i].title, url: pool[i].url, source: pool[i].org || "정책브리핑" })),
    }));
    cache(res, 3600);
    res.status(200).json({ available: true, mood: out.mood, points, count: pool.length, at: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(200).json({ available: true, mood: "", points: [], error: "풀이를 만들지 못했어요" });
  }
}
