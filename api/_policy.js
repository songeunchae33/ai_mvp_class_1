// 정부 정책뉴스·보도자료 (공공데이터포털 '문화체육관광부_정책브리핑_정책뉴스_API', 무료·자동승인)
// 공공저작물이라 출처를 밝히면 자유롭게 이용·가공할 수 있어서(저작권법 제24조의2), AI 풀이와 화제 개념 집계에 쓴다.
// 네이버 검색 결과는 약관상 AI 요약에 쓸 수 없어서 여기로 옮겼다.
import { kstYmd, dataGoKey } from "./_util.js";

const BASE = "https://apis.data.go.kr/1371000/policyNewsService2/policyNewsList2";

// 경제와 관련 깊은 부처
export const ECON_ORGS = ["기획재정부", "금융위원회", "국토교통부", "산업통상자원부", "공정거래위원회", "고용노동부", "국세청", "통계청",
  "중소벤처기업부", "관세청", "농림축산식품부", "행정안전부", "보건복지부", "과학기술정보통신부", "해양수산부", "문화체육관광부"];
export const ECON_WORDS = ["금리", "물가", "수출", "수입", "부동산", "주택", "전세", "대출", "세금", "세제", "예산", "청년", "일자리", "고용",
  "투자", "금융", "환율", "관세", "소비", "지원금", "경제", "성장", "반도체", "할인", "소상공인", "연금", "저축"];

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
