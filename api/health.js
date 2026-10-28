// 키 연결 점검: 어떤 키가 '있는지'만 알려준다 (값은 절대 보여주지 않음)
// GET /api/health
const KEYS = ["DATA_GO_KR_KEY", "KOREAEXIM_KEY", "NAVER_HUB_ID", "NAVER_HUB_SECRET", "NAVER_SEARCH_ID", "NAVER_SEARCH_SECRET", "OPENAI_API_KEY", "FINLIFE_KEY",
  "FIREBASE_API_KEY", "FIREBASE_AUTH_DOMAIN", "FIREBASE_PROJECT_ID", "FIREBASE_APP_ID"];

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const present = Object.fromEntries(KEYS.map((k) => [k, !!process.env[k]]));
  // 이름이 비슷하게 들어간 키가 있으면 이름만 보여줘서 오타를 찾기 쉽게
  const similar = Object.keys(process.env).filter((k) => !KEYS.includes(k) && /DATA|GO_KR|EXIM|NAVER|FINLIFE|OPENAI|FIREBASE/i.test(k) && !/^VERCEL|^NOW_|^AWS/.test(k));
  res.status(200).json({ present, similar, deployedAt: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null });
}
