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

function field(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? clean(m[1]) : "";
}

// 최근 days일 보도자료 (API는 한 번에 최대 3일 범위라 나눠서 부른다)
export async function pressReleases(days = 3) {
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
      if (/[34]/.test(field(b, "KoglType"))) continue;
      seen.add(title);
      items.push({
        title, sub: field(b, "SubTitle1"), body: field(b, "DataContents").slice(0, 500),
        org: field(b, "MinisterCode"), url: field(b, "OriginalUrl"), at: field(b, "ApproveDate"),
      });
    }
  }
  return items;
}

export function isEcon(p) {
  const text = `${p.title} ${p.sub}`;
  return ECON_ORGS.some((o) => p.org.includes(o)) || ECON_WORDS.some((w) => text.includes(w));
}
