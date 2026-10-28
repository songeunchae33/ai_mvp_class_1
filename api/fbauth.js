// 구글 로그인 중계: 로그인 창(/__/auth/...)을 우리 주소(aimvpclass1.vercel.app)에서 열리게 Firebase 쪽 파일을 그대로 전달한다.
// 휴대폰 브라우저는 다른 주소(firebaseapp.com)에서 로그인 결과를 돌려받는 걸 막아서, 같은 주소로 맞추는 Firebase 권장 방식이다.
// vercel.json 이 /__/auth/* 요청을 여기로 보낸다.
export default async function handler(req, res) {
  const host = process.env.FIREBASE_AUTH_DOMAIN;
  if (!host) return res.status(404).end();
  const path = String(req.query.path || "").replace(/[^a-zA-Z0-9._\-/]/g, "");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (k !== "path") [].concat(v).forEach((x) => qs.append(k, x));
  try {
    const r = await fetch(`https://${host}/__/auth/${path}${qs.toString() ? "?" + qs : ""}`, {
      headers: { "user-agent": String(req.headers["user-agent"] || ""), accept: String(req.headers.accept || "*/*") },
    });
    for (const h of ["content-type", "cache-control"]) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
    res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
}
