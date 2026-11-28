(function () {
  const cfg = window.KB_CONFIG;
  if (!cfg) throw new Error('KB_CONFIG 未加载');

  async function getOrderSnapshot(auth) {
    const token = auth?.session?.access_token;
    if (!token) throw new Error('登录状态已失效，请重新登录。');

    const base = cfg.SUPABASE_URL.replace(/\/$/, '');
    const url = new URL(`${base}/rest/v1/sales_dashboard_snapshots`);
    url.searchParams.set('select', 'payload,generated_at');
    url.searchParams.set('scope', 'eq.us_market');
    url.searchParams.set('limit', '1');

    const response = await fetch(url.toString(), {
      method: 'GET',
      cache: 'no-store',
      headers: {
        apikey: cfg.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch (_) {}
      const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('销量数据格式异常。');
    return rows[0] || null;
  }

  const ASIN = /^[A-Z0-9]{10}$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  function validDay(day) {
    if (typeof day !== 'string' || !DATE.test(day)) return false;
    const date = new Date(day + 'T00:00:00Z');
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day;
  }

  function shiftDay(day, n) {
    const date = new Date(day + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + n);
    return date.toISOString().slice(0, 10);
  }

  async function rangeRpc(auth, name, args, signal) {
    const token = auth?.session?.access_token;
    if (!token) throw new Error('登录已过期，请重新登录。');
    const base = cfg.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(base + '/rest/v1/rpc/' + name, {method:'POST', cache:'no-store', signal,
      headers:{apikey:cfg.SUPABASE_PUBLISHABLE_KEY,Authorization:'Bearer ' + token,'Content-Type':'application/json'},
      body:JSON.stringify(args)});
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.code === 'PGRST202' ? '日期查询接口尚未安装，请先完成后台更新。' :
        detail.message || ('日期查询失败（HTTP ' + response.status + '）。'));
      error.code = detail.code;
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function collectPart(state, part) {
    const {date,sale,sp} = part;
    if (sale) {
      if (!sale.summary || sale.summary.date !== date || !Array.isArray(sale.daily_rows) ||
          !Array.isArray(sale.parent_daily_rows)) throw new Error('历史日销售数据不完整，请重新同步。');
      state.summaries.push(sale.summary);
      for (const row of sale.daily_rows) {
        state.rows.push(row);
        state.childAsins.add(row.asin);
      }
      for (const row of sale.parent_daily_rows) {
        state.parentRows.push(row);
        state.groups.add(row.group_type + ':' + row.asin);
      }
      if (sale.parent_available) state.parentAvailable = true;
      const dayParents = {};
      for (const [parent,children] of Object.entries(sale.parent_child_asins || {})) {
        if (!ASIN.test(parent) || !Array.isArray(children)) continue;
        if (!state.parents.has(parent)) state.parents.set(parent,new Set());
        for (const child of children) {
          if (!ASIN.test(child) || child === parent) continue;
          if (dayParents[child] && dayParents[child] !== parent) throw new Error('同日销售记录的父 ASIN 关系冲突，请重新同步。');
          dayParents[child] = parent;
          state.parents.get(parent).add(child);
        }
      }
      state.saleParentsByDate[date] = dayParents;
    }
    if (sp) {
      state.adDays[date] = sp.day;
      const dayParents = {};
      for (const [child,parent] of Object.entries(sp.parent_asins || {})) {
        if (ASIN.test(child) && ASIN.test(parent) && child !== parent) dayParents[child] = parent;
      }
      state.adParentsByDate[date] = dayParents;
      Object.assign(state.adParents,dayParents);
    }
  }

  async function getOrderRange(auth, start, end, options = {}) {
    if (!validDay(start) || !validDay(end) || end < start || end > shiftDay(start,359))
      throw new Error('请选择有效的开始和结束日期，最多可查看 360 天。');
    const signal = options.signal;
    const manifest = await rangeRpc(auth,'mc_sales_range_manifest',{p_start:start,p_end:end},signal);
    if (!manifest) {
      const error = new Error('历史日期数据尚未发布，或当前账号无权查看。');
      error.code = 'RANGE_NOT_PUBLISHED';
      throw error;
    }
    if (!manifest.generated_at || !manifest.dates || typeof manifest.dates !== 'object' || Array.isArray(manifest.dates))
      throw new Error('历史日期索引不完整，请重新同步。');

    const state = {summaries:[],rows:[],parentRows:[],childAsins:new Set(),groups:new Set(),parentAvailable:false,
      parents:new Map(),saleParentsByDate:{},adDays:{},adParents:{},adParentsByDate:{}};
    const expected = new Map(Object.entries(manifest.dates));
    const recordDates = [...expected.keys()].sort();
    for (let index=0; index<recordDates.length;) {
      const first = recordDates[index], last = shiftDay(first,6) < end ? shiftDay(first,6) : end;
      if (!validDay(first) || first < start || first > end) throw new Error('历史日期索引超出查询范围。');
      const parts = await rangeRpc(auth,'mc_sales_range_days',
        {p_generation:manifest.generated_at,p_start:first,p_end:last},signal);
      if (!Array.isArray(parts)) throw new Error('历史明细格式错误。');
      for (const part of parts) {
        const flags = expected.get(part?.date);
        if (!flags || part.date < first || part.date > last || Boolean(flags.sale) !== Boolean(part.sale) ||
            Boolean(flags.sp) !== Boolean(part.sp)) throw new Error('日期明细与本次发布版本不一致，请刷新。');
        expected.delete(part.date);
        collectPart(state,part);
      }
      while (index < recordDates.length && recordDates[index] <= last) {
        if (expected.has(recordDates[index])) throw new Error('日期明细读取不完整，请重新查询。');
        index++;
      }
    }
    const daily = state.summaries.sort((a,b) => a.date.localeCompare(b.date));
    const recorded = daily.map(row=>row.date);
    const summary = window.KBSalesModel.sumSummaries(daily);
    if (summary) {
      // Database numerics can preserve more fractional digits than the two shown in the table.
      if (summary.sales_amount === null && summary.currency !== 'MIXED') {
        const amounts = daily.map(row => String(row.sales_amount).match(/^(-?)(\d+)(?:\.(\d+))?$/));
        if (amounts.every(Boolean)) {
          const scale = Math.max(2,...amounts.map(match => match[3]?.length || 0));
          let total = 0n;
          for (const [,sign,whole,fraction=''] of amounts) {
            const value = BigInt(whole + fraction.padEnd(scale,'0'));
            total += sign ? -value : value;
          }
          const digits = String(total < 0n ? -total : total).padStart(scale+1,'0');
          summary.sales_amount = (total < 0n ? '-' : '') + digits.slice(0,-scale) + '.' + digits.slice(-scale);
        }
      }
      summary.child_asins_count = state.childAsins.size;
      summary.parent_asins_count = state.parentAvailable ? state.groups.size : null;
    }
    const parentAvailable = state.parentAvailable || (!recorded.length && Object.keys(state.adParents).length > 0);
    return {generated_at:manifest.generated_at,payload:{schema_version:1,report_timezone:'America/Los_Angeles',
      period:{start_date:start,end_date:end},range_summary:summary,
      range_coverage:{days_with_records:recorded.length,recorded_start_date:recorded[0] || null,
        recorded_end_date:recorded[recorded.length-1] || null,recorded_dates:recorded},
      ranking:[],parent_ranking:[],parent_asin_available:parentAvailable,parent_children_available:parentAvailable,
      daily_rows:state.rows,parent_daily_rows:state.parentRows,
      parent_child_asins:Object.fromEntries([...state.parents].map(([parent,children])=>[parent,[...children].sort()])),
      sale_parent_by_date:state.saleParentsByDate,
      sales_daily_summaries:daily,sp_ads_spend:{schema_version:1,store:'MC',marketplace:'US',currency:'USD',
        timezone:'America/Los_Angeles',days:state.adDays,parent_asins:state.adParents,
        parent_asins_by_date:state.adParentsByDate}}};
  }

  const snapshots = new WeakMap();
  async function getOfficial(auth, start, end, signal) {
    const module = window.KBSalesOfficial;
    const closed = window.KBSalesModel.previousDate(window.KBSalesModel.pacificDate());
    const last = end < closed ? end : closed;
    const all = [], seen = new Set();
    for (let first = start < module.startDate ? module.startDate : start; first <= last;) {
      const through = shiftDay(first,6) < last ? shiftDay(first,6) : last;
      const days = await rangeRpc(auth,'mc_sales_official_days',{p_start:first,p_end:through},signal);
      if (!Array.isArray(days)) throw new Error('业务日报读取失败。');
      for (const day of days) {
        module.validate(day,first,through);
        if (seen.has(day.date)) throw new Error('业务日报包含重复日期。');
        seen.add(day.date);
        all.push(day);
      }
      first = shiftDay(through,1);
    }
    return all;
  }

  function rawSnapshot(snapshot) { return snapshots.get(snapshot) || snapshot; }

  async function getSnapshot(auth) {
    const raw = await getOrderSnapshot(auth);
    if (!window.KBSalesModel.reportTimezoneMatches(raw)) return raw;
    const {start_date:start,end_date:end} = raw.payload.period || {};
    if (!validDay(start) || !validDay(end) || end < start || end > shiftDay(start,359))
      throw new Error('订单快照的日期范围无效。');
    const today = window.KBSalesModel.pacificDate();
    // A delayed order publisher does not prevent a newer closed-day report
    // from being read. The original generation remains the order timestamp.
    const period = end < today ? {start_date:shiftDay(today,-14),end_date:today} : raw.payload.period;
    const base = period === raw.payload.period ? raw : {...raw,payload:{...raw.payload,period}};
    const reports = await getOfficial(auth,period.start_date,period.end_date);
    const result = window.KBSalesOfficial.apply(base,reports,today,false);
    snapshots.set(result,raw);
    return result;
  }

  async function getHistoryRange(auth,start,end,options={}) {
    if (!validDay(start) || !validDay(end) || end < start || end > shiftDay(start,359))
      throw new Error('请选择有效日期，最多可查看 360 天。');
    const recent = rawSnapshot(options.recent);
    const short = recent && window.KBSalesModel.recentHistoryRange(recent,start,end);
    // Official-only older days are displayable even when no order archive
    // exists. Authorization, network and consistency errors still surface.
    const fetchOrders = async () => {
      if (short) return short;
      try { return await getOrderRange(auth,start,end,options); }
      catch (error) {
        if (error.code === 'RANGE_NOT_PUBLISHED' || error.code === 'PGRST202') return null;
        // The existing archive publishes a rolling 360-day window and reports its
        // exact bounds in this error. An older official archive remains readable.
        const bounds = error.code === '22023' && /^日期超出已发布范围（(\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})）$/.exec(error.message);
        if (!bounds || !validDay(bounds[1]) || !validDay(bounds[2])) throw error;
        const first = start < bounds[1] ? bounds[1] : start;
        const last = end > bounds[2] ? bounds[2] : end;
        if (first > last) return null;
        if (first === start && last === end) throw error;
        return await getOrderRange(auth,first,last,options);
      }
    };
    const [orders,reports] = await Promise.all([fetchOrders(),getOfficial(auth,start,end,options.signal)]);
    if (!orders && !reports.length) throw new Error('所选日期尚无可读取的历史数据。');
    const base = orders || {generated_at:new Date().toISOString(),payload:{schema_version:1,
      report_timezone:'America/Los_Angeles',period:{start_date:start,end_date:end},
      daily_rows:[],parent_daily_rows:[],sales_daily_summaries:[],ranking:[],parent_ranking:[]}};
    return window.KBSalesOfficial.apply({...base,payload:{...base.payload,period:{start_date:start,end_date:end}}},
      reports,window.KBSalesModel.pacificDate(),true);
  }

  window.KBSales = {getSnapshot,getHistoryRange,rawSnapshot};
})();
