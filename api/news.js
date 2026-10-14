// 뉴스: 네이버 검색 API (제목 + 링크만 보여준다. 본문은 가져오지 않음)
// GET /api/news?interests=삼성전자,여행   → { issues: 오늘의 이슈 3, forYou: 관심 뉴스 3, keywords: 오늘의 키워드 3 }
// GET /api/news?q=FOMC                     → { items: 해당 키워드 뉴스 3 }
// 둘 다 &full=1 을 붙이면 '뉴스 더보기' 화면용으로 더 많이 돌려준다
import { cache } from "./_util.js";
import { PREF_QUERY, naver, dedupe, keywords, searchUrl } from "./_news.js";

// 화면에는 제목·링크만 보낸다
const strip = (list) => list.map(({ desc, ...n }) => n);

function sampleHome(interests) {
  const issues = ["FOMC 앞두고 금리 동결 전망 우세", "원/달러 환율 1,470원대서 등락", "반도체 업황 개선 기대에 대형주 강세"]
    .map((title) => ({ title, url: searchUrl(title), source: "예시" }));
  const forYou = (interests.length ? interests : ["경제"]).slice(0, 3)
    .map((q) => ({ title: `${q} 관련 최신 뉴스 (예시)`, url: searchUrl(q), source: "예시", tag: q }));
  return { sample: true, issues, forYou, keywords: ["FOMC", "환율", "반도체"] };
}

export default async function handler(req, res) {
  const ready = process.env.NAVER_SEARCH_ID && process.env.NAVER_SEARCH_SECRET;

  const full = req.query.full === "1";

  if (req.query.q) {
    const q = String(req.query.q).slice(0, 30);
    if (!ready) return res.status(200).json({ sample: true, items: [{ title: `${q} 뉴스 검색 결과 보기`, url: searchUrl(q), source: "네이버 뉴스" }] });
    try {
      const items = dedupe(await naver(q + " 경제", { display: full ? 40 : 15, sort: "sim" })).slice(0, full ? 15 : 3);
      cache(res, 900);
      return res.status(200).json({ items: strip(items) });
    } catch (e) {
      console.error(e);
      return res.status(200).json({ items: [], error: "뉴스를 불러오지 못했어요" });
    }
  }

  const interests = String(req.query.interests || "")
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);

  if (!ready) return res.status(200).json(sampleHome(interests));

  try {
    const dayAgo = Date.now() - 36 * 3600e3;
    const pool = dedupe([...(await naver("경제", { display: 50, sort: "sim" })), ...(await naver("증시 금리 환율", { display: 30, sort: "date" }))]);
    const fresh = pool.filter((n) => new Date(n.at).getTime() > dayAgo);
    const issues = (fresh.length >= 3 ? fresh : pool).slice(0, full ? 15 : 3);

    // 관심 종목·선호마다 최신 뉴스 1개씩, 모자라면 앞쪽 관심사에서 더
    const queries = interests.map((i) => ({ tag: i, q: PREF_QUERY[i] || i }));
    const perQuery = await Promise.all(queries.map(({ q }) => naver(q, { display: full ? 15 : 6, sort: "date" }).catch(() => [])));
    const taken = new Set(issues.map((i) => i.url));
    const forYou = [];
    const want = full ? 20 : 3;
    for (let round = 0; round < (full ? 6 : 3) && forYou.length < want; round++) {
      perQuery.forEach((list, i) => {
        const pick = dedupe(list).filter((n) => !taken.has(n.url))[0];
        if (pick && forYou.length < want) {
          taken.add(pick.url);
          forYou.push({ ...pick, tag: queries[i].tag });
        }
      });
    }

    cache(res, 900);
    res.status(200).json({ issues: strip(issues), forYou: strip(forYou), keywords: keywords(pool) });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ...sampleHome(interests), error: "뉴스를 불러오지 못했어요" });
  }
}
