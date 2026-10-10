// 우리 지역·정부 혜택: 행정안전부 '대한민국 공공서비스(혜택) 정보' (정부24, 공공데이터포털 무료)
// 지자체·교육청·정부 부처가 하는 서비스를 지역·나이·상태(대학생 등)·관심사에 맞춰 골라준다.
// GET /api/benefits?sido=서울특별시&sigungu=강남구&age=24&status=대학생&prefs=여행,부동산
// DATA_GO_KR_KEY 하나로 동작 (공공데이터포털에서 이 API도 '활용신청' 필요)
import { fetchJson, dataGoKey, cache } from "./_util.js";

const BASE = "https://api.odcloud.kr/api/gov24/v3/serviceList";

// 선호 → 정부24 서비스분야
const PREF_FIELD = {
  부동산: ["주거·자립"], 저축: ["생활안정"], 자기계발: ["고용·창업", "보육·교육"],
  여행: ["문화·환경"], 취미: ["문화·환경"], 쇼핑: ["생활안정"], 음식: ["생활안정"],
};
// 상태 → 찾을 단어와 분야
const STATUS = {
  대학생: { words: ["대학생", "장학", "학자금", "청년"], fields: ["보육·교육"] },
  대학원생: { words: ["대학원", "장학", "연구", "청년"], fields: ["보육·교육"] },
  취준생: { words: ["구직", "취업", "미취업", "면접", "청년"], fields: ["고용·창업"] },
  직장인: { words: ["근로자", "직장인", "재직"], fields: ["고용·창업", "생활안정"] },
  자영업: { words: ["소상공인", "자영업", "창업"], fields: ["고용·창업"] },
};
const NOT_YOUNG = ["노인", "어르신", "고령", "65세", "임산부", "영유아", "아동", "장애", "보훈", "농업인", "어업인"];

async function query(cond) {
  const qs = new URLSearchParams({ page: "1", perPage: "300", returnType: "JSON" });
  for (const [k, v] of Object.entries(cond)) qs.set(`cond[${k}]`, v);
  const json = await fetchJson(`${BASE}?serviceKey=${dataGoKey()}&${qs}`, {}, 9000);
  return json.data || [];
}

// "만 19세 ~ 39세" 같은 문구에서 나이 범위 뽑기
function ageRange(text) {
  const m = String(text || "").match(/(\d{2})\s*세?\s*(?:이상)?\s*[~∼\-]\s*(?:만\s*)?(\d{2})\s*세/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function norm(r) {
  return {
    id: r["서비스ID"], name: r["서비스명"], summary: r["서비스목적요약"], target: r["지원대상"],
    org: r["소관기관명"], orgType: r["소관기관유형"], field: r["서비스분야"], deadline: r["신청기한"],
    url: r["상세조회URL"], user: r["사용자구분"], kind: r["지원유형"],
  };
}

export default async function handler(req, res) {
  const sido = String(req.query.sido || "").slice(0, 20);
  const sigungu = String(req.query.sigungu || "").slice(0, 20);
  const age = Number(req.query.age) || null;
  const status = STATUS[req.query.status] ? req.query.status : "";
  const prefs = String(req.query.prefs || "").split(",").filter(Boolean);

  if (!process.env.DATA_GO_KR_KEY) return res.status(200).json({ available: false, items: [] });
  if (!sido) return res.status(200).json({ available: true, items: [], needRegion: true });

  try {
    const jobs = [query({ "소관기관명::LIKE": sigungu || sido }), query({ "서비스명::LIKE": "청년" })];
    if (status) jobs.push(query({ "서비스명::LIKE": STATUS[status].words[0] }));
    const lists = await Promise.all(jobs.map((j) => j.catch(() => [])));

    const sidoShort = sido.slice(0, 2);
    const wantFields = new Set([...prefs.flatMap((p) => PREF_FIELD[p] || []), ...(status ? STATUS[status].fields : [])]);
    const words = status ? STATUS[status].words : [];
    const seen = new Set();
    const items = [];

    for (const r of lists.flat().map(norm)) {
      if (!r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      const text = `${r.name} ${r.target} ${r.summary}`;
      if (r.user && !r.user.includes("개인")) continue; // 법인·기관용 제외
      const org = r.org || "";
      // 지자체·교육청이면 '우리 지역', 부처·공공기관이면 '정부'
      const isLocal = r.orgType
        ? /지방|자치/.test(r.orgType) || /교육청$/.test(org)
        : /^(.+(특별시|광역시|특별자치시|특별자치도|도))(\s|$)/.test(org) || /교육청$/.test(org);
      // 다른 지역 지자체 서비스는 제외
      if (isLocal && !org.includes(sidoShort)) continue;
      if (isLocal && sigungu && org.split(" ").length > 1 && !org.includes(sigungu)) continue;
      if (age) {
        const rg = ageRange(r.target);
        if (rg && (age < rg[0] || age > rg[1])) continue;
        if (age < 40 && !text.includes("청년") && NOT_YOUNG.some((w) => text.includes(w))) continue;
        if (age > 39 && r.name.includes("청년")) continue;
      }
      let score = 0;
      if (isLocal) score += sigungu && org.includes(sigungu) ? 30 : 20;
      else score += 5;
      if (age && age <= 39 && text.includes("청년")) score += 15;
      if (wantFields.has(r.field)) score += 10;
      if (words.some((w) => text.includes(w))) score += 12;
      if (String(r.deadline).includes("상시")) score += 2;
      items.push({ ...r, local: isLocal, score });
    }

    items.sort((a, b) => b.score - a.score);
    cache(res, 21600);
    res.status(200).json({
      available: true,
      items: items.slice(0, 30).map(({ score, user, ...r }) => ({
        ...r, summary: String(r.summary || "").slice(0, 120), target: String(r.target || "").slice(0, 160),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(200).json({ available: true, items: [], error: "혜택 정보를 불러오지 못했어요" });
  }
}
