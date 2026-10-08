// 프론트에서 써도 되는 공개 키만 내려준다. (네이버 지도 JS API Client ID는 도메인 제한이 걸린 공개 키)
export default function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300");
  res.status(200).json({
    naverMapKeyId: process.env.NAVER_MAP_CLIENT_ID || "",
  });
}
