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
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date).replaceAll('/', '-') + ' 北京时间';
  };
  const descriptions = {
    home: '近 15 天订单与已识别商品的汇总。',
    today: '逐个 ASIN 对比今日与昨日的销量、销售额和订单量。',
    history: '按日期和 ASIN 查看近 15 天销售明细。'
  };
  const viewLabels = { home: '首页', today: '今日数据', history: '历史数据' };
  let currentSnapshot = null;
  let productImages = {};
  let dailyAllRows = [];
  let dailyPage = 0;
  let dailyMessage = '正在加载明细…';
  let comparison = null;
  let todayPage = 0;
  let loading = false;

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
    if (name === 'today' && currentSnapshot) {
      comparison = model.todayComparison(currentSnapshot);
      renderToday();
    }
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
  function productCell(tr, asin) {
    const cell = addCell(tr, '', 'sales-product-cell');
    const normalizedAsin = String(asin || '').trim().toUpperCase();
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
    const placeholder = document.createElement('span');
    placeholder.className = 'sales-image-placeholder';
    placeholder.textContent = '暂无图';
    const url = model.imageUrl(productImages[normalizedAsin]?.image_url);
    frame.appendChild(placeholder);
    if (url) {
      const img = document.createElement('img');
      img.alt = '';
      img.width = 48;
      img.height = 48;
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.addEventListener('load', () => { placeholder.hidden = true; });
      img.addEventListener('error', () => { img.remove(); placeholder.hidden = false; }, { once: true });
      img.src = url;
      frame.appendChild(img);
    }
    const text = document.createElement('span');
    text.className = 'sales-asin';
    text.textContent = normalizedAsin || '—';
    product.append(frame, text);
    cell.appendChild(product);
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
      const formatted = !data ? '—' : metric === 'sales_amount' ? money(data.sales_amount, data.currency) : fmt(data[metric]);
      value.textContent = formatted;
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
    $(`${prefix}Count`).textContent = message || `共 ${fmt(count)} ${prefix === 'today' ? '个 ASIN' : '条日期 + ASIN 明细'}，每页 ${PAGE_SIZE} 条`;
    $(`${prefix}PageInfo`).textContent = message ? '—' : `第 ${page + 1} / ${pages} 页`;
    $(`${prefix}PrevBtn`).disabled = !!message || page === 0;
    $(`${prefix}NextBtn`).disabled = !!message || page >= pages - 1;
  }

  function renderDailyTable() {
    const body = $('dailyRows');
    body.replaceChildren();
    const date = $('dailyDateFilter').value;
    const query = $('dailyAsinFilter').value.trim().toUpperCase();
    const filtered = dailyAllRows.filter(row => (!date || row.date === date) && (!query || row.asin.toUpperCase().includes(query)));
    dailyPage = Math.min(dailyPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
    const visible = filtered.slice(dailyPage * PAGE_SIZE, (dailyPage + 1) * PAGE_SIZE);
    if (dailyMessage || !visible.length) emptyRow(body, dailyMessage || '当前筛选条件下没有明细记录', 5);
    else for (const row of visible) {
      const tr = document.createElement('tr');
      addCell(tr, row.date || '—');
      productCell(tr, row.asin);
      addCell(tr, fmt(row.units), 'sales-number');
      amountCell(tr, row);
      addCell(tr, fmt(row.orders_count), 'sales-number');
      body.appendChild(tr);
    }
    pageState('daily', filtered.length, dailyPage, dailyMessage);
  }
  function setDailyRows(rows, message = '') {
    dailyAllRows = Array.isArray(rows) ? rows.filter(row => row && typeof row.asin === 'string' && typeof row.date === 'string') : [];
    dailyAllRows.sort((a, b) => b.date.localeCompare(a.date) || a.asin.localeCompare(b.asin));
    dailyMessage = message;
    if (message) dailyPage = 0;
    const select = $('dailyDateFilter');
    const previousDate = select.value;
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部日期';
    select.appendChild(all);
    for (const date of [...new Set(dailyAllRows.map(row => row.date))].sort().reverse()) {
      const option = document.createElement('option');
      option.value = date;
      option.textContent = date;
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === previousDate)) select.value = previousDate;
    renderDailyTable();
  }
  function renderToday() {
    const body = $('todayRows');
    body.replaceChildren();
    const query = $('todayAsinFilter').value.trim().toUpperCase();
    const rows = comparison?.rows.filter(row => !query || row.asin.includes(query)) || [];
    todayPage = Math.min(todayPage, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
    $('todayDate').textContent = comparison?.today || model.beijingDate();
    $('yesterdayDate').textContent = comparison?.yesterday || model.previousDate(model.beijingDate());
    const missingDates = [];
    if (comparison && !comparison.todayAvailable) missingDates.push(`今日（${comparison.today}）`);
    if (comparison && !comparison.yesterdayAvailable) missingDates.push(`昨日（${comparison.yesterday}）`);
    $('todayStatus').textContent = missingDates.length ? `${missingDates.join('、')}尚无可用发布数据，对应数值显示“—”。` : '';
    $('todayStatus').hidden = !missingDates.length;
    const message = dailyMessage || (!comparison ? '正在加载明细…' : !comparison.todayAvailable && !comparison.yesterdayAvailable ? '今日与昨日尚无可用发布数据，请稍后刷新' : '');
    const visible = rows.slice(todayPage * PAGE_SIZE, (todayPage + 1) * PAGE_SIZE);
    if (message || !visible.length) emptyRow(body, message || (query ? '当前 ASIN 筛选条件下没有销售记录' : '今日与昨日暂无已识别商品销售记录'), 4);
    else for (const entry of visible) {
      const tr = document.createElement('tr');
      productCell(tr, entry.asin);
      for (const metric of ['units', 'sales_amount', 'orders_count']) pairCell(tr, entry, metric);
      body.appendChild(tr);
    }
    pageState('today', rows.length, todayPage, message);
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
      productCell(tr, entry.asin);
      addCell(tr, entry.seller_sku || '—', 'sales-sku');
      const title = addCell(tr, entry.title || '—', 'sales-rank-title');
      title.title = entry.title || '';
      addCell(tr, fmt(entry.units), 'sales-number');
      addCell(tr, fmt(entry.orders_count), 'sales-number');
      body.appendChild(tr);
    });
  }
  function render(snapshot) {
    const data = snapshot?.payload;
    if (!data || data.schema_version !== 1) throw new Error('销量数据格式不匹配，请联系管理员。');
    currentSnapshot = snapshot;
    productImages = data.product_images && typeof data.product_images === 'object' ? data.product_images : {};
    const coverage = data.coverage_15d || {};
    const total = Number(coverage.total_orders) || 0;
    const identified = Number(coverage.identified_orders) || 0;
    const ratio = total ? Math.min(100, Math.max(0, identified / total * 100)) : 0;
    $('snapshotTime').textContent = `数据发布时间：${time(snapshot.generated_at)}`;
    $('periodText').textContent = `统计日期：${data.period?.start_date || '—'} 至 ${data.period?.end_date || '—'}（北京时间）`;
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
    renderRanking(data.ranking);
    setDailyRows(data.daily_rows, Array.isArray(data.daily_rows) ? '' : '本次发布尚未提供每日明细，请等待数据更新。');
    comparison = model.todayComparison(snapshot);
    renderToday();
    const ageMinutes = (Date.now() - Date.parse(snapshot.generated_at)) / 60000;
    const stale = !Number.isFinite(ageMinutes) ? '发布时间未提供。' : ageMinutes > 90 ? '数据已超过 90 分钟未发布，页面显示上次发布结果。' : '';
    const basis = data.price_metadata_available === true
      ? '销售额优先采用订单商品实际金额；缺价时按自家售价 × 订购数量估算，取得实际金额后替换。取消订单不计入销售。'
      : '本次发布未提供完整的估算与缺价说明，销售额口径尚待核实。';
    const missing = prices && Number(prices.missing_rows) > 0 ? `仍有 ${fmt(prices.missing_rows)} 条商品明细缺价，相关销售额尚未补齐。` : '';
    setNotice([stale, basis, missing].filter(Boolean).join(' '), stale || missing || data.price_metadata_available !== true ? 'warn' : '');
  }
  async function refresh() {
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
          setDailyRows([], '尚无可读取的销量数据');
          renderToday();
          $('trendFoot').textContent = '尚无已发布的趋势数据';
        }
        setNotice('尚无可读取的销量数据。请确认当前账号已获授权，并完成首次数据发布。', 'warn');
        return;
      }
      render(snapshot);
    } catch (error) {
      if (!currentSnapshot) {
        renderRanking([]);
        setDailyRows([], '销量明细加载失败');
        renderToday();
        $('trendFoot').textContent = '销量数据加载失败';
      }
      setNotice(`刷新失败${currentSnapshot ? '，当前仍显示上次加载的数据' : ''}：${error?.message || '未知错误'}`, 'error');
    } finally {
      loading = false;
      $('refreshBtn').disabled = false;
    }
  }

  window.addEventListener('hashchange', route);
  $('refreshBtn').addEventListener('click', refresh);
  $('dailyDateFilter').addEventListener('change', () => { dailyPage = 0; renderDailyTable(); });
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
