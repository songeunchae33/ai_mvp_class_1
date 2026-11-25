// 뉴스: 여러 출처에서 제목 + 링크만 보여준다(본문은 가져오지 않음). 네이버 뉴스 검색 API는 유료라 쓰지 않는다.
// 오늘의 이슈 = NewsData(국내 경제 최신) + 정책브리핑 보도자료를 출처가 고르게 섞어서, 해외 뉴스 = GDELT(막히면 BBC 경제 RSS).
// 나를 위한 뉴스·키워드 뉴스 = NewsData 낱말 검색(못 찾으면 이미 받아 둔 기사 제목에서 그 낱말로). 한 출처가 막혀도 나머지로 채운다.
// GET /api/news?interests=삼성전자,여행   → { issues: 오늘의 이슈 3, forYou: 관심 뉴스 3, global: 해외 뉴스 3, keywords: 오늘의 키워드 3, providers }
// GET /api/news?q=FOMC                     → { items: 해당 키워드 뉴스 3 }
// 둘 다 &full=1 을 붙이면 '뉴스 더보기' 화면용으로 더 많이 돌려준다
import { cache } from "./_util.js";
import { PREF_QUERY, dedupe, keywords, searchUrl, newsReady, byTrust, globalNews, newsdata, meaty, translateTitles, translateState } from "./_news.js";
import { pressReleases, isEcon, byHot, hotScores, topicDf, sameStory } from "./_policy.js";

const hotTop = (it, corpus) => { const all = [it, ...corpus.filter((c) => c !== it)]; return hotScores(all)[0]; };
// 화면에는 제목·링크만 보낸다
const strip = (list) => list;

function sampleHome(interests) {
  const issues = ["(예시) 미국 금리 결정 앞두고 시장 관심 집중", "(예시) 원/달러 환율 흐름 살펴보기", "(예시) 반도체 업황과 대형주 소식"]
    .map((title) => ({ title, url: searchUrl(title), source: "예시" }));
  const forYou = (interests.length ? interests : ["경제"]).slice(0, 3)
    .map((q) => ({ title: `${q} 관련 최신 뉴스 (예시)`, url: searchUrl(q), source: "예시", tag: q }));
  return { sample: true, issues, forYou, keywords: ["FOMC", "환율", "반도체"] };
}

const policyNews = () => pressReleases(2, true).then((l) => l.filter(isEcon).slice(0, 30).map((r) => ({ title: r.title, url: r.url, source: r.org || "정책브리핑", at: new Date().toISOString() }))); // 제목·링크만이라 변경 금지 유형도 넣음
// 낱말 검색이 비면, 이미 받은 기사(경제 최신·정책브리핑) 제목에서 그 낱말이 든 것으로
const byWords = (list, tag, q) => {
  const words = [tag, ...String(q || "").split(/\s+/)].filter((w) => w && w.length >= 2);
  return list.filter((n) => words.some((w) => n.title.includes(w)));
};

export default async function handler(req, res) {
  const ready = newsReady();
  const full = req.query.full === "1";

  if (req.query.q) {
    const q = String(req.query.q).slice(0, 30);
    if (!ready) return res.status(200).json({ sample: true, items: [{ title: `${q} 뉴스 검색 결과 보기`, url: searchUrl(q), source: "네이버 뉴스 검색" }] });
    try {
      let items = await newsdata(q).catch((e) => { console.error("q", q, e.message); return []; });
      if (!items.length) {
        const [nd, policy] = await Promise.all([newsdata().catch(() => []), process.env.DATA_GO_KR_KEY ? policyNews().catch(() => []) : []]);
        items = byWords(dedupe([...nd, ...policy]), q);
      }
      items = byTrust(dedupe(items).filter(meaty)).slice(0, full ? 15 : 3); // 출처가 약한 기사는 뒤로
      if (items.length) cache(res, 3600); // 하루 횟수를 아끼려고 1시간 동안 같은 결과를 재사용
      else res.setHeader("Cache-Control", "s-maxage=300");
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
  const [policy, nd, global] = await Promise.all([
    process.env.DATA_GO_KR_KEY ? got("정책브리핑", policyNews()) : [],
    ready ? got("NewsData", newsdata()) : [],
    globalNews(full ? 15 : 6).then((g) => { if (g.items.length) providers.push(g.provider); return g.items; }).catch((e) => { console.error("global", e.message); return []; }),
  ]);
  if (!policy.length && !nd.length) return res.status(200).json({ ...sampleHome(interests), global, providers });

  try {
    const pool = dedupe(nd).filter(meaty);
    // 오늘의 이슈: 여러 언론·부처가 같이 다루는 화제부터(byHot), 같은 화제 점수면 믿을 만한 출처 먼저.
    // 언론 · 정책브리핑을 번갈아 골라 한 출처에 쏠리지 않게 하되, 화제 점수가 더 높은 쪽이 첫 줄
    const corpus = [...pool, ...policy];
    const lanes = [byHot(byTrust(pool), corpus), byHot(policy, corpus)].filter((l) => l.length);
    if (lanes.length === 2) { const [a, b] = lanes.map((l) => hotTop(l[0], corpus)); if (b > a) lanes.reverse(); }
    const issues = [], wantI = full ? 15 : 3, df = topicDf(corpus);
    // 같은 이야기(중심 낱말이 같거나 화제 낱말 2개 이상 겹침)는 하나만. 한 줄씩 번갈아 고르되 같은 이야기면 그 줄의 다음 기사로
    const pos = lanes.map(() => 0);
    for (let guard = 0; issues.length < wantI && guard < 400; guard++) {
      let moved = false;
      for (let li = 0; li < lanes.length && issues.length < wantI; li++) {
        while (pos[li] < lanes[li].length) {
          const it = lanes[li][pos[li]++];
          if (issues.some((x) => sameStory(x, it, df))) continue;
          issues.push(it); moved = true; break;
        }
      }
      if (!moved) break;
    }

    // 관심 종목·선호마다 최신 뉴스 1개씩, 모자라면 앞쪽 관심사에서 더 (NewsData 낱말 검색, 하나씩 불러서 서버가 3시간 기억)
    const queries = interests.map((i) => ({ tag: i, q: PREF_QUERY[i] || i }));
    const others = dedupe([...pool, ...policy]);
    const perQuery = [];
    for (const { tag, q } of queries) {
      const found = ready ? await newsdata(q).catch((e) => { console.error("interest", q, e.message); return []; }) : [];
      perQuery.push(found.length ? found : byWords(others, tag, q));
    }
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
    // 1시간 동안 같은 결과를 재사용. 영어가 남았거나 관심사가 있는데 나를 위한 뉴스를 못 찾았으면 2분만 쓰고 다시
    if (globalKo.some((a) => a.lang === "en") || (interests.length && !forYou.length)) res.setHeader("Cache-Control", "s-maxage=120");
    else cache(res, 3600);
    res.status(200).json({ issues: strip(issues), forYou: strip(forYou), global: strip(globalKo), keywords: keywords([...pool, ...policy]), providers, ...(translateState.why ? { tr: translateState.why } : {}) });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ...sampleHome(interests), error: "뉴스를 불러오지 못했어요", why: String(e.message).slice(0, 80) });
  }
}
