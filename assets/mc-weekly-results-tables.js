(function () {
  'use strict';

  const missing = '—';
  const pageSize = 50;
  const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 });
  const spNotice = 'SP 指商品推广，订单和销售额采用 7 天归因，可能包含其他 SKU。仅展示能归属所选范围的数据。';
  const weeklyReturnsNotice = 'FBA 周退货率 = 全周收退件数 ÷ 全周发货件数。退货和发货数据都需齐全 7 天；当周无发货时显示「—」。该比率反映当周进出量。';
  const channelOrder = ['SP', 'SB', 'SD'];
  const otherAdChannels = channelOrder.slice(1);
  const channelMetrics = ['cost', 'sales', 'orders'];
  const manualFeeKeys = ['review_fee', 'offsite_fee', 'other_fee'];
  const numberKinds = new Set(['usd', 'num', 'int', 'pct']);
  const compactHeadings = Object.freeze({
    '出现次数(多个日期与活动)': ['出现次数', '多日/多活动'],
    '平均:份额排名': ['份额排名', '平均'],
    '开始点击日期': ['首次点击'],
    '最后点击日期': ['末次点击'],
    '已订购商品数量': ['订购件数'],
    '自然订单（估算）': ['自然订单', '估算'],
    '自然单占比（估算）': ['自然单占比', '估算'],
    '广告单占比（估算）': ['广告单占比', '估算'],
    '利润（估算）': ['利润', '估算'],
    '毛利率（估算）': ['毛利率', '估算'],
    'FBA 退货率': ['FBA 退货率', '当日收退 / 发货'],
    'FBA 周退货率': ['FBA 退货率', '全周收退 / 发货'],
    '广告费占总销售额': ['广告费占', '总销售额'],
    '订单毛利（估算）': ['订单毛利', '估算'],
    '订单毛利率（估算）': ['订单毛利率', '估算'],
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

  function reportColumn(key, prefix, suffix, kind, tone = 'ad') {
    return Object.freeze({ ...col(key, prefix + suffix, kind), tone, lines: Object.freeze([prefix, suffix]) });
  }

  const advertisingMetrics = [
    col('sales', '总销售额', 'usd'),
    reportColumn('sp_cost', 'SP', '广告费', 'usd'),
    reportColumn('sp_sales', 'SP广告', '销售额', 'usd'),
    reportColumn('sp_sales_share', 'SP广告', '销售额占比', 'pct'),
    reportColumn('sp_orders', 'SP广告', '订单', 'int'),
    reportColumn('sp_impressions', 'SP广告', '展现', 'int'),
    reportColumn('sp_clicks', 'SP广告', '点击量', 'int'),
    reportColumn('sp_conversion_rate', 'SP广告', '转化率', 'pct'),
    reportColumn('organic_sales', '自然', '销售额', 'usd', 'organic'),
    reportColumn('organic_sales_share', '自然', '销售额占比', 'pct', 'organic'),
    reportColumn('organic_orders', '自然', '订单', 'int', 'organic'),
    reportColumn('organic_clicks', '自然', '点击量', 'int', 'organic'),
    reportColumn('organic_conversion_rate', '自然', '转化率', 'pct', 'organic'),
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

  function productTrafficMetrics(row, reasons) {
    // BR and advertising have different attribution windows. A negative residual is not a natural sale.
    const sales = numeric(row.br_sales);
    const adSales = numeric(row.ad_sales);
    const orders = numeric(row.br_orders);
    const adOrders = numeric(row.ad_orders);
    const spOrders = numeric(row.sp_orders);
    const isCount = value => Number.isSafeInteger(value) && value >= 0;
    const adReadIssue = row.ad_read_error ? 'SB、SD 数据读取失败。' :
      row.coverage?.sp !== 'ready' ? 'SP 报表未齐。' : '';
    let salesIssue = adReadIssue;
    if (!salesIssue && (sales === null || sales < 0 || adSales === null || adSales < 0 || numeric(row.sp_sales) === null)) {
      salesIssue = '缺少有效的 BR 销售额或广告归因销售额。';
    }
    const difference = salesIssue ? null : sales - adSales;
    if (!salesIssue && difference < -Number.EPSILON * Math.max(1, sales, adSales) * 4) {
      salesIssue = '广告归因销售额超过同期 BR 销售额，无法估算自然销售额。';
    }
    const orderIssue = adReadIssue || (!isCount(orders) || !isCount(adOrders) || !isCount(spOrders)
      ? '缺少有效的 BR 订单商品数或广告归因订单。' : '');
    const splitIssue = orderIssue || (adOrders > orders ? '广告归因订单超过同期 BR 订单商品数，无法估算自然订单。' : '');
    const organicSales = salesIssue ? null : Math.max(0, difference);
    if (salesIssue) reasons.organic_sales = reasons.organic_sales_share = [salesIssue];
    else if (sales === 0) reasons.organic_sales_share = ['同期 BR 总销售额为零。'];
    if (splitIssue) reasons.organic_orders = reasons.organic_order_share = [splitIssue];

    const hasOtherAds = otherAdChannels.some(channel => row.ad_channels.includes(channel));
    const spClicks = numeric(row.sp_clicks);
    const spImpressions = numeric(row.sp_impressions);
    const spConversionIssue = row.coverage?.sp !== 'ready' ? 'SP 报表未齐。' :
      !isCount(spOrders) || !isCount(spClicks) ? '缺少有效的 SP 归因订单或 SP 广告点击量。' :
      spClicks === 0 ? 'SP 广告点击量为零。' : '';
    if (spConversionIssue) reasons.sp_conversion_rate = [spConversionIssue];
    const clickIssue = adReadIssue || (hasOtherAds ? '已归属的 SB 或 SD 报表未提供对应点击量。' :
      !row.ad_channels.includes('SP') || !isCount(spClicks) ? '缺少已计入广告渠道的点击量。' : '');
    const adClicks = clickIssue ? null : spClicks;
    const adCtrIssue = clickIssue || (!isCount(spImpressions) ? '缺少已计入广告渠道的展示量。' :
      spImpressions === 0 ? '广告展示量为零。' : '');
    const adConversionIssue = clickIssue || (!isCount(adOrders) ? '缺少已计入广告渠道的归因订单。' :
      adClicks === 0 ? '广告点击量为零。' : '');
    // The workbook specifies BR sessions as its total-click proxy.
    const visits = numeric(row.sessions);
    const organicClickIssue = clickIssue || (row.coverage?.br !== 'ready' || !isCount(visits) ? '缺少有效的 BR 总访客数。' :
      adClicks > visits ? '广告点击量超过总访客数，无法估算自然点击量。' : '');
    const organicClicks = organicClickIssue ? null : visits - adClicks;
    const organicOrders = splitIssue ? null : orders - adOrders;
    const organicConversionIssue = organicClickIssue || splitIssue || (organicClicks === 0 ? '估算的自然点击量为零。' : '');
    if (clickIssue) reasons.ad_clicks = [clickIssue];
    if (adCtrIssue) reasons.ad_ctr = [adCtrIssue];
    if (adConversionIssue) reasons.ad_conversion_rate = [adConversionIssue];
    if (organicClickIssue) reasons.organic_clicks = [organicClickIssue];
    if (organicConversionIssue) reasons.organic_conversion_rate = [organicConversionIssue];

    return {
      sp_conversion_rate: spConversionIssue ? null : ratio(spOrders, spClicks),
      organic_sales: organicSales,
      organic_sales_share: ratio(organicSales, sales),
      organic_orders: organicOrders,
      organic_order_share: ratio(organicOrders, orders),
      ad_order_share: orderIssue ? null : ratio(adOrders, orders),
      ad_clicks: adClicks,
      organic_clicks: organicClicks,
      ad_ctr: adCtrIssue ? null : ratio(adClicks, spImpressions),
      organic_conversion_rate: organicConversionIssue ? null : ratio(organicOrders, organicClicks),
      ad_conversion_rate: adConversionIssue ? null : ratio(adOrders, adClicks),
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

  function validFee(value) {
    const amount = numeric(value);
    return amount !== null && amount >= 0 && amount <= 9_999_999_999.99 &&
      amount === Math.round(amount * 100) / 100 ? amount : null;
  }

  function sumFees(row) {
    const cents = addKnown(manualFeeKeys.map(key => {
      const amount = validFee(own(row, key));
      return amount === null ? null : Math.round(amount * 100);
    }));
    return cents === null ? null : cents / 100;
  }

  function aggregateOtherAds(rows, keyOf) {
    const periods = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!otherAdChannels.includes(row?.channel) || !dateValue(row.report_date)) continue;
      const key = keyOf(row.report_date);
      const values = channelNumbers(row);
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
      const statuses = row._parentAds.applicable ? byWeek.get(monday(period)) : null;
      const readError = row._parentAds.readError;
      const scope = names.length === 1 ? `仅 ${names[0]}` : names.join(' + ') || missing;
      const pending = otherAdChannels.filter(channel => ['unmapped', 'partial'].includes(statuses?.get(channel)));
      const missingReports = otherAdChannels.filter(channel => statuses?.get(channel) === 'missing');
      const noRows = otherAdChannels.filter(channel => statuses?.get(channel) === 'empty');
      const details = readError ? ['SB、SD 读取失败'] : [
        missingReports.length ? `${missingReports.join('、')} 缺报，暂未计入` : '',
        pending.length ? `${pending.join('、')} 未归属部分未计入` : '',
      ].filter(Boolean);
      const result = {
        ...row,
        ad_scope: details.length ? `${scope}（${details.join('；')}）` : scope,
        ad_channels: names,
        ad_pending: pending,
        ad_missing_reports: missingReports,
        ad_empty: noRows,
        ad_read_error: Boolean(readError),
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

  function advertisingColumns(daily) {
    return [
      daily ? col('report_date', '日期', 'date') : col('week_start', '日期', 'week'),
      ...advertisingMetrics,
    ];
  }

  function advertisingNotice(rows, daily) {
    const seen = new Set(rows.flatMap(row => row.ad_channels));
    const names = channelOrder.filter(channel => seen.has(channel));
    const pending = new Set(rows.flatMap(row => row.ad_pending));
    const missingReports = new Set(rows.flatMap(row => row.ad_missing_reports));
    const confirmedEmpty = otherAdChannels.filter(channel => rows.length && rows.every(row => row.ad_empty.includes(channel)));
    const join = values => otherAdChannels.filter(channel => values.has(channel)).join('、');
    const notices = [
      names.length ? `统计范围：${names.length === 1 ? `仅 ${names[0]}` : names.join(' + ')}，只计入能归属所选范围的数据。` : '所选范围暂无可归属的广告数据。',
      '总销售额取同期 BR 销售额。SP 广告销售额占比和自然销售额占比均以总销售额为分母。SP 广告转化率为 SP 归因订单除以 SP 广告点击量。',
      names.length > 1 ? '估算自然销售额和自然订单时扣除所列统计范围内各广告渠道的归因数据。各渠道归因窗口可能不同，归因订单未跨渠道去重。' : '',
      seen.has('SP') ? spNotice : '',
      pending.size ? `${join(pending)} 有广告报表，但部分或全部记录未能归属产品，未归属部分未计入。` : '',
      missingReports.size ? `部分期间缺少 ${join(missingReports)} 报表，这些期间先按已知费用估算毛利。` : '',
      confirmedEmpty.length ? `${confirmedEmpty.join('、')} 在本表期间的源报表无记录。` : '',
      rows.some(row => row.ad_read_error) ? '暂时无法核对 SB、SD，未把缺失数据按 0 计。' : '',
      daily ? `按报表实际日期展示；有可归属广告数据的日期：${rows.filter(row => row.ad_channels.length).length} / ${rows.length}。` : '',
    ];
    return notices.filter(Boolean).join(' ');
  }

  function weekLabel(value) {
    const end = dateValue(value);
    if (!end) return missing;
    const thursday = new Date(end);
    thursday.setUTCDate(thursday.getUTCDate() + 3 - ((end.getUTCDay() + 6) % 7));
    const weekNumber = 1 + Math.floor((Date.UTC(thursday.getUTCFullYear(), thursday.getUTCMonth(), thursday.getUTCDate()) -
      Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 604800000);
    end.setUTCDate(end.getUTCDate() + 6);
    return `US·周${weekNumber} | ${value} 至 ${end.toISOString().slice(0, 10)}`;
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

  function renderColumnHeading(column, sort) {
    const heading = element('th');
    heading.scope = 'col';
    heading.dataset.column = column.key;
    heading.dataset.kind = column.kind;
    if (column.tone) heading.classList.add('metric-' + column.tone);
    if (numberKinds.has(column.kind)) heading.classList.add('results-number');
    const threshold = /^(.*?)\[([^\]]+)\]$/.exec(column.label);
    const [label, hint] = compactHeadings[column.label] ||
      (threshold ? [threshold[1].replace(/^计算:/, ''), `[${threshold[2]}]`] : [column.label]);
    const caption = element('span', 'results-column-label', label);
    // Split at a metric boundary while keeping the original label and sort key.
    const lines = column.lines || (!hint && label.length >= 5 &&
      /^(已归属广告|交易订单|自然单(?=占比)|广告单(?=占比)|APP流量|客户(?=搜索词)|自然|广告|全部|订单|交易|(?:SP|SB|SD) (?=归因))(.+)$/.exec(label)?.slice(1));
    if (lines) caption.replaceChildren(...lines.map(line => element('span', 'results-heading-line', line)));
    heading.append(caption);
    if (hint) heading.append(element('span', 'results-column-hint', hint));
    if (label !== column.label || hint) {
      heading.title = column.label;
      heading.setAttribute('aria-label', column.label);
    }
    if (sort) {
      const active = sort.key === column.key;
      const direction = active ? sort.direction : null;
      const button = element('button', 'results-analysis-sort');
      button.type = 'button';
      button.dataset.analysisSort = column.key;
      button.setAttribute('aria-label', `按${column.label}排序`);
      const contents = [...heading.children];
      heading.replaceChildren();
      button.append(...contents);
      const arrow = element('span', 'results-analysis-sort-icon', direction === 'desc' ? '▼' : direction === 'asc' ? '▲' : '↕');
      arrow.setAttribute('aria-hidden', 'true');
      button.append(arrow);
      button.addEventListener('click', event => sort.choose(column, event?.detail === 0));
      if (active) heading.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
      heading.append(button);
    }
    return heading;
  }

  function renderTable(target, { columns, rows, week, label, note, emptyText, summary, summaryLabel, sort, numbered = false }) {
    if (!target) return;
    const wrapper = element('div', 'results-table-scroll');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', `${label}数据表，可横向滚动`);
    const table = element('table', 'results-table results-table-compact');
    table.setAttribute('aria-label', label);
    const head = element('thead');
    const headings = element('tr');
    if (numbered) headings.append(renderColumnHeading(col('row_number', '序号', 'int')));
    for (const column of columns) headings.append(renderColumnHeading(column, sort));
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
      const start = (page - 1) * pageSize;
      const pageRows = rows.slice(start, start + pageSize);
      let rowNumber = start;
      if (summary) pageRows.unshift(summary);
      for (const row of pageRows) {
        const tr = element('tr');
        if (summary && row === summary) tr.dataset.summary = 'true';
        if (numbered) {
          const cell = element('td', 'results-number', row === summary ? '' : String(++rowNumber));
          cell.dataset.column = 'row_number';
          tr.append(cell);
        }
        const current = Boolean(week && own(row, 'week_start') === week);
        if (current) tr.dataset.selectedWeek = 'true';
        columns.forEach((column, index) => {
          const summaryHeading = row === summary && index === 0 && summaryLabel;
          const formatted = summaryHeading ? { text: summaryLabel } : format(sheetValue(row, column), column.kind);
          const cell = element(index === 0 ? 'th' : 'td', '', formatted.text);
          cell.dataset.column = column.key;
          cell.dataset.kind = column.kind;
          if (column.tone) cell.classList.add('metric-' + column.tone);
          if (!summaryHeading && column.kind === 'week' && formatted.text !== missing) {
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
          const reasons = row._missingReasons?.[column.key];
          if (formatted.text === missing && Array.isArray(reasons) && reasons.length) {
            const info = element('details','results-profit-details');
            const known = column.key === 'order_profit_net' ? row._knownOrderProfit :
              column.key === 'txn_profit' ? row._knownTxnProfit : null;
            const caption = numeric(known) === null ? '— 原因' :
              (row._skuProfitOnly ? 'SKU 毛利 ' : '已知毛利 ') + dollars.format(known) +
                (row._deductedParentAds ? '（已扣可归属父款广告）' : '');
            const summary = element('summary', '', caption);
            summary.setAttribute('aria-label', column.label + '，' + caption + '，展开原因');
            const list = element('ul');
            reasons.forEach(text=>list.append(element('li','',text)));
            info.append(summary,list);
            cell.replaceChildren(info);
          }
          setHighlight(cell, formatted.number, column.rule);
          tr.append(cell);
        });
        fragment.append(tr);
      }
      if (!rows.length) {
        const tr = element('tr');
        const cell = element('td', 'results-table-note', emptyText);
        cell.colSpan = columns.length + (numbered ? 1 : 0);
        tr.append(cell);
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

  const analysisRatios = Object.freeze({
    avg_order_value:['sales','orders'], cpc:['cost','clicks'], cpa:['cost','orders'],
    ctr:['clicks','impressions'], cvr:['orders','clicks'], acos:['cost','sales'],
  });
  const analysisCollator = new Intl.Collator('zh-CN', { numeric:true, sensitivity:'base' });
  const normalizeSearch = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();

  function analysisValue(row, column) {
    const value = sheetValue(row,column);
    if (numberKinds.has(column.kind)) {
      const percentText = column.kind === 'pct' && typeof value === 'string' && value.trim().endsWith('%');
      const n = numeric(percentText ? value.trim().slice(0,-1) : value);
      if (n === null || (column.kind === 'int' && !Number.isSafeInteger(n))) return null;
      return percentText ? n/100 : n;
    }
    if (column.kind === 'date') return dateValue(value) ? value : null;
    return typeof value === 'string' && value.trim() ? value : null;
  }

  // Attribute rows overlap. Source membership, never splitting the displayed term, identifies which
  // complete terms contributed. Check RPC word frequencies before using that membership to report totals.
  function attributeIndex(keywords) {
    const byName = new Map(), unique = new Set();
    for (const row of keywords) {
      if (!row || typeof row.term !== 'string' || unique.has(row.term) ||
          !Array.isArray(row.attributes) || !row.attributes.length ||
          row.attributes.some(a=>typeof a !== 'string' || !a.trim())) return null;
      unique.add(row.term);
      for (const a of new Set(row.attributes)) {
        if (!byName.has(a)) byName.set(a,[]);
        byName.get(a).push(row);
      }
    }
    return byName;
  }

  function analysisSummary(chosen, primary, membership) {
    const attr = primary === 'attribute';
    const summary = { [primary]: '筛选汇总' };
    let basis = chosen, basisColumns = keywordColumns;
    if (attr) {
      const matched = new Set();
      const complete = chosen.every(row => {
        const group = membership?.get(sheetValue(row,attributeColumns[0]));
        const frequency = analysisValue(row,attributeColumns[1]);
        if (!group || group.length !== frequency) return false;
        for (const term of group) matched.add(term);
        return true;
      });
      if (complete) {
        basis = [...matched];
        summary.word_frequency = basis.length;
      } else if (chosen.length === 1) {
        // A single source attribute is already de-duplicated within that attribute.
        basisColumns = attributeColumns;
        summary.word_frequency = analysisValue(chosen[0],attributeColumns[1]);
      } else {
        return { summary, explanation:'这些属性缺少完整的搜索词归属明细，汇总无法去重；相关指标显示「—」。' };
      }
    }
    const columns = Object.fromEntries(basisColumns.map(c=>[c.key,c]));
    const value = (row,key) => columns[key] ? analysisValue(row,columns[key]) : null;
    function total(key) {
      if (basis.length === 0) return key === 'market_impressions' ? null : 0;
      let sum = 0;
      for (const row of basis) {
        const part = value(row,key);
        if (part === null) return null;
        sum += part;
      }
      return Number.isFinite(sum) ? sum : null;
    }
    for (const key of ['occurrences','market_impressions','impressions','clicks','cost','orders','sales']) summary[key]=total(key);
    for (const [k,[n,d]] of Object.entries(analysisRatios)) summary[k]=ratio(summary[n],summary[d]);
    // Rank and source search share have no cross-term weighting contract.
    if (basis.length === 1) for (const key of ['rank','share']) summary[key] = value(basis[0],key);
    if (!attr) {
      const days = new Set();
      const datesKnown = basis.every(row => {
        if (!Array.isArray(row.click_dates) || row.click_dates.length !== value(row,'click_days') ||
            row.click_dates.some(d => !dateValue(d))) return false;
        const one = new Set(row.click_dates);
        if (one.size !== row.click_dates.length) return false;
        for (const date of one) days.add(date);
        return true;
      });
      summary.click_days = datesKnown ? days.size : basis.length === 1 ? value(basis[0],'click_days') : null;
      for (const [k,num] of [['daily_clicks','clicks'],['daily_orders','orders'],['daily_spend','cost'],
        ['daily_impressions','impressions'],['daily_market_impressions','market_impressions']]) summary[k]=ratio(summary[num],summary.click_days);
      if (datesKnown) {
        const sorted = [...days].sort();
        summary.first_click = sorted[0]; summary.last_click = sorted[sorted.length-1];
      } else {
        for (const [key,which] of [['first_click','min'],['last_click','max']]) {
          let date = null, complete = true;
          for (const row of basis) {
            if (value(row,'click_days') === 0) continue;
            const v = value(row,key);
            if (v === null) { complete=false; break; }
            if (date === null || (which === 'min' ? v<date : v>date)) date=v;
          }
          summary[key] = complete ? date : null;
        }
      }
    }
    return { summary, explanation:attr && chosen.length
      ? (summary.word_frequency == null ? '' : `覆盖 ${integer.format(summary.word_frequency)} 个不同搜索词。`)
      : '' };
  }

  function renderAnalysis(target,{columns,rows,membership,label,note,emptyText}) {
    if (!target) return;
    const primary=columns[0].key;
    const attr=primary==='attribute';
    const fields=Object.fromEntries(columns.map(c=>[c.key,c]));
    const toolbar=element('div','results-analysis-controls');
    toolbar.setAttribute('role','group');
    toolbar.setAttribute('aria-label',`${label}筛选`);
    const count=element('p','results-analysis-count');
    count.setAttribute('aria-live','polite');
    const data=element('div','results-analysis-content');
    function field(name,captionText,tag) {
      const labelEl=element('label','results-field results-analysis-field');
      const caption=element('span','',captionText);
      const control=element(tag);
      control.dataset.analysisControl=name;
      labelEl.append(caption,control); toolbar.append(labelEl);
      return control;
    }
    function option(select,value,title) {
      const node=element('option','',title); node.value=value; select.append(node);
    }
    const query=field('query','包含搜索','input');
    query.type='search'; query.placeholder=attr?'输入属性的一部分':'输入搜索词的一部分';
    const order=field('order','出单状态','select');
    for (const [v,l] of [['all','全部'],['yes','已出单'],['no','未出单']]) option(order,v,l);
    const metric=field('metric','筛选指标','select');
    for (const c of columns.filter(c=>numberKinds.has(c.kind))) option(metric,c.key,`${c.label.replace(/^计算:/,'').replace(/\[.*$/,'')}${c.kind === 'pct' ? ' (%)' : ''}`);
    const min=field('min','最低值（含）','input');
    const max=field('max','最高值（含）','input');
    for(const input of [min,max]){input.type='number';input.step='any';input.placeholder='不限';}
    const reset=element('button','results-button','清除筛选和排序');
    reset.type='button';reset.dataset.analysisControl='reset';toolbar.append(reset);
    target.replaceChildren(toolbar,count,data);
    function defaults() { query.value='';order.value='all';metric.value='cost';min.value='';max.value=''; }
    function orderKey(v) {return v===null ? null : v>0?'yes':v===0?'no':null;}
    const cached=rows.map(row=>({row,term:normalizeSearch(sheetValue(row,columns[0])),order:orderKey(analysisValue(row,fields.orders))}));
    let sortKey=null,direction=null;
    function refresh(focusSortKey) {
      const q=normalizeSearch(query.value);
      const metricCol=fields[metric.value] || fields.cost;
      const lowBlank=String(min.value).trim()==='', highBlank=String(max.value).trim()==='';
      const low=lowBlank ? null : numeric(min.value), high=highBlank ? null : numeric(max.value);
      const invalid=Boolean(min.validity?.badInput || max.validity?.badInput || (!lowBlank && low===null) ||
        (!highBlank && high===null) || (low!==null && high!==null && low>high));
      const bounded=low!==null || high!==null;
      const lowerLimit = low === null ? null : metricCol.kind==='pct' ? low/100 : low;
      const upperLimit = high === null ? null : metricCol.kind==='pct' ? high/100 : high;
      const visible=invalid ? [] : cached.filter(rec=>{
        if (!rec.term.includes(q) || (order.value!=='all' && rec.order!==order.value)) return false;
        if (!bounded) return true;
        const n=analysisValue(rec.row,metricCol);
        return n!==null && (lowerLimit===null || n>=lowerLimit) && (upperLimit===null || n<=upperLimit);
      }).map(rec=>rec.row);
      if (sortKey) {
        const column=fields[sortKey], entries=visible.map(row=>({row,value:analysisValue(row,column)}));
        entries.sort((a,b)=>{
          const x=a.value,y=b.value;
          if (x===null || y===null) return x===y?0:x===null?1:-1;
          return (direction==='asc'?1:-1)*(typeof x==='number'?x-y:analysisCollator.compare(x,y));
        });
        for(let i=0;i<entries.length;i++)visible[i]=entries[i].row;
      }
      const {summary,explanation}=analysisSummary(visible,primary,membership);
      const rowWord=attr?'个属性':'个搜索词';
      count.textContent=invalid?'请输入有效的筛选范围，最低值不能高于最高值。':
        `筛选结果：${integer.format(visible.length)} / ${integer.format(rows.length)} ${rowWord}。${explanation}`;
      if (invalid) {
        data.replaceChildren(element('p','results-empty','筛选范围无效。更正数值后即可查看汇总。'));
        return;
      }
      const scope=attr?'属性可能覆盖同一搜索词；汇总中的词频为不同搜索词数，展现、花费和订单等按搜索词去重。':
        '汇总中的点击天数按日期去重，日均值以这些日期为分母。';
      renderTable(data,{columns,rows:visible,summary,numbered:true,
        label,note:[note,scope,'比率用筛选后的合计重算；点击列名可排序。'].filter(Boolean).join(' '),
        emptyText:rows.length?'没有符合筛选条件的记录。':emptyText,
        sort:{key:sortKey,direction,choose(column,refocus) {
          if (sortKey===column.key) direction=direction==='asc'?'desc':'asc';
          else {sortKey=column.key;direction=numberKinds.has(column.kind)||column.kind==='date'?'desc':'asc';}
          refresh(refocus ? column.key : '');
        }},
      });
      if (focusSortKey) data.querySelector?.(`[data-analysis-sort="${focusSortKey}"]`)?.focus();
    }
    function refreshNow(){ refresh(''); }
    for (const control of [query,min,max]) control.addEventListener('input',refreshNow);
    order.addEventListener('change',refreshNow);
    metric.addEventListener('change',refreshNow);
    reset.addEventListener('click',()=>{defaults();sortKey=null;direction=null;refreshNow();query.focus();});
    defaults();refreshNow();
  }

  function renderSearch(targets, { keyword_rows: keywordRows, attribute_rows: attributeRows, rangeNotice = '', period } = {}) {
    const scope='仅展示归属当前父 ASIN 的搜索词。订单和销售额采用 7 天归因，缺少源数据的指标显示「—」。';
    const daily=period==='day';
    const keywords=Array.isArray(keywordRows)?keywordRows:[];
    const attrs=Array.isArray(attributeRows)?attributeRows:[];
    const notice=[rangeNotice,scope].filter(Boolean).join(' ');
    renderAnalysis(targets.keywords,{columns:keywordColumns,rows:keywords,label:'关键词分析',note:notice,
      emptyText:daily?'此父 ASIN 在所选日期范围暂无关键词分析。':'所选周没有可归属此父 ASIN 的关键词数据。'});
    renderAnalysis(targets.attributes,{columns:attributeColumns,rows:attrs,membership:attributeIndex(keywords),
      label:'属性分析',note:notice,
      emptyText:daily?'此父 ASIN 在所选日期范围暂无属性分析。':'所选周没有可归属此父 ASIN 的属性数据。'});
  }

  const skuSources = [['br','BR'],['sp','SP'],['orders','订单'],['transactions','交易']];
  const skuFinanceColumns = [
    col('order_sales','订单销售额','usd'), col('order_orders','订单 SKU 单数合计','int'),
    col('order_units','订单销量','int'), col('order_profit_net','订单毛利（估算）','usd'),
    col('order_gross_margin','订单毛利率（估算）','pct'),
    col('txn_sales','交易订单销售额','usd'), col('txn_orders','交易 SKU 单数合计','int'),
    col('txn_units','交易销量','int'), col('txn_total','交易净额','usd'), col('txn_refund','交易退款','usd'),
    col('txn_profit','交易毛利（估算）','usd'),
  ];

  function skuContextCoverage(days) {
    const ready = key => days.filter(day=>day.coverage?.[key] === 'ready').length;
    const label = skuSources.map(([key,name])=>`${name} ${ready(key)}/${days.length} 天`).join('、');
    const conflicts = days.reduce((sum,row)=>sum+(row.conflict_count ?? 0),0);
    return `报表到齐：${label}。${conflicts ? `共有 ${conflicts} 条 SKU 日期记录存在归属冲突，受影响的指标留空。` : ''}`;
  }

  const skuAdditiveFields = [
    'br_sales', 'br_orders', 'br_units', 'sessions_app', 'sessions',
    ...skuFinanceColumns.filter(column => column.kind !== 'pct').map(column => column.key),
    'ad_sales', 'ad_cost', 'ad_orders', 'sp_sales', 'sp_cost', 'sp_orders',
    'sp_impressions', 'sp_clicks', 'sp_units', ...manualFeeKeys,
    'base_ad_cost', 'expansion_ad_cost', '_returnUnits', '_shippedUnits',
  ];

  const skuRatioFields = {
    app_session_share: ['sessions_app', 'sessions'],
    unit_session_rate: ['br_units', 'sessions'],
    order_gross_margin: ['order_profit_net', 'order_sales'],
    returns_rate: ['_returnUnits', '_shippedUnits'],
    ad_cost_of_sales: ['ad_cost', 'br_sales'],
    ad_sales_share: ['ad_sales', 'br_sales'],
    ad_acos: ['ad_cost', 'ad_sales'],
    sp_sales_share: ['sp_sales', 'br_sales'],
    sp_acos: ['sp_cost', 'sp_sales'],
  };

  function summarizeSkuRows(rows, daily) {
    if (!rows.length) return null;
    const periodKey = daily ? 'report_date' : 'week_start';
    const periods = [...new Map(rows.map(row => [row[periodKey], row])).values()];
    const total = {};
    const sum = (items, key) => addKnown(items.map(row => numeric(row[key])));
    for (const key of skuAdditiveFields) total[key] = sum(periods, key);
    total.sales = total.br_sales;
    total.orders = total.br_orders;
    for (const [key, [numerator, denominator]] of Object.entries(skuRatioFields)) {
      total[key] = ratio(total[numerator], total[denominator]);
    }

    const verified = periods.filter(row => !row.skuReadError);
    const absent = skuSources.filter(([key]) => verified.some(row => row.coverage?.[key] !== 'ready'));
    const statuses = [];
    if (verified.length < periods.length) statuses.push('经营数据读取失败');
    if (absent.length) statuses.push('待同步：' + absent.map(([, name]) => name).join('、'));
    total.data_coverage = statuses.join('；') || '四类报表已齐';
    const channels = channelOrder.filter(channel => periods.some(row => row.ad_channels.includes(channel)));
    total.ad_scope = channels.length === 1 ? '仅 ' + channels[0] : channels.join(' + ') || missing;
    for (const channel of otherAdChannels) {
      // Only rows attributed to this product participate. A null amount on an attributed row stays unknown.
      const attributed = periods.filter(row => row.ad_channels.includes(channel));
      for (const metric of channelMetrics) {
        const key = channel.toLowerCase() + '_' + metric;
        total[key] = sum(attributed, key);
      }
    }
    for (const key of ['ad_missing_reports', 'ad_pending', 'ad_empty']) {
      total[key] = otherAdChannels.filter(channel => periods.some(row => row[key]?.includes(channel)));
    }
    total.ad_read_error = periods.some(row => row.ad_read_error);
    total.ad_channels = channels;
    const scopeNotes = [...new Set(periods.map(row => row._adScopeNote).filter(Boolean))];
    total._adScopeNote = scopeNotes.join('。');
    if (total.ad_missing_reports.length) scopeNotes.push(total.ad_missing_reports.join('、') + ' 有缺报');
    if (total.ad_pending.length) scopeNotes.push(total.ad_pending.join('、') + ' 有未归属记录');
    if (total.ad_read_error) scopeNotes.push('SB、SD 读取失败');
    if (scopeNotes.length) total.ad_scope += '（' + scopeNotes.join('；') + '，仅计已知归属）';

    // Weekly distinct-term counts cannot be added without the underlying terms.
    if (periods.length === 1) {
      for (const key of ['all_terms', 'organic_terms', 'sp_terms', 'ac_terms']) total[key] = periods[0][key];
    }
    total._skuProfitOnly = periods.every(row => row._skuProfitOnly);
    total._deductedParentAds = periods.some(row => row._deductedParentAds);
    total._knownOrderProfit = addKnown(periods.map(row => row.order_profit_net ?? row._knownOrderProfit));
    total._knownTxnProfit = addKnown(periods.map(row => row.txn_profit ?? row._knownTxnProfit));
    total._missingReasons = {};
    total.coverage = Object.fromEntries(['br', 'sp'].map(source =>
      [source, periods.every(row => row.coverage?.[source] === 'ready') ? 'ready' : 'missing']));
    Object.assign(total, productTrafficMetrics(total, total._missingReasons));
    for (const key of ['sessions','app_session_share','txn_refund','returns_rate']) {
      if (numeric(total[key]) !== null) continue;
      const messages = periods.flatMap(row => (row._missingReasons?.[key] ?? []).map(
        message => row[periodKey] + ' · ' + message));
      if (messages.length) total._missingReasons[key] = messages;
    }
    for (const key of ['order_profit_net', 'txn_profit', 'order_gross_margin']) {
      if (total[key] !== null) continue;
      const incomplete = periods.filter(row => numeric(row[key]) === null);
      total._missingReasons[key] = incomplete.length
        ? incomplete.map(row => row[periodKey] + '：' + (row._missingReasons?.[key]?.join('；') || '必要数据尚未齐全。'))
        : ['筛选期间订单销售额合计须大于零，才能计算毛利率。'];
    }
    return total;
  }

  function weeklySkuFba(week, movements, error, unfinished) {
    const date = dateValue(week);
    if (error || !date || date.getUTCDay() !== 1 || (!unfinished && !movements.size)) {
      return {rate:null,returned:null,shipped:null,note:'暂时无法读取 FBA 退货和发货数据。'};
    }
    const weekRows = Array.from({length:7},()=>{
      const row = movements.get(date.toISOString().slice(0,10));
      date.setUTCDate(date.getUTCDate()+1);
      return row;
    });
    const units = key => weekRows.map(row=>{
      const value = numeric(row?.[key]);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    });
    const returned = units('return_units');
    const shipped = units('shipped_units');
    const returnsDays = returned.filter(value=>value !== null).length;
    const shipmentsDays = shipped.filter(value=>value !== null).length;
    const allShipped = addKnown(shipped);
    const allReturned = addKnown(returned);
    const zeroShipments = !unfinished && allShipped === 0 ? '所选周 FBA 发货件数为 0，无法计算退货率。' : '';
    return {
      returned:unfinished ? null : allReturned,
      shipped:unfinished ? null : allShipped,
      rate:unfinished ? null : ratio(allReturned,allShipped),
      note:`FBA 数据到齐：退货 ${returnsDays}/7 天、发货 ${shipmentsDays}/7 天。${zeroShipments}`,
    };
  }

  const profitSourceNames = {br:'销售与流量',sp:'SP 广告',orders:'订单',transactions:'交易'};
  function skuProfitPolicyNote() {
    return 'SB、SD 按报表日期和父 ASIN 扣费，每个父款在当天只扣一次。没有归属记录的渠道跳过。缺报时按已知费用估算，读取失败或归属记录缺少金额时可展开原因核对。';
  }
  const profitFieldNames = {exchange_rate:'汇率',product_cost_rmb:'采购成本（RMB）',inbound_cost_rmb:'头程（RMB）',
    fba_fee:'FBA 费用',commission_rate:'佣金率',vat_rate:'VAT 税率',sp_cost:'SP 广告费',order_sales:'订单销售额',
    order_units:'订单销量',order_fba_units:'FBA 配送数量',order_promotion:'促销金额',txn_refund:'交易退款',
    txn_total:'交易净额',txn_units:'交易销量'};
  function explainSkuProfit(day,metric) {
    const issues=Array.isArray(day?.profit_issues) ? day.profit_issues.filter(v=>v?.metric===metric) : [];
    if (!issues.length) {
      const missing=Object.keys(profitSourceNames).filter(k=>k!=='br' && (metric==='order_profit'||k!=='orders') && day?.coverage?.[k]!=='ready');
      if (missing.length) return '待同步：'+missing.map(k=>profitSourceNames[k]).join('、');
      if (day?.conflict_count>0) return '存在归属冲突，需核对 SKU 归属和毛利输入。';
      return '缺少成本或计算所需的原始字段；请核对每日经营明细的输入。';
    }
    return issues.map(v=>{
      const src=profitSourceNames[v.field]||'报表';
      const field=profitFieldNames[v.field]||'必要字段';
      const n=Number.isSafeInteger(v.count)&&v.count>1 ? `（${v.count} 个 SKU）` : '';
      const example=typeof v.sku==='string'&&v.sku ? `，SKU：${v.sku}` : '';
      if(v.code==='source_missing') return src+'报表待同步';
      if(v.code==='identity_conflict') return src+'的 SKU 归属冲突'+n;
      if(v.code==='catalog_unmatched') return 'SKU 未匹配到当日目录'+n+example;
      if(v.code==='cost_missing') return (day.profit_cost_mode==='daily'?'缺当日成本：':day.profit_cost_mode==='catalog'?'缺目录成本：':'缺成本：')+field+n+example;
      if(v.code==='source_field_missing') return '原始数据缺'+field+n+example;
      return '计算所需的原始字段不完整';
    }).join('；');
  }

  function parentAdsForPeriod(scope, dates, ownerPartial, readError) {
    if (!scope) return {skuOnly:false, applicable:!ownerPartial, complete:!ownerPartial,
      known:!ownerPartial, readError:!ownerPartial && readError};
    if (scope.mode === 'sku') return {skuOnly:true, applicable:false, complete:false, known:true, readError:false};
    const days = dates.map(date => scope.byDate?.[date]);
    return {
      skuOnly:false, applicable:days.some(day => day?.parents?.length),
      complete:days.length > 0 && days.every(day => day?.known && day.complete),
      known:days.length > 0 && days.every(day => day?.known),
      readError:days.some(day => day?.parents?.length && (day.readError ?? readError)),
    };
  }

  function skuPeriodData({ sku, week = '', otherAds, returns, dailyFees, weeklyNotes }) {
    if (sku?.ownerInScope === false) return {week,rows:[],note:'该时段没有符合所选范围的 SKU。',adError:false};
    const daily = !week;
    const days = sku?.days ?? [];
    const dateKey = daily ? 'report_date' : 'week_start';
    const coverageText = coverage => {
      const absent = skuSources.filter(([key])=>coverage?.[key] !== 'ready').map(([,label])=>label);
      return absent.length ? `待同步：${absent.join('、')}` : '四类报表已齐';
    };
    const weekCoverage = Object.fromEntries(skuSources.map(([key])=>
      [key,days.length === 7 && days.every(day=>day.coverage?.[key] === 'ready') ? 'ready' : 'missing']));
    const ownerPartial = sku?.ownerPartial === true;
    const partialProduct = sku?.productGroup === true && ownerPartial;
    const scope = sku?.parentAdScope;
    const readError = Boolean(otherAds?.error || (sku?.productGroup === true && !otherAds));
    const baseRows = (daily ? days : [{...sku?.totals,week_start:week,coverage:weekCoverage}]).map(raw => ({
      ...raw,
      skuReadError:Boolean(sku?.error),
      _parentAds:parentAdsForPeriod(scope,daily ? [raw.report_date] : days.map(day => day.report_date),ownerPartial,readError),
      data_coverage:sku?.error ? '经营数据读取失败' : coverageText(raw.coverage),
      sales:raw.br_sales,
      orders:raw.br_orders,
      sp_sales_share:ratio(raw.sp_sales,raw.br_sales),
      sp_acos:ratio(raw.sp_cost,raw.sp_sales),
    }));
    const adRows = (otherAds?.rows ?? []).filter(row => scope
      ? scope.mode === 'parents' && scope.byDate?.[row.report_date]?.parents?.includes(row.parent_asin)
      : !ownerPartial);
    const parentAds = aggregateOtherAds(!daily && sku?.unfinished ? [] : adRows, daily ? date => date : monday);
    const scopedRows = advertisingRows(baseRows,dateKey,parentAds,otherAds?.coverage ?? otherAds?.pending);
    const movements = new Map((!returns?.error ? returns?.rows ?? [] : []).map(row=>[row.report_date,row]));
    const weeklyFba = daily ? null : weeklySkuFba(week,movements,returns?.error,sku?.unfinished);
    const expenses = new Map((!dailyFees?.error ? dailyFees?.rows ?? [] : []).map(row=>[row.report_date,row]));
    const summaryRows = scopedRows.map(row=>{
      const date = row[dateKey];
      const savedFees = daily ? expenses.get(date) : weeklyNotes ?
        Object.fromEntries(manualFeeKeys.map(key=>[key,weeklyNotes.notes?.[key] ?? 0])) : null;
      const parentFees = Object.fromEntries(manualFeeKeys.map(key=>[key,partialProduct ? null : validFee(savedFees?.[key])]));
      const parentFeeTotal = sumFees(parentFees);
      const fees = ownerPartial ? Object.fromEntries(manualFeeKeys.map(key => [key, parentFees[key] === 0 ? 0 : null])) : parentFees;
      const feeTotal = sumFees(fees);
      const orderProfit = numeric(row.order_profit);
      const txnProfit = numeric(row.txn_profit);
      const channels = parentAds.get(date) ?? new Map();
      const unknownCost = [...channels.keys()].filter(channel => channels.get(channel).cost === null);
      const adState = row._parentAds;
      const adScopeNote = adState.skuOnly ? 'SKU 明细只计 SP，SB、SD 在父 ASIN 汇总扣除' :
        !adState.known ? '父 ASIN 归属资料不全，仅计已确认范围' :
        !adState.complete ? '仅计完整选中的父 ASIN，共享或部分选中的父款单独核算' : '';
      const adProblem = adState.readError ? 'SB、SD 花费读取失败。' :
        unknownCost.length ? `已归属的 ${unknownCost.join('、')} 广告缺少花费。` : '';
      const adCost = adProblem ? null : channels.size ? addKnown([...channels.values()].map(channel => channel.cost)) : 0;
      const knownFee = Object.values(fees).reduce((sum,value) => sum + (value ?? 0),0);
      const knownOrder = orderProfit !== null && adCost !== null ? orderProfit - adCost - knownFee : null;
      const knownTxn = txnProfit !== null && adCost !== null ? txnProfit - adCost : null;
      const net = adState.complete && feeTotal !== null ? knownOrder : null;
      const txnNet = adState.complete ? knownTxn : null;
      const dailyMovement = movements.get(date);
      function reasons(metric, base) {
        const why=[];
        if (sku?.error) why.push(sku.error);
        else if (!daily && sku?.unfinished) why.push('所选周尚未结束，请按日查看已发布的日期。');
        if (base===null && !sku?.error) {
          (daily?[row]:days).filter(d=>numeric(d[metric])===null).forEach(d=>{
            if (!daily && sku?.unfinished && !Number.isInteger(d.conflict_count)) return;
            why.push((daily?'':d.report_date+'：')+explainSkuProfit(d,metric));
          });
        }
        if (adScopeNote) why.push(adScopeNote+'。');
        if (adCost > 0) why.push('已扣所选完整父 ASIN 的 SB、SD 广告费 '+dollars.format(adCost)+'。');
        if (adProblem) why.push(adProblem);
        if (metric==='order_profit' && knownFee > 0) why.push('已扣可归属手动费用 '+dollars.format(knownFee)+'。');
        if (metric==='order_profit' && feeTotal===null) {
          if (partialProduct) why.push('手动费用在完整父款明细中核对。');
          else if (ownerPartial && parentFeeTotal > 0) why.push('父款有手动费用，尚未分配至所选 SKU。');
          else why.push('手动费用读取失败或金额未知，请重新读取费用。');
        }
        if (base!==null && adProblem) why.unshift('扣父款费用前的基础'+(metric==='order_profit'?'订单':'交易')+'毛利 '+dollars.format(base)+'。');
        if (!why.length) why.push('必要数据尚未齐全。');
        return why;
      }
      const missingReasons={};
      const waitingOnWeek = !daily && sku?.unfinished;
      function sourceReason(source, label, unresolved) {
        if (sku?.error) return '经营明细读取失败，请重新查询。';
        if (waitingOnWeek) return '本周尚未结束，可按日查看已发布的日期。';
        if (row.coverage?.[source] !== 'ready') return label + '尚未覆盖所选期间。';
        return unresolved;
      }
      if (numeric(row.txn_refund) === null) {
        missingReasons.txn_refund = [sourceReason('transactions','按美西入账日统计的交易报表','交易报表已到，所选 SKU 的退款金额仍待核对。')];
      }
      if (numeric(row.sessions) === null) {
        missingReasons.sessions = [sourceReason('br','SKU 销售与流量报表','SKU 报表已到，所选范围的会话数仍缺少可归属的流量数据。')];
      }
      if (ratio(row.sessions_app,row.sessions) === null) {
        missingReasons.app_session_share = missingReasons.sessions ?? [numeric(row.sessions) === 0
          ? '所选范围的总会话数为 0，无法计算 APP 占比。'
          : sourceReason('br','SKU 销售与流量报表','所选范围的 APP 会话数缺失。')];
      }
      const returnUnits = daily ? numeric(dailyMovement?.return_units) : weeklyFba.returned;
      const shippedUnits = daily ? numeric(dailyMovement?.shipped_units) : weeklyFba.shipped;
      const returnRate = daily ? ratio(returnUnits,shippedUnits) : weeklyFba.rate;
      if (returnRate === null) {
        if (!daily) missingReasons.returns_rate = [waitingOnWeek ? '本周尚未结束，可按日查看收退与发货件数。' : weeklyFba.note];
        else if (returns?.error) missingReasons.returns_rate = ['FBA 收退或发货数据读取失败，请重新查询。'];
        else if (returnUnits === null || shippedUnits === null) {
          missingReasons.returns_rate = [['收退',returnUnits,dailyMovement?.return_report],
            ['发货',shippedUnits,dailyMovement?.shipment_report]]
            .filter(([,value]) => value === null).map(([label,,published]) => published === true
              ? 'FBA '+label+'报表已到，本次选择的 SKU 无法确认对应件数。'
              : published === false ? '当天 FBA '+label+'报表尚未入库。' : '当天 FBA '+label+'件数暂缺。');
        } else missingReasons.returns_rate = ['当天 FBA 发货件数为 0，无法计算退货率。'];
      }
      if (net===null) missingReasons.order_profit_net=missingReasons.order_gross_margin=reasons('order_profit',orderProfit);
      else if (!(numeric(row.order_sales)>0)) missingReasons.order_gross_margin=['订单销售额为零、负数或缺失，无法计算毛利率。'];
      if (txnNet===null) missingReasons.txn_profit=reasons('txn_profit',txnProfit);
      return {...row,...fees,...productTrafficMetrics(row,missingReasons),_missingReasons:missingReasons,order_profit_net:net,
        _knownOrderProfit:knownOrder,_knownTxnProfit:knownTxn,_skuProfitOnly:adState.skuOnly,
        _deductedParentAds:adCost > 0,_adScopeNote:adScopeNote,
        ad_scope:adScopeNote ? row.ad_scope+'（'+adScopeNote+'）' : row.ad_scope,
        txn_profit:txnNet,
        order_gross_margin:ratio(net,row.order_sales),
        _returnUnits:returnUnits, _shippedUnits:shippedUnits, returns_rate:returnRate,
        app_session_share:ratio(row.sessions_app,row.sessions),unit_session_rate:ratio(row.br_units,row.sessions),
        ad_cost_of_sales:ratio(row.ad_cost,row.br_sales)};
    });
    const costModes = new Set(days.map(day => day.profit_cost_mode).filter(Boolean));
    const costNote = costModes.size === 1 && costModes.has('daily') ? '成本按子 ASIN 和美西日期读取。' :
      costModes.size === 1 && costModes.has('catalog') ? '成本取自子 ASIN 的目录。' : '';
    const feeUnavailable = !partialProduct && (daily ? dailyFees?.error : !weeklyNotes);
    const note = [
      sku?.error || skuContextCoverage(days), costNote,
      sku?.unfinished ? '所选周尚未结束，整周指标留空。' : '',
      daily ? (returns?.error ? '暂时无法读取 FBA 退货和发货数据。' : '') : weeklyFba.note,
      feeUnavailable ? '暂时无法核对手动费用，完整订单毛利待核对。' : '',
    ].filter(Boolean).join(' ');
    return { week, rows: summaryRows, note };
  }

  function skuSummaryColumns(daily) {
    return [
      daily ? col('report_date', '日期', 'date') : col('week_start', '日期', 'week'),
      col('order_profit_net', '利润', 'usd'),
      col('order_gross_margin', '毛利率', 'pct'),
      col('br_sales', '销售额', 'usd'),
      col('organic_sales', '自然销售额', 'usd'),
      col('ad_sales', '广告销售额', 'usd'),
      col('br_orders', '订单', 'int'),
      col('organic_orders', '自然订单', 'int'),
      col('ad_orders', '广告订单', 'int'),
      col('organic_order_share', '自然单占比', 'pct'),
      col('ad_order_share', '广告单占比', 'pct'),
      col('ad_cost', '广告费', 'usd'),
      col('ad_cost_of_sales', '广告费占总销售额', 'pct'),
      col('txn_refund', '退货金额', 'usd'),
      col('returns_rate', '退货率', 'pct'),
      col('app_session_share', 'APP流量占比', 'pct'),
      col('sessions', '总访客数', 'int'),
      col('ad_clicks', '广告点击量', 'int'),
      col('organic_clicks', '自然点击量', 'int'),
      col('ad_ctr', '广告点击率', 'pct'),
      col('unit_session_rate', '总转化', 'pct'),
      col('organic_conversion_rate', '自然转化', 'pct'),
      col('ad_conversion_rate', '广告转化', 'pct'),
    ];
  }

  function renderSku(targets, inputs) {
    const periods = (Array.isArray(inputs) ? inputs : [inputs]).map(skuPeriodData);
    if (targets.summary) renderSkuTable(targets.summary, periods, false);
    if (targets.ads) renderSkuTable(targets.ads, periods, true);
  }

  function renderSkuTable(target, periods, ads) {
    const daily = !periods[0]?.week;
    const dateKey = daily ? 'report_date' : 'week_start';
    const allRows = periods.flatMap(period => period.rows);
    const label = ads ? (daily ? '每日广告' : '产品广告结构') : (daily ? '每日明细' : '周总结');
    const periodText = value => daily ? value : weekLabel(value);
    const priorSelection = target.querySelector('[data-sku-period-filter]')?.value;
    const controls = element('div', 'results-sku-filters');
    const field = element('label', 'results-field');
    const select = element('select');
    select.dataset.skuPeriodFilter = '';
    select.append(new Option(daily ? '全部已选日期' : '全部已选周次', ''));
    const choices = new Set(allRows.map(row => row[dateKey]));
    for (const value of choices) select.append(new Option(periodText(value), value));
    if (choices.has(priorSelection)) select.value = priorSelection;
    field.append(element('span', '', daily ? '筛选日期' : '筛选周次'), select);
    const clear = element('button', 'results-button', '清除筛选');
    clear.type = 'button';
    controls.append(field, clear);
    if (ads) {
      const legend = element('div', 'results-metric-legend');
      legend.append(element('span', 'metric-ad', 'SP 广告指标'), element('span', 'metric-organic', '自然指标'));
      controls.append(legend);
    }
    const data = element('div');
    const explanation = element('details', 'results-sku-notes');
    const detailsBody = element('div');
    explanation.append(element('summary', '', ads ? '查看广告统计口径' : '查看数据到齐情况与计算口径'), detailsBody);
    target.replaceChildren(controls, data, explanation);

    function refresh() {
      const rows = select.value ? allRows.filter(row => row[dateKey] === select.value) : allRows;
      const shownPeriods = periods.filter(period => daily || !select.value || period.week === select.value);
      clear.disabled = !select.value;
      const summary = summarizeSkuRows(rows, daily);
      const statusNotes = [];
      if (summary?._adScopeNote) statusNotes.push(summary._adScopeNote+'。');
      if (summary) {
        if (summary.data_coverage !== '四类报表已齐') statusNotes.push(summary.data_coverage);
        if (summary.ad_read_error || summary.ad_missing_reports.length || summary.ad_pending.length) {
          statusNotes.push('广告统计范围：' + summary.ad_scope);
        }
      }
      renderTable(data, {
        columns: ads ? advertisingColumns(daily) : skuSummaryColumns(daily),
        rows, label, summary, note: statusNotes.join(' · '),
        summaryLabel: '筛选汇总（' + rows.length + (daily ? ' 天）' : ' 周）'),
        emptyText: ads ? '所选期间暂无广告数据。' : '所选期间暂无经营数据。',
      });
      const organicNote = '自然销售额为 BR 销售额减去已归属广告销售额，自然订单为 BR 订单商品数减去已归属广告订单，均为估算值。广告归因可能跨日或跨 SKU。';
      const clickNote = '按模板以 BR 会话数作为总点击量的估算值。自然点击量 = 会话数 − 已归属广告点击量，自然转化率 = 自然订单 ÷ 估算自然点击量。';
      const lines = ads ? [
        advertisingNotice(rows, daily),
        organicNote,
        clickNote,
        '当前仅 SP 提供点击和展现数据。计入 SB 或 SD 时，依赖全渠道点击或展现的数据留空。',
      ] : [
        skuProfitPolicyNote(),
        'SKU 基础毛利计入商品成本、SP 和交易退款。完整订单毛利再扣除可归属的手动费用和 SB、SD 花费。毛利率以订单报表销售额为分母。表内销售额取自 BR 销售与流量报告。',
        organicNote,
        '订单取 BR 订单商品数。总访客数取 BR 会话数。APP流量占比为 APP 会话数除以总会话数。总转化为 BR 订购件数除以总会话数。',
        clickNote,
        '广告点击率 = 已归属广告点击量 ÷ 同范围的广告展现量。广告转化 = 已归属广告订单 ÷ 同范围的广告点击量。当前仅 SP 提供点击和展现数据，计入 SB 或 SD 时，相应指标留空。',
        '退货金额取交易报表的退款金额。' + (daily ? '退货率为当日 FBA 收退件数除以发货件数。' : weeklyReturnsNotice),
        ...shownPeriods.map(period => (daily ? '所查日期范围：' : weekLabel(period.week) + '：') + period.note),
      ];
      detailsBody.replaceChildren(...lines.filter(Boolean).map(line => element('p', 'results-table-note', line)));
    }
    select.addEventListener('change', refresh);
    clear.addEventListener('click', () => { select.value = ''; refresh(); select.focus(); });
    refresh();
  }

  window.MCWeeklyResultTables = Object.freeze({ renderSku, renderSearch, weekLabel, keywordColumns, attributeColumns });
})();
