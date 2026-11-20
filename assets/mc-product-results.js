'use strict';

(() => {
  const asin = /^[A-Z0-9]{10}$/;
  const validAmount = value => value === null ||
    ((typeof value === 'number' || (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value))) &&
      Number.isFinite(Number(value)) && Math.abs(Number(value)) <= Number.MAX_SAFE_INTEGER);
  const validCount = value => value === null || (Number.isSafeInteger(value) && value >= 0);

  function validPeriodRows(rows, dates, validRow) {
    return Array.isArray(rows) && rows.length === dates.size &&
      new Set(rows.map(row => row?.report_date)).size === dates.size &&
      rows.every(row => dates.has(row?.report_date) && validRow(row));
  }

  async function readScopedDays({rpc, skuMetricKeys, skuSources, signal, group, expected}) {
    const dates = [...expected].sort();
    const validMetrics = row => row && skuMetricKeys.every(key => validAmount(row[key])) &&
      Number.isSafeInteger(row.conflict_count) && row.conflict_count >= 0;
    const parts = [];
    for (let i = 0; i < dates.length; i += 7) parts.push(dates.slice(i, i + 7));
    async function read(part) {
      const span = new Set(part);
      const data = await rpc('mc_owner_product_detail', {
        p_start_date:part[0], p_end_date:part[part.length - 1], p_owner:group.owner,
        p_kind:group.kind === 'owner' ? null : group.kind, p_key:group.key ?? null,
        p_operator:group.operator || null, p_search:group.search || null,
      }, signal);
      if (!data || typeof data.in_scope !== 'boolean' || typeof data.whole_parent !== 'boolean' ||
          !Array.isArray(data.parents) || !data.parents.every(key => typeof key === 'string' && asin.test(key)) ||
          (data.whole_parent && (!data.in_scope || data.parents.length !== 1 || data.parent_asin !== data.parents[0])) ||
          !validMetrics(data.totals) || !validPeriodRows(data.days, span, row => validMetrics(row) &&
            skuSources.every(source => ['ready','missing'].includes(row.coverage?.[source])))) {
        throw new Error('经营明细返回格式有误。');
      }
      if (!validPeriodRows(data.fba_rows, span, row => validCount(row.return_units) && validCount(row.shipped_units))) {
        data.fba_rows = [];
      }
      return data;
    }
    if (parts.length === 1) return read(parts[0]);
    const blocks = [];
    for (let i = 0; i < parts.length; i += 2) {
      if (signal.aborted) throw new Error('查询已取消。');
      blocks.push(...await Promise.all(parts.slice(i, i + 2).map(read)));
    }
    const parents = [...new Set(blocks.flatMap(block => block.parents))].sort();
    const skus = [...new Set(blocks.flatMap(block => block.skus ?? []))].sort();
    const inScope = parents.length > 0;
    const days = [], fbaRows = [];
    for (const block of blocks) {
      const inactive = new Set();
      for (const row of block.days) {
        // A group first created or renamed later contributes zero on known,
        // out-of-scope catalog days, even if a report on such a day is absent.
        if (inScope && !block.in_scope && row.catalog_ready === true) {
          const empty = Object.fromEntries(skuMetricKeys.map(key => [key, 0]));
          days.push({...row, ...empty, profit_issues:[]});
          inactive.add(row.report_date);
        } else days.push(row);
      }
      for (const row of block.fba_rows) {
        fbaRows.push(inactive.has(row.report_date) ? {...row,
          return_units:row.return_report === true ? 0 : null,
          shipped_units:row.shipment_report === true ? 0 : null} : row);
      }
    }
    const totals = {conflict_count:days.reduce((sum, row) => sum + row.conflict_count, 0)};
    for (const key of skuMetricKeys) {
      totals[key] = days.every(row => row[key] !== null)
        ? days.reduce((sum, row) => sum + Number(row[key]), 0) : null;
    }
    return {parents, skus, in_scope:inScope, parent_asin:parents.length === 1 ? parents[0] : null,
      whole_parent:parents.length === 1 && blocks.every(block => block.whole_parent), days, totals, fba_rows:fbaRows};
  }

  function eligibleAdDays(payload, groupKind) {
    const skuOnly = groupKind !== 'owner';
    const scope = {mode:skuOnly ? 'sku' : 'parents',complete:true,byDate:{}};
    const byParent = new Map();
    const allowed = new Set(payload.parents);
    const validList = values => Array.isArray(values) && values.every(value => allowed.has(value));
    for (const day of payload.days) {
      let known = false, parents = [], selectedParents = [];
      if (validList(day.selected_parents) && validList(day.ad_fee_parents) &&
          day.ad_fee_parents.every(parent => day.selected_parents.includes(parent))) {
        known = day.catalog_ready !== false;
        selectedParents = [...new Set(day.selected_parents)];
        if (known && !skuOnly) parents = [...new Set(day.ad_fee_parents)];
      } else if (day.selected_parents === undefined && day.ad_fee_parents === undefined &&
                 day.catalog_ready !== false && payload.whole_parent) {
        // An older reader can certify one whole parent for the entire requested interval.
        known = true;
        selectedParents = [payload.parent_asin];
        if (!skuOnly) parents = [payload.parent_asin];
      }
      const complete = skuOnly || (known && selectedParents.length === parents.length);
      const reportDate = day.report_date;
      scope.byDate[reportDate] = {known,complete,selectedParents,parents,readError:false};
      if (!complete) scope.complete = false;
      for (const parent of parents) {
        if (!byParent.has(parent)) byParent.set(parent,new Set());
        byParent.get(parent).add(reportDate);
      }
    }
    return {scope,byParent};
  }

  async function readParentAds(plan, signal, {optionalOtherAds,blankOtherAds,shiftDay}) {
    const {scope,byParent} = plan;
    const ads = blankOtherAds();
    const statuses = new Map(), conflictingWeeks = new Set();
    const tasks = [...byParent.entries()];
    let next = 0;
    async function worker() {
      while (next < tasks.length && !signal.aborted) {
        const [parent, dates] = tasks[next++];
        const ordered = [...dates].sort();
        let part;
        try {
          part = await optionalOtherAds(ordered[0],ordered[ordered.length-1],parent,signal);
        } catch {
          // One failed parent must not discard other parents or the already-loaded SKU facts.
        }
        if (signal.aborted) return;
        if (!part || part.error) {
          for (const date of dates) scope.byDate[date].readError = true;
          ads.error = true;
          continue;
        }
        // The RPC validates a single daily row per parent/channel. Keep it only on eligible days.
        for (const row of part.rows) {
          if (dates.has(row.report_date)) ads.rows.push(row);
        }
        // File status is store-wide for a week and channel; it carries no spend quantity.
        for (const entry of part.coverage) {
          const end = shiftDay(entry.week_start,6);
          if (!ordered.some(date => date >= entry.week_start && date <= end)) continue;
          const key = entry.week_start + '/' + entry.channel;
          if (statuses.has(key) && statuses.get(key).status !== entry.status) conflictingWeeks.add(entry.week_start);
          else statuses.set(key,entry);
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(2,tasks.length)},worker));
    for (const week of conflictingWeeks) {
      const end = shiftDay(week,6);
      ads.error = true;
      for (const [date,day] of Object.entries(scope.byDate)) {
        if (day.parents.length && date >= week && date <= end) day.readError = true;
      }
    }
    ads.coverage = [...statuses.values()];
    ads.pending = ads.coverage.filter(entry => !['mapped','empty'].includes(entry.status));
    return ads;
  }

  async function period({group, from, to, lastClosed, daily, weekStart, signal}, readers) {
    const {rpc, blankOtherAds, readDailyFees, readSkuWeeklyNotes,
      shiftDay, skuMetricKeys, skuSources} = readers;
    const closed = to < lastClosed ? to : lastClosed;
    const dates = [];
    for (let date = to; date >= from; date = shiftDay(date, -1)) dates.push(date);
    const expected = new Set(dates.filter(date => date <= closed));
    const missing = Object.fromEntries(skuSources.map(source => [source, 'missing']));
    const sku = {days:dates.map(report_date => ({report_date, coverage:missing})), totals:null,
      error:'', unfinished:closed < to, productGroup:true, ownerPartial:true, ownerInScope:null,
      parentAdScope:{mode:group.kind === 'owner' ? 'parents' : 'sku',complete:false,byDate:{}}};
    const result = {sku, otherAds:blankOtherAds(), returns:{rows:[], error:false},
      dailyFees:daily ? {rows:[], error:false} : null, rows:[], search:{state:'idle'},
      groupContext:{wholeParent:false, parentAsin:null, parents:[], skus:[]}};
    if (!expected.size) return result;

    try {
      const payload = await readScopedDays({rpc, skuMetricKeys, skuSources, signal, group, expected});
      const byDate = new Map(payload.days.map(row => [row.report_date, row]));
      sku.days = sku.days.map(row => byDate.get(row.report_date) ?? row);
      sku.totals = sku.unfinished ? null : payload.totals;
      sku.ownerInScope = payload.in_scope;
      sku.ownerPartial = !payload.whole_parent;
      result.returns = validPeriodRows(payload.fba_rows, expected, row =>
        validCount(row.return_units) && validCount(row.shipped_units))
        ? {rows:payload.fba_rows, error:false} : {rows:[], error:true};
      result.groupContext = {wholeParent:payload.whole_parent, parentAsin:payload.parent_asin, parents:payload.parents,
        skus:Array.isArray(payload.skus) ? payload.skus.filter(sku => typeof sku === 'string') : []};
      const plan = eligibleAdDays(payload,group.kind);
      sku.parentAdScope = plan.scope;
      const feeParent = payload.whole_parent ? payload.parent_asin : null;
      [result.otherAds,result.dailyFees,result.rows] = await Promise.all([
        readParentAds(plan,signal,readers),
        daily && feeParent ? readDailyFees(from,closed,feeParent,signal) : result.dailyFees,
        !daily && feeParent ? readSkuWeeklyNotes(weekStart,feeParent,signal) : [],
      ]);
    } catch (error) {
      sku.error = error.status === 404 || error.code === 'PGRST202'
        ? '负责人和产品明细接口尚未安装。' : '暂时无法读取负责人和产品明细，请重试。';
      result.returns.error = true;
    }
    return result;
  }

  window.MCProductResults = Object.freeze({period});
})();
