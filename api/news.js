// 뉴스: 여러 출처에서 제목 + 링크만 보여준다(본문은 가져오지 않음). 네이버 뉴스 검색 API는 유료라 쓰지 않는다.
// 오늘의 이슈 = NewsData(국내 경제 최신) + 정책브리핑 보도자료를 출처가 고르게 섞어서, 해외 뉴스 = GDELT(막히면 BBC 경제 RSS).
// 나를 위한 뉴스·키워드 뉴스 = NewsData 낱말 검색(못 찾으면 이미 받아 둔 기사 제목에서 그 낱말로). 한 출처가 막혀도 나머지로 채운다.
// GET /api/news?interests=삼성전자,여행   → { issues: 오늘의 이슈 3, forYou: 관심 뉴스 3, global: 해외 뉴스 3, keywords: 오늘의 키워드 3, providers }
// GET /api/news?q=FOMC                     → { items: 해당 키워드 뉴스 3 }
// 둘 다 &full=1 을 붙이면 '뉴스 더보기' 화면용으로 더 많이 돌려준다
import { cache } from "./_util.js";
import { PREF_QUERY, dedupe, keywords, searchUrl, newsReady, byTrust, globalNews, newsdata, meaty, translateTitles, translateState, tier, poolState } from "./_news.js";
import { pressReleases, isEcon, stories, forYouStories } from "./_policy.js";

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

  // 점검용: /api/news?check=1 → 하루치 모아 두기가 언제 새로 받았는지, 통로별 개수, 지금 화제 순위 10개 (휴대폰 브라우저로 열어 확인)
  if (req.query.check === "1") {
    res.setHeader("Cache-Control", "no-store");
    const [nd, policy] = await Promise.all([ready ? newsdata().catch((e) => ({ error: e.message })) : [], process.env.DATA_GO_KR_KEY ? policyNews().catch(() => []) : []]);
    const pool = Array.isArray(nd) ? dedupe(nd).filter(meaty) : [];
    const ST = stories([...pool, ...policy], { trust: tier });
    const kst = (t) => (t ? new Date(t + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " (한국)" : null);
    const ps = poolState();
    return res.status(200).json({
      지금: kst(Date.now()), 하루치_새로받은시각: kst(ps.mem?.fetchedAt), 모아둔기사: pool.length, 보도자료: policy.length, 이번에받은통로별: ps.last?.bySrc || "이 서버에서는 아직 새로 받지 않았어요(다른 서버가 받았거나 1시간 안)",
      화제순위: ST.slice(0, 10).map((st, i) => `${i + 1}. [${st.outlets}곳] ${st.rep.title} (${st.rep.source})`), 오류: Array.isArray(nd) ? undefined : nd.error,
    });
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
    // 오늘의 이슈: 언론 기사(하루치)·정부 보도자료를 '이야기'로 묶어, 다룬 언론사·부처가 많은 이야기부터 하나씩 (api/_policy.js stories)
    const wantI = full ? 15 : 3;
    const ST = stories([...pool, ...policy], { trust: tier });
    const issues = ST.slice(0, wantI).map((st) => ({ ...st.rep, outlets: st.outlets }));

    // 나를 위한 뉴스: 하루치 이야기(언론사 RSS·GDELT·NewsData·보도자료) 중 관심사 낱말이 든 큰 이야기부터 (api/_policy.js forYouStories).
    // 오늘의 이슈와 같은 기사여도 괜찮다(홈 화면이 네 줄 화제를 겹치지 않게 다시 고름). 못 찾은 관심사만 NewsData 낱말 검색으로 채운다
    const want = full ? 20 : 3;
    const forYou = forYouStories(ST, interests, want);
    const missing = interests.filter((i) => !forYou.some((x) => x.tag === i));
    if (forYou.length < want && ready) for (const tag of missing.slice(0, 3)) {
      const found = await newsdata(PREF_QUERY[tag] || tag).catch((e) => { console.error("interest", tag, e.message); return []; });
      const pick = byTrust(dedupe(found)).filter((n) => meaty(n) && !forYou.some((x) => x.url === n.url))[0];
      if (pick && forYou.length < want) forYou.push({ ...pick, tag });
    }

    const globalKo = await translateTitles(global.slice(0, full ? 15 : 3)); // 영어 제목은 한국어로(안 되면 영어 그대로)
    // 1시간 동안 같은 결과를 재사용. 영어가 남았거나 관심사가 있는데 나를 위한 뉴스를 못 찾았으면 2분만 쓰고 다시
    if (globalKo.some((a) => a.lang === "en") || (interests.length && !forYou.length)) res.setHeader("Cache-Control", "s-maxage=120");
    else cache(res, 900); // 15분마다 다시 계산(하루치 모아 두기는 1시간마다 새로 받음)
    res.status(200).json({ issues: strip(issues), forYou: strip(forYou), global: strip(globalKo), keywords: keywords([...pool, ...policy]), providers, ...(translateState.why ? { tr: translateState.why } : {}) });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ...sampleHome(interests), error: "뉴스를 불러오지 못했어요", why: String(e.message).slice(0, 80) });
  }
}
