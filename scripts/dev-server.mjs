// 내 컴퓨터에서 확인용 서버 (Vercel 흉내): 화면 파일과 /api/* 를 같이 띄운다.
// 사용법: node scripts/dev-server.mjs  →  http://localhost:3123
// 키는 .env 없이 환경변수로만 읽는다. 키가 없으면 각 API가 예시 데이터로 동작한다.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[3] || 3123);
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    const file = path.join(root, "api", url.pathname.slice(5) + ".js");
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    let body = "";
    for await (const c of req) body += c;
    req.query = Object.fromEntries(url.searchParams);
    try { req.body = body ? JSON.parse(body) : undefined; } catch { req.body = undefined; }
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); };
    const mod = await import(pathToFileURL(file).href + "?t=" + Date.now());
    return mod.default(req, res);
  }
  const file = path.join(root, url.pathname === "/" ? "index.html" : url.pathname);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log("listening on " + port));
