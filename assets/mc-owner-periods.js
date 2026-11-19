(() => {
  'use strict';
  const dayMs = 86400000;
  const batchSize = 7;
  const metrics = ['br_sales','br_orders','br_units','sessions','sp_cost','sp_orders','sp_sales','order_profit'];
  const coverageFields = ['active_days','br_days','sp_days','orders_days','transactions_days'];
  const statusFields = ['closed','catalog_ready','br','sp','orders','transactions'];
  const sorted = values => [...values].sort();
  const bad = () => new Error('负责人列表分段数据不完整，请重新加载。');

  function utcDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad();
    const time = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) throw bad();
    return time;
  }

  function selectedDays(ranges) {
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > 26) throw bad();
    const days = new Set();
    for (const range of ranges) {
      const start = utcDay(range?.start_date), end = utcDay(range?.end_date);
      const maxDays = ranges.length === 1 ? 92 : 7;
      if (end < start || end - start >= maxDays * dayMs) throw bad();
      for (let time=start; time<=end; time+=dayMs) days.add(new Date(time).toISOString().slice(0,10));
    }
    return sorted(days);
  }

  function batchRanges(days) {
    const ranges = [];
    for (const day of days) {
      const last = ranges[ranges.length-1];
      if (last && utcDay(day) - utcDay(last.end_date) === dayMs) last.end_date = day;
      else ranges.push({start_date:day, end_date:day});
    }
    return ranges;
  }

  function newGroup() {
    return {
      totals:Object.fromEntries(metrics.map(metric => [metric,0])),
      coverage:Object.fromEntries(coverageFields.map(field => [field,0])),
    };
  }

  function addAmount(a,b) {
    if (!a) return b;
    if (!b) return a;
    if (Number.isInteger(a) && Number.isInteger(b)) return a+b;
    const places = value => {
      const [coefficient,exponent='0'] = String(value).split('e');
      return (coefficient.split('.')[1]?.length ?? 0) - Number(exponent);
    };
    // Keep decimal subtotals such as 0.1 + 0.2 at their input precision.
    const precision = Math.max(0,places(a),places(b));
    return precision > 100 ? a+b : Number((a+b).toFixed(precision));
  }

  function addGroup(target, source) {
    for (const metric of metrics) {
      const n = source.totals?.[metric];
      if (n !== null && !Number.isFinite(n)) throw bad();
      if (n === null || target.totals[metric] === null) target.totals[metric] = null;
      else target.totals[metric] = addAmount(target.totals[metric],n);
    }
    for (const field of coverageFields) {
      const n = source.coverage?.[field];
      if (!Number.isSafeInteger(n) || n < 0) throw bad();
      target.coverage[field] += n;
    }
  }

  function addLabels(set, labels) {
    if (!Array.isArray(labels)) throw bad();
    for (const label of labels) {
      if (typeof label !== 'string' || !label) throw bad();
      set.add(label);
    }
  }

  function merge(parts, batches) {
    const owners = new Map(), operators = new Set(), days = [];
    let complete = true;
    parts.forEach((part,i) => {
      if (!part || !Array.isArray(part.owners) || !Array.isArray(part.days)) throw bad();
      const expected = new Set(batches[i]);
      for (const day of part.days) {
        if (!expected.delete(day?.report_date) || statusFields.some(field => typeof day[field] !== 'boolean')) throw bad();
        if (!day.closed || !day.catalog_ready) complete = false;
        days.push(day);
      }
      if (expected.size) throw bad();
      addLabels(operators,part.operators);
      const seenOwners = new Set();
      for (const row of part.owners) {
        if (typeof row?.owner !== 'string' || !row.owner || seenOwners.has(row.owner) || !Array.isArray(row.products)) throw bad();
        seenOwners.add(row.owner);
        if (!owners.has(row.owner)) owners.set(row.owner,{...newGroup(),owner:row.owner,products:new Map()});
        const target = owners.get(row.owner);
        addGroup(target,row);
        const seenProducts = new Set();
        for (const product of row.products) {
          if (!['short_name','sku'].includes(product?.kind) || typeof product.key !== 'string' || !product.key) throw bad();
          const id = JSON.stringify([product.kind,product.key]);
          if (seenProducts.has(id)) throw bad();
          seenProducts.add(id);
          if (!target.products.has(id)) target.products.set(id,{
            ...newGroup(),kind:product.kind,key:product.key,skus:new Set(),parent_asins:new Set(),operators:new Set(),
          });
          const child = target.products.get(id);
          addGroup(child,product);
          for (const field of ['skus','parent_asins','operators']) addLabels(child[field],product[field]);
        }
      }
    });

    const result = [];
    for (const key of sorted(owners.keys())) {
      const row = owners.get(key);
      const products = [...row.products.values()].sort((a,b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
      for (const product of products) {
        for (const field of ['skus','parent_asins','operators']) product[field] = sorted(product[field]);
      }
      if (!complete) {
        for (const group of [row,...products]) for (const metric of metrics) group.totals[metric] = null;
      }
      result.push({...row,products});
    }
    return {owners:result,operators:sorted(operators),days:days.sort((a,b) => a.report_date.localeCompare(b.report_date))};
  }

  async function list(ranges, request, signal) {
    const days = selectedDays(ranges);
    signal?.throwIfAborted();
    if (days.length <= batchSize) {
      const part = await request(ranges);
      signal?.throwIfAborted();
      return merge([part],[days]);
    }
    const batches = [];
    for (let i=0;i<days.length;i+=batchSize) batches.push(days.slice(i,i+batchSize));
    const parts = new Array(batches.length);
    let next = 0, stopped = false;
    async function worker() {
      try {
        while (!stopped && next < batches.length) {
          signal?.throwIfAborted();
          const i = next++;
          parts[i] = await request(batchRanges(batches[i]));
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
    await Promise.all([worker(),worker()]);
    signal?.throwIfAborted();
    return merge(parts,batches);
  }

  window.MCOwnerPeriods = Object.freeze({list});
})();
