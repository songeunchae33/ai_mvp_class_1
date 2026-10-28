// 로그인(구글)·기기 연결에 쓰는 Firebase 연결 정보.
// 이 값들은 원래 화면 코드에서 쓰도록 만든 공개용 값이고, 기록을 지키는 건 Firestore 보안 규칙이다.
// 그래도 저장소(GitHub)에는 적지 않고 Vercel 설정에만 두려고 여기서 내려준다.
// GET /api/config → { available, firebase: { apiKey, authDomain, projectId, appId } }
import { cache } from "./_util.js";

export default function handler(req, res) {
  const { FIREBASE_API_KEY: apiKey, FIREBASE_AUTH_DOMAIN: authDomain, FIREBASE_PROJECT_ID: projectId, FIREBASE_APP_ID: appId } = process.env;
  if (!apiKey || !authDomain || !projectId || !appId) return res.status(200).json({ available: false });
  cache(res, 3600);
  res.status(200).json({ available: true, firebase: { apiKey, authDomain, projectId, appId } });
}
