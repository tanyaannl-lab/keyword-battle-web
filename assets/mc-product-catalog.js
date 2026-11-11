'use strict';

(() => {
  const ids = ['appShell', 'loading', 'userEmail', 'logoutBtn', 'catalog', 'search', 'owner',
    'clearFilters', 'summary', 'snapshotDate', 'catalogStatus', 'catalogList', 'retry'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const config = window.KB_CONFIG;
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });
  const sort = (a, b) => collator.compare(a, b);
  const normalize = text => text.normalize('NFKC').toLowerCase();
  const asinPattern = /^[A-Z0-9]{10}$/;
  const empty = '—';
  let auth = null;
  let request = null;
  let generation = 0;
  let groups = [];
  let total = 0;
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
    groups = [];
    total = 0;
    ui.catalog.hidden = true;
    ui.catalogList.replaceChildren();
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
    status();
  }

  function checkedText(value, max = 300) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      throw new Error('产品目录数据格式有误，请联系管理员。');
    }
    return value;
  }

  function checkedList(values, required = false) {
    if (!Array.isArray(values) || values.length > 30 || (required && !values.length)) {
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
    const result = new Map();
    const keys = new Set();
    const owners = new Set();
    for (const item of data.products) {
      if (!item || typeof item.parent_asin !== 'string' || !asinPattern.test(item.parent_asin) ||
          typeof item.asin !== 'string' || !asinPattern.test(item.asin) || typeof item.review_required !== 'boolean') {
        throw new Error('产品目录数据格式有误，请联系管理员。');
      }
      const sku = checkedText(item.sku);
      const key = `${item.asin}\0${sku}`;
      if (keys.has(key)) throw new Error('产品目录存在重复商品，请联系管理员。');
      keys.add(key);
      const row = { asin: item.asin, sku, names: checkedList(item.names, true),
        companySkus: checkedList(item.company_skus), owners: checkedList(item.owners), review: item.review_required };
      row.searchText = normalize([item.parent_asin, row.asin, row.sku, ...row.names, ...row.companySkus, ...row.owners].join(' '));
      row.owners.forEach(owner => owners.add(owner));
      if (!result.has(item.parent_asin)) result.set(item.parent_asin, []);
      result.get(item.parent_asin).push(row);
    }
    const products = [...result].map(([parent, rows]) => {
      const names = new Map();
      for (const row of rows) for (const name of row.names) names.set(name, (names.get(name) ?? 0) + 1);
      const labels = [...names].sort(([a, countA], [b, countB]) => countB - countA || sort(a, b)).map(([name]) => name);
      const name = labels.length === 1 ? labels[0]
        : labels.length === 2 ? labels.join(' / ')
        : `${labels[0]} 等 ${labels.length} 个名称`;
      return { parent, name, rows: rows.sort((a, b) => sort(a.names[0], b.names[0]) || sort(a.sku, b.sku)),
      };
    }).sort((a, b) => sort(a.name, b.name) || sort(a.parent, b.parent));
    return { products, owners: [...owners].sort(sort) };
  }

  function cell(values, className) {
    const td = node('td', className);
    const text = Array.isArray(values) ? values : [values];
    for (const value of text.length ? text : [empty]) td.append(node('span', '', value));
    return td;
  }

  function renderItems(rows) {
    const table = node('table', 'catalog-table');
    const header = node('tr');
    for (const column of ['产品中文名', '子 ASIN', 'SKU', '公司 SKU', '负责人']) {
      const th = node('th', '', column);
      th.scope = 'col';
      header.append(th);
    }
    const head = node('thead');
    head.append(header);
    const body = node('tbody');
    for (const row of rows) {
      const tr = node('tr');
      const name = cell(row.names, 'catalog-aliases');
      if (row.review) name.append(node('span', 'catalog-review', '待核对'));
      tr.append(name, cell(row.asin, 'catalog-asin'), cell(row.sku, 'catalog-asin'),
        cell(row.companySkus, 'catalog-aliases'), cell(row.owners, 'catalog-aliases'));
      body.append(tr);
    }
    table.append(head, body);
    return table;
  }

  function renderGroup(group, rows, open) {
    const card = node('details', 'catalog-group');
    card.dataset.parentAsin = group.parent;
    const title = node('summary', 'catalog-group-title');
    const meta = node('span', 'catalog-group-meta');
    meta.append(node('span', 'catalog-group-name', group.name), node('span', 'catalog-group-asin', `父 ASIN ${group.parent}`));
    title.append(meta);
    title.append(node('span', 'catalog-count', rows.length === group.rows.length
      ? `${rows.length} 个子商品` : `${rows.length} / ${group.rows.length} 个子商品`));
    if (rows.some(row => row.review)) title.append(node('span', 'catalog-review', '待核对'));
    const items = node('div', 'catalog-items');
    const addItems = () => { if (!items.firstChild) items.append(renderItems(rows)); };
    card.append(title, items);
    card.addEventListener('toggle', () => { if (card.open) addItems(); });
    if (open) { card.open = true; addItems(); }
    return card;
  }

  function render() {
    if (ui.catalog.hidden || !auth) return;
    const tokens = normalize(ui.search.value.trim()).split(/\s+/).filter(Boolean);
    const owner = ui.owner.value;
    const opened = new Set([...ui.catalogList.querySelectorAll('details[open]')].map(detail => detail.dataset.parentAsin));
    const visible = [];
    let visibleCount = 0;
    for (const group of groups) {
      const rows = group.rows.filter(row => (!owner || row.owners.includes(owner)) && tokens.every(token => row.searchText.includes(token)));
      if (!rows.length) continue;
      visible.push({ group, rows });
      visibleCount += rows.length;
    }
    ui.clearFilters.disabled = !ui.search.value && !owner;
    ui.summary.textContent = tokens.length || owner
      ? `找到 ${visible.length} / ${groups.length} 个父款 · ${visibleCount} / ${total} 个子商品`
      : `${groups.length} 个父款 · ${total} 个子商品`;
    const result = document.createDocumentFragment();
    for (const { group, rows } of visible) {
      result.append(renderGroup(group, rows, opened.has(group.parent) || Boolean(tokens.length && visible.length <= 3)));
    }
    ui.catalogList.replaceChildren(result);
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
      groups = parsed.products;
      total = data.products.length;
      ui.owner.append(...parsed.owners.map(owner => new Option(owner, owner)));
      ui.snapshotDate.textContent = data.snapshot_date;
      ui.snapshotDate.dateTime = data.snapshot_date;
      ui.catalog.hidden = false;
      render();
    } catch (error) {
      if (request !== controller || controller.signal.aborted) return;
      const message = error.name === 'TimeoutError' ? '读取产品目录超时，请重试。'
        : error instanceof TypeError || error instanceof SyntaxError ? '暂时无法读取产品目录，请重试。' : error.message;
      status(message, 'error', true);
    } finally {
      if (request === controller) request = null;
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

  ui.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 100);
  });
  ui.owner.addEventListener('change', render);
  ui.clearFilters.addEventListener('click', () => {
    clearTimeout(searchTimer);
    ui.search.value = '';
    ui.owner.value = '';
    render();
    ui.search.focus();
  });
  ui.retry.addEventListener('click', () => {
    hidePrivateData();
    void initialize();
  });
  ui.logoutBtn.addEventListener('click', async () => {
    hidePrivateData();
    try { await window.KBAuth.logout(); } finally { location.replace(login); }
  });
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
