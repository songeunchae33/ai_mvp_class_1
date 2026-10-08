// 네이버 지역검색 API 프록시: 특정 지역의 가챠샵 목록을 좌표와 함께 돌려준다.
// 검색 API는 한 번에 최대 5개만 주므로 검색어 여러 개로 나눠 부르고 중복을 제거한다.

const QUERIES = ["가챠샵", "가챠", "캡슐토이"];

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
}

async function searchLocal(query, id, secret) {
  const url =
    "https://openapi.naver.com/v1/search/local.json?display=5&sort=random&query=" +
    encodeURIComponent(query);
  const r = await fetch(url, {
    headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
  });
  if (!r.ok) throw new Error("naver search " + r.status);
  const data = await r.json();
  return data.items || [];
}

export default async function handler(req, res) {
  const id = process.env.NAVER_SEARCH_ID;
  const secret = process.env.NAVER_SEARCH_SECRET;
  if (!id || !secret) {
    return res.status(500).json({ error: "NAVER_SEARCH_ID / NAVER_SEARCH_SECRET 환경변수가 없어요" });
  }

  const area = String(req.query.area || "").trim().slice(0, 20);
  if (!area) return res.status(400).json({ error: "area 파라미터가 필요해요" });

  try {
    const results = await Promise.all(
      QUERIES.map((q) => searchLocal(area + " " + q, id, secret))
    );
    const seen = new Set();
    const shops = [];
    results.flat().forEach((item) => {
      const name = stripTags(item.title);
      const key = name + "|" + item.roadAddress;
      if (seen.has(key)) return;
      seen.add(key);
      // mapx/mapy는 WGS84 경위도에 10^7을 곱한 정수
      const lng = Number(item.mapx) / 1e7;
      const lat = Number(item.mapy) / 1e7;
      if (!lat || !lng) return;
      shops.push({
        name,
        category: item.category,
        address: item.roadAddress || item.address,
        lat,
        lng,
        link: item.link || "",
      });
    });

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ area, shops });
  } catch (e) {
    return res.status(502).json({ error: "가챠샵 검색에 실패했어요", detail: e.message });
  }
}
