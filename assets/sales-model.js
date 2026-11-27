(function (root) {
  'use strict';

  const REPORT_TIMEZONE = 'America/Los_Angeles';
  const reportTimezoneMatches = snapshot => snapshot?.payload?.report_timezone === REPORT_TIMEZONE;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
  const count = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const spendCache = new WeakMap();
  const record = value => value && typeof value === 'object' && !Array.isArray(value);

  function pacificDate(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
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
    if (!reportTimezoneMatches(snapshot)) return { available: false, daily: [], ranking: [] };
    if (dimension === 'parent') {
      const available = data.parent_asin_available === true && Array.isArray(data.parent_daily_rows) && Array.isArray(data.parent_ranking);
      return { available, daily: available ? data.parent_daily_rows : [], ranking: available ? data.parent_ranking : [] };
    }
    return { available: Array.isArray(data.daily_rows), daily: Array.isArray(data.daily_rows) ? data.daily_rows : [], ranking: Array.isArray(data.ranking) ? data.ranking : [] };
  }

  function coveredDate(snapshot, date) {
    const data = snapshot?.payload || {};
    if (data.range_coverage && !data.range_coverage.recorded_dates?.includes(date)) return false;
    const publishedDay = snapshot?.generated_at ? pacificDate(snapshot.generated_at) : null;
    return reportTimezoneMatches(snapshot) && Array.isArray(data.daily_rows) && DATE_PATTERN.test(String(date)) &&
      DATE_PATTERN.test(String(data.period?.start_date)) && DATE_PATTERN.test(String(data.period?.end_date)) &&
      data.period.start_date <= date && date <= data.period.end_date && !!publishedDay && date <= publishedDay;
  }

  function parentChildren(snapshot, parentAsin, includeAds = false) {
    const data = snapshot?.payload || {};
    const key = String(parentAsin || '').trim().toUpperCase();
    const mapping = data.parent_child_asins;
    const available = reportTimezoneMatches(snapshot) && data.parent_children_available === true && mapping && typeof mapping === 'object' &&
      !Array.isArray(mapping) && Object.hasOwn(mapping, key) && Array.isArray(mapping[key]);
    const adsChildren = includeAds ? spAdsContext(snapshot)?.children.get(key) : null;
    if (adsChildren?.length) return { available: true, asins: adsChildren };
    return { available: !!available, asins: available ? [...new Set(mapping[key].filter(asin =>
      typeof asin === 'string' && ASIN_PATTERN.test(asin) && asin !== key))].sort() : [] };
  }

  function zeroRow(date, asin) {
    return { date, asin, units: 0, orders_count: 0, sales_amount: '0', currency: 'USD',
      estimated_rows: 0, missing_price_rows: 0, legacy_unknown_price_rows: 0 };
  }

  function unknownRow(date, asin) {
    return { date, asin, units: null, orders_count: null, sales_amount: null, currency: 'USD',
      estimated_rows: null, missing_price_rows: null, legacy_unknown_price_rows: null };
  }

  function spAdsContext(snapshot) {
    if (!record(snapshot)) return null;
    if (spendCache.has(snapshot)) return spendCache.get(snapshot);
    const data = snapshot.payload;
    const source = data?.sp_ads_spend;
    if (!reportTimezoneMatches(snapshot) || source?.schema_version !== 1 || source.store !== 'MC' ||
        source.marketplace !== 'US' || source.currency !== 'USD' || source.timezone !== REPORT_TIMEZONE ||
        !record(source.days)) {
      spendCache.set(snapshot, null);
      return null;
    }
    const days = new Map();
    for (const [date, day] of Object.entries(source.days)) {
      if (!DATE_PATTERN.test(date) || day?.status !== 'complete' || !record(day.asin_cents) ||
          !Object.entries(day.asin_cents).every(([asin, cents]) =>
            ASIN_PATTERN.test(asin) && Number.isSafeInteger(cents) && cents >= 0)) continue;
      days.set(date, day);
    }
    const parents = new Map();
    const conflicts = new Set();
    const add = (child, parent) => {
      if (typeof child !== 'string' || typeof parent !== 'string' || !ASIN_PATTERN.test(child) ||
          !ASIN_PATTERN.test(parent) || child === parent || conflicts.has(child)) return;
      if (parents.has(child) && parents.get(child) !== parent) {
        parents.delete(child);
        conflicts.add(child);
      } else parents.set(child, parent);
    };
    if (data.parent_children_available === true && record(data.parent_child_asins)) {
      for (const [parent, asins] of Object.entries(data.parent_child_asins)) {
        if (Array.isArray(asins)) for (const asin of asins) add(asin, parent);
      }
    }
    if (record(source.parent_asins)) for (const [child, parent] of Object.entries(source.parent_asins)) add(child, parent);
    const children = new Map();
    for (const [child, parent] of parents) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
    for (const asins of children.values()) asins.sort();
    const context = { days, parents, children };
    spendCache.set(snapshot, context);
    return context;
  }

  function spAdsDay(snapshot, date) {
    return spAdsContext(snapshot)?.days.get(date) || null;
  }

  function spAdsCents(snapshot, date, asin, groupType = 'child', today = pacificDate()) {
    const context = spAdsContext(snapshot);
    const day = context?.days.get(date);
    if (!day || typeof asin !== 'string' || !ASIN_PATTERN.test(asin)) return null;
    const finalDay = day.provisional === false && date < today;
    const children = groupType === 'parent' ? context.children.get(asin) : [asin];
    if (!children?.length) return null;
    let sum = 0;
    let found = false;
    for (const child of children) {
      if (!Object.hasOwn(day.asin_cents, child)) continue;
      found = true;
      sum += day.asin_cents[child];
      if (!Number.isSafeInteger(sum)) return null;
    }
    return found || finalDay ? sum : null;
  }

  const spAdsAmount = cents => Number.isSafeInteger(cents) && cents >= 0
    ? `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` : null;

  function dailyRowsWithSpend(snapshot, dimension = 'child', today = pacificDate()) {
    const data = snapshot?.payload || {};
    const source = dimensionRows(snapshot, dimension);
    const context = spAdsContext(snapshot);
    if (!context?.days.size) return source.daily;
    const key = (date, asin, group) => `${date}:${group}:${asin}`;
    const rows = new Map(source.daily.filter(row => row && typeof row.asin === 'string').map(row => {
      const group = row.group_type === 'parent' ? 'parent' : 'child';
      return [key(row.date, row.asin, group), { ...row,
        sp_ads_spend_cents: spAdsCents(snapshot, row.date, row.asin, group, today) }];
    }));
    for (const [date, day] of context.days) {
      if (!DATE_PATTERN.test(String(data.period?.start_date)) || !DATE_PATTERN.test(String(data.period?.end_date)) ||
          date < data.period.start_date || date > data.period.end_date || date > today) continue;
      for (const [child, cents] of Object.entries(day.asin_cents)) {
        if (!cents) continue;
        const parent = dimension === 'parent' ? context.parents.get(child) : null;
        const asin = parent || child;
        const group = parent ? 'parent' : 'child';
        const id = key(date, asin, group);
        if (rows.has(id)) continue;
        const row = source.available && coveredDate(snapshot, date) ? zeroRow(date, asin) : unknownRow(date, asin);
        rows.set(id, { ...row, group_type: group, parent_asin: parent || null, image_asin: child,
          child_asins_count: parent ? context.children.get(parent)?.length : null,
          sp_ads_spend_cents: spAdsCents(snapshot, date, asin, group, today) });
      }
    }
    return [...rows.values()];
  }

  function childRowsForDate(snapshot, parentAsin, date, today = pacificDate()) {
    const children = parentChildren(snapshot, parentAsin, true);
    if (!children.available) return [];
    const available = coveredDate(snapshot, date);
    const daily = snapshot?.payload?.daily_rows || [];
    const byAsin = new Map(daily.filter(row => row && row.date === date).map(row => [row.asin, row]));
    return children.asins.map(asin => {
      const cents = spAdsCents(snapshot, date, asin, 'child', today);
      const row = available ? byAsin.get(asin) || zeroRow(date, asin) : cents === null ? null : unknownRow(date, asin);
      return { asin, data: row ? { ...row, sp_ads_spend_cents: cents } : null };
    });
  }

  function childrenTodayComparison(snapshot, parentAsin, now = new Date()) {
    const today = pacificDate(now);
    const yesterday = previousDate(today);
    const yesterdayRows = new Map(childRowsForDate(snapshot, parentAsin, yesterday, today).map(row => [row.asin, row.data]));
    return childRowsForDate(snapshot, parentAsin, today, today).map(row => ({ asin: row.asin,
      today: row.data, yesterday: yesterdayRows.get(row.asin) || null })).sort((a, b) =>
      (count(b.today?.units) || 0) - (count(a.today?.units) || 0) || a.asin.localeCompare(b.asin));
  }

  function childrenPeriodRows(snapshot, parentAsin) {
    const children = parentChildren(snapshot, parentAsin);
    if (!children.available) return [];
    const daily = snapshot?.payload?.daily_rows || [];
    const hasCoverage = coveredDate(snapshot, snapshot?.payload?.period?.start_date);
    return children.asins.map(asin => {
      const rows = daily.filter(row => row && row.asin === asin && coveredDate(snapshot, row.date));
      const result = { asin, ...zeroRow(null, asin) };
      if (!hasCoverage) return { ...result, units: null, orders_count: null, sales_amount: null,
        estimated_rows: null, missing_price_rows: null, legacy_unknown_price_rows: null };
      const sumCount = field => {
        if (!rows.every(row => row[field] !== null && row[field] !== undefined && row[field] !== '' && count(row[field]) !== null)) return null;
        const sum = rows.reduce((total, row) => total + count(row[field]), 0);
        return Number.isSafeInteger(sum) ? sum : null;
      };
      for (const field of ['units', 'orders_count', 'estimated_rows', 'missing_price_rows', 'legacy_unknown_price_rows']) result[field] = sumCount(field);
      const currencies = new Set(rows.map(row => String(row.currency || 'USD').toUpperCase()));
      result.currency = currencies.size > 1 || currencies.has('MIXED') ? 'MIXED' : [...currencies][0] || 'USD';
      // Sum published decimal amounts exactly; absent amounts never become zero.
      let cents = 0n;
      let validAmount = true;
      for (const row of rows) {
        if (row.sales_amount === null || row.sales_amount === undefined || row.sales_amount === '') { validAmount = false; break; }
        const decimal = String(row.sales_amount).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
        if (!decimal) { validAmount = false; break; }
        const value = BigInt(decimal[2]) * 100n + BigInt((decimal[3] || '').padEnd(2, '0'));
        cents += decimal[1] ? -value : value;
      }
      const absolute = cents < 0n ? -cents : cents;
      result.sales_amount = result.currency === 'MIXED' || !validAmount ? null
        : `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
      return result;
    }).sort((a, b) => (count(b.units) || 0) - (count(a.units) || 0) || a.asin.localeCompare(b.asin));
  }

  function todayComparison(snapshot, now = new Date(), dimension = 'child') {
    const data = snapshot?.payload || {};
    const today = pacificDate(now);
    const yesterday = previousDate(today);
    const publishedDay = snapshot?.generated_at ? pacificDate(snapshot.generated_at) : null;
    const source = dimensionRows(snapshot, dimension);
    const rowsAvailable = source.available;
    const available = date => rowsAvailable && DATE_PATTERN.test(String(data.period?.start_date)) &&
      DATE_PATTERN.test(String(data.period?.end_date)) && data.period.start_date <= date &&
      date <= data.period.end_date && !!publishedDay && date <= publishedDay;
    const todayAvailable = available(today);
    const yesterdayAvailable = available(yesterday);
    const index = new Map();
    const zero = () => ({ units: 0, orders_count: 0, sales_amount: '0', currency: 'USD', estimated_rows: 0, missing_price_rows: 0, legacy_unknown_price_rows: 0 });
    for (const row of dailyRowsWithSpend(snapshot, dimension, today)) {
      if (!row || typeof row.asin !== 'string' || !row.asin.trim()) continue;
      if (row.date !== today && row.date !== yesterday) continue;
      if (!available(row.date) && row.sp_ads_spend_cents == null) continue;
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
    for (const entry of index.values()) {
      for (const [side, date] of [['today', today], ['yesterday', yesterday]]) {
        const cents = spAdsCents(snapshot, date, entry.asin, entry.group_type, today);
        if (entry[side] || cents !== null) entry[side] = { ...entry[side], sp_ads_spend_cents: cents };
      }
    }
    const rows = [...index.values()].sort((a, b) => (count(b.today?.units) || 0) - (count(a.today?.units) || 0) || a.asin.localeCompare(b.asin));
    return { today, yesterday, todayAvailable, yesterdayAvailable, todayAds: spAdsDay(snapshot, today),
      yesterdayAds: spAdsDay(snapshot, yesterday), rows };
  }

  const HISTORY_DAYS = [7, 30, 90, 150, 240, 360];
  function historyWindow(snapshot, days = 7, dimension = 'child') {
    const history = snapshot?.payload?.sales_history;
    const window = reportTimezoneMatches(snapshot) && HISTORY_DAYS.includes(Number(days)) ? history?.windows?.[String(days)] : null;
    const available = reportTimezoneMatches(snapshot) && history?.available === true && !!window && Array.isArray(window.child_rows) &&
      (dimension !== 'parent' || window.parent_asin_available === true && Array.isArray(window.parent_rows));
    return { available: !!available, parentAvailable: window?.parent_asin_available === true,
      period: window?.period || null, summary: available ? window.summary || null : null,
      rows: available ? dimension === 'parent' ? window.parent_rows : window.child_rows : [],
      recorded_start_date: window?.recorded_start_date || null, recorded_end_date: window?.recorded_end_date || null,
      days_with_records: count(window?.days_with_records), window };
  }

  function historyParentChildren(snapshot, parentAsin, days = 7) {
    const source = historyWindow(snapshot, days);
    const window = source.window;
    const key = String(parentAsin || '').trim().toUpperCase();
    const mapping = window?.parent_child_asins;
    const available = source.available && window?.parent_children_available === true && mapping &&
      typeof mapping === 'object' && !Array.isArray(mapping) && Object.hasOwn(mapping, key) && Array.isArray(mapping[key]);
    const asins = available ? [...new Set(mapping[key].filter(asin =>
      typeof asin === 'string' && /^[A-Z0-9]{10}$/.test(asin) && asin !== key))].sort() : [];
    return { available: !!available, asins };
  }

  function historyChildrenRows(snapshot, parentAsin, days = 7) {
    const mapping = historyParentChildren(snapshot, parentAsin, days);
    if (!mapping.available) return [];
    const members = new Set(mapping.asins);
    return historyWindow(snapshot, days).rows.filter(row => members.has(row.asin))
      .sort((a, b) => (count(b.units) || 0) - (count(a.units) || 0) || a.asin.localeCompare(b.asin));
  }

  function dailySummary(snapshot, date) {
    if (!coveredDate(snapshot, date)) return null;
    const summaries = snapshot?.payload?.sales_daily_summaries;
    return Array.isArray(summaries) ? summaries.find(row => row && row.date === date) || null : null;
  }

  function sumSummaries(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.some(row => !row)) return null;
    const result = {};
    for (const field of ['units', 'orders_count', 'estimated_rows', 'missing_price_rows', 'legacy_unknown_price_rows']) {
      const values = rows.map(row => row[field]);
      result[field] = values.every(value => value !== null && value !== undefined && value !== '' && count(value) !== null)
        ? values.reduce((sum, value) => sum + Number(value), 0) : null;
      if (result[field] !== null && !Number.isSafeInteger(result[field])) result[field] = null;
    }
    // The API already deduplicates each purchase date. An order has one purchase date,
    // so these daily distinct counts may be added; per-ASIN order counts may not.
    const nonempty = rows.filter(row => !(Number(row.orders_count) === 0 && Number(row.units) === 0 &&
      row.sales_amount !== null && row.sales_amount !== undefined && row.sales_amount !== '' && Number(row.sales_amount) === 0));
    const currencies = new Set(nonempty.map(row => String(row.currency || 'USD').toUpperCase()));
    result.currency = currencies.size > 1 ? 'MIXED' : [...currencies][0] || 'USD';
    let cents = 0n;
    let amountAvailable = result.currency !== 'MIXED';
    for (const row of rows) {
      const match = typeof row.sales_amount === 'string' || typeof row.sales_amount === 'number'
        ? String(row.sales_amount).match(/^(-?)(\d+)(?:\.(\d{1,2})0*)?$/) : null;
      if (!match) { amountAvailable = false; continue; }
      const value = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
      cents += match[1] ? -value : value;
    }
    const absolute = cents < 0n ? -cents : cents;
    result.sales_amount = amountAvailable
      ? `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}` : null;
    // Product counts cannot be added across dates. Derive them from published rows
    // for the selected scope in the page, while preserving the summary order total.
    return result;
  }

  // A purchase has one Pacific order date. Add the source's independently
  // deduplicated daily product/parent counts without adding siblings' orders.
  const productRangeCache = new WeakMap();

  function buildProductRange(snapshot, today) {
    const data = snapshot?.payload;
    const period = data?.period;
    if (!reportTimezoneMatches(snapshot) || !period || !DATE_PATTERN.test(period.start_date) ||
        !DATE_PATTERN.test(period.end_date)) return null;
    const days = (Date.parse(period.end_date) - Date.parse(period.start_date)) / 86400000 + 1;
    if (!Number.isInteger(days) || days < 1 || days > 360) return null;
    const within = date => date >= period.start_date && date <= period.end_date;
    const source = dimensionRows(snapshot);
    if (!source.available) return null;
    const groups = {child: new Map(), parent: new Map()};
    const members = new Map();
    const parents = new Map();
    for (const [parent, children] of Object.entries(data.parent_child_asins || {})) {
      if (!ASIN_PATTERN.test(parent) || !Array.isArray(children)) continue;
      for (const child of children) {
        if (!ASIN_PATTERN.test(child) || child === parent) continue;
        parents.set(child, parents.has(child) && parents.get(child) !== parent ? null : parent);
      }
    }
    function getGroup(map, type, asin) {
      const key = type + ':' + asin;
      if (!map.has(key)) map.set(key, {asin, type, rows: [], spendByDay: new Map(), positiveSpend: false});
      return map.get(key);
    }
    function member(parent, child) {
      if (!members.has(parent)) members.set(parent, new Map());
      return getGroup(members.get(parent), 'child', child);
    }
    const salesDays = new Set();
    const selling = new Map();
    const parentSource = dimensionRows(snapshot, 'parent');
    const sp = data.sp_ads_spend;
    const saleParents = data.sale_parent_by_date;
    const adParents = sp?.parent_asins_by_date;
    function saleParent(date, child, row) {
      if (saleParents && Object.hasOwn(saleParents, date)) return saleParents[date][child] || null;
      return row?.parent_asin || parents.get(child) || null;
    }
    for (const row of source.daily) {
      if (!row || !within(row.date) || !ASIN_PATTERN.test(row.asin)) continue;
      salesDays.add(row.date);
      getGroup(groups.child, 'child', row.asin).rows.push(row);
      if (!parentSource.available) continue;
      const parent = saleParent(row.date, row.asin, row);
      if (!selling.has(row.date)) selling.set(row.date, new Map());
      selling.get(row.date).set(row.asin, parent);
      if (parent) member(parent, row.asin).rows.push(row);
    }
    for (const row of parentSource.daily) {
      if (!row || !within(row.date) || !ASIN_PATTERN.test(row.asin)) continue;
      getGroup(groups.parent, row.group_type === 'parent' ? 'parent' : 'child', row.asin).rows.push(row);
    }
    const ads = spAdsContext(snapshot);
    const finalDays = new Set();
    function addSpend(group, date, cents, imageAsin) {
      group.spendByDay.set(date, (group.spendByDay.get(date) || 0) + cents);
      if (cents > 0) {
        group.positiveSpend = true;
        if (!group.imageAsin) group.imageAsin = imageAsin;
      }
    }
    for (const [date, day] of ads?.days || []) {
      if (!within(date) || date > today) continue;
      if (day.provisional === false && date < today) finalDays.add(date);
      for (const [child, cents] of Object.entries(day.asin_cents)) {
        addSpend(getGroup(groups.child, 'child', child), date, cents, child);
        if (!parentSource.available) continue;
        // Keep the SP source's dated attribution. When it omits a relationship,
        // use the corresponding sale day's mapping before a static snapshot mapping.
        const sold = selling.get(date);
        const hasDatedAds = adParents && Object.hasOwn(adParents, date);
        const adParent = hasDatedAds ? adParents[date][child] : sp.parent_asins?.[child];
        const parent = adParent || (sold?.has(child) ? sold.get(child) : hasDatedAds ? null : parents.get(child));
        addSpend(getGroup(groups.parent, parent ? 'parent' : 'child', parent || child), date, cents, child);
        if (parent) addSpend(member(parent, child), date, cents, child);
      }
    }

    function summarize(group, childCount = null) {
      const raw = group.rows;
      const metrics = raw.length ? sumSummaries(raw) : salesDays.size === days
        ? zeroRow(null, group.asin) : unknownRow(null, group.asin);
      const sample = raw.find(row => row.title) || raw[0];
      let cents = 0;
      let known = group.type !== 'parent' || childCount ? finalDays.size : 0;
      let provisional = false;
      for (const [date, value] of group.spendByDay) {
        cents += value;
        if (!finalDays.has(date)) { known++; provisional = true; }
      }
      const amount = Number.isSafeInteger(cents) && known > 0 ? cents : null;
      return {
        units: metrics.units, sales_amount: metrics.sales_amount, currency: metrics.currency,
        orders_count: metrics.orders_count, estimated_rows: metrics.estimated_rows,
        missing_price_rows: metrics.missing_price_rows, legacy_unknown_price_rows: metrics.legacy_unknown_price_rows,
        asin: group.asin, title: sample?.title || null, group_type: group.type,
        parent_asin: group.type === 'parent' ? group.asin : null,
        image_asin: sample?.image_asin || group.imageAsin || group.asin, child_asins_count: childCount,
        sp_ads_spend_cents: known === days ? amount : null, sp_ads_known_cents: amount,
        sp_ads_known_days: known, range_days: days, sp_ads_provisional: provisional
      };
    }
    const active = group => group.rows.length || group.positiveSpend;
    const compare = (a, b) => (b.units ?? -1) - (a.units ?? -1) || a.asin.localeCompare(b.asin) ||
      a.group_type.localeCompare(b.group_type);
    const children = new Map();
    for (const [parent, entries] of members) {
      const rows = Array.from(entries.values()).filter(active).map(group => summarize(group)).sort(compare);
      if (rows.length) children.set(parent, rows);
    }
    const rowsFor = map => Array.from(map.values()).filter(active).map(group =>
      summarize(group, group.type === 'parent' ? children.get(group.asin)?.length || null : null)).sort(compare);
    return {child: rowsFor(groups.child), parent: rowsFor(groups.parent), children};
  }

  function productRange(snapshot, today) {
    if (!record(snapshot)) return null;
    const cached = productRangeCache.get(snapshot);
    if (cached?.today === today) return cached.data;
    const data = buildProductRange(snapshot, today);
    productRangeCache.set(snapshot, {today, data});
    return data;
  }

  function historyProductRows(snapshot, dimension = 'child', today = pacificDate()) {
    const data = productRange(snapshot, today);
    return (dimension === 'parent' ? data?.parent : data?.child) || [];
  }

  function historyProductChildren(snapshot, parentAsin, today = pacificDate()) {
    return productRange(snapshot, today)?.children.get(parentAsin) || [];
  }

  // The 15-day publisher includes a store-level, distinct-order summary for each
  // day, including synthetic zero summaries on dates without source order lines.
  function recentHistoryRange(snapshot, start, end) {
    const data = snapshot?.payload;
    if (!coveredDate(snapshot, start) || !coveredDate(snapshot, end) || start > end ||
        !Array.isArray(data.sales_daily_summaries)) return null;
    const startTime = Date.parse(start + 'T00:00:00Z'), endTime = Date.parse(end + 'T00:00:00Z');
    const length = (endTime - startTime) / 86400000 + 1;
    if (!Number.isInteger(length) || length < 1 || length > 15 ||
        new Date(startTime).toISOString().slice(0, 10) !== start || new Date(endTime).toISOString().slice(0, 10) !== end) return null;
    const inRange = row => row?.date >= start && row.date <= end;
    const summaries = data.sales_daily_summaries.filter(inRange).sort((a, b) => a.date.localeCompare(b.date));
    if (summaries.length !== length) return null;
    const childRows = data.daily_rows.filter(inRange);
    const parentAvailable = data.parent_asin_available === true;
    if (parentAvailable && !dimensionRows(snapshot, 'parent').available) return null;
    const parentRows = parentAvailable ? data.parent_daily_rows.filter(inRange) : [];

    // The historical store summary and the daily ASIN view originate in separate
    // publisher queries. Only use them together when the dates and totals reconcile.
    const isCount = n => (typeof n === 'number' || (typeof n === 'string' && /^\d+$/.test(n))) && count(n) !== null;
    const groupKey = row => (row.group_type === 'parent' ? 'parent:' : 'child:') + row.asin;
    const rowsMatchDay = (rows, summary, dayTotals, countKey) => {
      if (!isCount(summary[countKey]) || rows.length !== Number(summary[countKey])) return false;
      if (!rows.length) return true;
      const groups = new Set();
      let lineOrders = 0;
      for (const row of rows) {
        const key = groupKey(row);
        if (groups.has(key) || !ASIN_PATTERN.test(row.asin || '') || !isCount(row.orders_count) ||
            !isCount(row.units) || Number(row.orders_count) > Number(summary.orders_count) ||
            (row.group_type === 'parent' && row.asin !== row.parent_asin)) return false;
        groups.add(key);
        lineOrders += Number(row.orders_count);
      }
      const totals = sumSummaries(rows);
      return lineOrders >= Number(summary.orders_count) && totals.units === Number(summary.units) &&
        totals.currency === dayTotals.currency && totals.sales_amount === dayTotals.sales_amount;
    };
    const selected = [];
    for (let i = 0; i < summaries.length; i++) {
      const day = summaries[i];
      const iso = new Date(startTime + i * 86400000).toISOString().slice(0, 10);
      if (day.date !== iso || !isCount(day.units) || !isCount(day.orders_count) || !day.currency) return null;
      const dayTotals = sumSummaries([day]);
      if (dayTotals.sales_amount === null && day.currency !== 'MIXED') return null;
      const children = childRows.filter(row => row.date === iso);
      if (!rowsMatchDay(children, day, dayTotals, 'child_asins_count') ||
          (parentAvailable && !rowsMatchDay(parentRows.filter(row => row.date === iso), day, dayTotals, 'parent_asins_count'))) return null;
      if (children.length) selected.push(day);
      else if (Number(day.units) || Number(day.orders_count) || dayTotals.sales_amount !== '0.00') return null;
    }

    const parentGroups = new Set(parentRows.map(groupKey));
    const children = new Set(childRows.map(row => row.asin));
    const knownParents = new Set(parentRows.filter(row => row.group_type === 'parent').map(row => row.asin));
    const recorded = selected.map(day => day.date);
    const summary = sumSummaries(selected);
    if (summary) Object.assign(summary, {
      child_asins_count: children.size, parent_asins_count: parentAvailable ? parentGroups.size : null,
      mapped_parent_asins_count: parentAvailable ? knownParents.size : null,
      unknown_child_asins_count: parentAvailable ? parentGroups.size - knownParents.size : null
    });
    const within = date => date >= start && date <= end;
    const ads = data.sp_ads_spend;
    const mappings = {};
    for (const [parent, members] of Object.entries(data.parent_child_asins || {})) {
      if (!Array.isArray(members)) continue;
      const scoped = members.filter(asin => children.has(asin));
      if (scoped.length) mappings[parent] = scoped;
    }
    return { generated_at: snapshot.generated_at, payload: {
      schema_version: 1, report_timezone: REPORT_TIMEZONE, period: {start_date: start, end_date: end},
      daily_rows: childRows, parent_daily_rows: parentRows, parent_ranking: [], ranking: [],
      parent_asin_available: parentAvailable, parent_children_available: data.parent_children_available === true,
      parent_child_asins: mappings, product_images: data.product_images,
      sp_ads_spend: ads && {...ads, days: Object.fromEntries(Object.entries(ads.days || {}).filter(([day]) => within(day)))},
      sales_daily_summaries: selected, range_summary: summary,
      range_coverage: { recorded_start_date: recorded[0] || null, recorded_end_date: recorded.at(-1) || null,
        days_with_records: recorded.length, recorded_dates: recorded }
    }};
  }

  function dailyScopeSummary(snapshot, selectedDate = '') {
    if (selectedDate) return dailySummary(snapshot, selectedDate);
    const period = snapshot?.payload?.period;
    if (!DATE_PATTERN.test(String(period?.start_date)) || !DATE_PATTERN.test(String(period?.end_date))) return null;
    const rows = [];
    let date = period.start_date;
    for (let index = 0; index < 15 && date <= period.end_date; index++) {
      rows.push(dailySummary(snapshot, date));
      date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    }
    if (date <= period.end_date) return null;
    return sumSummaries(rows);
  }

  function csvCell(value) {
    if (value === null || value === undefined) return '""';
    let text = String(value);
    // Keep numeric amounts numeric, but prevent text cells from becoming Excel formulas.
    if ((/^[\t\r\n]/.test(text) || /^\s*[=+\-@]/.test(text)) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  function csvDocument(headers, rows) {
    return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  const priceBasis = row => !row ? '' : priceFlags(row).map(flag => flag.label).join('；') || '实际金额';
  function historyCsv(rows, period, dimension, mode = 'daily') {
    const periodTable = mode === 'range';
    const dates = periodTable ? [] : ['开始日期', '结束日期'];
    const spendFields = ['SP广告花费（USD）'];
    if (periodTable) spendFields.push('SP已知小计（USD）', 'SP花费有值天数', '所选天数', 'SP花费含暂定日报');
    return csvDocument([...dates, '统计时区', '统计方式', '统计维度', '分组类型', 'ASIN', '父ASIN', '商品标题',
      '销量', '销售额', '币种', '订单量', '子ASIN数', '估算明细数', '缺价明细数', '待核价明细数', '金额口径',
      ...(mode === 'daily' || periodTable ? spendFields : [])], rows.map(row => [
      ...(periodTable ? [] : mode === 'daily' ? [row.date, row.date] : [period?.start_date, period?.end_date]), REPORT_TIMEZONE,
      mode === 'daily' ? '每日明细' : '期间汇总', dimension === 'parent' ? '父ASIN' : '子ASIN',
      row.group_type === 'parent' ? '父ASIN' : dimension === 'parent' ? '未匹配子ASIN' : '子ASIN',
      row.asin, row.parent_asin, row.title, row.units, row.sales_amount, row.currency, row.orders_count,
      row.child_asins_count, row.estimated_rows, row.missing_price_rows, row.legacy_unknown_price_rows, priceBasis(row),
      ...(mode === 'daily' || periodTable ? [spAdsAmount(row.sp_ads_spend_cents)] : []),
      ...(periodTable ? [spAdsAmount(row.sp_ads_known_cents), row.sp_ads_known_days, row.range_days,
        row.sp_ads_known_days ? (row.sp_ads_provisional ? '是' : '否') : null] : [])
    ]));
  }
  function todayCsv(rows, dates, dimension) {
    const metrics = ['销量', '销售额', '币种', '订单量', '估算明细数', '缺价明细数', '待核价明细数', '金额口径'];
    const values = row => row ? [row.units, row.sales_amount, row.currency, row.orders_count, row.estimated_rows,
      row.missing_price_rows, row.legacy_unknown_price_rows, priceBasis(row)] : Array(metrics.length).fill(null);
    return csvDocument(['今日日期', '昨日日期', '统计时区', '统计维度', '分组类型', 'ASIN', '父ASIN',
      ...metrics.map(label => `今日${label}`), ...metrics.map(label => `昨日${label}`),
      '今日SP广告花费（USD）', '昨日SP广告花费（USD）'], rows.map(row => [
      dates?.today, dates?.yesterday, REPORT_TIMEZONE, dimension === 'parent' ? '父ASIN' : '子ASIN',
      row.group_type === 'parent' ? '父ASIN' : dimension === 'parent' ? '未匹配子ASIN' : '子ASIN',
      row.asin, row.parent_asin, ...values(row.today), ...values(row.yesterday),
      spAdsAmount(row.today?.sp_ads_spend_cents), spAdsAmount(row.yesterday?.sp_ads_spend_cents)
    ]));
  }

  const model = { REPORT_TIMEZONE, reportTimezoneMatches, pacificDate, previousDate, imageUrl, priceFlags, dimensionRows, todayComparison,
    spAdsDay, spAdsCents, spAdsAmount, dailyRowsWithSpend,
    parentChildren, childRowsForDate, childrenTodayComparison, childrenPeriodRows,
    HISTORY_DAYS, historyWindow, historyParentChildren, historyChildrenRows, dailySummary,
    sumSummaries, historyProductRows, historyProductChildren, recentHistoryRange, dailyScopeSummary, csvCell, csvDocument, historyCsv, todayCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.KBSalesModel = model;
})(typeof window === 'undefined' ? globalThis : window);
