// 뉴스: 여러 출처에서 제목 + 링크만 보여준다(본문은 가져오지 않음).
// 오늘의 이슈 = 네이버 뉴스 검색 + 정책브리핑 보도자료 + NewsData(키가 있을 때)를 출처가 고르게 섞어서, 해외 뉴스 = GDELT.
// 한 출처가 막혀도 나머지로 채운다.
// GET /api/news?interests=삼성전자,여행   → { issues: 오늘의 이슈 3, forYou: 관심 뉴스 3, global: 해외 뉴스 3, keywords: 오늘의 키워드 3, providers }
// GET /api/news?q=FOMC                     → { items: 해당 키워드 뉴스 3 }
// 둘 다 &full=1 을 붙이면 '뉴스 더보기' 화면용으로 더 많이 돌려준다
import { cache } from "./_util.js";
import { PREF_QUERY, naver, dedupe, keywords, searchUrl, newsReady, byTrust, gdelt, newsdata } from "./_news.js";
import { pressReleases, isEcon } from "./_policy.js";

// 화면에는 제목·링크만 보낸다
const strip = (list) => list;

function sampleHome(interests) {
  const issues = ["(예시) 미국 금리 결정 앞두고 시장 관심 집중", "(예시) 원/달러 환율 흐름 살펴보기", "(예시) 반도체 업황과 대형주 소식"]
    .map((title) => ({ title, url: searchUrl(title), source: "예시" }));
  const forYou = (interests.length ? interests : ["경제"]).slice(0, 3)
    .map((q) => ({ title: `${q} 관련 최신 뉴스 (예시)`, url: searchUrl(q), source: "예시", tag: q }));
  return { sample: true, issues, forYou, keywords: ["FOMC", "환율", "반도체"] };
}

export default async function handler(req, res) {
  const ready = newsReady();

  const full = req.query.full === "1";

  if (req.query.q) {
    const q = String(req.query.q).slice(0, 30);
    if (!ready) return res.status(200).json({ sample: true, items: [{ title: `${q} 뉴스 검색 결과 보기`, url: searchUrl(q), source: "네이버 뉴스" }] });
    try {
      const items = byTrust(dedupe(await naver(q + " 경제", { display: full ? 40 : 15, sort: "sim" }))).slice(0, full ? 15 : 3); // 출처가 약한 기사는 뒤로
      cache(res, 3600); // 네이버 사용량을 아끼려고 1시간 동안 같은 결과를 재사용
      return res.status(200).json({ items: strip(items) });
    } catch (e) {
      console.error(e);
      return res.status(200).json({ items: [], error: "뉴스를 불러오지 못했어요", why: String(e.message).slice(0, 80) });
    }
  }

  const interests = String(req.query.interests || "")
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);

  // 출처마다 따로 불러서, 실패한 곳은 빼고 나머지로 채운다
  const providers = [];
  const got = (name, p) => p.then((v) => { if (v.length) providers.push(name); return v; }).catch((e) => { console.error(name, e.message); return []; });
  const [nv1, nv2, policy, nd, global] = await Promise.all([
    ready ? got("네이버 뉴스", naver("경제", { display: 50, sort: "sim" })) : [],
    ready ? naver("증시 금리 환율", { display: 30, sort: "date" }).catch(() => []) : [],
    process.env.DATA_GO_KR_KEY ? got("정책브리핑", pressReleases(2).then((l) => l.filter(isEcon).slice(0, 15).map((r) => ({ title: r.title, url: r.url, source: r.org || "정책브리핑", at: new Date().toISOString() })))) : [],
    got("NewsData", newsdata()),
    got("GDELT", gdelt(full ? 15 : 6)),
  ]);
  if (!ready && !policy.length && !nd.length) return res.status(200).json({ ...sampleHome(interests), global, providers });

  try {
    const dayAgo = Date.now() - 36 * 3600e3;
    const pool = dedupe([...nv1, ...nv2, ...nd]);
    const fresh = pool.filter((n) => new Date(n.at).getTime() > dayAgo);
    // 오늘의 이슈: 언론(신뢰 순) · 정책브리핑 · NewsData를 번갈아 골라 한 출처에 쏠리지 않게
    const lanes = [byTrust(dedupe(fresh.length >= 3 ? fresh : pool).filter((n) => !nd.includes(n))), policy, byTrust(nd)].filter((l) => l.length);
    const issues = [], seenT = new Set(), wantI = full ? 15 : 3;
    for (let i = 0; issues.length < wantI && lanes.some((l) => l.length > i); i++) for (const l of lanes) {
      const it = l[i], k = it?.title.replace(/[^가-힣A-Za-z0-9]/g, "").slice(0, 14);
      if (it && !seenT.has(k) && issues.length < wantI) { seenT.add(k); issues.push(it); }
    }

    // 관심 종목·선호마다 최신 뉴스 1개씩, 모자라면 앞쪽 관심사에서 더
    const queries = interests.map((i) => ({ tag: i, q: PREF_QUERY[i] || i }));
    const perQuery = ready ? await Promise.all(queries.map(({ q }) => naver(q, { display: full ? 15 : 6, sort: "date" }).catch(() => []))) : queries.map(() => []);
    const taken = new Set(issues.map((i) => i.url));
    const forYou = [];
    const want = full ? 20 : 3;
    for (let round = 0; round < (full ? 6 : 3) && forYou.length < want; round++) {
      perQuery.forEach((list, i) => {
        const pick = byTrust(dedupe(list)).filter((n) => !taken.has(n.url))[0];
        if (pick && forYou.length < want) {
          taken.add(pick.url);
          forYou.push({ ...pick, tag: queries[i].tag });
        }
      });
    }

    cache(res, 3600); // 사용량을 아끼려고(GDELT는 5초에 한 번 제한) 1시간 동안 같은 결과를 재사용
    res.status(200).json({ issues: strip(issues), forYou: strip(forYou), global: strip(global.slice(0, full ? 15 : 3)), keywords: keywords([...pool, ...policy]), providers });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ...sampleHome(interests), error: "뉴스를 불러오지 못했어요", why: String(e.message).slice(0, 80) });
  }
}
