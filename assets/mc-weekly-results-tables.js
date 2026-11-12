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
  const compactHeadings = Object.freeze({
    '出现次数(多个日期与活动)': ['出现次数', '多日/多活动'],
    '平均:份额排名': ['份额排名', '平均'],
    '开始点击日期': ['首次点击'],
    '最后点击日期': ['末次点击'],
    '运营操作记录': ['运营记录'],
    '已订购商品数量': ['订购件数'],
    '总广告单占比': ['广告单占比'],
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
    col('operation', '运营操作记录', 'note'),
    col('review_fee', '测评费用原币', 'usd'),
    col('offsite_fee', '站外费用原币', 'usd'),
    col('other_fee', '其他费用原币', 'usd'),
  ];

  const adsColumns = [
    col('week_start', '周期', 'week'),
    col('sales', '销售额', 'usd'),
    col('total_ad_sales', '广告销售额', 'usd'),
    col('ad_order_share', '总广告单占比', 'pct'),
    col('total_ad_cost', '总广告花费', 'usd'),
    col('sp_cost', 'SP 广告费', 'usd'),
    col('sp_sales', 'SP 归因销售额', 'usd'),
    col('sp_orders', 'SP 归因订单', 'int'),
    col('sp_impressions', 'SP 展现', 'int'),
    col('sp_clicks', 'SP 点击', 'int'),
    col('sp_acos', 'SP ACOS', 'pct'),
    col('base_ad_cost', '根基广告', 'usd'),
    col('expansion_ad_cost', '拓词广告', 'usd'),
    col('all_terms', '全部流量词', 'int'),
    col('organic_terms', '自然流量词', 'int'),
    col('sp_terms', 'SP 广告词', 'int'),
    col('sb_terms', '品牌广告词', 'int'),
    col('sbv_terms', '视频广告词', 'int'),
    col('ac_terms', 'AC 推荐词', 'int'),
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

  function dateValue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null;
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
    if (kind === 'text' || kind === 'note') return { text: typeof value === 'string' && value.trim() ? value : missing };
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
            cell.replaceChildren(element('span', 'results-week-part', first), document.createTextNode(' 至 '),
              element('span', 'results-week-part', last));
          }
          if (index === 0) {
            cell.scope = 'row';
            if (current) cell.setAttribute('aria-current', 'date');
          }
          if (formatted.number !== undefined) cell.classList.add('results-number');
          if (formatted.text === missing) cell.classList.add('results-missing');
          if (column.kind === 'note') cell.classList.add('results-note-cell');
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
        operation: own(notes, 'operation'),
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
      weeks.set(week, base);
    }
    return [...weeks.values()].sort((a, b) => b.week_start.localeCompare(a.week_start));
  }

  function render(targets, { rows, week, adRows } = {}) {
    const weeklyRows = buildWeeklyRows(rows, adRows, week);
    const spNote = Array.isArray(adRows) && adRows.length ? spNotice : '此父 ASIN 暂无已导入的商品推广结果。';
    renderTable(targets.summary, {
      columns: summaryColumns, rows: weeklyRows, week, label: '周总结',
      note: `${sourceNotice} ${spNote} 利润、退货率及未接入费用显示为 —。`, emptyText: '没有可展示的周期。',
    });
    renderTable(targets.ads, {
      columns: adsColumns, rows: weeklyRows, week, label: '产品广告结构',
      note: `${spNote} 全部广告、活动分类及流量词数据接入前显示为 —。`, emptyText: '没有可展示的周期。',
    });
  }

  function renderSearch(targets, { keyword_rows: keywordRows, attribute_rows: attributeRows } = {}) {
    const scope = '仅展示明确归属当前父 ASIN 的数据。订单和销售额采用 7 天归因。搜索份额、排名和全站展现缺少源数据，显示为 —。';
    renderTable(targets.keywords, {
      columns: keywordColumns, rows: Array.isArray(keywordRows) ? keywordRows : [], label: '关键词分析',
      note: scope,
      emptyText: '此父 ASIN 在所选周暂无关键词分析。',
    });
    renderTable(targets.attributes, {
      columns: attributeColumns, rows: Array.isArray(attributeRows) ? attributeRows : [], label: '属性分析',
      note: scope,
      emptyText: '此父 ASIN 在所选周暂无属性分析。',
    });
  }

  window.MCWeeklyResultTables = Object.freeze({ render, renderSearch, weekLabel, keywordColumns, attributeColumns });
})();
