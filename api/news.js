// 뉴스: 여러 출처에서 제목 + 링크만 보여준다(본문은 가져오지 않음).
// 오늘의 이슈 = 네이버 뉴스 검색 + 정책브리핑 보도자료 + NewsData(키가 있을 때)를 출처가 고르게 섞어서, 해외 뉴스 = GDELT(막히면 BBC 경제 RSS).
// 한 출처가 막혀도 나머지로 채운다.
// GET /api/news?interests=삼성전자,여행   → { issues: 오늘의 이슈 3, forYou: 관심 뉴스 3, global: 해외 뉴스 3, keywords: 오늘의 키워드 3, providers }
// GET /api/news?q=FOMC                     → { items: 해당 키워드 뉴스 3 }
// 둘 다 &full=1 을 붙이면 '뉴스 더보기' 화면용으로 더 많이 돌려준다
import { cache } from "./_util.js";
import { PREF_QUERY, naver, dedupe, keywords, searchUrl, newsReady, byTrust, globalNews, newsdata, meaty, translateTitles, translateState } from "./_news.js";
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

// 관심사별 검색 결과를 이 서버가 3시간 기억한다. 네이버가 막혀도(429) 기억해 둔 것이 있으면 그걸 쓴다
const qCache = new Map();
async function searchInterest(q, display) {
  const key = `${q}|${display}`, hit = qCache.get(key);
  if (hit && Date.now() - hit.at < 3 * 3600e3) return hit.items;
  let items = [];
  try { items = await naver(q, { display, sort: "date" }); } catch (e) { console.error("interest naver", q, e.message); }
  // 네이버가 막혔거나(하루 한도·429) 못 찾으면 NewsData에서 같은 낱말로 (기억해 둔 게 있으면 그걸 먼저)
  if (!items.length && !hit) items = await newsdata(q).catch((e) => { console.error("interest newsdata", q, e.message); return []; });
  if (items.length) { qCache.set(key, { at: Date.now(), items }); if (qCache.size > 300) qCache.delete(qCache.keys().next().value); }
  return items.length ? items : hit?.items || [];
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
    globalNews(full ? 15 : 6).then((g) => { if (g.items.length) providers.push(g.provider); return g.items; }).catch((e) => { console.error("global", e.message); return []; }),
  ]);
  if (!ready && !policy.length && !nd.length) return res.status(200).json({ ...sampleHome(interests), global, providers });

  try {
    const dayAgo = Date.now() - 36 * 3600e3;
    const pool = dedupe([...nv1, ...nv2, ...nd]).filter(meaty);
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
    // 한꺼번에 부르면 네이버가 '너무 많다(429)'고 막아서 하나씩 부른다
    const perQuery = [];
    for (const { q } of queries) perQuery.push(ready ? await searchInterest(q, full ? 15 : 6) : []);
    // 네이버에서 못 찾은 관심사는 이미 받아 둔 다른 출처(네이버 경제·NewsData·정책브리핑) 제목에서 그 낱말이 든 기사로 채운다
    const others = dedupe([...pool, ...policy]);
    queries.forEach(({ tag, q }, i) => {
      if (perQuery[i].length) return;
      const words = [tag, ...q.split(/\s+/)].filter((w) => w.length >= 2);
      perQuery[i] = others.filter((n) => words.some((w) => n.title.includes(w)));
    });
    const taken = new Set(issues.map((i) => i.url));
    const forYou = [];
    const want = full ? 20 : 3;
    for (let round = 0; round < (full ? 6 : 3) && forYou.length < want; round++) {
      perQuery.forEach((list, i) => {
        const pick = byTrust(dedupe(list)).filter((n) => !taken.has(n.url) && meaty(n))[0];
        if (pick && forYou.length < want) {
          taken.add(pick.url);
          forYou.push({ ...pick, tag: queries[i].tag });
        }
      });
    }

    const globalKo = await translateTitles(global.slice(0, full ? 15 : 3)); // 영어 제목은 한국어로(안 되면 영어 그대로)
    // 사용량을 아끼려고(GDELT는 5초에 한 번 제한) 1시간 동안 같은 결과를 재사용. 번역이 실패해 영어가 남았으면 2분만 쓰고 다시 번역
    // 영어가 남았거나 관심사가 있는데 나를 위한 뉴스를 못 찾았으면 2분만 쓰고 다시 찾는다
    if (globalKo.some((a) => a.lang === "en") || (interests.length && !forYou.length)) res.setHeader("Cache-Control", "s-maxage=120");
    else cache(res, 3600);
    res.status(200).json({ issues: strip(issues), forYou: strip(forYou), global: strip(globalKo), keywords: keywords([...pool, ...policy]), providers, ...(translateState.why ? { tr: translateState.why } : {}) });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ...sampleHome(interests), error: "뉴스를 불러오지 못했어요", why: String(e.message).slice(0, 80) });
  }
}
