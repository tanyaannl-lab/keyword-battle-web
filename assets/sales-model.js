(function (root) {
  'use strict';

  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const count = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

  function beijingDate(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const read = type => parts.find(part => part.type === type).value;
    return `${read('year')}-${read('month')}-${read('day')}`;
  }

  function previousDate(date) {
    if (!DATE_PATTERN.test(String(date))) return null;
    return new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  }

  function imageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value);
      const amazonImageHost = new Set(['m.media-amazon.com', 'images.amazon.com', 'ecx.images-amazon.com',
        'images-na.ssl-images-amazon.com', 'images-eu.ssl-images-amazon.com', 'images-fe.ssl-images-amazon.com']).has(url.hostname);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !amazonImageHost) return null;
      return url.href;
    } catch (_) { return null; }
  }

  function priceFlags(row) {
    if (!row) return [];
    const flags = [];
    if (count(row.estimated_rows) > 0) flags.push({ type: 'estimate', label: '含估算', text: '缺价商品按自家售价 × 订购数量估算，取得订单实际金额后替换。' });
    if (count(row.missing_price_rows) > 0) flags.push({ type: 'missing', label: '有缺价', text: `${row.missing_price_rows} 条商品明细尚无价格，当前销售额未包含这部分金额。` });
    if (count(row.legacy_unknown_price_rows) > 0) flags.push({ type: 'unknown', label: '待核价', text: '部分历史商品金额的来源尚待核实。' });
    if ([row.estimated_rows, row.missing_price_rows, row.legacy_unknown_price_rows].some(value => value === null || value === undefined)) {
      flags.push({ type: 'unknown', label: '口径待核实', text: '本次发布未提供完整的估算与缺价说明。' });
    }
    return flags;
  }

  function dimensionRows(snapshot, dimension = 'child') {
    const data = snapshot?.payload || {};
    if (dimension === 'parent') {
      const available = data.parent_asin_available === true && Array.isArray(data.parent_daily_rows) && Array.isArray(data.parent_ranking);
      return { available, daily: available ? data.parent_daily_rows : [], ranking: available ? data.parent_ranking : [] };
    }
    return { available: Array.isArray(data.daily_rows), daily: Array.isArray(data.daily_rows) ? data.daily_rows : [], ranking: Array.isArray(data.ranking) ? data.ranking : [] };
  }

  function todayComparison(snapshot, now = new Date(), dimension = 'child') {
    const data = snapshot?.payload || {};
    const today = beijingDate(now);
    const yesterday = previousDate(today);
    const publishedDay = snapshot?.generated_at ? beijingDate(snapshot.generated_at) : null;
    const source = dimensionRows(snapshot, dimension);
    const rowsAvailable = source.available;
    const available = date => rowsAvailable && DATE_PATTERN.test(String(data.period?.start_date)) &&
      DATE_PATTERN.test(String(data.period?.end_date)) && data.period.start_date <= date &&
      date <= data.period.end_date && !!publishedDay && date <= publishedDay;
    const todayAvailable = available(today);
    const yesterdayAvailable = available(yesterday);
    const index = new Map();
    const zero = () => ({ units: 0, orders_count: 0, sales_amount: '0', currency: 'USD', estimated_rows: 0, missing_price_rows: 0, legacy_unknown_price_rows: 0 });
    for (const row of source.daily) {
      if (!row || typeof row.asin !== 'string' || !row.asin.trim()) continue;
      if (row.date !== today && row.date !== yesterday) continue;
      if (!available(row.date)) continue;
      const asin = row.asin.trim().toUpperCase();
      const key = dimension === 'parent' ? `${row.group_type === 'parent' ? 'parent' : 'child'}:${asin}` : asin;
      if (!index.has(key)) index.set(key, { asin, group_type: row.group_type, parent_asin: row.parent_asin,
        image_asin: row.image_asin || asin, child_asins_count: row.child_asins_count,
        today: todayAvailable ? zero() : null, yesterday: yesterdayAvailable ? zero() : null });
      const entry = index.get(key);
      entry[row.date === today ? 'today' : 'yesterday'] = row;
      // Prefer today's representative image and variant count when both dates have data.
      if (row.date === today) {
        entry.image_asin = row.image_asin || asin;
        entry.child_asins_count = row.child_asins_count;
      }
    }
    const rows = [...index.values()].sort((a, b) => (count(b.today?.units) || 0) - (count(a.today?.units) || 0) || a.asin.localeCompare(b.asin));
    return { today, yesterday, todayAvailable, yesterdayAvailable, rows };
  }

  const model = { beijingDate, previousDate, imageUrl, priceFlags, dimensionRows, todayComparison };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.KBSalesModel = model;
})(typeof window === 'undefined' ? globalThis : window);
