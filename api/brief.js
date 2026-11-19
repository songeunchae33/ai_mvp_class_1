// 쉽게 풀이: 최근 7일 정부 경제 보도자료(정책브리핑, 공공저작물)를 관심사 순으로 모아 AI가 쉬운 말로 짧게 정리한다.
// 네이버 뉴스 검색 결과는 약관상 AI 요약에 쓸 수 없어서 쓰지 않는다. 근거 보도자료는 링크로 붙인다.
// GET  /api/brief?interests=삼성전자,여행   → 오늘 경제 정책 풀이 (1시간 동안 같은 결과를 재사용해 비용 절약)
// POST /api/brief { text }                  → 붙여넣은 뉴스레터 풀이 (저장하지 않음)
// GET  /api/brief?hints=1                    → 모의투자 '루미의 오늘 힌트' (보도자료 근거, 모두에게 같은 답을 6시간 재사용)
import { generate, aiReady } from "./_ai.js";
import { cache } from "./_util.js";
import { pressReleases, isEcon, interestScore } from "./_policy.js";

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

// Gemini 무료 등급 먼저, 안 되면 OpenAI (api/_ai.js). 어느 AI가 답했는지 ai로 돌려준다
async function ask(system, text) {
  const out = await generate({ system, text, schema: SCHEMA, schemaName: "brief", maxTokens: 900 });
  return { ...JSON.parse(out.text), ai: out.ai };
}

// 모의투자 힌트: 보도자료에서 주가에 영향을 줄 만한 흐름을 골라, 영향받을 수 있는 업종·상장 기업과 방향·기간을 붙인다
const HINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hints"],
  properties: {
    hints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "text", "dir", "days", "stocks", "sources"],
        properties: {
          title: { type: "string", description: "짧은 제목 (16자 이내)" },
          text: { type: "string", description: "무슨 일이고 어느 기업·업종에 어떤 영향이 있을 수 있는지 1~2문장 (90자 이내)" },
          dir: { type: "string", enum: ["up", "down", "swing"], description: "up 오를 수도 · down 내릴 수도 · swing 크게 출렁일 수도" },
          days: { type: "integer", description: "영향이 나타날 수 있는 기간(일): 3·7·14·30 중 하나" },
          stocks: { type: "array", items: { type: "string" }, description: "영향받을 수 있는 한국 상장 기업 이름 0~3개 (정식 종목명)" },
          sources: { type: "array", items: { type: "integer" }, description: "근거 보도자료 번호" },
        },
      },
    },
  },
};
const HINT_RULES = `너는 모의투자 게임에서 20대에게 경제 소식을 쉽게 알려주는 친구야. 존댓말(~요), 쉬운 단어만 써.
- 아래 보도자료에 나온 사실만 근거로 써. 없는 사건·숫자를 지어내지 마. 사람 이름은 쓰지 마.
- 영향받을 수 있는 업종과 한국 상장 기업을 구체적으로 짚어도 돼(예: "반도체 관련주(SK하이닉스·삼성전자)의 기대가 커질 수 있어요").
- 사라·팔아라·추천 같은 말은 절대 쓰지 말고 "~할 수 있어요"처럼 가능성으로만 말해.
- 주가에 영향을 줄 만한 흐름 3개를 골라. 서로 다른 업종이면 좋아.`;

// 뉴스레터 붙여넣기 풀이: 하루 5번 (IP 기준)
const letterHits = new Map();

export default async function handler(req, res) {
  if (!aiReady()) return res.status(200).json({ available: false });

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
      const out = await ask(RULES + "\n- 사용자가 구독하는 뉴스레터 내용을 붙여넣었어. 핵심 2~3개만 골라 points로 정리하고, sources는 빈 배열로 둬.", text.slice(0, 6000));
      return res.status(200).json({ available: true, ...out });
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: "풀이를 만들지 못했어요. 잠시 후 다시 시도해 주세요" });
    }
  }

  if (!process.env.DATA_GO_KR_KEY) return res.status(200).json({ available: false });

  if (req.query.hints) {
    try {
      const pool = (await pressReleases(7)).filter(isEcon).slice(0, 40);
      if (pool.length < 3) return res.status(200).json({ available: true, hints: [] });
      const listText = pool.map((n, i) => `[${i}] (${n.org}) ${n.title} — ${n.sub} ${n.body.slice(0, 200)}`).join("\n");
      const out = await generate({ system: HINT_RULES, text: listText, schema: HINT_SCHEMA, schemaName: "hints", maxTokens: 900 });
      const hints = (JSON.parse(out.text).hints || []).slice(0, 3).map((h, i) => ({
        id: `p${i}`, title: h.title, text: h.text, dir: ["up", "down", "swing"].includes(h.dir) ? h.dir : "swing",
        days: [3, 7, 14, 30].includes(h.days) ? h.days : 14, stocks: (h.stocks || []).slice(0, 3),
        sources: (h.sources || []).filter((k) => pool[k]).slice(0, 2).map((k) => ({ title: pool[k].title, url: pool[k].url, source: pool[k].org || "정책브리핑" })),
      })).filter((h) => h.sources.length); // 근거 없는 힌트는 버린다
      cache(res, 21600);
      return res.status(200).json({ available: true, hints, at: new Date().toISOString(), ai: out.ai });
    } catch (e) {
      console.error(e);
      return res.status(200).json({ available: true, hints: [], error: "힌트를 만들지 못했어요" });
    }
  }

  const interests = String(req.query.interests || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5);
  try {
    // 최근 7일 경제 보도자료 중 관심사와 겹치는 것을 앞에 두고 40개까지
    const pool = (await pressReleases(7)).filter(isEcon)
      .map((p, i) => ({ p, i, s: interestScore(p, interests) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, 40).map((x) => x.p);
    if (pool.length < 3) return res.status(200).json({ available: true, mood: "", points: [] });

    const listText = pool.map((n, i) => `[${i}] (${n.org}) ${n.title} — ${n.sub} ${n.body.slice(0, 200)}`).join("\n");
    const out = await ask(RULES + `
- 아래는 최근 7일 정부 보도자료야(관심사와 관련된 것이 앞쪽에 있어). 생활과 돈에 영향이 큰 흐름 3개를 골라 points로 정리해. 관심사(${interests.join(", ") || "없음"})와 관련된 게 있으면 하나 이상 꼭 포함하고, 그 point의 forMe에서 관심사와 이어서 설명해.
- sources에는 근거 보도자료 번호를 1~3개 넣어.`, listText);
    const points = (out.points || []).slice(0, 3).map((p) => ({
      ...p,
      sources: (p.sources || []).filter((i) => pool[i]).slice(0, 3).map((i) => ({ title: pool[i].title, url: pool[i].url, source: pool[i].org || "정책브리핑" })),
    }));
    cache(res, 3600);
    res.status(200).json({ available: true, mood: out.mood, points, count: pool.length, at: new Date().toISOString(), ai: out.ai });
  } catch (e) {
    console.error(e);
    res.status(200).json({ available: true, mood: "", points: [], error: "풀이를 만들지 못했어요" });
  }
}
