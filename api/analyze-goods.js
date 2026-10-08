// 굿즈 사진 → 상품 정보 / 예상 시세 / 교환·판매 전략을 JSON으로 돌려준다.
// Google Gemini API 무료 등급 사용. (무료 등급은 구글 검색 연동이 없어서 시세는 모델 지식 기반 추정)
import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-3.8-flash";
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BASE64_LEN = 4_000_000; // Vercel 요청 본문 4.5MB 제한 안쪽

const GOODS_SCHEMA = {
  type: "object",
  required: [
    "recognized", "name", "character", "series", "condition", "emoji",
    "price_min", "price_max", "recommended_mode", "recommended_premium",
    "wanted_suggestions", "tips", "confidence",
  ],
  properties: {
    recognized: { type: "boolean", description: "사진에서 굿즈를 식별했는지" },
    name: { type: "string", description: "목록에 보일 짧은 상품명. 예: 치이카와 모몽가 키링" },
    character: { type: "string", description: "캐릭터 / IP 이름" },
    series: { type: "string", description: "시리즈·제조사·가챠 라인업. 모르면 빈 문자열" },
    condition: { type: "string", enum: ["미개봉", "개봉-상태좋음", "사용감있음", "판단불가"] },
    emoji: { type: "string", description: "목록 썸네일로 쓸 이모지 1개" },
    price_min: { type: "integer", description: "중고 시세 하한 (원)" },
    price_max: { type: "integer", description: "중고 시세 상한 (원)" },
    recommended_mode: { type: "string", enum: ["교환", "판매", "교환+웃돈"] },
    recommended_premium: {
      type: "integer",
      description: "교환 시 내가 받으면 양수, 내가 얹어주면 음수 (원). 판매·순수교환이면 0",
    },
    wanted_suggestions: {
      type: "array", items: { type: "string" },
      description: "교환 상대로 제시하면 성사율이 높을 굿즈 1~3개",
    },
    tips: {
      type: "array", items: { type: "string" },
      description: "교환/판매 가능성을 높이는 구체적 팁 2~3개, 각 40자 이내",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

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
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "AI 분석이 아직 설정되지 않았어요 (GEMINI_API_KEY 없음)" });
  }

  const { image, mediaType } = req.body || {};
  if (typeof image !== "string" || !image || image.length > MAX_BASE64_LEN) {
    return res.status(400).json({ error: "사진 데이터가 없거나 너무 커요" });
  }
  if (!ALLOWED_TYPES.includes(mediaType)) {
    return res.status(400).json({ error: "지원하지 않는 이미지 형식이에요" });
  }

  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  let interaction;
  try {
    interaction = await client.interactions.create({
      model: MODEL,
      system_instruction: SYSTEM,
      input: [
        { type: "image", data: image, mime_type: mediaType },
        { type: "text", text: "이 굿즈를 등록하려고 해. 등록 정보를 채워줘." },
      ],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: GOODS_SCHEMA,
      },
    });
  } catch (e) {
    if (e && e.status === 429) {
      return res.status(429).json({ error: "오늘 무료 사용량이 다 찼거나 요청이 많아요. 잠시 후 다시 시도해주세요" });
    }
    return res.status(502).json({ error: "AI 분석 중 오류가 났어요", status: e && e.status });
  }

  let goods;
  try {
    goods = JSON.parse(interaction.output_text);
  } catch {
    return res.status(502).json({ error: "분석 결과를 읽지 못했어요" });
  }
  if (!goods.recognized) {
    return res.status(422).json({ error: "굿즈를 인식하지 못했어요. 직접 선택해주세요" });
  }
  // 빠진 배열이 있어도 화면이 깨지지 않게
  goods.tips = Array.isArray(goods.tips) ? goods.tips : [];
  goods.wanted_suggestions = Array.isArray(goods.wanted_suggestions) ? goods.wanted_suggestions : [];
  return res.status(200).json(goods);
}
