// 하단 질문창: 사용자 상황(요약)과 오늘 시세를 붙여 짧게 답한다. OpenAI 사용 (충전 금액에서 차감).
// POST /api/ask { question, profile, market }
import OpenAI from "openai";

const MODEL = "gpt-6.1-sol";

const SYSTEM = `너는 '나만의 경제' 앱의 캐릭터야. 2030 사용자에게 경제를 친근한 존댓말(~요)로 설명해.
- 4~6문장, 쉬운 말. 어려운 용어는 괄호로 한 번 풀어줘.
- 사용자 정보(나이대, 위험 성향, 선호, 대출·자산 요약)가 주어지면 "당신에게는" 관점으로 연결해서 설명해. 계산이 가능하면 근거와 함께 대략적인 금액을 보여줘.
- 특정 종목 매수·매도 추천이나 수익 보장은 하지 마. 판단은 사용자 몫이라고 자연스럽게 남겨.
- 모르는 최신 사실은 지어내지 말고 모른다고 말해. 시세는 주어진 값만 사용해.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원해요" });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "AI 질문 기능이 아직 설정되지 않았어요" });

  const { question, profile, market } = req.body || {};
  if (typeof question !== "string" || !question.trim() || question.length > 300) {
    return res.status(400).json({ error: "질문은 300자 이내로 적어주세요" });
  }
  const context = JSON.stringify({ profile: profile || {}, market: market || {} }).slice(0, 2000);

  try {
    const client = new OpenAI();
    const response = await client.responses.create({
      model: MODEL,
      reasoning: { effort: "low" },
      max_output_tokens: 700,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `[내 상황]\n${context}\n\n[질문]\n${question.trim()}` },
      ],
    });
    res.status(200).json({ answer: response.output_text });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "답변을 만들지 못했어요. 잠시 후 다시 시도해 주세요" });
  }
}
