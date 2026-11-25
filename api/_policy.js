// 정부 정책뉴스·보도자료 (공공데이터포털 '문화체육관광부_정책브리핑_정책뉴스_API', 무료·자동승인)
// 공공저작물이라 출처를 밝히면 자유롭게 이용·가공할 수 있어서(저작권법 제24조의2), AI 풀이와 화제 개념 집계에 쓴다.
// 네이버 검색 결과는 약관상 AI 요약에 쓸 수 없어서 여기로 옮겼다.
import { kstYmd, dataGoKey } from "./_util.js";

const BASE = "https://apis.data.go.kr/1371000/policyNewsService2/policyNewsList2";

// 경제와 관련 깊은 부처
export const ECON_ORGS = ["기획재정부", "재정경제부", "기획예산처", "금융위원회", "국토교통부", "산업통상자원부", "공정거래위원회", "고용노동부", "국세청", "통계청",
  "중소벤처기업부", "관세청", "농림축산식품부", "행정안전부", "보건복지부", "과학기술정보통신부", "해양수산부", "문화체육관광부",
  "교육부", "국무조정실", "조달청", "특허청", "성평등가족부", "여성가족부", "방송통신위원회", "환경부", "기후에너지환경부"];
export const ECON_WORDS = ["금리", "물가", "수출", "수입", "부동산", "주택", "전세", "대출", "세금", "세제", "예산", "청년", "일자리", "고용",
  "투자", "금융", "환율", "관세", "소비", "지원금", "경제", "성장", "반도체", "할인", "소상공인", "연금", "저축",
  "청약", "월세", "예금", "적금", "보험", "카드", "학자금", "장학", "최저임금", "근로장려금", "취업", "창업", "주식", "증시", "가상자산",
  "전기요금", "가스요금", "유가", "교통비", "통신비", "관광", "항공", "수당", "바우처", "임금"];
// 사용자 선호(첫 설문) → 보도자료에서 찾을 단어. 관심 종목 이름은 그대로 찾는다
const PREF_WORDS = {
  여행: ["관광", "여행", "항공", "환율", "숙박"], 부동산: ["부동산", "주택", "전세", "월세", "청약", "임대"],
  저축: ["예금", "적금", "저축", "금리", "연금"], 쇼핑: ["소비", "할인", "물가", "유통", "카드"],
  음식: ["외식", "식품", "농산물", "물가"], 취미: ["문화", "공연", "체육", "관광"], 자기계발: ["교육", "훈련", "자격", "취업", "장학"],
  비상금: ["예금", "적금", "금리"], "첫 투자": ["주식", "투자", "자본시장", "ETF"], "내 집 마련": ["주택", "전세", "청약", "임대", "부동산"],
  "대출 갚기": ["대출", "금리", "학자금", "가계부채"], "여행 자금": ["관광", "여행", "환율"], "취업·이직": ["취업", "일자리", "고용", "채용", "청년"],
  "노후·연금": ["연금", "노후", "퇴직"], 반도체: ["반도체"], "2차전지": ["배터리", "이차전지"], AI: ["인공지능", "AI", "디지털"],
  바이오: ["바이오", "의약품", "제약"], 자동차: ["자동차", "전기차"], "게임·엔터": ["게임", "콘텐츠", "한류"], "은행·금융": ["금융", "은행"],
};
// 관심사와 겹치는 단어 수 (많을수록 먼저 풀이한다)
export function interestScore(p, interests) {
  const text = `${p.title} ${p.sub} ${p.body}`;
  const words = interests.flatMap((i) => PREF_WORDS[i] || [i]);
  return words.filter((w) => w.length > 1 && text.includes(w)).length;
}

function clean(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// 승인일(ApproveDate)을 비교할 수 있게 YYYYMMDDhhmm으로 ('2026-11-25 10:00' · '11/25/2026 10:00:00' 둘 다)
export function atKey(at) {
  const t = String(at || "");
  let m = t.match(/(\d{4})[-./]?(\d{2})[-./]?(\d{2})\D*(\d{1,2})?:?(\d{2})?/);
  if (m) return `${m[1]}${m[2]}${m[3]}${(m[4] || "0").padStart(2, "0")}${m[5] || "00"}`;
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\D*(\d{1,2})?:?(\d{2})?/);
  return m ? `${m[3]}${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}${(m[4] || "0").padStart(2, "0")}${m[5] || "00"}` : "";
}
function field(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? clean(m[1]) : "";
}

// 최근 days일 보도자료 (API는 한 번에 최대 3일 범위라 나눠서 부른다)
// listOnly: 제목·링크만 보여 줄 때는 공공누리 3·4유형(변경 금지)도 넣는다. AI로 다시 쓰는 곳(쉽게 풀이 등)은 기본값(뺌)으로
export async function pressReleases(days = 3, listOnly = false) {
  const ranges = [];
  for (let d = 0; d < days; d += 3) ranges.push([kstYmd(Math.min(d + 2, days - 1)), kstYmd(d)]);
  const texts = await Promise.all(ranges.map(([start, end]) =>
    fetch(`${BASE}?serviceKey=${dataGoKey()}&startDate=${start}&endDate=${end}`, { signal: AbortSignal.timeout(9000) })
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "")));
  const seen = new Set();
  const items = [];
  for (const xml of texts) {
    for (const m of xml.matchAll(/<NewsItem>([\s\S]*?)<\/NewsItem>/g)) {
      const b = m[1];
      const title = field(b, "Title");
      if (!title || seen.has(title)) continue;
      // 공공누리 3·4유형(변경 금지)은 AI로 다시 쓰면 안 되니 뺀다
      if (!listOnly && /[34]/.test(field(b, "KoglType"))) continue;
      seen.add(title);
      items.push({
        title, sub: field(b, "SubTitle1"), body: field(b, "DataContents").slice(0, 500),
        org: field(b, "MinisterCode"), url: field(b, "OriginalUrl"), at: field(b, "ApproveDate"),
      });
    }
  }
  return items.sort((a, b) => (atKey(b.at) > atKey(a.at) ? 1 : -1)); // 최근 것부터
}

export function isEcon(p) {
  const text = `${p.title} ${p.sub}`;
  return ECON_ORGS.some((o) => p.org.includes(o)) || ECON_WORDS.some((w) => text.includes(w));
}

// ── 오늘의 화제 점수: 여러 기사·보도자료 제목에 같이 나오는 낱말일수록 큰 화제로 본다 ──
// (예: '증시안정펀드'가 언론 기사 여러 개와 금융위원회 보도자료에 같이 나오면 그 기사들이 위로)
const JOSA = /(으로서|으로써|에서는|에게서|으로|에서|에게|까지|부터|보다|처럼|에는|이며|하고|하며|에도|으로는|은|는|이|가|을|를|의|에|와|과|도|만|로)$/;
const STOP = new Set(["정부", "관련", "위해", "위한", "대한", "통해", "추진", "개최", "발표", "오늘", "내일", "올해", "내년", "지난해", "이번", "최대", "확대", "지원", "강화", "개선",
  "본격", "시행", "운영", "계획", "결과", "현장", "방안", "회의", "기자", "속보", "단독", "종합", "포토", "사진", "영상", "뉴스", "기업", "한국", "국내", "우리", "주요", "대통령"]);
// 같은 뜻 다른 이름은 하나로 (증안펀드 = 증시안정펀드 = 증권시장안정펀드)
const SAME = [[/증권시장안정펀드|증시안정펀드|증안펀드/g, "증시안정펀드"], [/코스피지수/g, "코스피"], [/기준 ?금리/g, "기준금리"]];
const twMemo = new Map();
export function topicWords(title) {
  const key = String(title || "");
  if (twMemo.has(key)) return twMemo.get(key);
  const r = topicWords0(key);
  if (twMemo.size > 5000) twMemo.clear();
  twMemo.set(key, r);
  return r;
}
function topicWords0(title) {
  let t = String(title || "");
  for (const [re, to] of SAME) t = t.replace(re, ` ${to} `);
  const out = new Set();
  for (let w of t.split(/[^가-힣A-Za-z0-9]+/)) {
    const cut = w.replace(JOSA, "");
    if (cut.length >= 2) w = cut; // '주가'·'물가'처럼 잘라서 한 글자가 되면 그대로
    if (w.length >= 2 && !/^\d+$/.test(w) && !STOP.has(w)) out.add(w);
  }
  return [...out];
}
// 시장·경제 전체를 흔드는 낱말과 핵심 경제 부처는 조금 더 무겁게
const BIG = ["증시안정펀드", "증시", "코스피", "코스닥", "기준금리", "금리", "환율", "외환", "폭락", "급락", "급등", "긴급", "대책", "관세", "물가", "부동산", "공매도", "밸류업"];
const CORE_ORG = ["금융위원회", "기획재정부", "재정경제부", "한국은행", "금융감독원"];
// 출처(언론사·부처)별로 한 번만 센다: 한 곳이 같은 형식으로 여러 개 찍어낸 기사(예: 해외 증권사 목표가 기사)가 큰 화제로 잡히지 않게
const srcKey = (it) => String(it.source || it.org || "").trim() || String(it.url || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
const latin = (w) => /^[A-Za-z0-9]+$/.test(w);
export function topicDf(items) {
  const df = new Map();
  items.forEach((it) => { const k = srcKey(it); for (const w of topicWords(it.title)) { const set = df.get(w) || new Set(); set.add(k); df.set(w, set); } });
  return new Map([...df].map(([w, set]) => [w, set.size]));
}
export function hotScores(items) {
  const df = topicDf(items);
  return items.map((it) => {
    let s = topicWords(it.title).reduce((a, w) => a + Math.max(0, (df.get(w) || 0) - 1) * (latin(w) ? 0.5 : 1), 0);
    s += BIG.filter((w) => it.title.replace(/증권시장안정펀드|증안펀드/g, "증시안정펀드").includes(w)).length * 3;
    if (CORE_ORG.some((o) => String(it.source || it.org || "").includes(o))) s += 2;
    return s;
  });
}
// 같은 중심 낱말의 기사는 하나만: 이미 고른 기사와 중심 낱말이 같거나, 화제 낱말이 2개 이상 겹치면 같은 이야기로 보고 건너뛴다
export function centralWord(it, df) {
  return topicWords(it.title).filter((w) => !latin(w) || w.length >= 3).sort((a, b) => (df.get(b) || 0) - (df.get(a) || 0) || b.length - a.length)[0] || "";
}
export function sameStory(a, b, df) {
  const A = new Set(topicWords(a.title)), shared = topicWords(b.title).filter((w) => A.has(w) && (df.get(w) || 0) >= 2);
  return centralWord(a, df) === centralWord(b, df) || shared.length >= 2;
}
// 화제 점수가 높은 순(같으면 원래 순서). corpus는 점수를 셀 때 같이 볼 기사들(언론+보도자료 전체)
export function byHot(items, corpus = items) {
  const all = [...items, ...corpus.filter((c) => !items.includes(c))];
  const sc = hotScores(all);
  return items.map((it, i) => ({ it, i, s: sc[i] })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.it);
}

// ── 화제성 검수: 기사를 '이야기'로 묶고, 그 이야기를 다룬 언론사·부처 수로 순위를 매긴다 ──
// 1) 같은 이야기(sameStory)끼리 묶음 2) 점수 = 다룬 곳 수 × 3 + 시장 낱말·핵심 부처 + 최근(6시간 안) − 기계식 기사(목표가·특징주·시황 표 등)
// 3) 한 곳만 다룬 이야기는 두 곳 이상 다룬 이야기 뒤로 4) 대표 기사는 공식 기관·주요 언론·최신 순으로 고른다
const JUNK = /목표가|목표주가|투자의견|\[특징주\]|특징주|\[마감시황\]|\[표\]|\[게시판\]|\[인사\]|\[부고\]|\[포토\]|\[e공시\]|\[공시\]|fnRASSI|\[이 시각|\[오늘의|운세|날씨|\[광고\]|\[AD\]/;
export function isJunk(it) {
  const t = String(it.title || "");
  const hangul = (t.match(/[가-힣]/g) || []).length, latinCh = (t.match(/[A-Za-z]/g) || []).length;
  return JUNK.test(t) || latinCh > hangul; // 영어가 더 많은 제목(해외 증권사 목표가 기사 등)도 기계식으로 본다
}
export function stories(items, { trust = () => 1, now = Date.now() } = {}) {
  const df = topicDf(items), hot = hotScores(items);
  const order = items.map((it, i) => ({ it, h: hot[i] })).sort((a, b) => b.h - a.h);
  const S = [];
  for (const { it, h } of order) {
    const st = S.find((x) => sameStory(x.rep0, it, df));
    if (st) { st.items.push(it); st.h = Math.max(st.h, h); } else S.push({ rep0: it, items: [it], h });
  }
  for (const st of S) {
    const outlets = new Set(st.items.map(srcKey));
    const newest = Math.max(...st.items.map((x) => Date.parse(x.at) || 0));
    const junk = st.items.every(isJunk);
    st.outlets = outlets.size;
    st.score = outlets.size * 3 + Math.min(st.h, 12) + (now - newest < 6 * 3600e3 ? 2 : 0) - (junk ? 20 : 0);
    // 대표 기사: 기계식이 아닌 것 → 출처 등급(공식 0·주요 언론 1·그 밖 2) → 최신
    st.rep = [...st.items].sort((a, b) => isJunk(a) - isJunk(b) || trust(a) - trust(b) || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
  }
  return S.sort((a, b) => (b.outlets >= 2) - (a.outlets >= 2) || b.score - a.score);
}
