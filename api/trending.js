// 경제 공부 '화제순': 개념마다 최근 7일 정부 보도자료(정책브리핑)에 몇 번 나왔는지 센다.
// 앱 사용자 기록을 모으는 서버가 없어서 '요즘 많이 나오는 개념'을 보도자료 언급량으로 대신한다.
// (네이버 검색 결과는 약관상 '그대로 보여주기'에만 쓸 수 있어서 집계에 쓰지 않는다)
// GET /api/trending → { available, counts: { 개념id: 언급 횟수 }, total: 본 보도자료 수, at }
import { cache } from "./_util.js";
import { pressReleases } from "./_policy.js";

// "토큰증권 (STO)" → "토큰증권", "양적완화 / 양적긴축" → "양적완화", "고정금리 vs 변동금리" → "고정금리"
function searchWord(term) {
  return term.split(/\s*(?:\(|\/|·|vs)\s*/)[0].trim();
}

export default async function handler(req, res) {
  if (!process.env.DATA_GO_KR_KEY) return res.status(200).json({ available: false });
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const [learn, docs] = await Promise.all([
      fetch(`${proto}://${req.headers.host}/data/learn.json`).then((r) => r.json()),
      pressReleases(7),
    ]);
    if (!docs.length) return res.status(200).json({ available: false });
    const texts = docs.map((d) => `${d.title} ${d.sub} ${d.body}`);
    const counts = {};
    for (const c of learn.concepts) {
      const w = searchWord(c.term);
      counts[c.id] = texts.reduce((n, t) => n + (t.split(w).length - 1), 0);
    }
    cache(res, 21600); // 6시간마다 다시 셈
    res.status(200).json({ available: true, counts, total: docs.length, at: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(200).json({ available: false });
  }
}
