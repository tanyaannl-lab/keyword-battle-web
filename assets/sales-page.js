(async function () {
  const auth = await KBAuth.requireAuth('../index.html');
  if (!auth) return;

  const $ = id => document.getElementById(id);
  const fmt = value => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
  const time = value => {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(d).replaceAll('/', '-') + ' 北京时间';
  };

  $('userEmail').textContent = auth.user?.email || '已登录用户';
  $('loading').remove();
  $('appShell').hidden = false;

  $('logoutBtn').addEventListener('click', async () => {
    await KBAuth.logout();
    location.replace('../index.html');
  });

  function setNotice(message, state = 'warn') {
    const el = $('notice');
    el.textContent = message;
    el.className = `sales-banner ${state}`;
  }

  function addCell(row, text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = String(text ?? '—');
    if (className) cell.className = className;
    row.appendChild(cell);
    return cell;
  }

  const DAILY_PAGE_SIZE = 50;
  let dailyAllRows = [];
  let dailyPage = 0;
  let dailyMessage = '正在加载明细…';

  function money(value, currency) {
    if (value === null || value === undefined || currency === 'MIXED') return '币种混合';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '—';
    const code = String(currency || 'USD').toUpperCase();
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: code,
        minimumFractionDigits: 2, maximumFractionDigits: 2
      }).format(amount);
    } catch (_) {
      return `${amount.toFixed(2)} ${code}`;
    }
  }

  function renderDailyTable() {
    const body = $('dailyRows');
    body.replaceChildren();
    const date = $('dailyDateFilter').value;
    const query = $('dailyAsinFilter').value.trim().toUpperCase();
    const filtered = dailyAllRows.filter(row =>
      (!date || row.date === date) && (!query || String(row.asin || '').toUpperCase().includes(query))
    );
    const pages = Math.max(1, Math.ceil(filtered.length / DAILY_PAGE_SIZE));
    dailyPage = Math.min(dailyPage, pages - 1);
    const visible = filtered.slice(dailyPage * DAILY_PAGE_SIZE, (dailyPage + 1) * DAILY_PAGE_SIZE);

    if (dailyMessage || !visible.length) {
      const tr = document.createElement('tr');
      const td = addCell(tr, dailyMessage || '当前筛选条件下没有明细记录', 'empty');
      td.colSpan = 5;
      body.appendChild(tr);
    } else {
      for (const row of visible) {
        const tr = document.createElement('tr');
        addCell(tr, row.date || '—');
        addCell(tr, row.asin || '—', 'sales-rank-main');
        addCell(tr, fmt(row.units), 'sales-number');
        addCell(tr, money(row.sales_amount, row.currency), 'sales-number');
        addCell(tr, fmt(row.orders_count), 'sales-number');
        body.appendChild(tr);
      }
    }

    $('dailyCount').textContent = dailyMessage || `共 ${fmt(filtered.length)} 条日期 + ASIN 明细，每页 ${DAILY_PAGE_SIZE} 条`;
    $('dailyPageInfo').textContent = dailyMessage ? '—' : `第 ${dailyPage + 1} / ${pages} 页`;
    $('dailyPrevBtn').disabled = !!dailyMessage || dailyPage === 0;
    $('dailyNextBtn').disabled = !!dailyMessage || dailyPage >= pages - 1;
  }

  function setDailyRows(rows, message = '') {
    dailyAllRows = Array.isArray(rows) ? rows : [];
    dailyMessage = message;
    if (message) dailyPage = 0;
    const select = $('dailyDateFilter');
    const previousDate = select.value;
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部日期';
    select.appendChild(all);
    for (const date of [...new Set(dailyAllRows.map(row => row.date).filter(Boolean))].sort().reverse()) {
      const option = document.createElement('option');
      option.value = date;
      option.textContent = date;
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === previousDate)) select.value = previousDate;
    renderDailyTable();
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
    $('trendFoot').textContent = entries.length
      ? `已识别商品合计 ${fmt(total)} 件 · 按 sales_daily.sale_date 显示`
      : '暂无已发布的趋势数据';
  }

  function renderRanking(ranking) {
    const rows = $('rankingRows');
    rows.replaceChildren();
    if (!Array.isArray(ranking) || !ranking.length) {
      const tr = document.createElement('tr');
      const td = addCell(tr, '暂无已识别的 ASIN 销量记录', 'empty');
      td.colSpan = 6;
      rows.appendChild(tr);
      return;
    }
    ranking.forEach((entry, index) => {
      const tr = document.createElement('tr');
      addCell(tr, index + 1, 'sales-rank');
      addCell(tr, entry.asin || '—', 'sales-rank-main');
      addCell(tr, entry.seller_sku || '—');
      const title = addCell(tr, entry.title || '—', 'sales-rank-title');
      title.title = entry.title || '';
      addCell(tr, fmt(entry.units), 'sales-number');
      addCell(tr, fmt(entry.orders_count), 'sales-number');
      rows.appendChild(tr);
    });
  }

  function render(snapshot) {
    const data = snapshot?.payload;
    if (!data || data.schema_version !== 1) throw new Error('销量快照版本不匹配。');
    const coverage = data.coverage_15d || {};
    const total = Number(coverage.total_orders) || 0;
    const identified = Number(coverage.identified_orders) || 0;
    const ratio = total ? Math.min(100, Math.max(0, identified / total * 100)) : 0;

    $('snapshotTime').textContent = `数据发布时间：${time(snapshot.generated_at)}`;
    $('periodText').textContent = `统计日期：${data.period?.start_date || '—'} 至 ${data.period?.end_date || '—'}（按数据库日期）`;
    $('totalOrders').textContent = fmt(total);
    $('coverageRate').textContent = total ? `${ratio.toFixed(1)}%` : '—';
    $('pendingOrders').textContent = fmt(coverage.pending_orders);
    $('identifiedOrders').textContent = `${fmt(identified)} / ${fmt(total)}`;
    $('coverageFill').style.width = `${ratio}%`;
    $('allPending').textContent = fmt(data.backlog?.pending_orders);
    $('allFailed').textContent = fmt(data.backlog?.failed_orders);
    $('lastSync').textContent = time(data.last_successful_sync_at);
    renderTrend(data.trend);
    renderRanking(data.ranking);
    setDailyRows(data.daily_rows, Array.isArray(data.daily_rows)
      ? '' : '当前快照没有每日明细，请在 Ubuntu 重新运行新版发布脚本。');
    const snapshotAgeHours = (Date.now() - Date.parse(snapshot.generated_at)) / 3600000;
    const freshness = snapshotAgeHours > 36 ? '数据快照已超过 36 小时未发布，请检查发布脚本。' : '';
    setNotice(`${freshness}本页显示数据库已记录订单与已识别商品的汇总。商品尚未全部补全，且现有订单表每个订单只保留一条商品记录；下方销售额是已有记录值，可能与 Amazon 后台不一致。`);
  }

  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    $('refreshBtn').disabled = true;
    try {
      const current = await KBAuth.getValidSession();
      if (!current) { location.replace('../index.html'); return; }
      const snapshot = await KBSales.getSnapshot(current);
      if (!snapshot) {
        renderRanking([]);
        setDailyRows([], '尚无可读取的销量快照');
        $('trendFoot').textContent = '尚无已发布的趋势数据';
        setNotice('尚无可读取的销量快照。请确认当前账号已获授权，并完成首次数据发布。', 'warn');
        return;
      }
      render(snapshot);
    } catch (error) {
      renderRanking([]);
      setDailyRows([], '销量明细加载失败');
      $('trendFoot').textContent = '销量数据加载失败';
      setNotice(`销量数据加载失败：${error?.message || '未知错误'}`, 'error');
    } finally {
      loading = false;
      $('refreshBtn').disabled = false;
    }
  }

  $('refreshBtn').addEventListener('click', refresh);
  $('dailyDateFilter').addEventListener('change', () => { dailyPage = 0; renderDailyTable(); });
  $('dailyAsinFilter').addEventListener('input', () => { dailyPage = 0; renderDailyTable(); });
  $('dailyPrevBtn').addEventListener('click', () => { if (dailyPage > 0) { dailyPage--; renderDailyTable(); } });
  $('dailyNextBtn').addEventListener('click', () => { dailyPage++; renderDailyTable(); });
  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
})();
