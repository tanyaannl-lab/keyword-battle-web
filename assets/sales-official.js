(function (root) {
  'use strict';
  const ASIN = /^[A-Z0-9]{10}$/;
  const startDate = '2026-09-14';
  const shift = (date, offset) => new Date(Date.parse(date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const groupKey = (asin, type) => (type === 'parent' ? 'parent:' : 'child:') + asin;
  const amount = cents => (BigInt(cents) / 100n).toString() + '.' + (BigInt(cents) % 100n).toString().padStart(2, '0');
  

  function validate(day, first, last) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
        day.date < first || day.date > last || !day.generated_at || !Number.isFinite(Date.parse(day.generated_at)) ||
        !validCount(day.totals?.sales_cents) || !validCount(day.totals?.units) || !Array.isArray(day.rows))
      throw new Error('业务日报日期、金额或件数不完整。');
    const seen = new Set();
    for (const row of day.rows) {
      if (!Array.isArray(row) || row.length !== 4 || !ASIN.test(row[0]) || seen.has(row[0]) ||
          (row[1] !== null && !ASIN.test(row[1])) || !validCount(row[2]) || !validCount(row[3]))
        throw new Error('业务日报的子 ASIN 明细不完整。');
      seen.add(row[0]);
    }
  }

  // Preserve source decimal precision before subtraction. Old snapshots can
  // contain unclassified amounts; those cannot be called confirmed order sales.
  function orderRow(row, today) {
    if (row.date !== today) return {...row, sales_basis: row.date < startDate ? 'legacy' : 'pending'};
    const full = /^(\d+)(?:\.(\d+))?$/.exec(String(row.sales_amount));
    const estimated = row.estimated_sales_amount ?? (row.estimated_rows != null && Number(row.estimated_rows) === 0 ? '0' : null);
    const est = /^(\d+)(?:\.(\d+))?$/.exec(String(estimated));
    let confirmed = null;
    if (full && est && row.currency === 'USD' && row.estimated_rows != null &&
        row.legacy_unknown_price_rows != null && Number(row.legacy_unknown_price_rows) === 0) {
      const scale = Math.max(2, full[2]?.length || 0, est[2]?.length || 0);
      const unscaled = match => BigInt(match[1] + (match[2] || '').padEnd(scale, '0'));
      const value = unscaled(full) - unscaled(est);
      if (value >= 0n) {
        const divisor = 10n ** BigInt(scale - 2);
        confirmed = amount((value + divisor / 2n) / divisor);
      }
    }
    return {...row, sales_basis:'confirmed', sales_amount:confirmed,
      estimated_sales_amount: row.currency === 'USD' ? estimated : null};
  }

  function byDate(rows) {
    const result = new Map();
    for (const row of rows || []) {
      if (!result.has(row.date)) result.set(row.date, []);
      result.get(row.date).push(row);
    }
    return result;
  }
  function fields(units, cents) {
    return {units, sales_amount:amount(cents), currency:'USD', estimated_rows:0, missing_price_rows:0,
      legacy_unknown_price_rows:0, estimated_sales_amount:'0.00', sales_basis:'official'};
  }

  function apply(snapshot, reports, today, isRange) {
    const model = root.KBSalesModel;
    if (!model.reportTimezoneMatches(snapshot)) return snapshot;
    const base = snapshot.payload;
    const period = base.period;
    const rawSummaries = new Map((base.sales_daily_summaries || []).map(row => [row.date,row]));
    const rawChildren = byDate(base.daily_rows), rawParents = byDate(base.parent_daily_rows);
    const oldParents = {};
    const membership = new Map();
    function member(parent, child) {
      if (parent && parent !== child) {
        if (!membership.has(parent)) membership.set(parent, new Set());
        membership.get(parent).add(child);
      }
    }
    for (const [parent, children] of Object.entries(base.parent_child_asins || {})) {
      for (const child of children) {
        if (Object.hasOwn(oldParents, child) && oldParents[child] !== parent) oldParents[child] = null;
        else oldParents[child] = parent;
        member(parent, child);
      }
    }

    const summaries = [], children = [], parents = [];
    const saleParentsByDate = {...base.sale_parent_by_date};
    const published = new Map(reports.map(day => [day.date,day]));
    const dayBasis = {}, nativeOrderDays = {}, soldChildren = new Set(), soldGroups = new Set();
    const counts = {official:0,confirmed:0,pending:0,legacy:0,unavailable:0};
    let lastOfficial = null;
    let unmatchedTotalsDays = 0;
    for (let date = period.start_date; date <= period.end_date; date = shift(date, 1)) {
      const native = rawSummaries.get(date);
      const report = published.get(date);
      const childRows = rawChildren.get(date) || [], parentRows = rawParents.get(date) || [];
      nativeOrderDays[date] = native?.orders_count != null;
      if (!report) {
        const summary = native && orderRow(native, today);
        if (summary) summaries.push(summary);
        if (childRows.length && !Object.hasOwn(saleParentsByDate,date)) {
          saleParentsByDate[date] = Object.fromEntries(childRows.map(row =>
            [row.asin,row.parent_asin || oldParents[row.asin] || null]));
        }
        for (const row of childRows) {
          children.push(orderRow(row, today));
          if (Number(row.units) > 0) soldChildren.add(row.asin);
        }
        for (const row of parentRows) {
          parents.push(orderRow(row, today));
          if (Number(row.units) > 0) soldGroups.add(groupKey(row.asin,row.group_type));
        }
        dayBasis[date] = summary?.sales_basis || 'unavailable';
        counts[dayBasis[date]]++;
        continue;
      }
      dayBasis[date] = 'official';
      counts.official++;
      if (!lastOfficial || report.generated_at > lastOfficial) lastOfficial=report.generated_at;
      const nativeByAsin = new Map(childRows.map(row=>[row.asin,row]));
      const old = new Map(nativeByAsin);
      const existingGroups = new Map(parentRows.map(row=>[groupKey(row.asin,row.group_type),row]));
      const previousMapping = base.sale_parent_by_date?.[date] || oldParents;
      const groups = new Map(), changedGroups = new Set(), datedParents = {};
      let sold = 0;
      function addChild(asin, parent, units, cents) {
        const original = old.get(asin);
        old.delete(asin);
        parent = parent === asin ? null : parent;
        datedParents[asin] = parent;
        if (parent) {
          member(parent,asin);
        }
        const child = {...original, ...fields(units,cents), date, asin, parent_asin:parent,
          orders_count:nativeOrderDays[date] ? (original ? original.orders_count ?? null : 0) : null};
        children.push(child);
        const key = groupKey(parent || asin, parent ? 'parent' : 'child');
        if (units > 0) { sold++; soldChildren.add(asin); soldGroups.add(key); }
        if (original?.orders_count > 0) {
          const was = original.parent_asin || previousMapping[asin] || null;
          if (was !== parent) {
            changedGroups.add(groupKey(was || asin, was ? 'parent' : 'child'));
            changedGroups.add(key);
          }
        }
        if (!groups.has(key)) groups.set(key, {asin:parent || asin, parent, image:asin, units:0, cents:0, n:0});
        const group = groups.get(key);
        group.units += units;
        group.cents += cents;
        group.n++;
        if (!validCount(group.cents) || !validCount(group.units)) throw new Error('父 ASIN 汇总超出金额或件数范围。');
      }
      let detailUnits = 0n, detailCents = 0n;
      for (const [asin,parent,units,cents] of report.rows) {
        detailUnits += BigInt(units);
        detailCents += BigInt(cents);
        addChild(asin,parent,units,cents);
      }
      if (detailUnits !== BigInt(report.totals.units) || detailCents !== BigInt(report.totals.sales_cents)) unmatchedTotalsDays++;
      // The authoritative complete report gives zero sales/units for absent
      // order ASINs. Preserve the separate order metric on those rows.
      for (const [asin,row] of old) addChild(asin,row.parent_asin || previousMapping[asin] || null,0,0);
      let soldParentCount = 0;
      for (const [key,g] of groups) {
        if (g.units > 0) soldParentCount++;
        const prior = existingGroups.get(key);
        const orderCount = !nativeOrderDays[date] || changedGroups.has(key) ? null :
          g.parent ? prior ? prior.orders_count ?? null :
            (base.parent_asin_available && parentRows.length ? 0 : null) :
            (nativeByAsin.get(g.asin)?.orders_count ?? 0);
        parents.push({...prior, ...fields(g.units,g.cents), date, asin:g.asin, parent_asin:g.parent,
          group_type:g.parent ? 'parent' : 'child', child_asins_count:g.parent ? g.n : null,
          image_asin:prior?.image_asin || g.image, orders_count:orderCount});
      }
      saleParentsByDate[date] = datedParents;
      summaries.push({...native, ...fields(report.totals.units,report.totals.sales_cents), date,
        orders_count:native?.orders_count ?? null, child_asins_count:sold, parent_asins_count:soldParentCount,
        official_generated_at:report.generated_at});
    }
    const hasParent = base.parent_asin_available === true || reports.length > 0;
    const payload = {...base, sales_daily_summaries:summaries, daily_rows:children, parent_daily_rows:parents,
      parent_children_available:hasParent, parent_asin_available:hasParent, sale_parent_by_date:saleParentsByDate,
      parent_child_asins:Object.fromEntries([...membership].map(([key,values])=>[key,[...values].sort()])),
      official_basis_counts:counts, sales_basis_by_date:dayBasis, native_order_dates:nativeOrderDays,
      latest_official_report_at:lastOfficial, official_totals_difference_days:unmatchedTotalsDays};
    if (isRange) {
      const dates = summaries.map(row=>row.date);
      const summary = model.sumSummaries(summaries);
      if (summary) Object.assign(summary, {child_asins_count:soldChildren.size,parent_asins_count:hasParent ? soldGroups.size : null});
      payload.range_summary = summary;
      payload.range_coverage = {days_with_records:dates.length,recorded_start_date:dates[0] || null,
        recorded_end_date:dates.at(-1) || null,recorded_dates:dates};
    }
    return {...snapshot, payload};
  }
  root.KBSalesOfficial = {apply, validate, startDate};
})(typeof window === 'undefined' ? globalThis : window);
