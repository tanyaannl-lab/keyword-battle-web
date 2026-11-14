'use strict';

(() => {
  const cfg = window.KB_CONFIG;
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const endpoint = `${origin}/rest/v1/rpc/mc_fba_inventory_movement_read`;
  const login = '../index.html';
  const limit = 10_000;
  const pageSize = 50;
  const missing = '—';
  const windowDays = 30;
  const dayMs = 86_400_000;
  const salesFreshnessDays = 3; // Normal reporting delay is two Pacific calendar days.
  const quantityKeys = ['fulfillable','reserved','unfulfillable','inbound_working','inbound_shipped',
    'inbound_receiving','researching','total_quantity','ordered_units_30d'];
  const columns = [
    ['seller_sku','卖家 SKU'], ['asin','子 ASIN'], ['operator_name','运营简称'],
    ['fulfillable','当前可售','number'], ['reserved','预留','number'], ['unfulfillable','不可售','number'],
    ['in_transit','实际在途','number'], ['inbound_working','计划入库','number'],
    ['ordered_units_30d','近 30 天订购件数','number'],
    ['daily_average','日均订购件数','average'], ['sellable_days','预计可售天数','days'],
  ];
  const extraColumns = [
    ['tracking_label','运营跟踪'], ['fnsku','FNSKU'], ['condition','商品状况'],
    ['inbound_shipped','已发往亚马逊'], ['inbound_receiving','接收中'],
    ['researching','调查中'], ['total_quantity','亚马逊总量'], ['last_updated_at','亚马逊更新时间（UTC）'],
  ];
  const ids = {
    shell: 'appShell', loading: 'loading', email: 'userEmail', logout: 'logoutBtn',
    snapshot: 'inventorySnapshot', timestamp: 'inventorySnapshotAt', reload: 'inventoryReload',
    salesWindow: 'inventorySalesWindow', salesDates: 'inventorySalesDates', salesTimestamp: 'inventorySalesAt',
    salesLag: 'inventorySalesLag',
    status: 'inventoryStatus', results: 'inventoryResults', search: 'inventorySearch',
    scope: 'inventoryScope', showAll: 'inventoryShowAll', tracking: 'inventoryTracking', filter: 'inventoryFilter',
    download: 'inventoryDownload', count: 'inventoryCount',
    empty: 'inventoryEmpty', table: 'inventoryTable', body: 'inventoryRows', pages: 'inventoryPages',
    prev: 'inventoryPrev', next: 'inventoryNext', page: 'inventoryPageNumber',
  };
  const el = Object.fromEntries(Object.entries(ids).map(([key,id]) => [key,document.getElementById(id)]));
  const integers = new Intl.NumberFormat('en-US');
  const averages = new Intl.NumberFormat('en-US', {maximumFractionDigits:2});
  const coverage = new Intl.NumberFormat('en-US', {maximumFractionDigits:1});
  const dates = new Intl.DateTimeFormat('zh-CN', { timeZone:'America/Los_Angeles',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
  const pacificDay = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles',
    year:'numeric',month:'2-digit',day:'2-digit'});
  const order = new Intl.Collator('en', { numeric:true });
  const searchable = value => String(value ?? '').normalize('NFKC').toLowerCase();
  const formatUnits = count => integers.format(count);
  const timeShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const dateShape = /^\d{4}-\d{2}-\d{2}$/;
  const safeText = (value,max) => typeof value === 'string' && /\S/.test(value) && Array.from(value).length <= max &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value);
  const isTime = value => typeof value === 'string' && timeShape.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const isDay = value => typeof value === 'string' && dateShape.test(value) && isTime(`${value}T00:00:00.000Z`);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const filters = {
    sellable: row => positive(row.fulfillable),
    zero: row => row.fulfillable === 0,
    reserved: row => positive(row.reserved),
    inbound: row => positive(row.in_transit),
    unfulfillable: row => positive(row.unfulfillable),
    unknown: row => row.fulfillable === null,
  };
  let auth, request, snapshot, generation = 0, page = 0, scopedCount = 0, visible = [];
  const downloads = new Set();

  class ReadError extends Error {
    constructor(status, code = '') {
      super('INVENTORY_READ_ERROR');
      this.status = status;
      this.code = code;
    }
  }

  function status(text, state = '') {
    el.status.textContent = text;
    el.status.hidden = !text;
    if (state) el.status.dataset.state = state;
    else delete el.status.dataset.state;
  }

  function translate(error) {
    if (error.status === 403 || error.code === '42501') return '当前账号没有查看 MC 美国站库存的权限。';
    if (error.status === 404 || error.code === 'PGRST202') return '库存读取服务尚未启用，请联系管理员。';
    if (error.code === 'invalid') return '库存数据格式异常，请联系管理员。';
    if (error.status === 429) return '读取过于频繁，请稍后再试。';
    if (error.name === 'TimeoutError') return '读取超时，请重试。';
    return '暂时无法读取库存，请重试。';
  }

  function parseSnapshot(data) {
    if (data === null) return null; // No successful capture yet.
    const invalid = () => { throw new ReadError(200, 'invalid'); };
    if (data?.store !== 'MC' || data.marketplace !== 'amazon.com' || !isTime(data.captured_at) ||
        !Array.isArray(data.rows) || data.rows.length > limit || data.row_count !== data.rows.length) invalid();
    const {sales_start_date,sales_end_date,sales_captured_at,tracking_count,tracking_matched_count} = data;
    const noSales = sales_start_date === null && sales_end_date === null && sales_captured_at === null;
    if (!noSales && (!isDay(sales_start_date) || !isDay(sales_end_date) || !isTime(sales_captured_at) ||
        Date.parse(sales_end_date) - Date.parse(sales_start_date) !== (windowDays - 1) * dayMs)) invalid();
    if (!Number.isSafeInteger(tracking_count) || tracking_count < 0 || tracking_count > 5_000 ||
        !Number.isSafeInteger(tracking_matched_count) || tracking_matched_count < 0 ||
        tracking_matched_count > tracking_count) invalid();
    const seen = new Set();
    const rows = data.rows.map(row => {
      if (!safeText(row?.seller_sku,255) || seen.has(row.seller_sku) ||
          (row.asin !== null && !/^[A-Z0-9]{10}$/.test(row.asin ?? '')) ||
          (row.fnsku !== null && !/^[A-Z0-9_.:-]{1,128}$/.test(row.fnsku ?? '')) ||
          (row.condition !== null && !safeText(row.condition,128)) ||
          (row.last_updated_at !== null && !isTime(row.last_updated_at)) ||
          typeof row.tracked !== 'boolean' ||
          (row.operator_name !== null && !safeText(row.operator_name,255)) ||
          (noSales && row.ordered_units_30d !== null) ||
          quantityKeys.some(key => row[key] !== null && (!Number.isSafeInteger(row[key]) || row[key] < 0))) invalid();
      seen.add(row.seller_sku);
      const in_transit = row.inbound_shipped === null || row.inbound_receiving === null ?
        null : row.inbound_shipped + row.inbound_receiving;
      if (in_transit !== null && !Number.isSafeInteger(in_transit)) invalid();
      const daily_average = row.ordered_units_30d === null ? null : row.ordered_units_30d / windowDays;
      const sellable_days = row.fulfillable !== null && positive(row.ordered_units_30d) ?
        row.fulfillable * windowDays / row.ordered_units_30d : null;
      return { ...row, in_transit, daily_average, sellable_days, tracking_label: row.tracked ? '是' : '否',
        search: [row.seller_sku,row.asin,row.fnsku,row.operator_name].map(searchable).join(' ') };
    });
    rows.sort((a,b) => order.compare(a.seller_sku,b.seller_sku));
    if (rows.some(row => row.tracked) !== (tracking_matched_count > 0)) invalid();
    return {captured_at:data.captured_at, sales_start_date, sales_end_date, sales_captured_at,
      tracking_count, tracking_matched_count, rows};
  }

  async function readInventory(current, signal) {
    const access = current.session.access_token;
    const send = token => fetch(endpoint, {
      method:'POST', cache:'no-store', credentials:'omit', mode:'cors', redirect:'error',
      referrerPolicy:'no-referrer', signal,
      headers:{ Accept:'application/json', 'Content-Type':'application/json',
        apikey:cfg.SUPABASE_PUBLISHABLE_KEY, Authorization:`Bearer ${token}` },
      body:'{}',
    });
    let response = await send(access);
    if (response.status === 401 && !signal.aborted && auth === current) {
      const refreshed = await window.KBAuth.getValidSession();
      if (!signal.aborted && auth === current && refreshed?.user?.id === current.user.id &&
          refreshed.session?.access_token && refreshed.session.access_token !== access) {
        auth = refreshed;
        response = await send(refreshed.session.access_token);
      }
    }
    if (!response.ok) {
      let code;
      try { code = (await response.json())?.code; } catch { /* HTTP status is enough. */ }
      throw new ReadError(response.status,code);
    }
    return parseSnapshot(await response.json());
  }

  function filterRows() {
    if (!snapshot) return;
    const query = searchable(el.search.value.trim()).split(/\s+/).filter(Boolean);
    const accepts = Object.hasOwn(filters,el.filter.value) ? filters[el.filter.value] : () => true;
    const scoped = el.scope.value === 'all' ? snapshot.rows : snapshot.rows.filter(row => row.tracked);
    scopedCount = scoped.length;
    visible = scoped.filter(row => accepts(row) && query.every(token => row.search.includes(token)));
    page = 0;
    renderPage();
  }

  function renderPage() {
    const count = visible.length;
    const pages = Math.ceil(count / pageSize);
    const total = snapshot.rows.length;
    const noTracked = total > 0 && scopedCount === 0;
    el.count.textContent = `符合条件 ${formatUnits(count)} / ${formatUnits(scopedCount)} 个 SKU`;
    el.empty.hidden = count > 0;
    el.empty.textContent = !total ? '最近一次同步成功，亚马逊未返回库存记录。' :
      noTracked ? (snapshot.tracking_count ? '运营跟踪名单没有匹配到本次库存快照，可查看全部库存。' :
        '运营跟踪名单尚未配置，可查看全部库存。') : '没有符合条件的 SKU。';
    el.showAll.hidden = !noTracked;
    const partialMatch = el.scope.value !== 'all' && snapshot.tracking_matched_count > 0 &&
      snapshot.tracking_matched_count < snapshot.tracking_count;
    el.tracking.hidden = !partialMatch;
    el.tracking.textContent = partialMatch ? `运营名单匹配 ${formatUnits(snapshot.tracking_matched_count)} / ` +
      `${formatUnits(snapshot.tracking_count)} 项；未匹配项暂无库存记录。` : '';
    el.table.hidden = count === 0;
    el.pages.hidden = pages < 2;
    el.download.disabled = count === 0;
    el.prev.disabled = page === 0;
    el.next.disabled = page + 1 >= pages;
    el.page.textContent = pages ? `第 ${formatUnits(page + 1)} / ${formatUnits(pages)} 页` : '';
    const body = document.createDocumentFragment();
    for (const row of visible.slice(page * pageSize,(page + 1) * pageSize)) {
      const tr = document.createElement('tr');
      for (const [index,[key,,kind]] of columns.entries()) {
        const value = row[key];
        const cell = document.createElement(index ? 'td' : 'th');
        if (!index) cell.scope = 'row';
        if (kind) cell.classList.add('results-num');
        if (key === 'operator_name') cell.classList.add('inventory-name');
        if (value === null) cell.classList.add('results-missing');
        if (key === 'fulfillable' && value === 0) cell.classList.add('inventory-zero');
        cell.textContent = formatCell(value,kind);
        tr.append(cell);
      }
      body.append(tr);
    }
    el.body.replaceChildren(body);
  }

  function formatCell(value,kind) {
    if (value === null) return missing;
    if (kind === 'number') return formatUnits(value);
    if (kind === 'average') return averages.format(value);
    if (kind === 'days') return value > 0 && value < 0.05 ? '<0.1' : coverage.format(value);
    return value;
  }

  function csvCell(value) {
    if (value === null) return '';
    if (typeof value === 'number') return String(value);
    const formula = /^[\s\uFEFF]*[=+\-@]/.test(value.normalize('NFKC'));
    return `"${(formula ? "'" + value : value).replace(/"/g,'""')}"`;
  }

  function exportRows() {
    if (!snapshot || !visible.length) return;
    const csvColumns = [...columns,...extraColumns];
    const header = ['库存快照时间（UTC）', '订购统计起始日（美西）', '订购统计截止日（美西）',
      '订购报表采集时间（UTC）', ...csvColumns.map(([,label]) => label)].map(csvCell).join(',');
    const blob = new Blob(['\uFEFF',header,'\r\n', ...visible.map(row =>
      [snapshot.captured_at,snapshot.sales_start_date,snapshot.sales_end_date,snapshot.sales_captured_at,
        ...csvColumns.map(([key]) => row[key])].map(csvCell).join(',') + '\r\n')],
      {type:'text/csv;charset=utf-8'});
    const href = URL.createObjectURL(blob);
    downloads.add(href);
    const link = document.createElement('a');
    link.href = href;
    link.download = `MC-US-FBA-inventory-${snapshot.captured_at.slice(0,10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => {
      if (downloads.delete(href)) URL.revokeObjectURL(href);
    },30_000);
  }

  function clearSnapshot() {
    snapshot = undefined;
    visible = [];
    page = scopedCount = 0;
    el.body.replaceChildren();
    el.results.hidden = el.snapshot.hidden = el.salesWindow.hidden = true;
    el.timestamp.removeAttribute('datetime');
    el.salesTimestamp.removeAttribute('datetime');
    for (const item of [el.timestamp,el.salesDates,el.salesTimestamp,el.count,el.empty,el.tracking,el.page]) item.textContent = '';
    for (const href of downloads) URL.revokeObjectURL(href);
    downloads.clear();
  }

  function displaySalesWindow() {
    const {sales_start_date,sales_end_date,sales_captured_at} = snapshot;
    el.salesLag.hidden = true;
    if (sales_captured_at === null) {
      el.salesDates.textContent = '近 30 天订购报表尚未同步。';
      el.salesTimestamp.hidden = true;
      el.salesTimestamp.removeAttribute('datetime');
      el.salesTimestamp.textContent = '';
    } else {
      el.salesDates.textContent = `近 30 天订购统计（美西）：${sales_start_date} 至 ${sales_end_date} · 报表采集：`;
      el.salesTimestamp.hidden = false;
      el.salesTimestamp.dateTime = sales_captured_at;
      el.salesTimestamp.textContent = dates.format(new Date(sales_captured_at));
      const {year,month,day} = Object.fromEntries(pacificDay.formatToParts().map(({type,value}) => [type,value]));
      const lag = (Date.parse(`${year}-${month}-${day}`) - Date.parse(sales_end_date)) / dayMs;
      el.salesLag.hidden = lag <= salesFreshnessDays;
    }
    el.salesWindow.hidden = false;
  }

  async function load() {
    if (!auth || request) return;
    const read = new AbortController();
    request = read;
    el.reload.disabled = true;
    status('正在读取库存…');
    try {
      const signal = AbortSignal.any([read.signal,AbortSignal.timeout(25_000)]);
      const next = await readInventory(auth,signal);
      if (request !== read || read.signal.aborted) return;
      if (next === null) {
        clearSnapshot();
        status('还没有库存快照。请在首次同步完成后重新读取。');
        return;
      }
      snapshot = next;
      el.timestamp.dateTime = snapshot.captured_at;
      el.timestamp.textContent = dates.format(new Date(snapshot.captured_at));
      displaySalesWindow();
      el.results.hidden = el.snapshot.hidden = false;
      filterRows();
      status('');
    } catch (error) {
      if (request !== read || read.signal.aborted) return;
      if (error.status === 401) {
        clearPrivate();
        location.replace(login);
        return;
      }
      if (error.status === 403 || error.code === '42501') clearSnapshot();
      status(translate(error) + (snapshot ? ' 当前显示上次成功读取的快照。' : ''),'error');
    } finally {
      if (request === read) {
        request = null;
        el.reload.disabled = false;
      }
    }
  }

  function clearPrivate() {
    generation++;
    request?.abort();
    request = auth = null;
    clearSnapshot();
    el.search.value = el.filter.value = el.email.textContent = '';
    el.scope.value = 'tracked';
    el.reload.disabled = false;
    el.shell.hidden = true;
    el.loading.hidden = false;
    el.loading.textContent = '正在验证登录状态…';
    status('');
  }

  async function start() {
    const id = ++generation;
    if (![origin,`${origin}/`].includes(cfg?.SUPABASE_URL) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(cfg?.SUPABASE_PUBLISHABLE_KEY ?? '') ||
        typeof window.KBAuth?.requireAuth !== 'function') {
      el.loading.textContent = '库存页面配置未加载，请刷新或联系管理员。';
      return;
    }
    try {
      const current = await window.KBAuth.requireAuth(login);
      if (generation !== id || !current) return;
      if (!current.user?.id || !current.session?.access_token) { location.replace(login); return; }
      auth = current;
      el.email.textContent = current.user.email ?? '';
      el.loading.hidden = true;
      el.shell.hidden = false;
      void load();
    } catch {
      if (generation === id) el.loading.textContent = '登录校验失败，请刷新重试。';
    }
  }

  function turn(direction) {
    if (!snapshot) return;
    const next = page + direction;
    if (next < 0 || next >= Math.ceil(visible.length / pageSize)) return;
    page = next;
    renderPage();
    el.table.scrollTop = 0;
  }

  el.reload.addEventListener('click',load);
  el.search.addEventListener('input',filterRows);
  el.filter.addEventListener('change',filterRows);
  el.scope.addEventListener('change',filterRows);
  el.showAll.addEventListener('click',() => {
    el.scope.value = 'all';
    el.scope.focus();
    filterRows();
  });
  el.download.addEventListener('click',exportRows);
  el.prev.addEventListener('click',() => turn(-1));
  el.next.addEventListener('click',() => turn(1));
  el.logout.addEventListener('click',async () => {
    clearPrivate();
    try { await window.KBAuth.logout(); } finally { location.replace(login); }
  });
  window.addEventListener('pagehide',clearPrivate);
  window.addEventListener('pageshow',event => { if (event.persisted) void start(); });
  window.addEventListener('storage',event => {
    if (event.key !== cfg?.SESSION_KEY && event.key !== null) return;
    const identify = raw => { try { return JSON.parse(raw)?.user?.id; } catch { return null; } };
    const incoming = identify(event.newValue);
    if (incoming && incoming === identify(event.oldValue) && (!auth || incoming === auth.user.id)) return;
    clearPrivate();
    if (event.newValue) void start();
    else location.replace(login);
  });
  el.scope.value = 'tracked';
  void start();
})();
