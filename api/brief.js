// 쉽게 풀이: 최근 7일 정부 경제 보도자료(정책브리핑, 공공저작물)를 관심사 순으로 모아 AI가 쉬운 말로 짧게 정리한다.
// 네이버 뉴스 검색 결과는 약관상 AI 요약에 쓸 수 없어서 쓰지 않는다. 근거 보도자료는 링크로 붙인다.
// GET  /api/brief?interests=삼성전자,여행   → 오늘 경제 정책 풀이 (1시간 동안 같은 결과를 재사용해 비용 절약)
// POST /api/brief { text }                  → 붙여넣은 뉴스레터 풀이 (저장하지 않음)
import { generate, aiReady, levelRule } from "./_ai.js";
import { cache, quota, crossSite } from "./_util.js";
import { newsdata } from "./_news.js";
import { pressReleases, isEcon, interestScore, hotScores, atKey } from "./_policy.js";

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
- 어려운 용어는 괄호로 한 번 풀어줘. 각 문장은 짧게.
- '조심해야 할 부분이 남아 있어요', '불확실성이 있어요'처럼 흐릿하게 끝내지 마. 조심할 점을 말할 때는 기사에 나온 것으로 '무엇이(지표·일정·정책·사건) 어떻게 되면 → 무엇이 어떻게 될 수 있는지'를 한 문장으로 콕 집어 말해. 기사에 근거가 없으면 조심하라는 말 자체를 빼.`;

const EN_RULE = "\n- 모든 답을 자연스럽고 쉬운 영어로 써. 한국어를 섞지 마. 돈은 ₩ 기호로(예: ₩1,000)."; // 기타 → 언어 English

// Gemini 무료 등급 먼저, 안 되면 OpenAI (api/_ai.js). 어느 AI가 답했는지 ai로 돌려준다
async function ask(system, text) {
  const out = await generate({ system, text, schema: SCHEMA, schemaName: "brief", maxTokens: 900 });
  return { ...JSON.parse(out.text), ai: out.ai };
}


export default async function handler(req, res) {
  if (!aiReady()) return res.status(200).json({ available: false });
  if (crossSite(req)) return res.status(403).json({ error: "다른 사이트에서는 쓸 수 없어요" });

  // 뉴스레터 붙여넣기 풀이
  if (req.method === "POST") {
    const text = String(req.body?.text || "").trim();
    if (text.length < 50) return res.status(400).json({ error: "내용을 조금 더 붙여넣어 주세요" }); // 짧은 글은 횟수를 깎지 않는다
    if (!(await quota(req, "letter", 5, 30))) return res.status(429).json({ error: "오늘 풀이는 다 썼어요. 내일 다시 해주세요!" });
    try {
      const out = await ask(RULES + levelRule(req.body?.lv) + (req.body?.lang === "en" ? EN_RULE : "") + "\n- 사용자가 구독하는 뉴스레터 내용을 붙여넣었어. 핵심 2~3개만 골라 points로 정리하고, sources는 빈 배열로 둬.", text.slice(0, 6000));
      return res.status(200).json({ available: true, ...out });
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: "풀이를 만들지 못했어요. 잠시 후 다시 시도해 주세요", why: String(e.message).slice(0, 300) });
    }
  }

  if (!process.env.DATA_GO_KR_KEY) return res.status(200).json({ available: false });

  const interests = String(req.query.interests || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const who = String(req.query.who || "").slice(0, 60); // 예: "대학생, 전세·내 집 마련"
  // 여기까지 왔다면 CDN에 저장된 풀이가 없어 새로 만드는 것. 조건을 바꿔 가며 계속 새로 만들게 하는 남용을 막는다
  if (!(await quota(req, "brief", 6, 40))) return res.status(200).json({ available: true, mood: "", points: [], error: "오늘은 풀이를 많이 만들었어요. 내일 다시 볼 수 있어요" });
  try {
    // 최근 7일 경제 보도자료 중 오늘의 큰 화제(여러 보도자료에 같이 나오는 낱말·시장 낱말·핵심 경제 부처)와
    // 최근 것(오늘·어제)을 앞에, 관심사와 겹치는 것을 그다음으로 40개까지
    const all = (await pressReleases(7)).filter(isEcon);
    // 화제 점수는 언론 기사 제목(하루치)도 같이 보고 센다. 기사 제목은 점수에만 쓰고 AI에는 보내지 않는다(네이버·NewsData 결과는 AI 요약에 안 씀)
    const press = await newsdata().catch(() => []);
    const hot = hotScores([...all, ...press.map((n) => ({ title: n.title, source: n.source }))]).slice(0, all.length), fresh = (p) => { const d = atKey(p.at).slice(0, 8), t = new Date(Date.now() + 9 * 3600e3); const ymd = (n) => new Date(t - n * 86400e3).toISOString().slice(0, 10).replace(/-/g, ""); return d === ymd(0) ? 3 : d === ymd(1) ? 2 : 0; };
    const pool = all
      .map((p, i) => ({ p, i, s: hot[i] + fresh(p) * 2 + interestScore(p, interests) * 2 }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, 40).map((x) => x.p);
    if (pool.length < 3) return res.status(200).json({ available: true, mood: "", points: [] });

    const listText = pool.map((n, i) => `[${i}] (${n.org}) ${n.title} — ${n.sub} ${n.body.slice(0, 200)}`).join("\n");
    const out = await ask(RULES + levelRule(req.query.lv) + (req.query.lang === "en" ? EN_RULE : "") + (who ? `\n- 이 사람의 상황·목표: ${who}. forMe는 이 상황과 목표에 이어서 말해줘.` : "") + `
- 아래는 최근 7일 정부 보도자료야(요즘 가장 큰 화제·최근 것이 앞쪽에 있어). 생활과 돈에 영향이 큰 흐름 3개를 골라 points로 정리하고, 첫 번째 point는 여러 보도자료가 함께 다루는 오늘의 가장 큰 화제(증시·금리·환율처럼 시장 전체에 영향이 큰 정부 대책이 있으면 그것)로 해. 관심사(${interests.join(", ") || "없음"})와 관련된 게 있으면 하나 이상 꼭 포함하고, 그 point의 forMe에서 관심사와 이어서 설명해.
- sources에는 근거 보도자료 번호를 1~3개 넣어.`, listText);
    const points = (out.points || []).slice(0, 3).map((p) => ({
      ...p,
      sources: (p.sources || []).filter((i) => pool[i]).slice(0, 3).map((i) => ({ title: pool[i].title, url: pool[i].url, source: pool[i].org || "정책브리핑" })),
    }));
    cache(res, 3600);
    res.status(200).json({ available: true, mood: out.mood, points, count: pool.length, at: new Date().toISOString(), ai: out.ai });
  } catch (e) {
    console.error(e);
    // why: 화면에는 안 보임, 원인 확인용(키는 들어가지 않음)
    res.status(200).json({ available: true, mood: "", points: [], error: "풀이를 만들지 못했어요", why: String(e.message).slice(0, 300) });
  }
}
