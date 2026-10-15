// 경제 공부 '화제순': 개념마다 최근 7일 동안 뉴스 기사에 몇 번 나왔는지 센다 (네이버 검색 API).
// 같은 앱 사용자들의 기록을 모으는 서버가 없어서, '요즘 사람들이 많이 보는 개념'을 뉴스 언급량으로 대신한다.
// GET /api/trending → { available, counts: { 개념id: 기사 수(최대 100) }, at }
import { cache } from "./_util.js";
import { naver } from "./_news.js";

// "토큰증권 (STO)" → "토큰증권", "양적완화 / 양적긴축" → "양적완화", "고정금리 vs 변동금리" → "고정금리"
function searchWord(term) {
  return term.split(/\s*(?:\(|\/|·|vs)\s*/)[0].trim();
}

export default async function handler(req, res) {
  if (!process.env.NAVER_SEARCH_ID || !process.env.NAVER_SEARCH_SECRET) return res.status(200).json({ available: false });
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const learn = await fetch(`${proto}://${req.headers.host}/data/learn.json`).then((r) => r.json());
    const weekAgo = Date.now() - 7 * 86400e3;
    const counts = {};
    await Promise.all(learn.concepts.map(async (c) => {
      try {
        const items = await naver(searchWord(c.term), { display: 100, sort: "date" });
        counts[c.id] = items.filter((n) => new Date(n.at).getTime() > weekAgo).length;
      } catch {
        counts[c.id] = 0;
      }
    }));
    cache(res, 21600); // 6시간마다 다시 셈
    res.status(200).json({ available: true, counts, at: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(200).json({ available: false });
  }
}
