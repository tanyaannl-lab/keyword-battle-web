'use strict';

(() => {
  const cfg = window.KB_CONFIG;
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const endpoint = `${origin}/rest/v1/rpc/mc_fba_inventory_movement_read`;
  const ageEndpoint = `${origin}/rest/v1/rpc/mc_fba_inventory_age_read`;
  const catalogEndpoint = `${origin}/rest/v1/rpc/mc_product_catalog_read`;
  const login = '../index.html';
  const limit = 10_000;
  const pageSize = 50;
  const missing = '—';
  const windowDays = 30;
  const shortWindows = [1,7,15];
  const dayMs = 86_400_000;
  const stockFreshnessMs = 30 * 3_600_000;
  const ageFreshnessDays = 7;
  const salesFreshnessDays = 3; // Normal reporting delay is two Pacific calendar days.
  const quantityKeys = ['fulfillable','reserved','unfulfillable','inbound_working','inbound_shipped',
    'inbound_receiving','researching','total_quantity','ordered_units_30d'];
  const columns = [
    ['product_short_name','产品简称'], ['parent_asin','父 ASIN'], ['owner','负责人'], ['asin','子 ASIN'], ['seller_sku','卖家 SKU'],
    ['fulfillable','当前可售','number'], ['reserved','预留','number'], ['unfulfillable','不可售','number'],
    ['in_transit','实际在途','number'], ['inbound_working','计划入库','number'],
    ['ordered_units_1d','近 1 天订购件数','number'], ['ordered_units_7d','近 7 天订购件数','number'],
    ['ordered_units_15d','近 15 天订购件数','number'], ['ordered_units_30d','近 30 天订购件数','number'],
    ['daily_average','日均订购件数（7 天）','average'], ['sellable_days','预计可售天数','days'],
  ];
  const extraColumns = [
    ['tracking_label','运营跟踪'], ['fnsku','FNSKU'], ['condition','商品状况'],
    ['inbound_shipped','已发往亚马逊'], ['inbound_receiving','接收中'],
    ['researching','调查中'], ['total_quantity','亚马逊总量'], ['last_updated_at','亚马逊更新时间（UTC）'],
  ];
  const detailGroups = [
    ['入库', [
      ['inbound_working','处理中（计划入库）'], ['inbound_shipped','已发货'], ['inbound_receiving','接收中'],
    ]],
    ['库存概况', [
      ['fulfillable','当前可售'], ['total_quantity','亚马逊库存总量'],
    ]],
    ['预留', [
      ['reserved','预留总量'], ['reserved_customer_order','买家订单'],
      ['reserved_fc_transfers','仓间调拨（API 预留）'], ['reserved_fc_processing','运营中心处理中'],
    ]],
    ['调查中', [
      ['researching','调查中总量'], ['researching_short_term','1–10 天'],
      ['researching_mid_term','11–20 天'], ['researching_long_term','21 天及以上'],
    ]],
    ['不可售', [
      ['unfulfillable','不可售总量'], ['unfulfillable_warehouse_damaged','仓库残损'],
      ['unfulfillable_defective','商品瑕疵'], ['unfulfillable_expired','已过期'],
      ['unfulfillable_customer_damaged','买家导致残损'], ['unfulfillable_carrier_damaged','承运商导致残损'],
      ['unfulfillable_distributor_damaged','分销商导致残损'],
    ]],
  ];
  const knownQuantities = new Set(quantityKeys);
  const optionalDetailColumns = detailGroups.flatMap(([group,items]) => items
    .filter(([key]) => !knownQuantities.has(key))
    .map(([key,label]) => [key,`${group} · ${label}`]));
  const ageBands = [
    ['age_0_90','0–90 天'], ['age_91_180','91–180 天'], ['age_181_330','181–330 天'],
    ['age_331_365','331–365 天'], ['age_366_455','366–455 天'], ['age_456_plus','456 天及以上'],
  ];
  const ageTotals = [['age_total','六档合计'], ['age_over_180','超时合计（181 天起）']];
  const ageTableKeys = [...ageBands,...ageTotals].map(([key]) => key);
  const ageYoungBands = [
    ['age_0_30','0–30 天'], ['age_31_60','31–60 天'], ['age_61_90','61–90 天'],
  ];
  const ageQuantityColumns = [...ageBands,...ageYoungBands];
  const ageCsvColumns = [
    ['age_snapshot_date','库龄快照日期（美西）'], ['report_snapshot_date','库龄来源报表日期（美西）'],
    ...[...ageBands,...ageTotals,...ageYoungBands].map(([key,label]) => [key,`库龄 · ${label}`]),
  ];
  const ids = {
    shell: 'appShell', loading: 'loading', email: 'userEmail', logout: 'logoutBtn',
    timestamp: 'inventorySnapshotAt', stockState: 'inventoryStockState', stockTime: 'inventoryStockTime',
    stockLag: 'inventoryStockLag', reload: 'inventoryReload',
    salesCoverage:'inventorySalesCoverage', salesDates: 'inventorySalesDates', salesTimestamp: 'inventorySalesAt', salesTime: 'inventorySalesTime',
    salesLag: 'inventorySalesLag', salesState: 'inventorySalesState',
    ageNotice: 'inventoryAgeNotice', ageState: 'inventoryAgeState', ageTime: 'inventoryAgeTime',
    ageTimestamp: 'inventoryAgeAt', ageReport: 'inventoryAgeReport', ageReportDate: 'inventoryAgeReportDate',
    ageLag: 'inventoryAgeLag', coverageNotice: 'inventoryCoverageNotice',
    catalogNotice: 'inventoryCatalogNotice', catalogRetry: 'inventoryCatalogRetry',
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
  const compareAsin = (a,b) => a === b ? 0 : a === null ? 1 : b === null || a < b ? -1 : 1;
  const inventoryOrder = (a,b) => compareAsin(a.parent_asin,b.parent_asin) || compareAsin(a.asin,b.asin) ||
    order.compare(a.seller_sku,b.seller_sku) || (a.seller_sku < b.seller_sku ? -1 : 1);
  const searchable = value => String(value ?? '').normalize('NFKC').toLowerCase();
  const searchText = row => [row.product_short_name,row.parent_asin,row.owner,row.asin,row.seller_sku,row.fnsku]
    .map(searchable).join(' ');
  const formatUnits = count => integers.format(count);
  const asinShape = /^[A-Z0-9]{10}$/;
  const fnskuShape = /^[A-Z0-9_.:-]{1,128}$/;
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
    researching: row => positive(row.researching),
    unfulfillable: row => positive(row.unfulfillable),
    unknown: row => row.fulfillable === null,
  };
  let auth, request, snapshot, generation = 0, page = 0, scopedCount = 0, visible = [];
  let catalogRequest, refreshSession;
  const expandedDetails = new Set();
  let stockStatus = 'idle', ageRequest, ageStatus = 'idle', ageSnapshot = null;
  const visibleAgeCells = new Map();
  const openAgeCards = new Map();
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
    const sales_br_end_date = isDay(data.sales_br_end_date) ? data.sales_br_end_date : null;
    const sales_br_days = Object.fromEntries(shortWindows.map(days => {
      const n = data.sales_br_days?.[days];
      return [days,Number.isInteger(n) && n >= 0 && n <= days ? n : null];
    }));
    const seen = new Set();
    const rows = data.rows.map(row => {
      if (!safeText(row?.seller_sku,255) || seen.has(row.seller_sku) ||
          (row.asin !== null && !asinShape.test(row.asin ?? '')) ||
          (row.fnsku !== null && !fnskuShape.test(row.fnsku ?? '')) ||
          (row.condition !== null && !safeText(row.condition,128)) ||
          (row.last_updated_at !== null && !isTime(row.last_updated_at)) ||
          typeof row.tracked !== 'boolean' ||
          (noSales && row.ordered_units_30d !== null) ||
          quantityKeys.some(key => row[key] !== null && (!Number.isSafeInteger(row[key]) || row[key] < 0))) invalid();
      seen.add(row.seller_sku);
      const parent_asin = typeof row.parent_asin === 'string' && row.parent_asin.length === 10 &&
        asinShape.test(row.parent_asin) ? row.parent_asin : null;
      const in_transit = row.inbound_shipped === null || row.inbound_receiving === null ?
        null : row.inbound_shipped + row.inbound_receiving;
      if (in_transit !== null && !Number.isSafeInteger(in_transit)) invalid();
      const shortSales = Object.fromEntries(shortWindows.map(days => {
        const key = 'ordered_units_' + days + 'd', amount = row[key];
        return [key,sales_br_end_date && sales_br_days[days] === days && Number.isSafeInteger(amount) && amount >= 0
          ? amount : null];
      }));
      const daily_average = shortSales.ordered_units_7d === null ? null : shortSales.ordered_units_7d / 7;
      const sellable_days = row.fulfillable !== null && daily_average > 0 ? row.fulfillable / daily_average : null;
      // Older inventory snapshots do not include the detail properties. A bad
      // optional value must not make the working base inventory unavailable.
      const quantities = Object.fromEntries(optionalDetailColumns.map(([key]) => [key,
        Number.isSafeInteger(row[key]) && row[key] >= 0 ? row[key] : null,
      ]));
      const item = {...row, ...quantities, ...shortSales, product_short_name:null, owner:null, parent_asin, inventoryParent:parent_asin,
        in_transit, daily_average, sellable_days, tracking_label:row.tracked ? '是' : '否'};
      item.search = searchText(item);
      return item;
    });
    rows.sort(inventoryOrder);
    if (rows.some(row => row.tracked) !== (tracking_matched_count > 0)) invalid();
    return {captured_at:data.captured_at, sales_start_date, sales_end_date, sales_captured_at, sales_br_end_date, sales_br_days,
      tracking_count, tracking_matched_count, rows};
  }

  function readDirectory(data) {
    if (data === null) return null;
    if (data?.store !== 'MC' || data.marketplace !== 'amazon.com' || !isDay(data.snapshot_date) ||
        !Array.isArray(data.products) || data.products.length > limit) throw new ReadError(200,'invalid');
    const bySku = new Map(), byChild = new Map();
    for (const product of data.products) {
      if (!safeText(product?.sku,255)) throw new ReadError(200,'invalid');
      const child = product.asin, parent = product.parent_asin;
      const validChild = typeof child === 'string' && child.length === 10 && asinShape.test(child);
      const validParent = typeof parent === 'string' && parent.length === 10 && asinShape.test(parent) ? parent : null;
      if (validChild) {
        if (!byChild.has(child)) byChild.set(child,validParent);
        else if (byChild.get(child) !== validParent) byChild.set(child,null);
      }
      // A seller SKU can occur under different child ASINs. Only a unique current row supplies its labels.
      bySku.set(product.sku,bySku.has(product.sku) ? null : {
        parent:validParent,
        name:safeText(product.product_short_name,160) ? product.product_short_name : null,
        owner:Array.isArray(product.owners) && product.owners.every(label => safeText(label,160))
          ? [...new Set(product.owners)].join('、') || null : null,
      });
    }
    return {bySku,byChild,date:data.snapshot_date};
  }

  function applyDirectory(base,directory) {
    let matched = 0;
    for (const row of base.rows) {
      const exact = directory?.bySku.get(row.seller_sku);
      if (exact) matched++;
      row.product_short_name = exact?.name ?? null;
      row.owner = exact?.owner ?? null;
      row.parent_asin = exact?.parent ?? row.inventoryParent ?? directory?.byChild.get(row.asin) ?? null;
      row.search = searchText(row);
    }
    base.rows.sort(inventoryOrder);
    filterRows(true);
    return matched;
  }

  function catalogNotice(message = '', retry = false) {
    el.catalogNotice.textContent = message;
    el.catalogNotice.hidden = !message;
    el.catalogRetry.hidden = !retry;
  }

  async function loadCatalog(base) {
    catalogRequest?.abort();
    const read = new AbortController();
    catalogRequest = read;
    el.download.disabled = true;
    catalogNotice('正在读取产品目录…');
    try {
      const signal = AbortSignal.any([read.signal,AbortSignal.timeout(25_000)]);
      const directory = readDirectory(await readRpc(catalogEndpoint,auth,signal));
      if (catalogRequest !== read || snapshot !== base || read.signal.aborted) return;
      const matched = applyDirectory(base,directory);
      if (directory) {
        catalogNotice('产品目录 ' + directory.date + '：已匹配 ' + formatUnits(matched) + ' / ' +
          formatUnits(base.rows.length) + ' 个库存 SKU；缺少的简称和负责人显示「—」。');
      } else catalogNotice('尚无产品目录，产品简称和负责人暂缺。',true);
    } catch (error) {
      if (catalogRequest !== read || snapshot !== base || read.signal.aborted) return;
      const message = error.status === 403 || error.code === '42501' ? '当前账号没有读取产品目录的权限。'
        : error.code === 'invalid' ? '产品目录格式异常。' : '产品目录读取失败。';
      catalogNotice(message + '库存仍可查看，产品简称和负责人暂缺。',true);
    } finally {
      if (catalogRequest === read) {
        catalogRequest = null;
        el.download.disabled = !snapshot || !visible.length;
      }
    }
  }

  function ageKey(row) {
    // Do not fall back to ASIN, fold case, or match a missing FNSKU.
    return row.asin && row.fnsku ? JSON.stringify([row.seller_sku,row.asin,row.fnsku]) : null;
  }

  function bandTotal(quantities, bands) {
    let total = 0;
    for (const [key] of bands) {
      if (quantities[key] === null) return null;
      total += quantities[key];
    }
    return Number.isSafeInteger(total) ? total : null;
  }

  function parseAgeSnapshot(data) {
    if (data === null) return null;
    const invalid = () => { throw new ReadError(200,'invalid'); };
    if (data?.store !== 'MC' || data.marketplace !== 'amazon.com' || !isTime(data.captured_at) ||
        !Array.isArray(data.rows) || data.rows.length > 20_000 || data.row_count !== data.rows.length) invalid();
    const rows = new Map();
    let reportDate = null;
    for (const row of data.rows) {
      if (!safeText(row?.seller_sku,255) || typeof row.asin !== 'string' || !asinShape.test(row.asin) ||
          (row.fnsku !== null && (typeof row.fnsku !== 'string' || !fnskuShape.test(row.fnsku))) || !isDay(row.report_snapshot_date) ||
          (row.age_snapshot_date !== null && !isDay(row.age_snapshot_date)) ||
          ageQuantityColumns.some(([key]) => row[key] != null &&
            (!Number.isSafeInteger(row[key]) || row[key] < 0))) invalid();
      if (reportDate === null || row.report_snapshot_date > reportDate) reportDate = row.report_snapshot_date;
      const key = ageKey(row);
      if (key === null) continue;
      if (rows.has(key)) invalid();
      const quantities = Object.fromEntries(ageQuantityColumns.map(([field]) => [field,row[field] ?? null]));
      rows.set(key,{...row,...quantities,age_total:bandTotal(quantities,ageBands),
        age_over_180:bandTotal(quantities,ageBands.slice(2))});
    }
    return {capturedAt:data.captured_at,reportDate,rows};
  }

  async function readRpc(api, current, signal) {
    const access = current.session.access_token;
    const send = token => fetch(api, {
      method:'POST', cache:'no-store', credentials:'omit', mode:'cors', redirect:'error',
      referrerPolicy:'no-referrer', signal,
      headers:{ Accept:'application/json', 'Content-Type':'application/json',
        apikey:cfg.SUPABASE_PUBLISHABLE_KEY, Authorization:`Bearer ${token}` },
      body:'{}',
    });
    let response = await send(access);
    if (response.status === 401 && !signal.aborted && auth?.user.id === current.user.id) {
      if (auth.session.access_token === access && !refreshSession) {
        const pending = window.KBAuth.getValidSession().finally(() => {
          if (refreshSession === pending) refreshSession = null;
        });
        refreshSession = pending;
      }
      const refreshed = auth.session.access_token === access ? await refreshSession : auth;
      if (!signal.aborted && auth?.user.id === current.user.id && refreshed?.user?.id === current.user.id &&
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
    return response.json();
  }

  function filterRows(preserve = false) {
    if (!snapshot) return;
    const query = searchable(el.search.value.trim()).split(/\s+/).filter(Boolean);
    const accepts = Object.hasOwn(filters,el.filter.value) ? filters[el.filter.value] : () => true;
    const scoped = el.scope.value === 'all' ? snapshot.rows : snapshot.rows.filter(row => row.tracked);
    scopedCount = scoped.length;
    visible = scoped.filter(row => accepts(row) && query.every(token => row.search.includes(token)));
    const preserveView = preserve === true;
    page = preserveView ? Math.max(0,Math.min(page,Math.ceil(visible.length/pageSize)-1)) : 0;
    renderPage(preserveView);
  }

  function renderPage(preserve = false) {
    const open = preserve ? new Set(expandedDetails) : new Set();
    expandedDetails.clear();
    renderSources();
    openAgeCards.clear();
    visibleAgeCells.clear();
    const count = visible.length;
    const pages = Math.ceil(count / pageSize);
    const total = snapshot.rows.length;
    const noTracked = total > 0 && scopedCount === 0;
    const scopeLabel = el.scope.value === 'all' ? '' : `（运营跟踪 · 全店 ${formatUnits(total)} 个 SKU）`;
    el.count.textContent = `符合条件 ${formatUnits(count)} / ${formatUnits(scopedCount)} 个 SKU${scopeLabel}`;
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
    el.download.disabled = count === 0 || Boolean(catalogRequest);
    el.prev.disabled = page === 0;
    el.next.disabled = page + 1 >= pages;
    el.page.textContent = pages ? `第 ${formatUnits(page + 1)} / ${formatUnits(pages)} 页` : '';
    const body = document.createDocumentFragment();
    let rowNumber = page * pageSize;
    const outdated = stockDelayed() || salesDelayed();
    for (const row of visible.slice(rowNumber,(page + 1) * pageSize)) {
      const tr = document.createElement('tr');
      const panelId = `inventory-detail-${++rowNumber}`;
      const detail = open.has(row) ? renderDetail(row,panelId) : null;
      for (const [key,,kind] of columns) {
        const value = key === 'sellable_days' && outdated ? null : row[key];
        const isSku = key === 'seller_sku';
        const cell = document.createElement(isSku ? 'th' : 'td');
        cell.dataset.column = key;
        if (isSku) {
          cell.scope = 'row';
          cell.id = `${panelId}-sku`;
          cell.classList.add('inventory-sku');
        }
        if (key === 'parent_asin' || key === 'asin') cell.classList.add('inventory-asin');
        if (kind) cell.classList.add('results-num');
        if (value === null) cell.classList.add('results-missing');
        if (key === 'fulfillable' && value === 0) cell.classList.add('inventory-zero');
        cell.textContent = formatCell(value,kind);
        if (isSku) cell.append(detailToggle(tr,row,panelId,detail));
        tr.append(cell);
      }
      const ageCells = ageTableKeys.map(key => {
        const cell = document.createElement('td');
        cell.dataset.column = key;
        cell.setAttribute('headers',`${panelId}-sku inventory-age-group inventory-col-${key}`);
        tr.append(cell);
        return cell;
      });
      visibleAgeCells.set(row,ageCells);
      fillAgeCells(row,ageCells);
      body.append(tr);
      if (detail) body.append(detail);
    }
    el.body.replaceChildren(body);
  }

  function fillAgeCells(row,cells) {
    const data = ageSnapshot?.rows.get(ageKey(row));
    for (const [index,cell] of cells.entries()) {
      const value = data?.[ageTableKeys[index]] ?? null;
      cell.textContent = formatCell(value,'number');
      cell.setAttribute('class',`results-num inventory-age-value${value === null ? ' results-missing' : ''}`);
    }
  }

  function detailToggle(summaryRow,row,panelId,previousDetail) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.classList.add('inventory-detail-toggle');
    toggle.textContent = '库存明细';
    toggle.setAttribute('aria-label',`库存明细：${row.seller_sku}`);
    let detail = previousDetail;
    toggle.setAttribute('aria-expanded',String(Boolean(detail)));
    if (detail) {
      detail.hidden = false;
      expandedDetails.add(row);
      toggle.setAttribute('aria-controls',panelId);
    }
    toggle.addEventListener('click',() => {
      if (!detail) {
        detail = renderDetail(row,panelId);
        summaryRow.after(detail);
        toggle.setAttribute('aria-controls',panelId);
      }
      const open = detail.hidden;
      detail.hidden = !open;
      if (open) expandedDetails.add(row);
      else expandedDetails.delete(row);
      toggle.setAttribute('aria-expanded',String(open));
    });
    return toggle;
  }

  function renderDetail(row,panelId) {
    const detail = document.createElement('tr');
    detail.classList.add('inventory-detail-row');
    detail.hidden = true;
    const cell = document.createElement('td');
    cell.colSpan = columns.length + ageTableKeys.length;
    const panel = document.createElement('div');
    panel.id = panelId;
    panel.classList.add('inventory-detail-panel');
    const title = document.createElement('h2');
    title.textContent = `${row.seller_sku} · FBA 库存明细`;
    const grid = document.createElement('div');
    grid.classList.add('inventory-detail-grid');
    for (const [group,items] of detailGroups) {
      const card = document.createElement('section');
      card.classList.add('inventory-detail-card');
      const heading = document.createElement('h3');
      heading.textContent = group;
      const list = document.createElement('dl');
      for (const [key,label] of items) {
        const line = document.createElement('div');
        const term = document.createElement('dt');
        const count = document.createElement('dd');
        term.textContent = label;
        count.textContent = formatCell(row[key],'number');
        if (row[key] === null) count.classList.add('results-missing');
        line.append(term,count);
        list.append(line);
      }
      card.append(heading,list);
      grid.append(card);
    }
    const age = document.createElement('section');
    age.classList.add('inventory-detail-card');
    age.classList.add('inventory-age-card');
    openAgeCards.set(row,age);
    renderAgeCard(row,age);
    panel.append(title,grid,age);
    cell.append(panel);
    detail.append(cell);
    return detail;
  }

  function renderAgeCard(row, element) {
    const title = document.createElement('h3');
    title.textContent = '库龄';
    const note = document.createElement('p');
    note.classList.add('inventory-age-note');
    const data = ageSnapshot?.rows.get(ageKey(row));
    if (!data) {
      note.textContent = ageStatus === 'loading' ? '正在读取库龄…' :
        ageStatus === 'failed' ? '库龄暂不可用。' :
        ageStatus === 'ready' ? '该 SKU 尚无匹配的库龄记录。' : '暂无库龄报表。';
      element.replaceChildren(title,note);
      return;
    }
    note.textContent = '库龄快照日期（美西）：';
    if (data.age_snapshot_date === null) note.textContent += missing;
    else {
      const date = document.createElement('time');
      date.dateTime = data.age_snapshot_date;
      date.textContent = data.age_snapshot_date;
      note.append(date);
    }
    const items = [title,note,ageList(data,ageTotals)];
    if (ageYoungBands.every(([key]) => data[key] !== null)) {
      const details = document.createElement('details');
      details.classList.add('inventory-age-young');
      const summary = document.createElement('summary');
      summary.textContent = '0–90 天细分';
      details.append(summary,ageList(data,ageYoungBands));
      items.push(details);
    }
    element.replaceChildren(...items);
  }

  function ageList(data,bands) {
    const list = document.createElement('dl');
    list.classList.add('inventory-age-bands');
    for (const [key,label] of bands) appendAgeLine(list,label,data[key]);
    return list;
  }

  function appendAgeLine(list,label,value) {
    const line = document.createElement('div');
    const term = document.createElement('dt');
    const count = document.createElement('dd');
    term.textContent = label;
    count.textContent = formatCell(value,'number');
    if (value === null) count.classList.add('results-missing');
    line.append(term,count);
    list.append(line);
  }

  function refreshAge() {
    for (const [row,cells] of visibleAgeCells) fillAgeCells(row,cells);
    for (const [row,card] of openAgeCards) renderAgeCard(row,card);
    const text = ageStatus === 'loading' ? '正在读取库龄…' : ageStatus === 'failed' ?
      (ageSnapshot ? '库龄读取失败，暂用上次成功加载的报表。' : '库龄暂不可用，可点「重新读取」重试。') :
      ageStatus === 'idle' && snapshot?.rows.length ? '暂无库龄报表。' : '';
    el.ageNotice.textContent = text;
    el.ageNotice.hidden = !text;
    renderSources();
  }

  function cancelAge() {
    ageRequest?.abort();
    ageRequest = null;
  }

  async function loadAge(base) {
    cancelAge();
    const read = new AbortController();
    ageRequest = read;
    ageStatus = 'loading';
    refreshAge();
    try {
      const signal = AbortSignal.any([read.signal,AbortSignal.timeout(25_000)]);
      const next = parseAgeSnapshot(await readRpc(ageEndpoint,auth,signal));
      if (ageRequest !== read || read.signal.aborted || snapshot !== base) return;
      ageSnapshot = next;
      ageStatus = next === null ? 'idle' : 'ready';
    } catch (error) {
      if (ageRequest !== read || read.signal.aborted || snapshot !== base) return;
      // An authorization error cannot leave data from an earlier allowed read visible.
      if (error.status === 401 || error.status === 403 || error.code === '42501') ageSnapshot = null;
      ageStatus = 'failed';
    } finally {
      if (ageRequest === read) {
        ageRequest = null;
        refreshAge();
      }
    }
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
    if (!snapshot || !visible.length || catalogRequest) return;
    const csvColumns = [...columns,...extraColumns,...optionalDetailColumns];
    const header = [...csvColumns.map(([,label]) => label), ...ageCsvColumns.map(([,label]) => label), '库存快照时间（UTC）',
      '订购统计起始日（美西）', '订购统计截止日（美西）', '订购报表采集时间（UTC）',
      '近 1、7、15 天订购截止日（美西）'].map(csvCell).join(',');
    const outdated = stockDelayed() || salesDelayed();
    const blob = new Blob(['\uFEFF',header,'\r\n', ...visible.map(row => {
      const age = ageSnapshot?.rows.get(ageKey(row));
      return [...csvColumns.map(([key]) => key === 'sellable_days' && outdated ? null : row[key]),
        ...ageCsvColumns.map(([key]) => age?.[key] ?? null),
        snapshot.captured_at,
        snapshot.sales_start_date,snapshot.sales_end_date,snapshot.sales_captured_at,snapshot.sales_br_end_date].map(csvCell).join(',') + '\r\n';
    })],
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
    catalogRequest?.abort();
    catalogRequest = null;
    el.download.disabled = true;
    catalogNotice();
    expandedDetails.clear();
    cancelAge();
    ageSnapshot = null;
    ageStatus = stockStatus = 'idle';
    visibleAgeCells.clear();
    openAgeCards.clear();
    snapshot = undefined;
    visible = [];
    page = scopedCount = 0;
    el.body.replaceChildren();
    el.ageNotice.textContent = '';
    el.ageNotice.hidden = true;
    el.results.hidden = true;
    for (const item of [el.count,el.empty,el.tracking,el.page]) item.textContent = '';
    renderSources();
    for (const href of downloads) URL.revokeObjectURL(href);
    downloads.clear();
  }

  function daysSincePacific(value) {
    const {year,month,day} = Object.fromEntries(pacificDay.formatToParts().map(({type,value}) => [type,value]));
    return (Date.parse(`${year}-${month}-${day}`) - Date.parse(value)) / dayMs;
  }

  function stockDelayed() {
    return !!snapshot && Date.now() - Date.parse(snapshot.captured_at) > stockFreshnessMs;
  }

  function salesDelayed() {
    return !!snapshot?.sales_br_end_date && daysSincePacific(snapshot.sales_br_end_date) > salesFreshnessDays;
  }

  function showTime(field,time,value,display) {
    field.hidden = time.hidden = !value;
    time.textContent = value ? display : '';
    if (value) time.dateTime = value;
    else time.removeAttribute('datetime');
  }

  function showState(el,state,label) {
    if (el.textContent !== label) el.textContent = label;
    el.dataset.state = state;
  }

  function renderSources() {
    const stockLate = stockDelayed();
    const salesLate = salesDelayed();
    const stockAt = snapshot?.captured_at;
    const salesAt = snapshot?.sales_captured_at;
    const shortEnd = snapshot?.sales_br_end_date;
    const longLate = !!snapshot?.sales_end_date && daysSincePacific(snapshot.sales_end_date) > salesFreshnessDays;
    const ageAt = ageSnapshot?.capturedAt;
    const ageDate = ageSnapshot?.reportDate;
    const ageLate = !!ageDate && daysSincePacific(ageDate) > ageFreshnessDays;
    const incoming = stockStatus === 'loading';
    const failed = stockStatus === 'failed';
    const sourceState = (el,available,late,missingLabel) => {
      if (incoming) showState(el,'loading','读取中');
      else if (failed) showState(el,'failed',available ? '显示上次读取' : '读取失败');
      else if (!available) showState(el,'empty',missingLabel);
      else if (late) showState(el,'delayed','数据较旧');
      else showState(el,'ready','已同步');
    };

    sourceState(el.stockState,stockAt,stockLate,'暂无快照');
    showTime(el.stockTime,el.timestamp,stockAt,stockAt && dates.format(new Date(stockAt)));
    el.stockLag.hidden = !stockLate;
    sourceState(el.salesState,salesAt || shortEnd,salesLate || longLate,'尚未同步');
    if (!incoming && !failed && (salesAt || shortEnd) && !salesLate && !longLate &&
        (!salesAt || !shortEnd || shortWindows.some(days => snapshot.sales_br_days[days] !== days))) {
      showState(el.salesState,'empty','部分已同步');
    }
    el.salesDates.textContent = snapshot ? [
      shortEnd ? '近 1、7、15 天截止日（美西）：' + shortEnd + '。' : '近 1、7、15 天订购数据尚未同步。',
      salesAt ? '近 30 天（美西）：' + snapshot.sales_start_date + ' 至 ' + snapshot.sales_end_date + '。' : '近 30 天订购报表尚未同步。',
    ].join(' ') : '';
    el.salesCoverage.textContent = shortEnd ? '日报覆盖：' + shortWindows.map(days =>
      (snapshot.sales_br_days[days] ?? missing) + '/' + days + ' 天').join('、') + '。' : '';
    el.salesCoverage.hidden = !shortEnd;
    showTime(el.salesTime,el.salesTimestamp,salesAt,salesAt && dates.format(new Date(salesAt)));
    el.salesLag.textContent = [salesLate ? '近 1、7、15 天订购截止日距今超过 3 天。' : '',
      longLate ? '近 30 天订购截止日距今超过 3 天。' : ''].join('');
    el.salesLag.hidden = !salesLate && !longLate;

    if (ageStatus === 'loading') showState(el.ageState,'loading','读取中');
    else if (ageStatus === 'failed') showState(el.ageState,'failed',ageAt ? '显示上次读取' : '读取失败');
    else if (!ageAt) showState(el.ageState,'empty',failed ? '未读取' : '暂无报表');
    else if (ageLate) showState(el.ageState,'delayed','数据较旧');
    else showState(el.ageState,'ready','已同步');
    showTime(el.ageReport,el.ageReportDate,ageDate,ageDate);
    showTime(el.ageTime,el.ageTimestamp,ageAt,ageAt && dates.format(new Date(ageAt)));
    el.ageLag.hidden = !ageLate;

    const reason = stockLate && salesLate ? '当前库存和近 7 天订购数据' : stockLate ? '当前库存' : '近 7 天订购数据';
    const message = stockLate || salesLate ? `${reason}较旧，预计可售天数暂不显示，导出也留空。库存及原始订购统计仍可查看。` : '';
    if (el.coverageNotice.textContent !== message) el.coverageNotice.textContent = message;
    el.coverageNotice.hidden = !message;
  }

  async function load() {
    if (!auth || request) return;
    cancelAge();
    if (ageStatus === 'loading') {
      ageStatus = ageSnapshot ? 'ready' : 'idle';
      refreshAge();
    }
    const read = new AbortController();
    request = read;
    el.reload.disabled = true;
    stockStatus = 'loading';
    renderSources();
    status('正在读取库存…');
    try {
      const signal = AbortSignal.any([read.signal,AbortSignal.timeout(25_000)]);
      const next = parseSnapshot(await readRpc(endpoint,auth,signal));
      if (request !== read || read.signal.aborted) return;
      if (next === null) {
        clearSnapshot();
        stockStatus = 'empty';
        status('还没有库存快照。请在首次同步完成后重新读取。');
        void loadAge(snapshot);
        return;
      }
      snapshot = next;
      stockStatus = 'ready';
      el.results.hidden = false;
      filterRows();
      status('');
      void loadAge(next);
      void loadCatalog(next);
    } catch (error) {
      if (request !== read || read.signal.aborted) return;
      if (error.status === 401) {
        clearPrivate();
        location.replace(login);
        return;
      }
      if (error.status === 403 || error.code === '42501') clearSnapshot();
      stockStatus = 'failed';
      renderSources();
      if (snapshot) renderPage();
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
    request = auth = refreshSession = null;
    clearSnapshot();
    el.search.value = el.filter.value = el.email.textContent = '';
    el.scope.value = 'all';
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
  el.catalogRetry.addEventListener('click',() => {
    if (auth && snapshot && !request && !catalogRequest) void loadCatalog(snapshot);
  });
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
  el.scope.value = 'all';
  void start();
})();
