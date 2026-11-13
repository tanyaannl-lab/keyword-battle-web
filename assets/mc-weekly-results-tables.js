(function () {
  'use strict';

  const missing = '—';
  const pageSize = 50;
  const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 });
  const sourceNotice = '同一父 ASIN 的周数据。销售额为已订购商品销售额，订单商品数不等于独立订单数；会话数为各子 ASIN 会话数之和。周报未齐时暂不汇总。';
  const spNotice = 'SP 指商品推广，订单和销售额采用 7 天归因，可能包含其他 SKU。仅展示明确归属当前父 ASIN 的数据。';
  const profitNotice = '利润尚未计算：产品目录目前只存当前成本，交易表的退款和平台费用还未按产品接入核算。';
  const channelOrder = ['SP', 'SB', 'SD'];
  const otherAdChannels = channelOrder.slice(1);
  const channelMetrics = ['cost', 'sales', 'orders'];
  const adShareNotice = '归因销售额占比 = 表内广告归因销售额 ÷ 同期销售额，仅供参考。各广告类型的归因窗口可能不同，归因订单合计未跨类型去重。';
  const numberKinds = new Set(['usd', 'num', 'int', 'pct']);
  const compactHeadings = Object.freeze({
    '出现次数(多个日期与活动)': ['出现次数', '多日/多活动'],
    '平均:份额排名': ['份额排名', '平均'],
    '开始点击日期': ['首次点击'],
    '最后点击日期': ['末次点击'],
    '已订购商品数量': ['订购件数'],
    '广告订单': ['广告订单', '归因'],
    '自然订单（估算）': ['自然订单', '估算'],
    '自然单占比（估算）': ['自然单占比', '估算'],
    '广告单占比（估算）': ['广告单占比', '估算'],
    '利润（估算）': ['利润', '估算'],
    '毛利率（估算）': ['毛利率', '估算'],
    'FBA 退货率': ['FBA 退货率', '当日收退 / 发货'],
    '广告费占总销售额': ['广告费占', '总销售额'],
    '总访客数': ['总访客数', '会话数'],
    'SP 归因销售额占比（参考）': ['SP 归因销售额占比', '参考'],
    '广告归因销售额占比（参考）': ['广告归因销售额占比', '参考'],
  });

  function col(key, label, kind = 'text', aliases = [], rule = null) {
    return Object.freeze({ key, label, kind, aliases: Object.freeze(aliases), rule: rule && Object.freeze(rule) });
  }

  const keywordColumns = Object.freeze([
    col('term', '客户搜索词', 'text', ['行标签']),
    col('occurrences', '出现次数(多个日期与活动)', 'int'),
    col('click_days', '点击天数', 'int'),
    col('daily_clicks', '日均点击[8]', 'num', ['日均点击'], [8]),
    col('daily_orders', '日均订单[0.5]', 'num', ['日均订单'], [0.5]),
    col('daily_spend', '日均花费[20]', 'usd', ['日均花费'], [20]),
    col('daily_market_impressions', '日均全站展现[10000]', 'num', ['日均全站展现'], [10000]),
    col('daily_impressions', '日均展现[10000]', 'num', ['日均展现'], [10000]),
    col('rank', '平均:份额排名', 'num'),
    col('share', '搜索份额', 'pct'),
    col('market_impressions', '全站展现', 'num'),
    col('impressions', '店铺展现', 'int', ['展现']),
    col('clicks', '点击', 'int'),
    col('cost', '广告费', 'usd'),
    col('orders', '订单', 'int', [], [5]),
    col('sales', '销售额', 'usd'),
    col('avg_order_value', '客单价', 'usd'),
    col('cpc', 'CPC', 'usd'),
    col('cpa', 'CPA', 'usd'),
    col('ctr', '点击率[1%]', 'pct', ['点击率'], [0.01]),
    col('cvr', '转化率[5%,2%]', 'pct', ['转化率'], [0.05, 0.02]),
    col('acos', 'ACOS[20%,40%]', 'pct', ['ACOS'], [0.2, 0.4, 'lower']),
    col('first_click', '开始点击日期', 'date'),
    col('last_click', '最后点击日期', 'date', ['最后点击日期[3天内]', '最后点击日期\n[3天内]']),
    col('order_label', '出单标识'),
  ]);

  const attributeColumns = Object.freeze([
    col('attribute', '属性'),
    col('word_frequency', '词频', 'int'),
    col('rank', '平均:份额排名', 'num'),
    col('share', '搜索份额', 'pct'),
    col('market_impressions', '全站展现', 'num'),
    col('impressions', '展现', 'int', ['店铺展现']),
    col('clicks', '点击', 'int'),
    col('cost', '广告费', 'usd'),
    col('orders', '订单', 'int', [], [5]),
    col('sales', '销售额', 'usd'),
    col('avg_order_value', '客单价', 'usd'),
    col('cpc', 'CPC', 'usd'),
    col('cpa', 'CPA', 'usd'),
    col('ctr', '计算:点击率[1%]', 'pct', ['点击率', '计算:点击率'], [0.01]),
    col('cvr', '计算:转化率[5%,2%]', 'pct', ['转化率', '计算:转化率'], [0.05, 0.02]),
    col('acos', '计算:ACOS[20%,40%]', 'pct', ['ACOS', '计算:ACOS', '计算:ACOS\n[20%,40%]'], [0.2, 0.4, 'lower']),
    col('order_label', '出单标识'),
  ]);

  const summaryColumns = [
    col('week_start', '周期', 'week'),
    col('sales', '销售额', 'usd'),
    col('profit', '利润', 'usd'),
    col('orders', '订单商品数', 'int'),
    col('units', '已订购商品数量', 'int'),
    col('visits', '会话数', 'int'),
    col('unit_session_rate', '订购件数 / 会话数', 'pct'),
    col('returns_rate', '退货率', 'pct'),
    col('total_ad_cost', '总广告费', 'usd'),
    col('sp_cost', 'SP 广告费', 'usd'),
    col('sp_orders', 'SP 归因订单', 'int'),
    col('sp_acos', 'SP ACOS', 'pct'),
    col('sbv_cost', 'SBV 广告费', 'usd'),
    col('sb_cost', 'SB 广告费', 'usd'),
    col('sd_cost', 'SD 广告费', 'usd'),
    col('traffic_days', '周报到齐', 'coverage'),
    col('review_fee', '测评费用原币', 'usd'),
    col('offsite_fee', '站外费用原币', 'usd'),
    col('other_fee', '其他费用原币', 'usd'),
  ];

  const spMetricColumns = [
    col('sp_sales', 'SP 归因销售额', 'usd'),
    col('sp_sales_share', 'SP 归因销售额占比（参考）', 'pct'),
    col('sp_cost', 'SP 广告费', 'usd'),
    col('sp_orders', 'SP 归因订单', 'int'),
    col('sp_impressions', 'SP 展现', 'int'),
    col('sp_clicks', 'SP 点击', 'int'),
    col('sp_acos', 'SP ACOS', 'pct'),
  ];

  const combinedAdColumns = [
    col('ad_sales', '已归属广告销售额', 'usd'),
    col('ad_sales_share', '广告归因销售额占比（参考）', 'pct'),
    col('ad_cost', '已归属广告花费', 'usd'),
    col('ad_orders', '已归属广告订单', 'int'),
    col('ad_acos', '已归属广告 ACOS', 'pct'),
  ];

  const weeklyAdExtraColumns = [
    col('base_ad_cost', '根基广告', 'usd'),
    col('expansion_ad_cost', '拓词广告', 'usd'),
    col('all_terms', '全部流量词', 'int'),
    col('organic_terms', '自然流量词', 'int'),
    col('sp_terms', 'SP 广告词', 'int'),
    col('ac_terms', 'AC 推荐词', 'int'),
  ];

  const dailyColumns = [
    col('report_date', '日期', 'date'),
    col('profit', '利润（估算）', 'usd'),
    col('gross_margin', '毛利率（估算）', 'pct'),
    col('sales', '销售额', 'usd'),
    col('ad_sales', '广告销售额', 'usd'),
    col('orders', '订单', 'int'),
    col('organic_orders', '自然订单（估算）', 'int'),
    col('ad_orders', '广告订单', 'int'),
    col('organic_order_share', '自然单占比（估算）', 'pct'),
    col('ad_order_share', '广告单占比（估算）', 'pct'),
    col('ad_cost', '广告费', 'usd'),
    col('ad_cost_of_sales', '广告费占总销售额', 'pct'),
    col('returns_rate', 'FBA 退货率', 'pct'),
    col('app_session_share', 'APP流量占比', 'pct'),
    col('visits', '总访客数', 'int'),
    col('unit_session_rate', '转化', 'pct'),
  ];

  function element(name, className, content) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function numeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function ratio(a, b) {
    const lhs = numeric(a);
    const rhs = numeric(b);
    return lhs !== null && rhs !== null && rhs > 0 ? lhs / rhs : null;
  }

  function estimateDailyOrderSplit(row) {
    const orders = numeric(row.orders);
    const adOrders = numeric(row.ad_orders);
    const isCount = value => Number.isSafeInteger(value) && value >= 0;
    const validCounts = isCount(orders) && isCount(adOrders);
    const organicOrders = validCounts && adOrders <= orders ? orders - adOrders : null;
    return {
      organic_orders: organicOrders,
      organic_order_share: ratio(organicOrders, orders),
      ad_order_share: validCounts ? ratio(adOrders, orders) : null,
    };
  }

  function dateValue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null;
  }

  function monday(value) {
    const date = dateValue(value);
    if (!date) return null;
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return date.toISOString().slice(0, 10);
  }

  function channelNumbers(row, prefix = '') {
    return Object.fromEntries(channelMetrics.map(key => [key, numeric(own(row, prefix + key))]));
  }

  function addKnown(values) {
    if (!values.length || values.some(value => value === null)) return null;
    const sum = values.reduce((total, value) => total + value, 0);
    return Number.isFinite(sum) ? sum : null;
  }

  function aggregateOtherAds(rows, keyOf) {
    const periods = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!otherAdChannels.includes(row?.channel) || !dateValue(row.report_date)) continue;
      const key = keyOf(row.report_date);
      const values = channelNumbers(row);
      if (!channelMetrics.some(metric => values[metric] !== null)) continue;
      const channels = periods.get(key) ?? new Map();
      if (!channels.has(row.channel)) channels.set(row.channel, values);
      else {
        const prior = channels.get(row.channel);
        for (const metric of channelMetrics) prior[metric] = addKnown([prior[metric], values[metric]]);
      }
      periods.set(key, channels);
    }
    return periods;
  }

  function advertisingRows(rows, dateKey, periods, coverage) {
    const byWeek = new Map();
    for (const entry of Array.isArray(coverage) ? coverage : []) {
      if (!otherAdChannels.includes(entry?.channel) || !dateValue(entry.week_start)) continue;
      const channels = byWeek.get(entry.week_start) ?? new Map();
      channels.set(entry.channel, entry.status);
      byWeek.set(entry.week_start, channels);
    }
    return rows.map(row => {
      const period = own(row, dateKey);
      const channels = new Map(periods.get(period));
      const sp = channelNumbers(row, 'sp_');
      if (channelMetrics.some(metric => sp[metric] !== null)) channels.set('SP', sp);
      const names = channelOrder.filter(channel => channels.has(channel));
      const statuses = byWeek.get(monday(period));
      const scope = names.length === 1 ? `仅 ${names[0]}` : names.join(' + ') || missing;
      const pending = otherAdChannels.filter(channel => ['unmapped', 'partial'].includes(statuses?.get(channel)));
      const missingReports = otherAdChannels.filter(channel => statuses?.get(channel) === 'missing');
      const noRows = otherAdChannels.filter(channel => statuses?.get(channel) === 'empty');
      const result = {
        ...row,
        ad_scope: scope,
        ad_channels: names,
        ad_pending: pending,
        ad_missing_reports: missingReports,
        ad_empty: noRows,
      };
      for (const metric of channelMetrics) {
        result[`ad_${metric}`] = addKnown(names.map(channel => channels.get(channel)[metric]));
        for (const channel of otherAdChannels) result[`${channel.toLowerCase()}_${metric}`] = channels.get(channel)?.[metric] ?? null;
      }
      result.ad_sales_share = ratio(result.ad_sales, row.sales);
      result.ad_acos = ratio(result.ad_cost, result.ad_sales);
      return result;
    });
  }

  function advertisingColumns(rows, daily) {
    const seen = new Set(rows.flatMap(row => row.ad_channels));
    const showCombined = otherAdChannels.some(channel => seen.has(channel));
    const details = showCombined ? otherAdChannels.filter(channel => seen.has(channel)).flatMap(channel => {
      const prefix = channel.toLowerCase();
      return [col(`${prefix}_sales`, `${channel} 归因销售额`, 'usd'), col(`${prefix}_cost`, `${channel} 广告费`, 'usd'),
        col(`${prefix}_orders`, `${channel} 归因订单`, 'int')];
    }) : [];
    return [
      daily ? col('report_date', '日期', 'date') : col('week_start', '周期', 'week'),
      col('ad_scope', '统计范围'),
      col('sales', '销售额', 'usd'),
      ...(showCombined ? combinedAdColumns : []),
      ...(!showCombined || seen.has('SP') ? spMetricColumns : []),
      ...details,
      ...(daily ? [] : weeklyAdExtraColumns),
    ];
  }

  function advertisingNotice(rows, daily, error, spError, showSalesShare = true) {
    const seen = new Set(rows.flatMap(row => row.ad_channels));
    const names = channelOrder.filter(channel => seen.has(channel));
    const pending = new Set(rows.flatMap(row => row.ad_pending));
    const missingReports = new Set(rows.flatMap(row => row.ad_missing_reports));
    const confirmedEmpty = otherAdChannels.filter(channel => rows.length && rows.every(row => row.ad_empty.includes(channel)));
    const join = values => otherAdChannels.filter(channel => values.has(channel)).join('、');
    const notices = [
      names.length ? `统计范围：${names.length === 1 ? `仅 ${names[0]}` : names.join(' + ')}，只计入能归属当前父 ASIN 的数据。` : '暂无能归属当前父 ASIN 的广告数据。',
      names.length ? (showSalesShare ? adShareNotice : '各广告类型的归因窗口可能不同，归因订单未跨类型去重。') : '',
      seen.has('SP') ? spNotice : '',
      pending.size ? `${join(pending)} 有广告报表，但部分或全部记录未能归属产品，未归属部分未计入。` : '',
      missingReports.size ? `部分期间缺少 ${join(missingReports)} 报表，缺失未按 0 计。` : '',
      confirmedEmpty.length ? `${confirmedEmpty.join('、')} 在本表期间的源报表无记录。` : '',
      error ? '暂时无法核对 SB、SD，未把缺失数据按 0 计。' : '',
      spError ? '暂时无法读取 SP，表内金额未包含缺失的 SP 数据。' : '',
      daily ? `按报表实际日期展示；有可归属广告数据的日期：${rows.filter(row => row.ad_channels.length).length} / ${rows.length}。` : '',
    ];
    return notices.filter(Boolean).join(' ');
  }

  function weekLabel(value) {
    const end = dateValue(value);
    if (!end) return missing;
    end.setUTCDate(end.getUTCDate() + 6);
    return `${value} 至 ${end.toISOString().slice(0, 10)}`;
  }

  function own(row, key) {
    return row && Object.prototype.hasOwnProperty.call(row, key) ? row[key] : null;
  }

  function sheetValue(row, column) {
    const direct = own(row, column.key) ?? own(row, column.label);
    if (direct !== null && direct !== undefined) return direct;
    for (const label of column.aliases) {
      const value = own(row, label);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  }

  function format(value, kind) {
    if (kind === 'week') return { text: weekLabel(value) };
    if (kind === 'date') return { text: dateValue(value) ? value : missing };
    if (kind === 'text') return { text: typeof value === 'string' && value.trim() ? value : missing };
    const percentString = kind === 'pct' && typeof value === 'string' && value.trim().endsWith('%');
    const parsed = numeric(percentString ? value.trim().slice(0, -1) : value);
    if (parsed === null || (kind === 'int' && !Number.isSafeInteger(parsed))) return { text: missing };
    const number = percentString ? parsed / 100 : parsed;
    if (kind === 'coverage') return { text: Number.isInteger(number) && number >= 0 && number <= 7 ? `${number}/7 天` : missing };
    const formatter = { int: integer, num: decimal, usd: dollars, pct: percent }[kind];
    return { text: formatter.format(number), number };
  }

  function setHighlight(cell, number, rule) {
    if (number === undefined || !rule) return;
    const [good, low, direction] = rule;
    if (direction === 'lower' ? number <= good : number >= good) cell.classList.add('results-rate-good');
    else if (low !== undefined && (direction === 'lower' ? number > low : number < low)) cell.classList.add('results-rate-low');
  }

  function renderColumnHeading(column) {
    const heading = element('th');
    heading.scope = 'col';
    heading.dataset.column = column.key;
    heading.dataset.kind = column.kind;
    if (numberKinds.has(column.kind)) heading.classList.add('results-number');
    const threshold = /^(.*?)\[([^\]]+)\]$/.exec(column.label);
    const [label, hint] = compactHeadings[column.label] ||
      (threshold ? [threshold[1].replace(/^计算:/, ''), `[${threshold[2]}]`] : [column.label]);
    heading.append(element('span', 'results-column-label', label));
    if (hint) heading.append(element('span', 'results-column-hint', hint));
    if (label !== column.label || hint) {
      heading.title = column.label;
      heading.setAttribute('aria-label', column.label);
    }
    return heading;
  }

  function renderTable(target, { columns, rows, week, label, note, emptyText }) {
    if (!target) return;
    const wrapper = element('div', 'results-table-scroll');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', `${label}数据表，可横向滚动`);
    const table = element('table', 'results-table results-table-compact');
    table.setAttribute('aria-label', label);
    const head = element('thead');
    const headings = element('tr');
    for (const column of columns) headings.append(renderColumnHeading(column));
    head.append(headings);
    const body = element('tbody');
    table.append(head, body);
    wrapper.append(table);
    const notice = note ? element('p', 'results-table-note', note) : null;
    const hasPages = rows.length > pageSize;
    const pager = hasPages ? element('div', 'results-table-pagination') : null;
    const pageLabel = hasPages ? element('span') : null;
    const prev = hasPages ? element('button', 'results-table-pager', '上一页') : null;
    const next = hasPages ? element('button', 'results-table-pager', '下一页') : null;
    let page = 1;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));

    function draw() {
      const fragment = document.createDocumentFragment();
      if (!rows.length) {
        const tr = element('tr');
        const cell = element('td', 'results-table-note', emptyText);
        cell.colSpan = columns.length;
        tr.append(cell);
        fragment.append(tr);
      }
      const start = (page - 1) * pageSize;
      for (const row of rows.slice(start, start + pageSize)) {
        const tr = element('tr');
        const current = Boolean(week && own(row, 'week_start') === week);
        if (current) tr.dataset.selectedWeek = 'true';
        columns.forEach((column, index) => {
          const formatted = format(sheetValue(row, column), column.kind);
          const cell = element(index === 0 ? 'th' : 'td', '', formatted.text);
          cell.dataset.column = column.key;
          cell.dataset.kind = column.kind;
          if (column.kind === 'week' && formatted.text !== missing) {
            const [first, last] = formatted.text.split(' 至 ');
            cell.replaceChildren(element('span', 'results-week-part', first), document.createTextNode(' '),
              element('span', 'results-week-part', `至 ${last}`));
          }
          if (index === 0) {
            cell.scope = 'row';
            if (current) cell.setAttribute('aria-current', 'date');
          }
          if (numberKinds.has(column.kind)) cell.classList.add('results-number');
          if (formatted.text === missing) cell.classList.add('results-missing');
          setHighlight(cell, formatted.number, column.rule);
          tr.append(cell);
        });
        fragment.append(tr);
      }
      body.replaceChildren(fragment);
      if (hasPages) {
        pageLabel.textContent = `第 ${page} / ${pages} 页 · 共 ${integer.format(rows.length)} 条`;
        prev.disabled = page <= 1;
        next.disabled = page >= pages;
      }
    }

    if (hasPages) {
      prev.type = next.type = 'button';
      pageLabel.setAttribute('aria-live', 'polite');
      prev.addEventListener('click', () => { if (page > 1) { page -= 1; draw(); } });
      next.addEventListener('click', () => { if (page < pages) { page += 1; draw(); } });
      pager.append(prev, pageLabel, next);
    }
    draw();
    target.replaceChildren(...[notice, wrapper, pager].filter(Boolean));
  }

  function buildWeeklyRows(input, ads, selected) {
    const weeks = new Map();
    const accept = (value) => dateValue(value) && (!selected || value <= selected);
    if (accept(selected)) weeks.set(selected, { week_start: selected });
    for (const row of Array.isArray(input) ? input : []) {
      const week = own(row, 'week_start');
      if (!accept(week)) continue;
      const days = numeric(own(row, 'traffic_days'));
      const complete = days === 7;
      const notes = own(row, 'notes');
      weeks.set(week, {
        week_start: week,
        sales: complete ? own(row, 'sales') : null,
        orders: complete ? own(row, 'orders') : null,
        units: complete ? own(row, 'units') : null,
        visits: complete ? own(row, 'visits') : null,
        unit_session_rate: complete ? ratio(own(row, 'units'), own(row, 'visits')) : null,
        traffic_days: days,
        review_fee: own(notes, 'review_fee'),
        offsite_fee: own(notes, 'offsite_fee'),
        other_fee: own(notes, 'other_fee'),
      });
    }
    for (const row of Array.isArray(ads) ? ads : []) {
      const week = own(row, 'week_start');
      if (!accept(week)) continue;
      const base = weeks.get(week) || { week_start: week };
      for (const key of ['sp_cost', 'sp_sales', 'sp_orders', 'sp_impressions', 'sp_clicks']) base[key] = own(row, key);
      base.sp_acos = ratio(base.sp_cost, base.sp_sales);
      base.sp_sales_share = ratio(base.sp_sales, base.sales);
      weeks.set(week, base);
    }
    return [...weeks.values()]
      .map(row => ({ ...row, review_fee: row.review_fee ?? 0, offsite_fee: row.offsite_fee ?? 0, other_fee: row.other_fee ?? 0 }))
      .sort((a, b) => b.week_start.localeCompare(a.week_start));
  }

  function render(targets, { rows, week, adRows, otherAds, spError } = {}) {
    const weeklyRows = buildWeeklyRows(rows, adRows, week);
    const spNote = Array.isArray(adRows) && adRows.length ? spNotice : '此父 ASIN 暂无已导入的商品推广结果。';
    renderTable(targets.summary, {
      columns: summaryColumns, rows: weeklyRows, week, label: '周总结',
      note: `${sourceNotice} ${profitNotice} ${spNote}`, emptyText: '没有可展示的周期。',
    });
    const byWeek = aggregateOtherAds(otherAds?.rows, monday);
    const dates = new Set(weeklyRows.map(row => row.week_start));
    const baseRows = [...weeklyRows, ...[...byWeek.keys()]
      .filter(value => !dates.has(value) && (!week || value <= week))
      .map(week_start => ({ week_start }))].sort((a, b) => b.week_start.localeCompare(a.week_start));
    const scopedRows = advertisingRows(baseRows, 'week_start', byWeek, otherAds?.coverage ?? otherAds?.pending);
    renderTable(targets.ads, {
      columns: advertisingColumns(scopedRows, false), rows: scopedRows, week, label: '产品广告结构',
      note: advertisingNotice(scopedRows, false, otherAds?.error, spError), emptyText: '没有可展示的周期。',
    });
  }

  function renderSearch(targets, { keyword_rows: keywordRows, attribute_rows: attributeRows, rangeNotice = '' } = {}) {
    const scope = '仅展示明确归属当前父 ASIN 的数据。订单和销售额采用 7 天归因。搜索份额、排名和全站展现缺少源数据，显示为 —。';
    renderTable(targets.keywords, {
      columns: keywordColumns, rows: Array.isArray(keywordRows) ? keywordRows : [], label: '关键词分析',
      note: [rangeNotice, scope].filter(Boolean).join(' '),
      emptyText: `此父 ASIN 在所选${rangeNotice ? '日期范围' : '周'}暂无关键词分析。`,
    });
    renderTable(targets.attributes, {
      columns: attributeColumns, rows: Array.isArray(attributeRows) ? attributeRows : [], label: '属性分析',
      note: [rangeNotice, scope].filter(Boolean).join(' '),
      emptyText: `此父 ASIN 在所选${rangeNotice ? '日期范围' : '周'}暂无属性分析。`,
    });
  }

  function renderDaily(target, { rows, adRows, otherAds, spError, profit, returns } = {}) {
    const byDate = source => new Map((Array.isArray(source?.rows) ? source.rows : []).map(row => [row.report_date, row]));
    const profits = byDate(profit);
    const returnsByDate = byDate(returns);
    const dailyRows = scopedDailyAds(rows, adRows, otherAds).map(row => {
      const appSessions = numeric(own(row, 'app_sessions'));
      const visits = numeric(own(row, 'visits'));
      const dailyProfit = profits.get(row.report_date);
      const profitBasis = numeric(dailyProfit?.profit_before_ads);
      const salesBasis = numeric(dailyProfit?.sales_basis);
      const adCost = numeric(row.ad_cost);
      const estimate = !spError && !otherAds?.error && profitBasis !== null && adCost !== null && adCost >= 0 &&
        salesBasis !== null && salesBasis === numeric(row.sales) ? profitBasis - adCost : null;
      const movement = returnsByDate.get(row.report_date);
      return {
        ...row,
        ...estimateDailyOrderSplit(row),
        profit: estimate,
        gross_margin: ratio(estimate, salesBasis),
        returns_rate: ratio(movement?.return_units, movement?.shipped_units),
        ad_cost_of_sales: ratio(row.ad_cost, row.sales),
        app_session_share: appSessions !== null && visits !== null && appSessions >= 0 && appSessions <= visits
          ? ratio(appSessions, visits) : null,
        unit_session_rate: ratio(own(row, 'units'), visits),
      };
    });
    const trafficNote = '订单取销售流量报表的订单商品数，不等于独立订单数。总访客数取各子 ASIN 会话数之和，未去重。转化 = 订购件数 ÷ 会话数；APP 流量占比 = APP 会话数 ÷ 会话数。';
    const orderEstimateNote = '运营估算：自然订单 = 订单商品数 − 广告归因订单，两项占比均除以订单商品数。广告订单超过订单商品数时，广告占比按原值显示，自然订单及其占比留空。';
    const profitNote = '预估利润按当前目录的商品成本、头程、FBA 配送费、佣金和税率，并扣除当日已归属广告费。未纳入独立促销、退款或结算调整。毛利率 = 预估利润 ÷ 销售额；所需数据缺失显示「—」。';
    const returnsNote = 'FBA 退货率 = 当天仓库收到的 FBA 退货件数 ÷ 当天 FBA 发货件数。反映当日进出量，不是同一批订单的退货率；缺报表或当天无发货时显示「—」。';
    renderTable(target, {
      columns: dailyColumns, rows: dailyRows, label: '每日销售与流量',
      note: [trafficNote, '广告销售额和广告订单取归因数据。广告费占总销售额 = 已归属广告费 ÷ 同日销售额。',
        advertisingNotice(dailyRows, false, otherAds?.error, spError, false), orderEstimateNote, profitNote, returnsNote,
        profit?.error ? '暂时无法读取预估利润。' : '', returns?.error ? '暂时无法读取 FBA 退货数据。' : ''].filter(Boolean).join(' '),
      emptyText: '所选日期范围暂无数据。',
    });
  }

  function scopedDailyAds(rows, adRows, otherAds) {
    const byDay = new Map((Array.isArray(adRows) ? adRows : []).map(row => [row.report_date, row]));
    const dailyRows = (Array.isArray(rows) ? rows : []).map(row => {
      const ad = byDay.get(row.report_date);
      return { ...row, sp_cost: ad?.sp_cost, sp_sales: ad?.sp_sales, sp_orders: ad?.sp_orders,
        sp_impressions: ad?.sp_impressions, sp_clicks: ad?.sp_clicks,
        sp_sales_share: ratio(ad?.sp_sales, row.sales), sp_acos: ratio(ad?.sp_cost, ad?.sp_sales) };
    });
    return advertisingRows(dailyRows, 'report_date', aggregateOtherAds(otherAds?.rows, date => date), otherAds?.coverage ?? otherAds?.pending);
  }

  function renderDailyAds(target, { rows, adRows, otherAds, spError } = {}) {
    const scopedRows = scopedDailyAds(rows, adRows, otherAds);
    renderTable(target, {
      columns: advertisingColumns(scopedRows, true), rows: scopedRows, label: '每日广告结构',
      note: advertisingNotice(scopedRows, true, otherAds?.error, spError),
      emptyText: '所选日期范围暂无可展示的日报。',
    });
  }

  window.MCWeeklyResultTables = Object.freeze({ render, renderDaily, renderDailyAds, renderSearch, weekLabel, keywordColumns, attributeColumns });
})();
