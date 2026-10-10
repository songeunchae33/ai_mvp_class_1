// 뉴스: 네이버 검색 API (제목 + 링크만 보여준다. 본문은 가져오지 않음)
// GET /api/news?interests=삼성전자,여행   → { issues: 오늘의 이슈 3, forYou: 관심 뉴스 3, keywords: 오늘의 키워드 3 }
// GET /api/news?q=FOMC                     → { items: 해당 키워드 뉴스 3 }
import { fetchJson, cache } from "./_util.js";

// 취향(선호) → 그 사람에게 의미 있는 뉴스 검색어
const PREF_QUERY = {
  쇼핑: "소비 물가",
  여행: "환율 여행",
  음식: "외식 물가",
  자기계발: "청년 정책",
  저축: "예금 금리",
  부동산: "부동산 금리",
  취미: "소비 트렌드",
};

// 오늘의 키워드 후보 (제목에 많이 나온 순으로 3개)
const TERMS = [
  "기준금리", "금리", "환율", "FOMC", "연준", "금통위", "코스피", "코스닥", "반도체", "2차전지", "배터리", "AI",
  "부동산", "전세", "청약", "물가", "인플레이션", "관세", "수출", "유가", "달러", "엔화", "비트코인", "실적",
  "배당", "공모주", "IPO", "채권", "국채", "고용", "소비", "무역", "외국인", "공매도", "ETF", "가계부채", "트럼프",
];

const SOURCES = {
  "hankyung.com": "한국경제", "mk.co.kr": "매일경제", "yna.co.kr": "연합뉴스", "chosun.com": "조선일보",
  "joongang.co.kr": "중앙일보", "donga.com": "동아일보", "hani.co.kr": "한겨레", "khan.co.kr": "경향신문",
  "sedaily.com": "서울경제", "edaily.co.kr": "이데일리", "mt.co.kr": "머니투데이", "fnnews.com": "파이낸셜뉴스",
  "heraldcorp.com": "헤럴드경제", "asiae.co.kr": "아시아경제", "newsis.com": "뉴시스", "news1.kr": "뉴스1",
  "biz.chosun.com": "조선비즈", "kbs.co.kr": "KBS", "imbc.com": "MBC", "sbs.co.kr": "SBS", "ytn.co.kr": "YTN",
  "yonhapnewstv.co.kr": "연합뉴스TV", "nocutnews.co.kr": "노컷뉴스", "etnews.com": "전자신문", "bizwatch.co.kr": "비즈니스워치",
};

function clean(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

function source(url) {
  try {
    const host = new URL(url).hostname.replace(/^(www|m|news|biz)\./, "");
    const hit = Object.keys(SOURCES).find((d) => host === d || host.endsWith("." + d));
    return hit ? SOURCES[hit] : host;
  } catch {
    return "";
  }
}

async function naver(query, { display = 10, sort = "date" } = {}) {
  const qs = new URLSearchParams({ query, display: String(display), sort });
  const json = await fetchJson(`https://openapi.naver.com/v1/search/news.json?${qs}`, {
    headers: {
      "X-Naver-Client-Id": process.env.NAVER_SEARCH_ID,
      "X-Naver-Client-Secret": process.env.NAVER_SEARCH_SECRET,
    },
  });
  return (json.items || []).map((it) => {
    const url = it.originallink || it.link;
    return { title: clean(it.title), url, source: source(url), at: new Date(it.pubDate).toISOString() };
  });
}

// 거의 같은 제목(같은 사건을 여러 언론이 쓴 것) 걸러내기
function dedupe(items) {
  const out = [];
  const key = (t) => t.replace(/[^가-힣A-Za-z0-9]/g, "").slice(0, 14);
  const seen = new Set();
  for (const it of items) {
    const k = key(it.title);
    if (!it.title || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function keywords(items) {
  const count = new Map();
  for (const { title } of items) {
    for (const t of TERMS) if (title.includes(t)) count.set(t, (count.get(t) || 0) + 1);
  }
  // '기준금리'가 잡히면 '금리'는 빼는 식으로 겹치는 단어 정리
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const picked = [];
  for (const t of ranked) {
    if (picked.some((p) => p.includes(t) || t.includes(p))) continue;
    picked.push(t);
    if (picked.length === 3) break;
  }
  return picked;
}

function searchUrl(q) {
  return `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(q)}`;
}

function sampleHome(interests) {
  const issues = ["FOMC 앞두고 금리 동결 전망 우세", "원/달러 환율 1,470원대서 등락", "반도체 업황 개선 기대에 대형주 강세"]
    .map((title) => ({ title, url: searchUrl(title), source: "예시" }));
  const forYou = (interests.length ? interests : ["경제"]).slice(0, 3)
    .map((q) => ({ title: `${q} 관련 최신 뉴스 (예시)`, url: searchUrl(q), source: "예시", tag: q }));
  return { sample: true, issues, forYou, keywords: ["FOMC", "환율", "반도체"] };
}

export default async function handler(req, res) {
  const ready = process.env.NAVER_SEARCH_ID && process.env.NAVER_SEARCH_SECRET;

  if (req.query.q) {
    const q = String(req.query.q).slice(0, 30);
    if (!ready) return res.status(200).json({ sample: true, items: [{ title: `${q} 뉴스 검색 결과 보기`, url: searchUrl(q), source: "네이버 뉴스" }] });
    try {
      const items = dedupe(await naver(q + " 경제", { display: 15, sort: "sim" })).slice(0, 3);
      cache(res, 900);
      return res.status(200).json({ items });
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
    const issues = (fresh.length >= 3 ? fresh : pool).slice(0, 3);

    // 관심 종목·선호마다 최신 뉴스 1개씩, 모자라면 앞쪽 관심사에서 더
    const queries = interests.map((i) => ({ tag: i, q: PREF_QUERY[i] || i }));
    const perQuery = await Promise.all(queries.map(({ q }) => naver(q, { display: 6, sort: "date" }).catch(() => [])));
    const taken = new Set(issues.map((i) => i.url));
    const forYou = [];
    for (let round = 0; round < 3 && forYou.length < 3; round++) {
      perQuery.forEach((list, i) => {
        const pick = dedupe(list).filter((n) => !taken.has(n.url))[0];
        if (pick && forYou.length < 3) {
          taken.add(pick.url);
          forYou.push({ ...pick, tag: queries[i].tag });
        }
      });
    }

    cache(res, 900);
    res.status(200).json({ issues, forYou, keywords: keywords(pool) });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ...sampleHome(interests), error: "뉴스를 불러오지 못했어요" });
  }
}
