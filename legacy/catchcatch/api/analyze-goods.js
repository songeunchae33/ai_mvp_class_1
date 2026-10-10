// 굿즈 사진 → 상품 정보 / 예상 시세 / 교환·판매 전략을 JSON으로 돌려준다.
// OpenAI Responses API 사용. (웹 검색은 비용 절약을 위해 끔 → 시세는 모델 지식 기반 추정)
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const MODEL = "gpt-6.1-sol";
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BASE64_LEN = 4_000_000; // Vercel 요청 본문 4.5MB 제한 안쪽

const Goods = z.object({
  recognized: z.boolean().describe("사진에서 굿즈를 식별했는지"),
  name: z.string().describe("목록에 보일 짧은 상품명. 예: 치이카와 모몽가 키링"),
  character: z.string().describe("캐릭터 / IP 이름"),
  series: z.string().describe("시리즈·제조사·가챠 라인업. 모르면 빈 문자열"),
  condition: z.enum(["미개봉", "개봉-상태좋음", "사용감있음", "판단불가"]),
  emoji: z.string().describe("목록 썸네일로 쓸 이모지 1개"),
  price_min: z.number().int().describe("중고 시세 하한 (원)"),
  price_max: z.number().int().describe("중고 시세 상한 (원)"),
  recommended_mode: z.enum(["교환", "판매", "교환+웃돈"]),
  recommended_premium: z.number().int()
    .describe("교환 시 내가 받으면 양수, 내가 얹어주면 음수 (원). 판매·순수교환이면 0"),
  wanted_suggestions: z.array(z.string()).describe("교환 상대로 제시하면 성사율이 높을 굿즈 1~3개"),
  tips: z.array(z.string()).describe("교환/판매 가능성을 높이는 구체적 팁 2~3개, 각 40자 이내"),
  confidence: z.enum(["high", "medium", "low"]),
});

const SYSTEM = `너는 한국 캐릭터 굿즈(가챠, 키링, 인형, 피규어) 중고 거래 도우미야.
사용자가 올린 굿즈 사진을 보고 등록 폼을 채울 정보를 만든다.
- 캐릭터와 상품 종류를 식별하고, 가능하면 시리즈나 가챠 라인업까지 특정해.
- 시세는 네가 알고 있는 한국 중고 시장(번개장터·중고나라·당근 등) 기준으로 추정해. 실시간 검색은 못 하니까,
  확실하지 않으면 범위를 넓게 잡고 confidence를 low로 해.
- 인기가 많아 찾는 사람이 많으면 교환, 희소하거나 시세가 높으면 판매나 교환+웃돈을 추천해.
- tips는 이 상품에 맞는 구체적인 조언이어야 해 (사진 구성, 제목 키워드, 교환 희망 상품, 거래 장소·시간 등).
- 굿즈가 아닌 사진이면 recognized=false로 하고 나머지는 빈 값/0으로 채워.
모든 텍스트는 한국어로 작성해.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원해요" });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "AI 분석이 아직 설정되지 않았어요 (OPENAI_API_KEY 없음)" });
  }

  const { image, mediaType } = req.body || {};
  if (typeof image !== "string" || !image || image.length > MAX_BASE64_LEN) {
    return res.status(400).json({ error: "사진 데이터가 없거나 너무 커요" });
  }
  if (!ALLOWED_TYPES.includes(mediaType)) {
    return res.status(400).json({ error: "지원하지 않는 이미지 형식이에요" });
  }

  const client = new OpenAI();

  let response;
  try {
    response = await client.responses.parse({
      model: MODEL,
      reasoning: { effort: "low" },
      input: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "input_text", text: "이 굿즈를 등록하려고 해. 등록 정보를 채워줘." },
            { type: "input_image", image_url: `data:${mediaType};base64,${image}`, detail: "auto" },
          ],
        },
      ],
      text: { format: zodTextFormat(Goods, "goods") },
    });
  } catch (e) {
    if (e instanceof OpenAI.RateLimitError) {
      // 429는 요청이 몰렸거나 충전 잔액이 바닥났을 때 온다
      return res.status(429).json({ error: "요청이 많거나 API 잔액이 부족해요. 잠시 후 다시 시도해주세요" });
    }
    if (e instanceof OpenAI.APIError) {
      return res.status(502).json({ error: "AI 분석 중 오류가 났어요", status: e.status });
    }
    return res.status(500).json({ error: "서버 오류", detail: e.message });
  }

  const goods = response.output_parsed;
  if (!goods) {
    return res.status(422).json({ error: "이 사진은 분석할 수 없어요. 직접 선택해주세요" });
  }
  if (!goods.recognized) {
    return res.status(422).json({ error: "굿즈를 인식하지 못했어요. 직접 선택해주세요" });
  }
  return res.status(200).json(goods);
}
