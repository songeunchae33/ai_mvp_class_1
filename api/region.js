// 내 위치로 동네 찾기: 좌표 → 시·도, 시·군·구 이름 (네이버 클라우드 Maps Reverse Geocoding)
// GET /api/region?lat=37.556&lng=126.923 → { available, sido, sigungu }
// 좌표는 앱이 소수점 셋째 자리(약 100m)로 뭉개서 보내고, 여기서도 저장하거나 로그에 남기지 않는다.
import { fetchJson } from "./_util.js";

// 앱의 시·도 목록(index.html SIDO)과 이름을 맞춘다. 예전 이름으로 오면 지금 이름으로 바꾼다
const SIDO = ["서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시", "울산광역시", "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도", "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도"];
const OLD = { "강원도": "강원특별자치도", "전라북도": "전북특별자치도", "제주도": "제주특별자치도", "세종시": "세종특별자치시" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const id = process.env.NAVER_MAP_CLIENT_ID, secret = process.env.NAVER_MAP_CLIENT_SECRET;
  if (!id || !secret) return res.status(200).json({ available: false });

  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) {
    return res.status(200).json({ available: true, error: "한국 안의 위치만 찾을 수 있어요" });
  }

  try {
    const json = await fetchJson(
      `https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc?coords=${lng.toFixed(3)},${lat.toFixed(3)}&orders=admcode,legalcode&output=json`,
      { headers: { "x-ncp-apigw-api-key-id": id, "x-ncp-apigw-api-key": secret } }
    );
    const r = (json?.results || [])[0]?.region;
    const a1 = r?.area1?.name || "", a2 = r?.area2?.name || "";
    const sido = SIDO.includes(a1) ? a1 : OLD[a1] || SIDO.find((s) => s.startsWith(a1.slice(0, 2))) || "";
    if (!sido) return res.status(200).json({ available: true, error: "동네 이름을 찾지 못했어요" });
    res.status(200).json({ available: true, sido, sigungu: a2.slice(0, 10) });
  } catch (e) {
    console.error("region lookup failed", e.message); // 좌표는 남기지 않는다
    res.status(200).json({ available: true, error: "동네 이름을 찾지 못했어요" });
  }
}
