// AI 부르기: Google Gemini 무료 등급을 먼저 쓰고, 실패하면(무료 한도 초과·오류·빈 답·시간 초과) OpenAI로 넘어간다.
// 파일명이 _로 시작해서 주소(엔드포인트)는 생기지 않는다. ask·brief·receipts가 같이 쓴다.
// Gemini: Interactions API (https://aistudio.google.com/docs/text-generation · image-understanding · structured-output)
import OpenAI from "openai";

// 3.8 Flash는 사용량이 몰리면 503·20초 초과가 잦아서, 무료 등급이 있고 안정판인 3.5 Flash-Lite를 쓴다 (https://aistudio.google.com/docs/models)
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const OPENAI_MODEL = "gpt-6.1-sol";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

// OpenAI용 schema의 additionalProperties는 Gemini에 보내지 않는다 (모양은 같고, 지원 여부가 문서에 없음)
function plainSchema(s) {
  if (Array.isArray(s)) return s.map(plainSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) if (k !== "additionalProperties") out[k] = plainSchema(v);
  return out;
}

async function gemini({ system, text, images, schema, maxTokens }) {
  const body = {
    model: GEMINI_MODEL,
    system_instruction: system,
    input: [{ type: "text", text }, ...images.map((url) => {
      const m = url.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      return { type: "image", data: m[2], mime_type: m[1] };
    })],
    // 생각하는 토큰도 출력 한도에 들어가서 넉넉히 둔다
    generation_config: { thinking_level: "low", max_output_tokens: maxTokens + 2000 },
    store: false,
  };
  if (schema) body.response_format = { type: "text", mime_type: "application/json", schema: plainSchema(schema) };
  const r = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY, "Api-Revision": "2026-05-20" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`gemini ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (j.status && j.status !== "completed") throw new Error(`gemini ${j.status}`);
  const out = (j.steps || []).filter((s) => s.type === "model_output")
    .flatMap((s) => s.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  if (!out) throw new Error("gemini empty");
  if (schema) JSON.parse(out); // 모양이 JSON이 아니면 실패로 보고 OpenAI로 넘긴다
  return out;
}

async function openai({ system, text, images, schema, schemaName, maxTokens }) {
  const client = new OpenAI();
  const r = await client.responses.create({
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    max_output_tokens: maxTokens,
    ...(schema ? { text: { format: { type: "json_schema", name: schemaName || "out", schema, strict: true } } } : {}),
    input: [
      { role: "system", content: system },
      { role: "user", content: images.length
        ? [{ type: "input_text", text }, ...images.map((image_url) => ({ type: "input_image", image_url, detail: "high" }))]
        : text },
    ],
  });
  return r.output_text;
}

// 경제 지식 수준(첫 설문·마이페이지): 0 처음이에요 · 1 뉴스는 보는데 어려워요 · 2 어느 정도 알아요 · 3 경제 전공자예요
export const LEVEL_RULE = [
  "- 이 사람은 경제를 처음 접해. 경제 용어는 하나도 빼지 말고 모두 쉬운 말로 풀고, 생활 속 예시(용돈·월세·장보기 등)를 하나 들어줘.",
  "- 이 사람은 뉴스는 보지만 어려워해. 핵심 용어만 괄호로 짧게 풀어줘.",
  "- 이 사람은 기초를 알아. 기본 용어 풀이는 빼고 핵심과 숫자 위주로 짧게 말해줘.",
  "- 이 사람은 경제·금융 전공자야. 위의 '쉬운 단어' 규칙보다 이 규칙이 먼저야. 용어 풀이와 생활 예시는 빼고 전문 용어(기준금리 경로, 장단기 금리차, 실질금리, 기대인플레이션, 밸류에이션 등)를 그대로 써. 누구나 아는 상식은 말하지 말고, 원인→전달 경로→영향(시장·가계)과 숫자, 반대로 갈 수 있는 위험 요인까지 짚어줘.",
];
export const levelRule = (lv) => LEVEL_RULE[Number(lv)] && lv !== "" && lv !== null ? "\n" + LEVEL_RULE[Number(lv)] : "";

export function aiReady() { return !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY); }

// → { text, ai: "gemini" | "openai" }. images는 data:image/...;base64 주소들
// geminiOnly: 제미나이가 실패해도 OpenAI(유료 크레딧)로 넘기지 않고 오류를 낸다 (모의투자 힌트 검수처럼 없어도 되는 곳)
export async function generate({ system, text, images = [], schema, schemaName, maxTokens = 800, geminiOnly = false }) {
  const req = { system, text, images, schema, schemaName, maxTokens };
  if (process.env.GEMINI_API_KEY) {
    // 무료 등급은 사람이 몰리면 503(바빠요)·429를 자주 낸다 → 잠깐 쉬었다가 두 번까지 다시
    for (let n = 0; n < 3; n++) {
      try { return { text: await gemini(req), ai: "gemini" }; }
      catch (e) {
        var why = String(e.message).slice(0, 300);
        console.error(`gemini 실패(${n + 1}번째):`, e.message);
        if (!/gemini (503|429|500)|UNAVAILABLE|high demand|overloaded/i.test(e.message)) break;
        if (n < 2) await new Promise((r) => setTimeout(r, 1500 * (n + 1)));
      }
    }
  }
  if (geminiOnly) throw new Error(why ? `gemini only: ${why}` : "GEMINI_API_KEY가 없어요");
  if (!process.env.OPENAI_API_KEY) throw new Error("AI 키가 없어요");
  // ai: 화면에는 안 보임. Gemini가 실패했으면 이유(오류 코드·메시지, 키는 없음)를 붙여 확인할 수 있게
  try { return { text: await openai(req), ai: why ? `openai (${why})` : "openai" }; }
  catch (e) { throw new Error(`gemini: ${why || "없음"} / openai: ${String(e.message).slice(0, 200)}`); } // 둘 다 왜 실패했는지 함께
}
