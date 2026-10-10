// 은행 정기예금 12개월 금리 상위 상품 (금융감독원 '금융상품 한눈에' 오픈 API, 무료)
// GET /api/rates → { available, items: [{ bank, product, base, max }] }
import { fetchJson, num, cache } from "./_util.js";

export default async function handler(req, res) {
  const key = process.env.FINLIFE_KEY;
  if (!key) return res.status(200).json({ available: false, items: [] });

  try {
    const json = await fetchJson(
      `https://finlife.fss.or.kr/finlifeapi/depositProductsSearch.json?auth=${key}&topFinGrpNo=020000&pageNo=1`
    );
    const base = json?.result?.baseList || [];
    const options = json?.result?.optionList || [];
    const byCode = new Map(base.map((b) => [b.fin_prdt_cd + b.fin_co_no, b]));
    const items = options
      .filter((o) => o.save_trm === "12" && num(o.intr_rate) !== null)
      .map((o) => {
        const b = byCode.get(o.fin_prdt_cd + o.fin_co_no) || {};
        return { bank: b.kor_co_nm, product: b.fin_prdt_nm, base: num(o.intr_rate), max: num(o.intr_rate2) };
      })
      .filter((i) => i.bank)
      .sort((a, b) => b.base - a.base)
      .slice(0, 3);
    cache(res, 21600);
    res.status(200).json({ available: true, items });
  } catch (e) {
    console.error(e);
    res.status(200).json({ available: false, items: [], error: "금리 정보를 불러오지 못했어요" });
  }
}
