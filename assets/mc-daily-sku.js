'use strict';

(() => {
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const minDate = '2000-01-03';
  const marketTime = 'America/Los_Angeles';
  const login = '../index.html';
  const pageSize = 25;
  const asinPattern = /^[A-Z0-9]{10}$/u;
  const catalogStates = new Set(['matched', 'unmatched', 'conflict']);
  const rowStates = new Set(['reported', 'not_reported', 'pending', 'conflict']);
  const sessionSources = new Set(['sku', 'child_asin']);
  const cfg = window.KB_CONFIG;
  const ids = ['appShell', 'loading', 'logoutBtn', 'userEmail', 'skuDate', 'skuParent', 'skuSearch', 'skuReload', 'skuStatus', 'skuData', 'skuHeading', 'skuCatalogDate', 'skuCoverageBr', 'skuCoverageSp', 'skuSections', 'skuScroll', 'skuTable', 'skuTableHead', 'skuTableBody', 'skuCount', 'skuPrev', 'skuNext'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const query = new URLSearchParams(location.search);
  const dates = new Intl.DateTimeFormat('en-US', {timeZone:marketTime, calendar:'gregory', numberingSystem:'latn', year:'numeric', month:'2-digit', day:'2-digit'});
  const formats = {
    count: new Intl.NumberFormat('en-US'),
    usd: new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'}),
    cny: new Intl.NumberFormat('zh-CN', {style:'currency', currency:'CNY'}),
    rate: new Intl.NumberFormat('en-US', {style:'percent', maximumFractionDigits:4}),
    decimal: new Intl.NumberFormat('en-US', {minimumFractionDigits:0, maximumFractionDigits:6}),
  };
  const groups = [
    ['产品标识', [
      ['日期','report_date'], ['SKU','sku'], ['公司SKU','company_skus'], ['ASIN','asin'], ['父ASIN','parent_asin'],
      ['产品中文名','names'], ['站点域名,如amazon.com','marketplace'],
    ]],
    ['成本设置', [
      ['汇率','exchange_rate','decimal'], ['产品成本(RMB)','product_cost_rmb','cny'], ['头程(RMB)','inbound_cost_rmb','cny'],
      ['FBA费用(原币)','fba_fee','usd'], ['佣金率','commission_rate','rate'], ['VAT税率','vat_rate','rate'],
    ]],
    ['运营记录', [
      ['店铺','store'], ['工作小组'], ['产品线'], ['新老品状态'], ['负责人','owners'], ['运营操作记录'],
      ['测评费用原币',null,'usd'], ['站外费用原币',null,'usd'], ['其他费用原币',null,'usd'],
    ]],
    ['周期与类目', [
      ['周','week'], ['周(周六-周五)','week_sat'], ['周(周日-周六)','week_sun'], ['周','week_label'], ['月份','month'],
      ['大类'], ['大类排名',null,'count'], ['小类'], ['小类排名',null,'count'],
    ]],
    ['业务报告（BR）', [
      ['买家访问次数-浏览器','sessions_browser','count'], ['买家访问次数-APP','sessions_app','count'], ['买家访问次数','sessions','count'],
      ['平均SKU访问-浏览器',null,'decimal'], ['平均SKU访问-APP',null,'decimal'], ['平均SKU访问',null,'decimal'],
      ['BR订单数','br_orders','count'], ['BR销量','br_units','count'], ['BR销售额','br_sales','usd'],
    ]],
    ['广告（目前仅 SP）', [
      ['广告曝光','sp_impressions','count'], ['广告点击','sp_clicks','count'], ['SP广告花费','sp_cost','usd'],
      ['SBV广告花费',null,'usd'], ['SB广告花费',null,'usd'], ['SD广告花费',null,'usd'], ['总广告花费','sp_cost','usd'],
      ['广告订单','sp_orders','count'], ['广告销量','sp_units','count'], ['广告销售额','sp_sales','usd'],
    ]],
    ['订单列表 · 待接入', [
      ['订单列表采购',null,'usd'], ['订单列表头程',null,'usd'], ['订单列表佣金',null,'usd'], ['订单列表税额',null,'usd'],
      ['订单列表FBA配送费',null,'usd'], ['订单列表促销订单数',null,'count'], ['订单列表促销',null,'usd'],
      ['订单列表订单数',null,'count'], ['订单列表销量',null,'count'], ['订单列表销售额',null,'usd'],
      ['订单列表毛利原币',null,'usd'], ['订单列表毛利(RMB)',null,'cny'],
    ]],
    ['交易表 · 待接入', [
      ['交易表采购',null,'usd'], ['交易表头程',null,'usd'], ['交易表佣金',null,'usd'], ['交易表税额',null,'usd'],
      ['交易表FBA配送费',null,'usd'], ['交易表促销订单数',null,'count'], ['交易表促销',null,'usd'], ['交易表退款',null,'usd'],
      ['交易表订单数',null,'count'], ['交易表销量',null,'count'], ['交易表回款订单销售额',null,'usd'],
      ['交易表Total回款金额',null,'usd'], ['交易表毛利原币',null,'usd'], ['交易表毛利(RMB)',null,'cny'],
    ]],
  ];
  const columns = groups.flatMap(([, entries]) => entries);
  const brKeys = new Set(groups[4][1].map(([,key]) => key).filter(Boolean));
  const spKeys = new Set(groups[5][1].map(([,key]) => key).filter(Boolean));
  const sessionKeys = new Set(['sessions_browser','sessions_app','sessions']);
  const childSessionLabel = '来自同日子 ASIN 报表；该子 ASIN 只对应一个卖家 SKU';
  const states = {pending:'报表尚未同步', not_reported:'同步报表里没有此 SKU 的记录', conflict:'无法唯一归属到该 SKU'};
  const dateKeys = new Set(['report_date','week','week_sat','week_sun','week_label','month']);
  let auth, refreshAuth, dayRequest, catalogRequest, current, generation = 0, page = 0;
  const groupStarts = [];

  function parseDay(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(text) || text.length !== 10) return null;
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === text ? date : null;
  }

  function yesterday() {
    const parts = Object.fromEntries(dates.formatToParts(Date.now()).map(({type,value}) => [type,value]));
    return iso(shift(parseDay(`${parts.year}-${parts.month}-${parts.day}`), -1));
  }

  const iso = date => date.toISOString().slice(0, 10);
  const shift = (date, days) => new Date(+date + days * 864e5);
  const monday = date => shift(date, -(date.getUTCDay() + 6) % 7);
  const dotted = date => iso(date).replaceAll('-', '.');

  function weekLabel(day, startDay) {
    const start = shift(day, -((day.getUTCDay() - startDay + 7) % 7));
    const end = shift(start, 6);
    const isoThursday = shift(monday(end), 3);
    const yearStart = parseDay(`${isoThursday.getUTCFullYear()}-01-04`);
    const number = 1 + Math.round((+monday(end) - +monday(yearStart)) / 6048e5);
    return `${dotted(start)}-${dotted(end)}[${String(number).padStart(2, '0')}]`;
  }

  function period(date) {
    const day = parseDay(date);
    return {report_date:date, week:weekLabel(day,1), week_sat:weekLabel(day,6), week_sun:weekLabel(day,0),
      week_label:'周', month:date.slice(0,7).replace('-','')};
  }

  function normalizeCoverage(coverage) {
    if (!coverage || !['ready','missing'].includes(coverage.status) ||
        (coverage.status === 'ready' && (!Number.isSafeInteger(coverage.source_rows) || coverage.source_rows < 0))) throw new TypeError('Invalid report coverage');
    return coverage;
  }

  function normalize(data, date, parent) {
    if (data?.report_date !== date || data.store !== 'MC' || data.marketplace !== 'amazon.com' ||
        (data.catalog_date != null && !parseDay(data.catalog_date)) ||
        !Array.isArray(data.rows) || data.rows.length > 30000) throw new TypeError('Invalid report response');
    const coverage = {br:normalizeCoverage(data.coverage?.br), sp:normalizeCoverage(data.coverage?.sp)};
    const seen = new Set();
    for (const row of data.rows) {
      if (typeof row?.sku !== 'string' || row.sku.length < 1 || row.sku.length > 128 || /[\x00-\x1f\x7f]/u.test(row.sku) || seen.has(row.sku) ||
          (row.asin != null && !asinPattern.test(row.asin)) || (row.parent_asin != null && !asinPattern.test(row.parent_asin)) ||
          (parent && parent !== row.parent_asin) || !catalogStates.has(row.catalog_status) || !rowStates.has(row.br_status) || !rowStates.has(row.sp_status) ||
          (row.sessions_source != null && !sessionSources.has(row.sessions_source)) ||
          ['company_skus','names','owners'].some(key => !Array.isArray(row[key]) || row[key].some(item => typeof item !== 'string'))) throw new TypeError('Invalid daily row');
      seen.add(row.sku);
    }
    return {date, parent, catalogDate:data.catalog_date, coverage, period:period(date), rows:data.rows};
  }

  function status(message = '', state) {
    ui.skuStatus.textContent = message;
    ui.skuStatus.hidden = !message;
    if (state) ui.skuStatus.dataset.state = state;
    else delete ui.skuStatus.dataset.state;
  }

  function clearRows() {
    current = null;
    page = 0;
    ui.skuData.hidden = true;
    ui.skuTableBody.replaceChildren();
    for (const key of ['skuHeading','skuCatalogDate','skuCoverageBr','skuCoverageSp','skuCount']) ui[key].textContent = '';
  }

  function clearPrivate() {
    generation++;
    dayRequest?.abort();
    catalogRequest?.abort();
    auth = refreshAuth = dayRequest = catalogRequest = null;
    clearRows();
    ui.skuParent.replaceChildren(new Option('全部父 ASIN',''));
    ui.skuSearch.value = '';
    ui.userEmail.textContent = '';
    ui.appShell.hidden = true;
    status();
  }

  function issue(httpStatus) {
    return Object.assign(new Error('MC_DAILY_SKU_READ_FAILED'), {status:httpStatus});
  }

  async function read(source, args, signal) {
    const name = source === 'day' ? 'mc_daily_sku_read' : source === 'catalog' ? 'mc_product_catalog_read' : null;
    if (!name || !auth?.session?.access_token) throw issue(401);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
    const send = token => fetch(`${origin}/rest/v1/rpc/${name}`, {
      method:'POST', redirect:'error', credentials:'omit', mode:'cors', cache:'no-store', referrerPolicy:'no-referrer', signal:combined,
      headers:{Accept:'application/json', 'Content-Type':'application/json', apikey:cfg.SUPABASE_PUBLISHABLE_KEY, Authorization:`Bearer ${token}`},
      body:JSON.stringify(args),
    });
    const previous = auth;
    const token = previous.session.access_token;
    let response = await send(token);
    if (response.status === 401 && !combined.aborted && auth?.user.id === previous.user.id) {
      if (auth.session.access_token !== token) response = await send(auth.session.access_token);
      else if (typeof window.KBAuth.getValidSession === 'function') {
        if (!refreshAuth) {
          const pending = Promise.resolve().then(() => window.KBAuth.getValidSession());
          refreshAuth = pending;
          const clear = () => { if (refreshAuth === pending) refreshAuth = null; };
          pending.then(clear,clear);
        }
        let next;
        try { next = await refreshAuth; } catch { throw issue(response.status); }
        if (!combined.aborted && auth?.user.id === previous.user.id && next?.user?.id === previous.user.id &&
            next.session?.access_token && next.session.access_token !== token) {
          auth = next;
          response = await send(next.session.access_token);
        }
      }
    }
    if (!response.ok) {
      if (response.status === 400 || response.status === 404) {
        let body;
        try { body = await response.json(); } catch {}
        if (body?.code === '42501') throw issue(403);
        if (body?.code === 'PGRST202' || body?.code === '42883') throw issue(404);
      }
      throw issue(response.status);
    }
    return await response.json();
  }

  function make(tag, content) {
    const node = document.createElement(tag);
    if (content != null) node.textContent = content;
    return node;
  }

  function jumpToGroup(index) {
    const first = groupStarts[index];
    if (!first) return;
    const firstRect = firstLocation();
    const base = ui.skuScroll.scrollLeft;
    const target = index === 0 ? 0 : Math.max(0, first.getBoundingClientRect().left - ui.skuScroll.getBoundingClientRect().left + base - firstRect);
    ui.skuScroll.scrollLeft = target;
  }

  function firstLocation() {
    const firstTwo = ui.skuTableHead.querySelectorAll('.sku-day-col-date, .sku-day-col-sku');
    return [...firstTwo].reduce((width, cell) => width + cell.getBoundingClientRect().width, 0);
  }

  function makeHeaders() {
    const groupsRow = make('tr');
    const columnsRow = make('tr');
    groupsRow.classList.add('sku-day-group-row');
    columnsRow.classList.add('sku-day-column-row');
    const shortcuts = [];
    let offset = 0;
    groups.forEach(([label, entries], index) => {
      const columnGroup = make('colgroup');
      columnGroup.span = entries.length;
      ui.skuTable.insertBefore(columnGroup,ui.skuTableHead);
      const group = make('th',label);
      group.id = `sku-col-group-${index}`;
      group.scope = 'colgroup';
      group.colSpan = entries.length;
      groupsRow.append(group);
      const shortcut = make('button',label);
      shortcut.type = 'button';
      shortcut.classList.add('sku-day-jump');
      shortcut.addEventListener('click',() => jumpToGroup(index));
      shortcuts.push(shortcut);
      entries.forEach(([name,,fmt], local) => {
        const cell = make('th',name);
        cell.scope = 'col';
        cell.id = `sku-col-${offset}`;
        cell.setAttribute('headers',group.id);
        if (fmt) cell.classList.add('results-number');
        if (offset === 0) cell.classList.add('sku-day-col-date');
        if (offset === 1) cell.classList.add('sku-day-col-sku');
        if (local === 0 && index > 0) groupStarts[index] = cell;
        if (offset === 0) groupStarts[0] = cell;
        columnsRow.append(cell);
        offset++;
      });
    });
    ui.skuSections.replaceChildren(...shortcuts);
    ui.skuTableHead.replaceChildren(groupsRow,columnsRow);
  }

  function numeric(raw, mask) {
    if ((typeof raw !== 'number' && (typeof raw !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/u.test(raw))) ||
        !Number.isFinite(Number(raw)) || Math.abs(Number(raw)) > Number.MAX_SAFE_INTEGER) return null;
    if (mask === 'count' && (!Number.isSafeInteger(Number(raw)) || Number(raw) < 0)) return null;
    return formats[mask].format(Number(raw));
  }

  function childAsinSessions(row, key) {
    return sessionKeys.has(key) && current.coverage.br.status === 'ready' &&
      row.sessions_source === 'child_asin' && row.catalog_status === 'matched' && row.br_status === 'not_reported';
  }

  function cellValue(row, key, fmt) {
    if (!key) return null;
    if (dateKeys.has(key)) return current.period[key];
    if (key === 'store') return 'MC';
    if (key === 'marketplace') return 'amazon.com';
    if (brKeys.has(key) && !childAsinSessions(row,key) && (current.coverage.br.status !== 'ready' || row.br_status !== 'reported')) return null;
    if (spKeys.has(key) && (current.coverage.sp.status !== 'ready' || row.sp_status !== 'reported')) return null;
    const raw = row[key];
    if (raw == null) return null;
    if (fmt) return numeric(raw,fmt);
    if (Array.isArray(raw)) return raw.length ? raw.join(' / ') : null;
    return typeof raw === 'string' && raw ? raw : null;
  }

  function renderPage(resetVertical = false) {
    if (!current) return;
    const search = ui.skuSearch.value.trim().toLowerCase();
    const rows = search ? current.rows.filter(row => [row.sku,row.asin,row.parent_asin].some(value => value?.toLowerCase().includes(search))) : current.rows;
    const last = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
    page = Math.min(page,last);
    const body = rows.slice(page * pageSize,(page + 1) * pageSize).map((row, rowIndex) => {
      const tr = make('tr');
      columns.forEach(([,key,fmt], index) => {
        const value = cellValue(row,key,fmt);
        const cell = make(index === 1 ? 'th' : 'td',value ?? '—');
        if (index === 0) cell.classList.add('sku-day-col-date');
        if (index === 1) {
          cell.classList.add('sku-day-col-sku');
          cell.scope = 'row';
          cell.id = `sku-row-${rowIndex}`;
          cell.setAttribute('headers','sku-col-1');
          cell.title = value;
        } else {
          cell.setAttribute('headers',`sku-col-${index} sku-row-${rowIndex}`);
        }
        if (fmt) cell.classList.add('results-number');
        if (value == null) {
          cell.classList.add('results-missing');
          const missing = brKeys.has(key) ? states[row.br_status] : spKeys.has(key) ? states[row.sp_status] : null;
          if (missing) { cell.title = missing;cell.setAttribute('aria-label',missing); }
        } else if (childAsinSessions(row,key)) {
          cell.title = childSessionLabel;
          cell.setAttribute('aria-label',`${value}，${childSessionLabel}`);
        } else if (index === 1 && row.catalog_status !== 'matched') {
          cell.title = row.catalog_status === 'conflict' ? '产品目录中 SKU 对应关系有冲突' : '产品目录没有唯一匹配项';
        } else if (key === 'names' || key === 'owners' || key === 'company_skus') {
          cell.classList.add('sku-day-inline-text');
          cell.title = value;
        }
        tr.append(cell);
      });
      return tr;
    });
    if (!body.length) {
      const none = make('tr');
      const cell = make('td',search ? '没有匹配的 SKU 或 ASIN。' : '当天没有这个范围的 SKU 记录。');
      cell.colSpan = columns.length;
      cell.classList.add('sku-day-no-rows');
      none.append(cell);
      body.push(none);
    }
    ui.skuTableBody.replaceChildren(...body);
    if (resetVertical) ui.skuScroll.scrollTop = 0;
    ui.skuCount.textContent = rows.length ? `${rows.length} 个 SKU · 第 ${page + 1} / ${last + 1} 页` : '0 个 SKU';
    ui.skuPrev.disabled = page === 0;
    ui.skuNext.disabled = page >= last;
  }

  function reportCoverage(node, label, coverage) {
    const ready = coverage.status === 'ready';
    node.textContent = ready ? `${label}：已同步（全店报表 ${formats.count.format(coverage.source_rows)} 行）` : `${label}：未同步`;
    node.dataset.ready = String(ready);
    const generated = coverage.source_generated_at == null ? null : new Date(coverage.source_generated_at);
    node.title = generated && Number.isFinite(+generated) ? `报告生成时间（美西）：${generated.toLocaleString('zh-CN',{timeZone:marketTime})}` : '';
  }

  function showDay(day) {
    current = day;
    ui.skuHeading.textContent = `${day.date} · ${day.parent || '全部父 ASIN'}`;
    ui.skuCatalogDate.textContent = day.catalogDate ? `产品目录版本：${day.catalogDate}` : '产品目录尚未同步';
    reportCoverage(ui.skuCoverageBr,'业务报告',day.coverage.br);
    reportCoverage(ui.skuCoverageSp,'SP 广告',day.coverage.sp);
    ui.skuData.hidden = false;
    renderPage(true);
    status();
  }

  function reportError(error, catalog = false) {
    if (error?.status === 401) {
      clearPrivate();
      location.replace(login);
    } else if (error?.status === 403) {
      clearRows();
      status('当前账号没有查看 MC 美国站经营明细的权限。','error');
    } else if (!catalog) {
      status(error?.status === 404 ? '每日经营明细接口尚未安装。' : '读取失败，请点击「重新读取」。','error');
    }
  }

  async function loadDay() {
    if (!auth) return;
    dayRequest?.abort();
    clearRows();
    const date = ui.skuDate.value;
    const parent = ui.skuParent.value;
    const latest = yesterday();
    ui.skuDate.max = latest;
    if (!parseDay(date) || date < minDate || date > latest) {
      status('请选择美西昨天或更早的日期。','error');
      return;
    }
    if (parent && !asinPattern.test(parent)) { status('请选择有效的父 ASIN。','error');return; }
    const controller = dayRequest = new AbortController();
    status('正在读取每日经营明细…');
    try {
      const data = await read('day',{p_report_date:date,p_parent_asin:parent || null},controller.signal);
      if (dayRequest === controller && !controller.signal.aborted && auth) showDay(normalize(data,date,parent));
    } catch (error) {
      if (dayRequest === controller && !controller.signal.aborted && auth) reportError(error);
    }
  }

  async function loadCatalog(preferred) {
    if (!auth) return;
    catalogRequest?.abort();
    const controller = catalogRequest = new AbortController();
    try {
      const catalog = await read('catalog',{},controller.signal);
      if (catalogRequest !== controller || controller.signal.aborted || !auth) return;
      const parents = new Set();
      if (catalog !== null) {
        if (catalog?.store !== 'MC' || catalog.marketplace !== 'amazon.com' || !Array.isArray(catalog.products) || catalog.products.length > 10000) throw new TypeError('Invalid MC catalog');
        for (const item of catalog.products) if (typeof item?.parent_asin === 'string' && asinPattern.test(item.parent_asin)) parents.add(item.parent_asin);
      }
      const selected = ui.skuParent.value;
      if (selected) parents.add(selected);
      else if (preferred && asinPattern.test(preferred)) parents.add(preferred);
      ui.skuParent.replaceChildren(new Option('全部父 ASIN',''), ...[...parents].sort().map(value => new Option(value,value)));
      ui.skuParent.value = selected;
    } catch (error) {
      if (catalogRequest === controller && !controller.signal.aborted && auth && error?.status === 401) reportError(error,true);
    }
  }

  async function start() {
    const counter = ++generation;
    ui.loading.hidden = false;
    ui.loading.textContent = '正在验证登录状态…';
    if (![origin,`${origin}/`].includes(cfg?.SUPABASE_URL) || !/^sb_publishable_[A-Za-z0-9_-]+$/u.test(cfg?.SUPABASE_PUBLISHABLE_KEY ?? '') ||
        typeof window.KBAuth?.requireAuth !== 'function') {
      ui.loading.textContent = '经营明细页面配置未加载，请刷新或联系管理员。';
      return;
    }
    try {
      const session = await window.KBAuth.requireAuth(login);
      if (generation !== counter || !session) return;
      if (!session.user?.id || !session.session?.access_token) { location.replace(login);return; }
      auth = session;
      ui.userEmail.textContent = session.user.email ?? '';
      const maximum = yesterday();
      const date = query.get('date');
      const parent = query.get('parent');
      ui.skuDate.min = minDate;
      ui.skuDate.max = maximum;
      ui.skuDate.value = parseDay(date) && date >= minDate && date <= maximum ? date : maximum;
      if (parent && asinPattern.test(parent)) {
        ui.skuParent.replaceChildren(new Option('全部父 ASIN',''),new Option(parent,parent));
        ui.skuParent.value = parent;
      }
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      void loadCatalog(parent);
      void loadDay();
    } catch {
      if (generation === counter) ui.loading.textContent = '登录校验失败，请刷新重试。';
    }
  }

  makeHeaders();
  ui.skuDate.addEventListener('change',loadDay);
  ui.skuParent.addEventListener('change',loadDay);
  ui.skuSearch.addEventListener('input',() => { page = 0; renderPage(true); });
  ui.skuReload.addEventListener('click',() => { void loadCatalog(); void loadDay(); });
  ui.skuPrev.addEventListener('click',() => { if (page > 0) { page--;renderPage(true); } });
  ui.skuNext.addEventListener('click',() => { page++;renderPage(true); });
  ui.logoutBtn.addEventListener('click',async () => {
    clearPrivate();
    try { await window.KBAuth.logout(); } finally { location.replace(login); }
  });
  window.addEventListener('pagehide',clearPrivate);
  window.addEventListener('pageshow',event => { if (event.persisted) void start(); });
  window.addEventListener('storage',event => {
    if (event.key !== cfg?.SESSION_KEY && event.key !== null) return;
    const user = value => { try { return JSON.parse(value)?.user?.id; } catch { return null; } };
    const next = user(event.newValue);
    if (next && next === user(event.oldValue) && (!auth || auth.user.id === next)) return;
    clearPrivate();
    if (event.newValue) void start();
    else location.replace(login);
  });
  void start();
})();
