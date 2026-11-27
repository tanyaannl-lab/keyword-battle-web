(async function () {
  'use strict';
  const auth = await KBAuth.requireAuth('../index.html');
  if (!auth) return;

  const $ = id => document.getElementById(id);
  const model = KBSalesModel;
  const PAGE_SIZE = 50;
  const fmt = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
  const time = value => {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date).replaceAll('/', '-') + ' 美国太平洋时间';
  };
  const descriptions = {
    home: '近 15 天订单与已识别商品的汇总。',
    today: '逐个 ASIN 对比今日与昨日的销量、销售额、订单量和 SP 广告花费。',
    history: '选择开始和结束日期，查看这段时间的销售汇总、每日趋势和商品明细。'
  };
  const viewLabels = { home: '首页', today: '今日数据', history: '历史数据' };
  let currentSnapshot = null;
  let productImages = {};
  let dailyAllRows = [];
  let dailyPage = 0;
  let dailyMessage = '正在加载明细…';
  let dailyRowsSnapshot = null;
  let dailyRowsDimension = null;
  let comparison = null;
  let todayPage = 0;
  let loading = false;
  let dimension = 'child';
  const onHistory = () => location.hash === '#history';
  let historyRange = null;
  let defaultRange = true;
  let historySnapshot = null;
  let historyRequest = null;
  let historySourceVersion = null;
  let historyMessage = '正在加载历史数据…';
  let snapshotNotice = null;
  const expandedChildren = new Set();
  const dimensionLabel = () => dimension === 'parent' ? '父 ASIN' : '子 ASIN';

  $('userEmail').textContent = auth.user?.email || '已登录用户';
  $('loading').remove();
  $('appShell').hidden = false;
  $('logoutBtn').addEventListener('click', async () => {
    await KBAuth.logout();
    location.replace('../index.html');
  });

  function route() {
    const name = Object.hasOwn(viewLabels, location.hash.slice(1)) ? location.hash.slice(1) : 'home';
    for (const link of document.querySelectorAll('[data-sales-view]')) {
      if (link.dataset.salesView === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    for (const [key, id] of Object.entries({ home: 'viewHome', today: 'viewToday', history: 'viewHistory' })) $(id).hidden = key !== name;
    $('viewDescription').textContent = descriptions[name];
    document.title = `销量观察｜${viewLabels[name]}｜关键词作战工具`;
    if (currentSnapshot) {
      renderDimension();
      renderPeriod();
      renderScopeNotice();
      if (onHistory()) loadHistoryRange();
    } else if (onHistory()) renderHistory();
  }

  function setNotice(message, state = '') {
    $('notice').textContent = message;
    $('notice').className = `sales-banner ${state}`;
  }
  function addCell(row, text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = String(text ?? '—');
    if (className) cell.className = className;
    row.appendChild(cell);
    return cell;
  }
  function emptyRow(body, message, columns) {
    const tr = document.createElement('tr');
    addCell(tr, message, 'empty').colSpan = columns;
    body.appendChild(tr);
  }
  function productCell(tr, entry, childDetail = false) {
    const cell = addCell(tr, '', 'sales-product-cell');
    const normalizedAsin = String(entry.asin || '').trim().toUpperCase();
    const imageAsin = String(entry.image_asin || normalizedAsin).trim().toUpperCase();
    const parentGroup = !childDetail && dimension === 'parent' && entry.group_type === 'parent';
    const validAsin = /^[A-Z0-9]{10}$/.test(normalizedAsin);
    const product = document.createElement(validAsin ? 'a' : 'span');
    product.className = 'sales-product';
    if (validAsin) {
      product.href = `https://www.amazon.com/dp/${normalizedAsin}`;
      product.target = '_blank';
      product.rel = 'noopener noreferrer';
      product.setAttribute('aria-label', `查看 ${normalizedAsin} 的亚马逊商品，打开新窗口`);
    }
    const frame = document.createElement('span');
    frame.className = 'sales-product-image';
    if (parentGroup) frame.title = `代表变体主图（子 ASIN：${imageAsin}）`;
    const placeholder = document.createElement('span');
    placeholder.className = 'sales-image-placeholder';
    placeholder.textContent = '暂无图';
    const url = model.imageUrl(productImages[imageAsin]?.image_url);
    frame.appendChild(placeholder);
    if (url) {
      const img = document.createElement('img');
      img.alt = '';
      img.width = 80;
      img.height = 80;
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.addEventListener('load', () => { placeholder.hidden = true; });
      img.addEventListener('error', () => { img.remove(); placeholder.hidden = false; }, { once: true });
      img.src = url;
      frame.appendChild(img);
    }
    const text = document.createElement('span');
    text.className = 'sales-product-text';
    const asinText = document.createElement('span');
    asinText.className = 'sales-asin';
    asinText.textContent = normalizedAsin || '—';
    text.appendChild(asinText);
    if (!childDetail && dimension === 'parent') {
      const detail = document.createElement('span');
      detail.className = parentGroup ? 'sales-variant-count' : 'sales-parent-unknown';
      detail.textContent = parentGroup ? `含 ${fmt(entry.child_asins_count)} 个子 ASIN` : '未识别父 ASIN';
      detail.title = parentGroup ? '图片为代表变体主图；销量与金额汇总该父 ASIN 下的子 ASIN，订单量按订单号去重。' : '暂未识别父子关系，继续单独显示该子 ASIN 的数据。';
      text.appendChild(detail);
    }
    product.append(frame, text);
    cell.appendChild(product);
  }

  function addChildrenExpansion(body, tr, entry, view) {
    if (dimension !== 'parent' || entry.group_type !== 'parent') return;
    const children = model.parentChildren(view === 'history' ? historySnapshot : currentSnapshot, entry.asin, view !== 'home');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sales-child-toggle';
    if (!children.available || !children.asins.length) {
      button.disabled = true;
      button.textContent = children.available ? '暂无子 ASIN 记录' : '子 ASIN 明细待同步';
      button.title = children.available ? '所选期间尚无可展示的子 ASIN 记录。' : '本次发布尚未提供父子 ASIN 明细，请等待后台更新。';
      tr.querySelector('.sales-product-cell').appendChild(button);
      return;
    }
    const key = `${view}:${entry.date || ''}:${entry.asin}`;
    const regionId = `children-${view}-${entry.date || 'period'}-${entry.asin}`;
    button.setAttribute('aria-controls', regionId);
    button.setAttribute('aria-label', `展开 ${entry.asin} 的子 ASIN 明细`);
    tr.querySelector('.sales-product-cell').appendChild(button);
    const detailTr = document.createElement('tr');
    detailTr.className = 'sales-child-detail-row';
    const cell = addCell(detailTr, '', 'sales-child-detail-cell');
    cell.colSpan = tr.children.length;
    const region = document.createElement('div');
    region.id = regionId;
    region.className = 'sales-child-panel';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', `${entry.asin} 的子 ASIN 明细`);
    cell.appendChild(region);
    body.appendChild(detailTr);
    let populated = false;
    const setOpen = open => {
      if (open && !populated) {
        renderChildren(region, entry, view, children.asins.length);
        populated = true;
      }
      detailTr.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', `${open ? '收起' : '展开'} ${entry.asin} 的子 ASIN 明细`);
      button.textContent = `${open ? '▴ 收起' : '▾ 展开'}子 ASIN (${fmt(children.asins.length)})`;
      if (open) expandedChildren.add(key);
      else expandedChildren.delete(key);
    };
    button.addEventListener('click', () => setOpen(!expandedChildren.has(key)));
    setOpen(expandedChildren.has(key));
  }

  function renderChildren(region, entry, view, childCount) {
    const heading = document.createElement('div');
    heading.className = 'sales-child-heading';
    heading.textContent = `${view === 'history' ? '所选期间' : '近 15 天'}有记录的子 ASIN · ${fmt(childCount)} 个${view === 'history' ? ` · ${entry.date}` : ''}`;
    const note = document.createElement('p');
    note.className = 'sales-child-note';
    note.textContent = view === 'today' ? '蓝色为今日，橙色为昨日。广告花费按已同步报表显示。'
      : view === 'history' ? '仅展示该父 ASIN 本行日期的子商品数据。'
      : '按子 ASIN 汇总近 15 天；同一订单含多个子 ASIN 时，子级订单量相加可能高于父级去重订单量。';
    const table = document.createElement('table');
    table.className = `sales-child-table ${view === 'today' ? 'sales-today-table' : ''}`;
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    const suffix = view === 'today' ? '（今日 / 昨日）' : '';
    const labels = ['商品 / 子 ASIN', `销量（件）${suffix}`, `销售额${suffix}`, `订单量${suffix}`];
    if (view !== 'home') labels.push(`SP 广告花费（USD）${suffix}`);
    for (const [index, label] of labels.entries()) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      if (index) th.className = 'sales-number';
      header.appendChild(th);
    }
    head.appendChild(header);
    const childBody = document.createElement('tbody');
    let rows;
    if (view === 'today') rows = model.childrenTodayComparison(currentSnapshot, entry.asin, new Date());
    else if (view === 'history') rows = model.childRowsForDate(historySnapshot, entry.asin, entry.date).map(row =>
      row.data || { asin: row.asin, units: null, sales_amount: null, orders_count: null });
    else rows = model.childrenPeriodRows(currentSnapshot, entry.asin);
    for (const row of rows) {
      const childTr = document.createElement('tr');
      productCell(childTr, row, true);
      if (view === 'today') {
        for (const metric of ['units', 'sales_amount', 'orders_count', 'sp_ads_spend_cents']) pairCell(childTr, row, metric);
      } else {
        addCell(childTr, fmt(row.units), 'sales-number');
        amountCell(childTr, row);
        addCell(childTr, fmt(row.orders_count), 'sales-number');
        if (view === 'history') spendCell(childTr, row, entry.date);
      }
      childBody.appendChild(childTr);
    }
    table.append(head, childBody);
    region.append(heading, note, table);
  }
  function money(value, currency) {
    if (currency === 'MIXED') return '混合币种';
    if (value === null || value === undefined || value === '') return '—';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '—';
    const code = String(currency || 'USD').toUpperCase();
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
    } catch (_) { return `${amount.toFixed(2)} ${code}`; }
  }
  function appendPriceFlags(container, row) {
    const flags = model.priceFlags(row);
    if (!flags.length) return;
    const badges = document.createElement('span');
    badges.className = 'sales-price-badges';
    for (const flag of flags) {
      const badge = document.createElement('span');
      badge.className = `sales-price-badge ${flag.type}`;
      badge.textContent = flag.label;
      badge.title = flag.text;
      badge.tabIndex = 0;
      badge.setAttribute('aria-label', `${flag.label}：${flag.text}`);
      badges.appendChild(badge);
    }
    container.appendChild(badges);
  }
  function amountCell(tr, row) {
    const cell = addCell(tr, '', 'sales-number');
    const amount = document.createElement('span');
    amount.textContent = money(row.sales_amount, row.currency);
    cell.appendChild(amount);
    appendPriceFlags(cell, row);
  }
  function spendTip(date, cents, snapshot = currentSnapshot) {
    const day = model.spAdsDay(snapshot, date);
    if (!day) return '该日期的 SP 广告报表尚未同步。';
    if (cents == null) return '该 ASIN 的 SP 广告花费尚无可用数据。';
    const stamp = time(day.fetched_at);
    return `${stamp === '—' ? 'SP 广告报表已同步' : `报表获取时间：${stamp}`}。${day.provisional !== false ? '当日数据仍可能补齐。' : ''}`;
  }
  function spendCell(tr, row, date = row.date) {
    const cents = row.sp_ads_spend_cents;
    const cell = addCell(tr, money(model.spAdsAmount(cents), 'USD'), 'sales-number sales-sp-ad-cost');
    cell.title = spendTip(date, cents, historySnapshot);
  }
  function pairCell(tr, entry, metric) {
    const cell = addCell(tr, '', 'sales-number');
    const pair = document.createElement('div');
    pair.className = 'sales-pair';
    for (const side of ['today', 'yesterday']) {
      if (side === 'yesterday') {
        const slash = document.createElement('span');
        slash.className = 'sales-pair-slash';
        slash.textContent = '/';
        slash.setAttribute('aria-hidden', 'true');
        pair.appendChild(slash);
      }
      const column = document.createElement('span');
      column.className = `sales-pair-side sales-${side}`;
      const value = document.createElement('span');
      const data = entry[side];
      const formatted = !data ? '—' : metric === 'sales_amount' ? money(data.sales_amount, data.currency)
        : metric === 'sp_ads_spend_cents' ? money(model.spAdsAmount(data[metric]), 'USD') : fmt(data[metric]);
      value.textContent = formatted;
      if (metric === 'sp_ads_spend_cents') {
        column.title = spendTip(comparison?.[side], data?.[metric]);
        column.classList.add('sales-sp-ad-cost');
      }
      const accessibleLabel = document.createElement('span');
      accessibleLabel.className = 'sales-sr-only';
      accessibleLabel.textContent = side === 'today' ? '今日：' : '昨日：';
      column.append(accessibleLabel, value);
      if (metric === 'sales_amount' && data) appendPriceFlags(column, data);
      pair.appendChild(column);
    }
    cell.appendChild(pair);
  }
  function pageState(prefix, count, page, message) {
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    $(`${prefix}Count`).textContent = message || `共 ${fmt(count)} ${prefix === 'today' ? `个 ${dimensionLabel()}${dimension === 'parent' ? '分组（含未识别子 ASIN）' : ''}` : `条日期 + ${dimensionLabel()}明细`}，每页 ${PAGE_SIZE} 条 · 导出包含当前筛选的全部记录`;
    $(`${prefix}PageInfo`).textContent = message ? '—' : `第 ${page + 1} / ${pages} 页`;
    $(`${prefix}PrevBtn`).disabled = !!message || page === 0;
    $(`${prefix}NextBtn`).disabled = !!message || page >= pages - 1;
  }

  function historyFilteredRows() {
    const query = $('dailyAsinFilter').value.trim().toUpperCase();
    return query ? dailyAllRows.filter(row => row.asin.toUpperCase().includes(query)) : dailyAllRows;
  }
  function todayFilteredRows() {
    const query = $('todayAsinFilter').value.trim().toUpperCase();
    return comparison?.rows.filter(row => !query || row.asin.includes(query)) || [];
  }
  function productCount(summary, parentAvailable = true) {
    if (!summary || dimension === 'parent' && !parentAvailable) return null;
    return summary[dimension === 'parent' ? 'parent_asins_count' : 'child_asins_count'];
  }
  function summaryCard(id, row, metric) {
    const container = $(id);
    container.replaceChildren();
    const value = document.createElement('span');
    value.textContent = metric === 'sales_amount' ? row ? money(row.sales_amount, row.currency) : '—'
      : fmt(row?.[metric]);
    container.appendChild(value);
    if (metric === 'sales_amount' && row) appendPriceFlags(container, row);
  }
  function renderTodaySummary() {
    const today = comparison?.today || model.pacificDate();
    const yesterday = comparison?.yesterday || model.previousDate(today);
    const parentAvailable = model.dimensionRows(currentSnapshot, 'parent').available;
    const todaySummary = model.dailySummary(currentSnapshot, today);
    const yesterdaySummary = model.dailySummary(currentSnapshot, yesterday);
    const entry = { today: todaySummary, yesterday: yesterdaySummary };
    for (const [id, metric] of [['todayUnits', 'units'], ['todayAmount', 'sales_amount'], ['todayOrders', 'orders_count']]) {
      const temporaryRow = document.createElement('tr');
      pairCell(temporaryRow, entry, metric);
      $(id).replaceChildren(...temporaryRow.firstElementChild.childNodes);
    }
    const temporaryRow = document.createElement('tr');
    pairCell(temporaryRow, {
      today: todaySummary ? { products: productCount(todaySummary, parentAvailable) } : null,
      yesterday: yesterdaySummary ? { products: productCount(yesterdaySummary, parentAvailable) } : null
    }, 'products');
    $('todayProducts').replaceChildren(...temporaryRow.firstElementChild.childNodes);
    $('todayProductLabel').textContent = dimension === 'parent' ? '商品分组数' : '售出 ASIN 数';
    $('todayProductNote').textContent = dimension === 'parent'
      ? '父 ASIN 分组，包含单独展示的未匹配子 ASIN' : '今日 / 昨日 · 多个 SKU 合并';
    const missing = [!todaySummary && '今日', !yesterdaySummary && '昨日'].filter(Boolean);
    $('todaySummaryStatus').textContent = missing.length
      ? `${missing.join('、')}全店汇总尚未发布，卡片显示“—”；订单量不会由各 ASIN 订单量相加推算。`
      : '蓝色为今日，橙色为昨日。汇总范围为全店已识别商品；ASIN 搜索只筛选下方列表。';
  }
  function rangeLabel() {
    return historyRange ? `${historyRange.start} 至 ${historyRange.end}` : '尚未选择';
  }

  function renderPeriod() {
    const period = currentSnapshot?.payload?.period;
    const text = onHistory() ? rangeLabel() : `${period?.start_date || '—'} 至 ${period?.end_date || '—'}`;
    $('periodText').textContent = model.reportTimezoneMatches(currentSnapshot)
      ? `统计日期：${text}（美国太平洋时间）` : '统计日期：等待后台按美国太平洋时间重新发布';
  }

  function renderScopeNotice() {
    if (!onHistory() || !model.reportTimezoneMatches(currentSnapshot)) {
      if (snapshotNotice) setNotice(snapshotNotice.text, snapshotNotice.state);
      return;
    }
    const summary = historySnapshot?.payload.range_summary;
    const missing = summary?.missing_price_rows;
    const priceNote = Number(missing) > 0 ? `所选期间有 ${fmt(missing)} 条商品明细缺价，销售额尚未补齐。` : '';
    setNotice(['销售额优先采用订单商品实际金额，缺价时按自家售价和订购数量估算。取消订单不计入销售。', priceNote].filter(Boolean).join(' '), priceNote ? 'warn' : '');
  }

  function renderHistorySummary() {
    const data = historySnapshot?.payload;
    const coverage = data?.range_coverage;
    const summary = coverage?.days_with_records > 0 ? data.range_summary : null;
    const productTotal = productCount(summary, data?.parent_asin_available);
    $('historyScopeText').textContent = `${rangeLabel()}（美国太平洋时间）· 全店已识别商品汇总`;
    $('dailyRangeLabel').textContent = rangeLabel();
    $('historyCoverage').textContent = historyMessage || (coverage?.days_with_records > 0
      ? `有销售记录 ${fmt(coverage.days_with_records)} 天，首次记录 ${coverage.recorded_start_date}，末次记录 ${coverage.recorded_end_date}。仅汇总已入库记录。`
      : '所选期间暂无已入库的销售记录。');
    window.MCSalesHistoryChart.render({start: historyRange?.start, end: historyRange?.end,
      days: data?.sales_daily_summaries || [], message: historyMessage});
    summaryCard('historyUnits', summary, 'units');
    summaryCard('historyAmount', summary, 'sales_amount');
    summaryCard('historyOrders', summary, 'orders_count');
    $('historyProducts').textContent = fmt(productTotal);
    $('historyProductLabel').textContent = dimension === 'parent' ? '商品分组数' : '售出 ASIN 数';
    $('historyProductNote').textContent = dimension === 'parent'
      ? '父 ASIN 分组，包含单独展示的未匹配子 ASIN' : '所选期间的去重子 ASIN 数';
  }

  function renderDailyTable() {
    const body = $('dailyRows');
    body.replaceChildren();
    const filtered = historyFilteredRows();
    const message = dailyMessage;
    $('dailyHeading').textContent = `每日${dimensionLabel()}销售明细`;
    dailyPage = Math.min(dailyPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
    const visible = filtered.slice(dailyPage * PAGE_SIZE, (dailyPage + 1) * PAGE_SIZE);
    if (message || !visible.length) emptyRow(body, message || '当前筛选条件下没有明细记录', 6);
    else for (const row of visible) {
      const tr = document.createElement('tr');
      addCell(tr, row.date || '—');
      productCell(tr, row);
      addCell(tr, fmt(row.units), 'sales-number');
      amountCell(tr, row);
      addCell(tr, fmt(row.orders_count), 'sales-number');
      spendCell(tr, row);
      body.appendChild(tr);
      addChildrenExpansion(body, tr, row, 'history');
    }
    pageState('daily', filtered.length, dailyPage, message);
    $('historyExportBtn').disabled = !!message || !filtered.length;
  }
  function setDailyRows(rows, message = '') {
    dailyAllRows = Array.isArray(rows) ? rows.filter(row => row && typeof row.asin === 'string' && typeof row.date === 'string') : [];
    dailyAllRows.sort((a, b) => b.date.localeCompare(a.date) || a.asin.localeCompare(b.asin));
    dailyMessage = message;
    if (message) dailyPage = 0;
    renderDailyTable();
  }
  function renderToday() {
    const body = $('todayRows');
    body.replaceChildren();
    const query = $('todayAsinFilter').value.trim().toUpperCase();
    const rows = todayFilteredRows();
    todayPage = Math.min(todayPage, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
    $('todayDate').textContent = comparison?.today || model.pacificDate();
    $('yesterdayDate').textContent = comparison?.yesterday || model.previousDate(model.pacificDate());
    const missingDates = [];
    if (comparison && !comparison.todayAvailable) missingDates.push(`今日（${comparison.today}）`);
    if (comparison && !comparison.yesterdayAvailable) missingDates.push(`昨日（${comparison.yesterday}）`);
    $('todayStatus').textContent = missingDates.length ? `${missingDates.join('、')}尚无可用发布数据，对应数值显示“—”。` : '';
    $('todayStatus').hidden = !missingDates.length;
    const adsStatus = (label, day) => !day ? `${label}待同步` :
      `${label}${day.provisional !== false ? '暂计' : '已同步'}${time(day.fetched_at) === '—' ? '' : `（报表获取时间：${time(day.fetched_at)}）`}`;
    $('todayAdsStatus').textContent = `SP 广告花费：${adsStatus('今日', comparison?.todayAds)}；${adsStatus('昨日', comparison?.yesterdayAds)}。广告报表可能延迟。`;
    const message = !comparison?.rows.length && (dailyMessage || (!comparison ? '正在加载明细…' :
      !comparison.todayAvailable && !comparison.yesterdayAvailable ? '今日与昨日尚无可用发布数据，请稍后刷新' : '')) || '';
    const visible = rows.slice(todayPage * PAGE_SIZE, (todayPage + 1) * PAGE_SIZE);
    if (message || !visible.length) emptyRow(body, message || (query ? '当前 ASIN 筛选条件下没有记录' : '今日与昨日暂无销售或广告花费记录'), 5);
    else for (const entry of visible) {
      const tr = document.createElement('tr');
      productCell(tr, entry);
      for (const metric of ['units', 'sales_amount', 'orders_count', 'sp_ads_spend_cents']) pairCell(tr, entry, metric);
      body.appendChild(tr);
      addChildrenExpansion(body, tr, entry, 'today');
    }
    pageState('today', rows.length, todayPage, message);
    $('todayExportBtn').disabled = !!message || !rows.length;
    renderTodaySummary();
  }
  function renderTrend(trend) {
    const container = $('trendBars');
    container.replaceChildren();
    const entries = Array.isArray(trend) ? trend : [];
    const max = Math.max(1, ...entries.map(row => Number(row.units) || 0));
    const total = entries.reduce((sum, row) => sum + (Number(row.units) || 0), 0);
    for (const row of entries) {
      const units = Math.max(0, Number(row.units) || 0);
      const item = document.createElement('div');
      item.className = 'sales-bar';
      item.setAttribute('aria-label', `${row.date || '未知日期'}：${fmt(units)} 件`);
      item.title = `${row.date || '未知日期'}：${fmt(units)} 件`;
      const value = document.createElement('span');
      value.className = 'sales-bar-count';
      value.textContent = units ? fmt(units) : '';
      const bar = document.createElement('span');
      bar.className = 'sales-bar-fill';
      bar.style.height = `${Math.max(2, Math.round(units / max * 195))}px`;
      const label = document.createElement('span');
      label.className = 'sales-bar-label';
      label.textContent = String(row.date || '').slice(5) || '—';
      item.append(value, bar, label);
      container.appendChild(item);
    }
    $('unitsSold').textContent = fmt(total);
    $('trendFoot').textContent = entries.length ? `近 15 天已识别商品合计 ${fmt(total)} 件 · 按订单日期统计` : '暂无已发布的趋势数据';
  }
  function renderRanking(ranking) {
    const body = $('rankingRows');
    body.replaceChildren();
    if (!Array.isArray(ranking) || !ranking.length) { emptyRow(body, '暂无已识别的 ASIN 销量记录', 6); return; }
    ranking.forEach((entry, index) => {
      const tr = document.createElement('tr');
      addCell(tr, index + 1, 'sales-rank');
      productCell(tr, entry);
      addCell(tr, dimension === 'parent' ? fmt(entry.child_asins_count) : entry.seller_sku || '—', 'sales-sku');
      const title = addCell(tr, entry.title || '—', 'sales-rank-title');
      title.title = entry.title || '';
      addCell(tr, fmt(entry.units), 'sales-number');
      addCell(tr, fmt(entry.orders_count), 'sales-number');
      body.appendChild(tr);
      addChildrenExpansion(body, tr, entry, 'home');
    });
  }
  function renderDimension() {
    const data = currentSnapshot?.payload || {};
    const source = model.dimensionRows(currentSnapshot, dimension);
    const parentAvailable = model.dimensionRows(onHistory() && historySnapshot ? historySnapshot : currentSnapshot, 'parent').available;
    $('dimensionChild').setAttribute('aria-pressed', String(dimension === 'child'));
    $('dimensionParent').setAttribute('aria-pressed', String(dimension === 'parent'));
    $('dimensionParent').disabled = !parentAvailable;
    const status = $('dimensionStatus');
    status.classList.toggle('warn', !parentAvailable);
    if (!model.reportTimezoneMatches(currentSnapshot)) status.textContent = '等待后台按美国太平洋时间发布数据';
    else if (!parentAvailable) status.textContent = '父 ASIN 关系尚未同步';
    else if (dimension === 'parent') {
      const coverage = onHistory() ? null : data.parent_coverage_15d;
      status.textContent = coverage
        ? `近 15 天：${fmt(coverage.mapped_child_asins)} / ${fmt(coverage.child_asins_total)} 个子 ASIN 已识别父子关系，汇总为 ${fmt(coverage.parent_asins)} 个父 ASIN；${fmt(coverage.unknown_child_asins)} 个未识别子 ASIN 单独显示。`
        : '同一父 ASIN 下的变体合并统计；未识别父子关系的子 ASIN 单独显示。';
    } else status.textContent = '按子 ASIN 查看；可切换父 ASIN 汇总变体数据。';
    const label = dimensionLabel();
    $('rankingHeading').textContent = `${label} 已识别销量排行`;
    for (const id of ['rankingAsinHeading', 'todayAsinHeading', 'dailyAsinHeading']) $(id).textContent = `商品 / ${label}`;
    $('rankingVariantHeading').textContent = dimension === 'parent' ? '子 ASIN 数' : 'SKU';
    $('rankingTitleHeading').textContent = dimension === 'parent' ? '代表变体标题' : '商品标题';
    $('rankingNote').textContent = dimension === 'parent'
      ? '父 ASIN 下的变体合并统计，订单按订单号去重；图片与标题展示代表变体。未识别父 ASIN 的商品继续按子 ASIN 显示。'
      : '排行按商品 SKU 展示；同一子 ASIN 如有多个 SKU，可能出现多行。今日数据与历史数据按子 ASIN 合并。';
    $('todayHeading').textContent = `今日 / 昨日${label}数据`;
    $('todayDescription').textContent = dimension === 'parent'
      ? '同一父 ASIN 下的变体合并显示；按今日销量排序。有花费但未售出的商品也会列出。'
      : '同一子 ASIN 的多个 SKU 合并显示；按今日销量排序。有花费但未售出的商品也会列出。';
    $('dailyHeading').textContent = `每日${label}销售明细`;
    $('dailyDescription').textContent = dimension === 'parent'
      ? '按所选日期和父 ASIN 汇总，未识别父 ASIN 的子 ASIN 单独显示。'
      : '按所选日期和子 ASIN 汇总，同一子 ASIN 的多个 SKU 合并显示。';
    for (const prefix of ['today', 'daily']) {
      $(`${prefix}FilterLabel`).textContent = dimension === 'parent' ? '父 / 未识别子 ASIN' : label;
      $(`${prefix}AsinFilter`).placeholder = dimension === 'parent' ? '搜索父 / 未识别子 ASIN' : '搜索子 ASIN';
    }
    $('todayNote').textContent = `已覆盖日期没有销售记录时，销售指标显示 0；订单按订单号去重。SP 花费为商品推广报表的广告花费，尚无可用记录时显示“—”。${dimension === 'parent' ? '父 ASIN 花费合计已识别的子 ASIN；未识别父 ASIN 的商品单独显示。' : ''}`;
    renderRanking(source.ranking);
    comparison = model.todayComparison(currentSnapshot, new Date(), dimension);
    renderToday();
    if (onHistory()) renderHistory();
  }

  function renderHistory() {
    const source = model.dimensionRows(historySnapshot, dimension);
    const message = historyMessage || (source.available ? '' : '尚无当前 ASIN 维度的每日明细。');
    if (dailyRowsSnapshot !== historySnapshot || dailyRowsDimension !== dimension || dailyMessage !== message) {
      dailyRowsSnapshot = historySnapshot;
      dailyRowsDimension = dimension;
      setDailyRows(source.available ? model.dailyRowsWithSpend(historySnapshot, dimension) : [], message);
    } else renderDailyTable();
    renderHistorySummary();
  }

  const validDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };

  function shiftDate(date, offset) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  }

  function updateRangeControls() {
    if (!model.reportTimezoneMatches(currentSnapshot)) return;
    const end = currentSnapshot.payload.period?.end_date;
    if (!validDate(end)) {
      historyMessage = '后台尚未发布可查询的日期范围。';
      return;
    }
    for (const id of ['historyStart', 'historyEnd']) {
      $(id).min = shiftDate(end, -359);
      $(id).max = end;
    }
    const inputsMatch = historyRange && $('historyStart').value === historyRange.start && $('historyEnd').value === historyRange.end;
    if (!historyRange || defaultRange && inputsMatch && historyRange.end !== end) {
      historyRange = {start: shiftDate(end, -6), end};
      $('historyStart').value = historyRange.start;
      $('historyEnd').value = end;
    }
  }

  function applyHistoryRange(event) {
    event.preventDefault();
    const start = $('historyStart');
    const end = $('historyEnd');
    let field = null;
    let message = '';
    if (!validDate(start.value) || !validDate(end.value)) {
      field = validDate(start.value) ? end : start;
      message = field === end ? '请选择有效的结束日期。' : '请选择有效的开始日期。';
    } else if (start.value > end.value) {
      field = end;
      message = '结束日期须等于或晚于开始日期。';
    } else if (!end.max) {
      message = '正在等待后台发布可查询的日期范围。';
    } else if (start.value < start.min || end.value > end.max) {
      field = start.value < start.min ? start : end;
      message = `可查询的日期为 ${start.min} 至 ${end.max}。`;
    }
    $('historyRangeFeedback').textContent = message;
    if (message) {
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
      return;
    }
    const changed = historyRange?.start !== start.value || historyRange?.end !== end.value;
    defaultRange = false;
    historyRange = {start: start.value, end: end.value};
    if (changed) { dailyPage = 0; expandedChildren.clear(); }
    loadHistoryRange({retry: true});
  }

  async function loadHistoryRange({force = false, retry = false} = {}) {
    if (!onHistory() || !currentSnapshot || !model.reportTimezoneMatches(currentSnapshot) || !historyRange) return;
    const {start, end} = historyRange;
    const version = `${start}/${end}/${currentSnapshot.generated_at || ''}`;
    if (historyRequest?.version === version) return;
    if (!force && historySourceVersion === version && (historySnapshot || !retry)) return;
    historyRequest?.controller.abort();
    const controller = new AbortController();
    const request = {version, controller};
    historyRequest = request;
    const loaded = historySnapshot?.payload.period;
    if (loaded?.start_date !== start || loaded?.end_date !== end) {
      historySnapshot = null;
      historyMessage = '正在查询所选日期…';
      renderPeriod();
      renderScopeNotice();
      renderHistory();
    } else {
      $('historyCoverage').textContent = '正在更新所选日期的数据…';
    }
    try {
      const session = await KBAuth.getValidSession();
      if (request !== historyRequest) return;
      if (!session) { location.replace('../index.html'); return; }
      const result = model.recentHistoryRange?.(currentSnapshot, start, end) ||
        await KBSales.getHistoryRange(session, start, end, {signal: controller.signal});
      if (request !== historyRequest) return;
      const data = result?.payload;
      if (!model.reportTimezoneMatches(result) || data.period?.start_date !== start || data.period?.end_date !== end ||
          !Array.isArray(data.daily_rows) || !Array.isArray(data.sales_daily_summaries) || !data.range_coverage) {
        throw new Error('服务器未返回完整的所选日期数据');
      }
      historySnapshot = result;
      historyMessage = '';
    } catch (error) {
      if (request !== historyRequest) return;
      historySnapshot = null;
      historyMessage = `查询失败：${error?.message || '无法读取销售数据'}。可点击「查询」重试。`;
    } finally {
      if (request === historyRequest) {
        historyRequest = null;
        historySourceVersion = version;
        if (onHistory()) {
          renderDimension();
          renderScopeNotice();
        }
      }
    }
  }

  function render(snapshot) {
    const data = snapshot?.payload;
    if (!data || data.schema_version !== 1) throw new Error('销量数据格式不匹配，请联系管理员。');
    currentSnapshot = snapshot;
    updateRangeControls();
    expandedChildren.clear();
    productImages = data.product_images && typeof data.product_images === 'object' ? data.product_images : {};
    if (!model.reportTimezoneMatches(snapshot)) {
      $('snapshotTime').textContent = `数据发布时间：${time(snapshot.generated_at)}`;
      $('periodText').textContent = '统计日期：等待后台按美国太平洋时间重新发布';
      for (const id of ['totalOrders', 'coverageRate', 'pendingOrders', 'paymentPending', 'identifiedOrders',
        'allPending', 'allFailed', 'lastSync', 'priceCoverage']) $(id).textContent = '—';
      $('coverageFill').style.width = '0%';
      renderTrend([]);
      $('unitsSold').textContent = '—';
      $('trendFoot').textContent = '等待按美国太平洋时间发布的趋势数据';
      historyRequest?.controller.abort();
      historyRequest = null;
      historySnapshot = null;
      historySourceVersion = null;
      historyMessage = '等待后台按美国太平洋时间发布数据。';
      renderDimension();
      setNotice(`后台时区待迁移：当前快照${data.report_timezone ? `使用 ${data.report_timezone}` : '未提供统计时区'}。请等待按 America/Los_Angeles 重新发布；旧日期数据不会当作美国太平洋时间显示。`, 'warn');
      snapshotNotice = {text: $('notice').textContent, state: 'warn'};
      return;
    }
    const coverage = data.coverage_15d || {};
    const total = Number(coverage.total_orders) || 0;
    const identified = Number(coverage.identified_orders) || 0;
    const ratio = total ? Math.min(100, Math.max(0, identified / total * 100)) : 0;
    $('snapshotTime').textContent = `数据发布时间：${time(snapshot.generated_at)}`;
    renderPeriod();
    $('totalOrders').textContent = fmt(total);
    $('coverageRate').textContent = total ? `${ratio.toFixed(1)}%` : '—';
    $('pendingOrders').textContent = fmt(coverage.item_pending_orders ?? coverage.pending_orders);
    $('paymentPending').textContent = coverage.payment_pending_orders === undefined ? '尚未提供' : fmt(coverage.payment_pending_orders);
    $('identifiedOrders').textContent = `${fmt(identified)} / ${fmt(total)}`;
    $('coverageFill').style.width = `${ratio}%`;
    $('allPending').textContent = fmt(data.backlog?.item_pending_orders ?? data.backlog?.pending_orders);
    $('allFailed').textContent = fmt(data.backlog?.failed_orders);
    $('lastSync').textContent = time(data.last_successful_sync_at);
    const prices = data.price_coverage_15d;
    $('priceCoverage').textContent = prices ? `${fmt(prices.estimated_rows)} / ${fmt(prices.missing_rows)}` : '尚未提供';
    renderTrend(data.trend);
    renderDimension();
    const ageMinutes = (Date.now() - Date.parse(snapshot.generated_at)) / 60000;
    const stale = !Number.isFinite(ageMinutes) ? '发布时间未提供。' : ageMinutes > 90 ? '数据已超过 90 分钟未发布，页面显示上次发布结果。' : '';
    const basis = data.price_metadata_available === true
      ? '销售额优先采用订单商品实际金额；缺价时按自家售价 × 订购数量估算，取得实际金额后替换。取消订单不计入销售。'
      : '本次发布未提供完整的估算与缺价说明，销售额口径尚待核实。';
    const missing = prices && Number(prices.missing_rows) > 0 ? `仍有 ${fmt(prices.missing_rows)} 条商品明细缺价，相关销售额尚未补齐。` : '';
    snapshotNotice = {text: [stale, basis, missing].filter(Boolean).join(' '),
      state: stale || missing || data.price_metadata_available !== true ? 'warn' : ''};
    renderScopeNotice();
  }
  async function refresh(forceRange = false) {
    if (loading) return;
    loading = true;
    $('refreshBtn').disabled = true;
    try {
      const current = await KBAuth.getValidSession();
      if (!current) { location.replace('../index.html'); return; }
      const snapshot = await KBSales.getSnapshot(current);
      if (!snapshot) {
        if (!currentSnapshot) {
          renderRanking([]);
          historyMessage = '尚无已发布的销量数据。';
          if (onHistory()) renderHistory();
          renderToday();
          $('trendFoot').textContent = '尚无已发布的趋势数据';
        }
        setNotice('尚无可读取的销量数据。请确认当前账号已获授权，并完成首次数据发布。', 'warn');
        return;
      }
      render(snapshot);
      if (onHistory()) loadHistoryRange({force: forceRange});
    } catch (error) {
      if (!currentSnapshot) {
        renderRanking([]);
        historyMessage = '销量数据加载失败，请点击「刷新」重试。';
        if (onHistory()) renderHistory();
        renderToday();
        $('trendFoot').textContent = '销量数据加载失败';
      }
      setNotice(`刷新失败${currentSnapshot ? '，当前仍显示上次加载的数据' : ''}：${error?.message || '未知错误'}`, 'error');
    } finally {
      loading = false;
      $('refreshBtn').disabled = false;
    }
  }

  function downloadCsv(contents, filename) {
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  function exportToday() {
    const rows = todayFilteredRows();
    if ($('todayExportBtn').disabled || !rows.length) return;
    try {
      downloadCsv(model.todayCsv(rows, comparison, dimension), `sales-today-${comparison.today}-${dimension}.csv`);
    } catch (error) { setNotice(`导出失败：${error?.message || '浏览器未能创建下载文件'}`, 'error'); }
  }
  function exportHistory() {
    const rows = historyFilteredRows();
    if ($('historyExportBtn').disabled || !rows.length) return;
    const period = historySnapshot?.payload?.period;
    if (!period) return;
    try {
      downloadCsv(model.historyCsv(rows, period, dimension, 'daily'),
        `sales-history-${period.start_date}_${period.end_date}-${dimension}.csv`);
    } catch (error) { setNotice(`导出失败：${error?.message || '浏览器未能创建下载文件'}`, 'error'); }
  }

  window.addEventListener('hashchange', route);
  $('refreshBtn').addEventListener('click', () => refresh(true));
  for (const button of document.querySelectorAll('[data-sales-dimension]')) button.addEventListener('click', () => {
    if (button.disabled || dimension === button.dataset.salesDimension) return;
    dimension = button.dataset.salesDimension;
    expandedChildren.clear();
    dailyPage = 0;
    todayPage = 0;
    $('todayAsinFilter').value = '';
    $('dailyAsinFilter').value = '';
    renderDimension();
  });
  $('historyRangeForm').addEventListener('submit', applyHistoryRange);
  $('historyEditRange').addEventListener('click', () => $('historyStart').focus());
  for (const id of ['historyStart', 'historyEnd']) {
    $(id).addEventListener('input', () => {
      $('historyStart').removeAttribute('aria-invalid');
      $('historyEnd').removeAttribute('aria-invalid');
      $('historyRangeFeedback').textContent = '';
    });
  }
  $('todayExportBtn').addEventListener('click', exportToday);
  $('historyExportBtn').addEventListener('click', exportHistory);
  $('dailyAsinFilter').addEventListener('input', () => { dailyPage = 0; renderDailyTable(); });
  $('dailyPrevBtn').addEventListener('click', () => { if (dailyPage > 0) { dailyPage--; renderDailyTable(); } });
  $('dailyNextBtn').addEventListener('click', () => { dailyPage++; renderDailyTable(); });
  $('todayAsinFilter').addEventListener('input', () => { todayPage = 0; renderToday(); });
  $('todayPrevBtn').addEventListener('click', () => { if (todayPage > 0) { todayPage--; renderToday(); } });
  $('todayNextBtn').addEventListener('click', () => { todayPage++; renderToday(); });
  route();
  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
})();
