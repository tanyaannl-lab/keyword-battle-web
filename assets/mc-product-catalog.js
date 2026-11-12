'use strict';

(() => {
  const ids = ['appShell', 'loading', 'userEmail', 'logoutBtn', 'catalog', 'search', 'owner',
    'clearFilters', 'summary', 'snapshotDate', 'catalogStatus', 'catalogList', 'catalogTable',
    'catalogPager', 'prevPage', 'nextPage', 'pageInfo', 'retry', 'catalogHeading', 'product-catalog',
    'costDetail', 'costTitle', 'costAsin', 'costParentGroup', 'costParent', 'costForm', 'costFields',
    'costExchange', 'costProduct', 'costInbound', 'costFba', 'costCommission', 'costVat',
    'costSave', 'costSavedAt', 'costStatus', 'costRetry'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const config = window.KB_CONFIG;
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });
  const sort = (a, b) => collator.compare(a, b);
  const normalize = text => text.normalize('NFKC').toLowerCase();
  const asinPattern = /^[A-Z0-9]{10}$/;
  const empty = '—';
  const pageSize = 25;
  const costInputs = [
    { id: 'costExchange', key: 'exchange_rate', min: 0.000001, max: 1000000, decimals: 6 },
    { id: 'costProduct', key: 'product_cost_rmb', min: 0, max: 100000000, decimals: 6 },
    { id: 'costInbound', key: 'inbound_cost_rmb', min: 0, max: 100000000, decimals: 6 },
    { id: 'costFba', key: 'fba_fee', min: 0, max: 100000000, decimals: 6 },
    { id: 'costCommission', key: 'commission_rate', min: 0, max: 100, decimals: 4, percent: true },
    { id: 'costVat', key: 'vat_rate', min: 0, max: 100, decimals: 4, percent: true },
  ];
  const costDateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  const catalogTitle = document.title;
  let auth = null;
  let request = null;
  let costRequest = null;
  let catalogLoaded = false;
  let activeCostAsin = null;
  let costRevision = null;
  let generation = 0;
  let products = [];
  let parentCount = 0;
  let page = 0;
  let searchTimer = 0;

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function status(message = '', state = '', retry = false) {
    ui.catalogStatus.textContent = message;
    ui.catalogStatus.hidden = !message;
    if (state) ui.catalogStatus.dataset.state = state;
    else delete ui.catalogStatus.dataset.state;
    ui.retry.hidden = !retry;
  }

  function clearCatalog() {
    clearTimeout(searchTimer);
    catalogLoaded = false;
    products = [];
    parentCount = 0;
    page = 0;
    ui.catalog.hidden = true;
    ui.catalogTable.hidden = true;
    ui.catalogPager.hidden = true;
    ui.catalogList.replaceChildren();
    ui.pageInfo.textContent = '';
    ui.prevPage.disabled = true;
    ui.nextPage.disabled = true;
    ui.owner.replaceChildren(new Option('全部负责人', ''));
    ui.search.value = '';
    ui.clearFilters.disabled = true;
    ui.summary.textContent = '';
    ui.snapshotDate.textContent = empty;
    ui.snapshotDate.removeAttribute('datetime');
  }

  function hidePrivateData() {
    generation++;
    request?.abort();
    request = null;
    auth = null;
    ui.appShell.hidden = true;
    ui.userEmail.textContent = '';
    clearCatalog();
    clearCostView();
    status();
  }

  function costStatus(message = '', state = '', retryLabel = '') {
    ui.costStatus.textContent = message;
    ui.costStatus.hidden = !message;
    if (state) ui.costStatus.dataset.state = state;
    else delete ui.costStatus.dataset.state;
    ui.costRetry.hidden = !retryLabel;
    if (retryLabel) ui.costRetry.textContent = retryLabel;
  }

  function clearCostView() {
    costRequest?.abort();
    costRequest = null;
    activeCostAsin = null;
    costRevision = null;
    ui.catalogHeading.hidden = false;
    ui.costDetail.hidden = true;
    ui.costForm.hidden = true;
    ui.costFields.disabled = true;
    ui.costSave.disabled = true;
    ui.costAsin.textContent = '';
    ui.costParent.textContent = '';
    ui.costParentGroup.hidden = true;
    ui.costSavedAt.textContent = '';
    for (const { id } of costInputs) ui[id].value = '';
    costStatus();
    document.title = catalogTitle;
  }

  function checkedText(value, max = 300) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      throw new Error('产品目录数据格式有误，请联系管理员。');
    }
    return value;
  }

  function checkedOwners(values) {
    if (!Array.isArray(values) || values.length > 30) {
      throw new Error('产品目录数据格式有误，请联系管理员。');
    }
    return [...new Set(values.map(value => checkedText(value)))].sort(sort);
  }

  function parseCatalog(data) {
    const date = typeof data?.snapshot_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.snapshot_date)
      ? new Date(`${data.snapshot_date}T00:00:00Z`) : null;
    if (!date || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== data.snapshot_date ||
        data.store !== 'MC' || data.marketplace !== 'amazon.com' ||
        !Array.isArray(data.products) || !data.products.length || data.products.length > 20000) {
      throw new Error('产品目录数据格式有误，请联系管理员。');
    }
    const rows = [];
    const keys = new Set();
    const owners = new Set();
    const parents = new Set();
    for (const item of data.products) {
      if (!item || typeof item.parent_asin !== 'string' || !asinPattern.test(item.parent_asin) ||
          typeof item.asin !== 'string' || !asinPattern.test(item.asin)) {
        throw new Error('产品目录数据格式有误，请联系管理员。');
      }
      const sku = checkedText(item.sku);
      const key = `${item.asin}\0${sku}`;
      if (keys.has(key)) throw new Error('产品目录存在重复商品，请联系管理员。');
      keys.add(key);
      const row = { asin: item.asin, parent: item.parent_asin, sku, owners: checkedOwners(item.owners) };
      row.searchText = normalize([row.asin, row.parent, ...row.owners, row.sku].join(' '));
      row.owners.forEach(owner => owners.add(owner));
      parents.add(row.parent);
      rows.push(row);
    }
    rows.sort((a, b) => sort(a.parent, b.parent) || sort(a.asin, b.asin) || sort(a.sku, b.sku));
    return { rows, parentCount: parents.size, owners: [...owners].sort(sort) };
  }

  function cell(values, className) {
    const td = node('td', className);
    const text = Array.isArray(values) ? values : [values];
    for (const value of text.length ? text : [empty]) td.append(node('span', '', value));
    return td;
  }

  function render() {
    if (ui.catalog.hidden || !auth) return;
    const tokens = normalize(ui.search.value.trim()).split(/\s+/).filter(Boolean);
    const owner = ui.owner.value;
    const visible = products.filter(row => (!owner || row.owners.includes(owner)) && tokens.every(token => row.searchText.includes(token)));
    const pageCount = Math.ceil(visible.length / pageSize);
    page = Math.min(Math.max(page, 0), Math.max(pageCount - 1, 0));
    ui.clearFilters.disabled = !ui.search.value && !owner;
    ui.summary.textContent = tokens.length || owner
      ? `找到 ${visible.length} / ${products.length} 个子商品`
      : `${parentCount} 个父款 · ${products.length} 个子商品`;
    const result = document.createDocumentFragment();
    for (const row of visible.slice(page * pageSize, (page + 1) * pageSize)) {
      const tr = node('tr');
      const costCell = node('td');
      const costLink = node('a', 'catalog-cost-link', '查看 / 修改');
      costLink.href = `#cost-params=${row.asin}`;
      costLink.dataset.costAsin = row.asin;
      costLink.setAttribute('aria-label', `查看或修改 ${row.asin} 的成本参数`);
      costCell.append(costLink);
      tr.append(cell(row.asin, 'catalog-asin'), cell(row.parent, 'catalog-asin'),
        cell(row.owners, 'catalog-owner'), cell(row.sku, 'catalog-sku'), costCell);
      result.append(tr);
    }
    ui.catalogList.replaceChildren(result);
    ui.catalogTable.hidden = !visible.length;
    ui.catalogPager.hidden = pageCount <= 1;
    ui.prevPage.disabled = page === 0;
    ui.nextPage.disabled = page + 1 >= pageCount;
    ui.pageInfo.textContent = pageCount > 1 ? `第 ${page + 1} / ${pageCount} 页` : '';
    status(visible.length ? '' : '没有找到匹配的产品。试试其他关键词，或清除筛选。');
  }

  async function loadCatalog() {
    if (!auth || request) return;
    const controller = new AbortController();
    request = controller;
    clearCatalog();
    status('正在读取 MC 产品目录…');
    try {
      const response = await fetch(`${origin}/rest/v1/rpc/mc_product_catalog_read`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
          apikey: config.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${auth.session.access_token}` },
        body: '{}', cache: 'no-store', credentials: 'omit', mode: 'cors', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      if (request !== controller || !auth) return;
      if (response.status === 401) { hidePrivateData(); location.replace(login); return; }
      if (response.status === 403) { status('当前账号没有查看 MC 产品目录的权限。', 'error'); return; }
      if (response.status === 404) { status('产品目录尚未启用，请联系管理员。', 'error'); return; }
      if (!response.ok) throw new Error('暂时无法读取产品目录，请稍后重试。');
      const data = await response.json();
      if (request !== controller || !auth) return;
      if (data === null) { status('还没有导入产品目录。'); return; }
      const parsed = parseCatalog(data);
      products = parsed.rows;
      parentCount = parsed.parentCount;
      ui.owner.append(...parsed.owners.map(owner => new Option(owner, owner)));
      ui.snapshotDate.textContent = data.snapshot_date;
      ui.snapshotDate.dateTime = data.snapshot_date;
      catalogLoaded = true;
      showRoute();
    } catch (error) {
      if (request !== controller || controller.signal.aborted) return;
      const message = error.name === 'TimeoutError' ? '读取产品目录超时，请重试。'
        : error instanceof TypeError || error instanceof SyntaxError ? '暂时无法读取产品目录，请重试。' : error.message;
      status(message, 'error', true);
    } finally {
      if (request === controller) request = null;
    }
  }

  function showRoute() {
    if (!auth || !catalogLoaded) return;
    const asin = /^#cost-params=([A-Z0-9]{10})$/.exec(location.hash)?.[1];
    const previous = activeCostAsin;
    if (asin && asin === previous) return;
    clearCostView();
    if (!asin) {
      ui.catalog.hidden = false;
      render();
      if (previous) (ui.catalogList.querySelector(`[data-cost-asin="${previous}"]`) ?? ui['product-catalog']).focus();
      return;
    }

    activeCostAsin = asin;
    ui.catalog.hidden = true;
    ui.catalogHeading.hidden = true;
    ui.costAsin.textContent = asin;
    ui.costDetail.hidden = false;
    document.title = `成本参数｜${asin}｜产品目录`;
    status();
    ui.costTitle.focus();

    const product = products.find(item => item.asin === asin);
    if (!product) {
      costStatus('该子 ASIN 不在当前 MC 产品目录中。', 'error');
      return;
    }
    ui.costParent.textContent = product.parent;
    ui.costParentGroup.hidden = false;
    void fetchCost();
  }

  function showCost(data, asin) {
    if (!data || data.asin !== asin || !Number.isInteger(data.revision) || data.revision < 0 ||
        (data.revision === 0 ? data.updated_at !== null :
          typeof data.updated_at !== 'string' || !Number.isFinite(Date.parse(data.updated_at)))) {
      throw new Error('成本参数数据格式有误，请联系管理员。');
    }
    const values = costInputs.map(({ key, min, max, decimals, percent }) => {
      if (data[key] === null) return '';
      const value = typeof data[key] === 'number' ? data[key] * (percent ? 100 : 1) : NaN;
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error('成本参数数据格式有误，请联系管理员。');
      }
      return value.toFixed(decimals).replace(/\.?0+$/, '');
    });
    costInputs.forEach(({ id }, index) => { ui[id].value = values[index]; });
    costRevision = data.revision;
    ui.costForm.hidden = false;
    ui.costSavedAt.textContent = data.updated_at === null
      ? '尚未设置成本参数' : `上次保存：${costDateFormat.format(new Date(data.updated_at))}`;
  }

  async function fetchCost(values) {
    if (!auth || !activeCostAsin || costRequest) return;
    const saving = values !== undefined;
    const asin = activeCostAsin;
    const userId = auth.user.id;
    const controller = new AbortController();
    const endpoint = saving ? 'mc_product_catalog_cost_save' : 'mc_product_catalog_cost_read';
    const current = () => costRequest === controller && activeCostAsin === asin && auth?.user.id === userId;
    costRequest = controller;
    ui.costFields.disabled = true;
    ui.costSave.disabled = true;
    costStatus(saving ? '正在保存成本参数…' : '正在读取成本参数…');
    try {
      const session = typeof window.KBAuth.getValidSession === 'function'
        ? await window.KBAuth.getValidSession() : auth;
      if (!current()) return;
      if (!session?.session?.access_token || session.user?.id !== userId) {
        hidePrivateData(); location.replace(login); return;
      }
      auth = session;
      const body = saving ? { p_asin: asin, p_revision: costRevision, ...values } : { p_asin: asin };
      const response = await fetch(`${origin}/rest/v1/rpc/${endpoint}`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
          apikey: config.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${auth.session.access_token}` },
        body: JSON.stringify(body), cache: 'no-store', credentials: 'omit', mode: 'cors', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      if (!current()) return;
      if (response.status === 401) { hidePrivateData(); location.replace(login); return; }
      const data = await response.json().catch(() => undefined);
      if (!current()) return;
      if (response.status === 403 || data?.code === '42501') {
        ui.costForm.hidden = true;
        costRevision = null;
        for (const { id } of costInputs) ui[id].value = '';
        costStatus('当前账号没有管理 MC 产品成本参数的权限。', 'error');
        return;
      }
      if (response.status === 404) { costStatus('成本参数尚未启用，请联系管理员。', 'error'); return; }
      if (data?.code === '40001') {
        costRevision = null;
        costStatus('保存前已有其他人修改。请先载入最新值，核对后再保存。', 'error', '载入最新值');
        return;
      }
      if (data?.code === '22023') {
        costStatus(saving ? '请检查参数范围，或确认该子 ASIN 仍在产品目录中。' : '该子 ASIN 已不在当前 MC 产品目录中。', 'error');
        return;
      }
      if (!response.ok) throw new Error(saving ? '暂时无法确认是否已保存，可先重新读取核对。' : '暂时无法读取成本参数，请重试。');
      showCost(data, asin);
      costStatus(saving ? '成本参数已保存。' : '', saving ? 'success' : '');
    } catch (error) {
      if (!current() || controller.signal.aborted) return;
      let message = error.message;
      if (error.name === 'TimeoutError') message = saving ? '保存请求超时，可先重新读取核对。' : '读取成本参数超时，请重试。';
      if (error instanceof TypeError) message = saving ? '暂时无法确认是否已保存，可先重新读取核对。' : '暂时无法读取成本参数，请重试。';
      costStatus(message, 'error', saving ? '重新读取' : '重试');
    } finally {
      if (costRequest === controller) {
        costRequest = null;
        ui.costFields.disabled = ui.costForm.hidden;
        ui.costSave.disabled = ui.costForm.hidden || costRevision === null;
      }
    }
  }

  async function initialize() {
    const current = ++generation;
    ui.loading.hidden = false;
    ui.loading.textContent = '正在验证登录状态…';
    if (![origin, `${origin}/`].includes(config?.SUPABASE_URL) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.SUPABASE_PUBLISHABLE_KEY || '') ||
        typeof window.KBAuth?.requireAuth !== 'function') {
      ui.loading.textContent = '站点登录配置不可用，请联系管理员。';
      return;
    }
    try {
      const session = await window.KBAuth.requireAuth(login);
      if (generation !== current || !session) return;
      if (!session.session?.access_token || !session.user?.id) { location.replace(login); return; }
      auth = session;
      ui.userEmail.textContent = auth.user.email || empty;
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      void loadCatalog();
    } catch {
      if (generation === current) ui.loading.textContent = '登录状态无法验证，请返回登录页重试。';
    }
  }

  function resetPage() {
    page = 0;
    render();
  }

  ui.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(resetPage, 100);
  });
  ui.owner.addEventListener('change', resetPage);
  ui.clearFilters.addEventListener('click', () => {
    clearTimeout(searchTimer);
    ui.search.value = '';
    ui.owner.value = '';
    resetPage();
    ui.search.focus();
  });
  ui.prevPage.addEventListener('click', () => { page--; render(); });
  ui.nextPage.addEventListener('click', () => { page++; render(); });
  ui.retry.addEventListener('click', () => {
    hidePrivateData();
    void initialize();
  });
  ui.costRetry.addEventListener('click', () => { void fetchCost(); });
  ui.costForm.addEventListener('submit', event => {
    event.preventDefault();
    if (costRevision === null || costRequest) return;
    const values = {};
    for (const { id, key, min, max, decimals, percent } of costInputs) {
      const input = ui[id];
      const raw = input.value;
      const number = Number(raw);
      if (input.validity?.badInput || (raw !== '' &&
          (!new RegExp(`^(?:\\d+(?:\\.\\d{0,${decimals}})?|\\.\\d{1,${decimals}})$`).test(raw) || number < min || number > max))) {
        costStatus(`请输入范围内的数字，最多保留 ${decimals} 位小数；未设置可留空。`, 'error');
        input.focus();
        return;
      }
      values[`p_${key}`] = raw === '' ? null : percent ? Number((number / 100).toFixed(6)) : number;
    }
    void fetchCost(values);
  });
  ui.logoutBtn.addEventListener('click', async () => {
    hidePrivateData();
    try { await window.KBAuth.logout(); } finally { location.replace(login); }
  });
  window.addEventListener('hashchange', showRoute);
  window.addEventListener('pagehide', hidePrivateData);
  window.addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
  window.addEventListener('storage', event => {
    if (event.key !== config?.SESSION_KEY && event.key !== null) return;
    // Session refreshes in another tab are harmless. Clear the view on logout or account switches.
    const oldUser = readSessionUser(event.oldValue);
    const newUser = readSessionUser(event.newValue);
    if (event.newValue && auth?.user.id && newUser === auth.user.id && oldUser === newUser) return;
    if (event.newValue && !auth && oldUser === newUser && newUser) return;
    hidePrivateData();
    if (event.newValue) void initialize();
    else location.replace(login);
  });

  function readSessionUser(raw) {
    try { return JSON.parse(raw)?.user?.id; }
    catch { return undefined; }
  }

  void initialize();
})();
