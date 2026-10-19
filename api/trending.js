// 경제 공부 '화제순': 개념마다 최근 7일 정부 보도자료(정책브리핑)에 몇 번 나왔는지 센다.
// 앱 사용자 기록을 모으는 서버가 없어서 '요즘 많이 나오는 개념'을 보도자료 언급량으로 대신한다.
// (네이버 검색 결과는 약관상 '그대로 보여주기'에만 쓸 수 있어서 집계에 쓰지 않는다)
// GET /api/trending → { available, counts: { 개념id: 언급 횟수 }, keywords: [{ word, count, concept }] 화제 키워드 5개, events: [{ title, word, count, url, org }] 화제 TOP 5(대표 보도자료 제목), total: 본 보도자료 수, at }
import { cache } from "./_util.js";
import { pressReleases, isEcon } from "./_policy.js";

// "토큰증권 (STO)" → "토큰증권", "양적완화 / 양적긴축" → "양적완화", "고정금리 vs 변동금리" → "고정금리"
function searchWord(term) {
  return term.split(/\s*(?:\(|\/|·|vs)\s*/)[0].trim();
}

// 화제 키워드 후보: 경제 개념 이름 + 정부 보도자료에 자주 나오는 경제 낱말
const WORDS = ["금리", "물가", "환율", "수출", "수입", "반도체", "AI", "배터리", "전기차", "부동산", "전세", "청약", "가계부채", "대출",
  "관세", "무역", "공급망", "일자리", "고용", "청년", "소상공인", "중소기업", "스타트업", "벤처", "예산", "세제", "세금", "추경",
  "국채", "외환", "증시", "코스피", "밸류업", "배당", "연금", "건강보험", "최저임금", "저출생", "에너지", "원전", "유가", "농산물",
  "관광", "디지털", "플랫폼", "가상자산", "스테이블코인", "물류", "조선업", "방산", "바이오", "자동차", "철강", "석유화학", "소비", "내수"];

// 보도자료 제목을 짧게: 앞의 [말머리]·따옴표 정리, 부제(— , ·· 뒤)는 자르기
// 보도자료 제목에 섞여 오는 HTML 문자(&middot; 등)를 글자로
function decode(t) {
  const N = { middot: "·", quot: '"', amp: "&", lt: "<", gt: ">", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", nbsp: " ", hellip: "…" };
  return String(t || "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&([a-z]+);/g, (m, k) => N[k] ?? m);
}
function shortTitle(t) {
  let s = decode(t).replace(/^\s*[\[(【<][^\])】>]{1,12}[\])】>]\s*/, "").replace(/\s+/g, " ").trim();
  s = s.split(/\s[-–—]\s|\s?…\s?|\s?\.\.\.\s?/)[0].trim();
  return s.length > 34 ? s.slice(0, 33).trim() + "…" : s;
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
    // 화제 키워드 TOP 5: 낱말이 나온 보도자료 수 (한 자료에 여러 번 나와도 1번). 개념 이름과 같으면 그 개념으로 연결
    const conceptOf = Object.fromEntries(learn.concepts.map((c) => [searchWord(c.term), c.id]));
    const words = [...new Set([...WORDS, ...Object.keys(conceptOf)])];
    const keywords = words.map((w) => ({ word: w, count: texts.filter((t) => t.includes(w)).length, concept: conceptOf[w] || null }))
      .filter((k) => k.count > 0).sort((a, b) => b.count - a.count).slice(0, 5);
    // 화제 TOP 5: 많이 나온 낱말마다, 그 낱말이 제목에 들어간 대표 보도자료 제목을 고른다 (무엇이 있었는지 알 수 있게)
    // 대표 = 제목에 다른 화제 낱말이 많이 들어간 것 → 같으면 최신. 같은 자료는 두 번 쓰지 않는다
    const ranked = words.map((w) => ({ word: w, count: texts.filter((t) => t.includes(w)).length })).filter((k) => k.count > 0).sort((a, b) => b.count - a.count);
    const hotWords = ranked.slice(0, 15).map((k) => k.word);
    // 언론 보도 설명·해명 자료는 '무슨 일이 있었는지'가 아니라서 빼고, 경제 관련 자료만 쓴다
    const eventDocs = docs.filter((d) => isEcon(d) && !/설명|해명|정정|반박/.test(decode(d.title).replace(/[^가-힣]/g, "").slice(0, 6)) && !/아닙니다|사실이 아닙|사실과 다릅/.test(decode(d.title)));
    const used = new Set();
    const events = [];
    for (const k of ranked) {
      if (events.length >= 5) break;
      const pick = eventDocs.filter((d) => d.title.includes(k.word) && !used.has(d.title))
        .map((d) => ({ d, score: hotWords.filter((w) => d.title.includes(w)).length }))
        .sort((a, b) => b.score - a.score || String(b.d.at).localeCompare(String(a.d.at)))[0];
      if (!pick) continue;
      used.add(pick.d.title);
      events.push({ title: shortTitle(pick.d.title), word: k.word, count: k.count, url: pick.d.url, org: pick.d.org });
    }
    cache(res, 21600); // 6시간마다 다시 셈
    res.status(200).json({ available: true, counts, keywords, events, total: docs.length, at: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(200).json({ available: false });
  }
}
