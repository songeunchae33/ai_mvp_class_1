// AI 부르기: Google Gemini 무료 등급을 먼저 쓰고, 실패하면(무료 한도 초과·오류·빈 답·시간 초과) OpenAI로 넘어간다.
// 파일명이 _로 시작해서 주소(엔드포인트)는 생기지 않는다. ask·brief·receipts가 같이 쓴다.
// Gemini: Interactions API (https://aistudio.google.com/docs/text-generation · image-understanding · structured-output)
import OpenAI from "openai";

const GEMINI_MODEL = "gemini-3.8-flash";
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

export function aiReady() { return !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY); }

// → { text, ai: "gemini" | "openai" }. images는 data:image/...;base64 주소들
export async function generate({ system, text, images = [], schema, schemaName, maxTokens = 800 }) {
  const req = { system, text, images, schema, schemaName, maxTokens };
  if (process.env.GEMINI_API_KEY) {
    try { return { text: await gemini(req), ai: "gemini" }; }
    catch (e) { console.error("gemini 실패 → openai:", e.message); var why = String(e.message).slice(0, 300); }
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("AI 키가 없어요");
  // ai: 화면에는 안 보임. Gemini가 실패했으면 이유(오류 코드·메시지, 키는 없음)를 붙여 확인할 수 있게
  return { text: await openai(req), ai: why ? `openai (${why})` : "openai" };
}
