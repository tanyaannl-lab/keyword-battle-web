/* Read the business inputs from the existing MC weekly results project. */
(() => {
  'use strict';
  const dayMs = 86400000;
  const finiteOrNull = value => value === null || Number.isFinite(value);
  const countOrNull = value => value === null || Number.isSafeInteger(value) && value >= 0;
  const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;

  function validateDay(payload, day) {
    if (payload?.date !== day || !Array.isArray(payload.rows)) throw Error('经营明细日期或格式有误。');
    const seen = new Set();
    for (const row of payload.rows) {
      const scope = row?.level;
      const validScope = (scope === 'store' && row.operator === null && row.product === null) ||
        (scope === 'operator' && label(row.operator) && row.product === null) ||
        (scope === 'product' && label(row.operator) && label(row.product));
      const key = JSON.stringify([scope,row?.operator,row?.product]);
      if (!validScope || row.date !== day || seen.has(key) || !countOrNull(row.orders) ||
          !countOrNull(row.organicOrders) || (row.sales !== undefined && !finiteOrNull(row.sales)) || !finiteOrNull(row.netProfit) ||
          !finiteOrNull(row.orderSales) || !finiteOrNull(row.profitRate)) throw Error('经营明细有重复或无效的数值。');
      seen.add(key);
    }
    if (!seen.has(JSON.stringify(['store',null,null]))) throw Error('缺少店铺经营明细。');
    return payload.rows;
  }

  async function readWeek(week, rpc, signal, onProgress) {
    const start = Date.parse(week + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(start) ||
        new Date(start).getUTCDay() !== 1 || new Date(start).toISOString().slice(0,10) !== week) {
      throw Error('经营明细需要有效的美西周起始日期。');
    }
    const dates = Array.from({length:7}, (_,i) => new Date(start+i*dayMs).toISOString().slice(0,10));
    const byDay = new Map(), failed = new Set();
    let next = 0;
    function snapshot() {
      const finished = byDay.size + failed.size === dates.length;
      const status = !finished ? 'loading' : !failed.size ? 'ready' : byDay.size ? 'partial' : 'error';
      return {source:'MC-weekly-results',store:'MC US',week,status,loadedDays:byDay.size,
        failedDates:dates.filter(date => failed.has(date)),rows:dates.flatMap(date => byDay.get(date) || [])};
    }
    async function worker() {
      while (next < dates.length) {
        signal?.throwIfAborted();
        const day = dates[next++];
        try {
          const data = await rpc('mc_ads_dashboard_business_day', {p_day:day},signal);
          signal?.throwIfAborted();
          byDay.set(day,validateDay(data,day));
        } catch (error) {
          signal?.throwIfAborted();
          failed.add(day);
        }
        if (onProgress) onProgress(snapshot());
      }
    }
    await Promise.all([worker(),worker()]);
    signal?.throwIfAborted();
    return snapshot();
  }
  window.MCAdsBusiness = Object.freeze({readWeek});
})();
