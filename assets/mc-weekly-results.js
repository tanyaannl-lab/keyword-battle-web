'use strict';

(() => {
  const ids = ['appShell','loading','userEmail','logoutBtn','results','resultsStatus','retryResults',
    'resultWeek','resultSearch','resultOwner','clearResultFilters','resultsCount','resultsCatalogDate',
    'parentResults','parentTable','parentEmpty','productList','resultProductFilters','productStatus',
    'productResults','selectedParent','selectedOwner','selectedWeek','backToProducts',
    'resultSummary','resultAds','resultKeywords','resultAttributes','summaryResults','adsResults',
    'keywordResults','attributeResults','weeklyNotesForm','operation','reviewFee','offsiteFee','otherFee',
    'saveWeeklyNotes','notesStatus'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const tabs = [...document.querySelectorAll('[data-result-tab]')];
  const panels = { summary: ui.resultSummary, ads: ui.resultAds, keywords: ui.resultKeywords, attributes: ui.resultAttributes };
  const tables = { summary: ui.summaryResults, ads: ui.adsResults, keywords: ui.keywordResults, attributes: ui.attributeResults };
  const config = window.KB_CONFIG;
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const allowedRpc = new Set(['mc_product_catalog_read','mc_weekly_results_weeks','mc_weekly_results_read',
    'mc_weekly_results_notes_save','mc_weekly_results_sp_read']);
  const asin = /^[A-Z0-9]{10}$/;
  const normalize = text => text.normalize('NFKC').toLowerCase();
  const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const integer = new Intl.NumberFormat('en-US');
  const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const empty = '—';
  const feeFields = ['reviewFee','offsiteFee','otherFee'];
  const formFields = ['operation', ...feeFields];
  let auth;
  let sessionGeneration = 0;
  let refreshSession;
  let bootstrap;
  let context;
  let saveRequest;
  let parents = new Map();
  let week = '';
  let parent = '';
  let selectedTab = 'summary';
  let listRows = new Map();
  let listAds = new Map();
  let detail = null;
  let hasList = false;
  let loadedContext = false;
  let activeNoteKey = '';
  let activeRevision = 0;
  let noteBase = null;
  let adUnavailable = false;
  let retryAction = null;
  let focusDetail = false;
  let returnParent = '';
  const drafts = new Map();

  const noteKey = () => `${week}/${parent}`;
  const validWeek = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+parsed) && parsed.toISOString().slice(0,10) === value && parsed.getUTCDay() === 1;
  };
  const weekLabel = value => {
    const day = new Date(`${value}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 6);
    return `${value} 至 ${day.toISOString().slice(0,10)}`;
  };
  const number = value => value !== null && value !== '' &&
    (typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value)) ? Number(value) : null;
  const format = (value, formatter) => number(value) === null ? empty : formatter.format(number(value));
  const groupLabel = value => value?.owners.length ? value.owners.join('、') : empty;

  function notice(target, message = '', state = '') {
    target.textContent = message;
    target.hidden = !message;
    if (state) target.dataset.state = state;
    else delete target.dataset.state;
  }

  function pageStatus(message = '', state = '', action = null) {
    notice(ui.resultsStatus, message, state);
    retryAction = action;
    ui.retryResults.hidden = !action;
  }

  class RpcError extends Error {
    constructor(status, code) {
      super(`RPC ${status}`);
      this.status = status;
      this.code = code;
    }
  }

  function explain(error) {
    if (error.status === 403) return '当前账号没有查看或填写 MC 周结果的权限。';
    if (error.status === 404 || error.code === 'PGRST202') return '周结果服务尚未启用，请先运行周结果数据库脚本。';
    if (error.status === 401) return '登录已过期，请重新登录。';
    if (error.name === 'TimeoutError') return '连接超时，请重试。';
    if (error.status === 429) return '操作过于频繁，请稍后重试。';
    return error instanceof RpcError || error instanceof TypeError || error instanceof SyntaxError
      ? '暂时无法读取周结果，请重试。' : error.message;
  }

  async function rpc(name, args, signal) {
    if (!allowedRpc.has(name) || !auth?.session?.access_token) throw new RpcError(401);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
    const send = token => fetch(`${origin}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { Accept:'application/json','Content-Type':'application/json',
        apikey: config.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify(args), cache: 'no-store', credentials: 'omit', mode: 'cors', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: combined,
    });
    const id = auth.user.id;
    const token = auth.session.access_token;
    let response = await send(token);
    if (response.status === 401 && auth?.user.id === id && !combined.aborted) {
      if (!refreshSession) refreshSession = window.KBAuth.getValidSession().finally(() => { refreshSession = null; });
      const current = await refreshSession;
      if (!combined.aborted && auth?.user.id === id && current?.user?.id === id && current.session?.access_token !== token) {
        auth = current;
        response = await send(auth.session.access_token);
      }
    }
    if (!response.ok) {
      let code;
      try { code = (await response.json())?.code; } catch { /* status is enough */ }
      if (response.status === 401 && auth?.user.id === id && !combined.aborted) {
        clearPrivate();
        location.replace(login);
      }
      throw new RpcError(response.status, code);
    }
    return response.json();
  }

  function catalogGroups(data) {
    if (data === null) throw new Error('还没有导入产品目录，请先导入 MC 美国站产品表。');
    if (data?.store !== 'MC' || data.marketplace !== 'amazon.com' ||
        typeof data.snapshot_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.snapshot_date) ||
        !Array.isArray(data.products) || !data.products.length || data.products.length > 10000) {
      throw new Error('产品目录格式有误，请联系管理员。');
    }
    const grouped = new Map();
    const allOwners = new Set();
    for (const item of data.products) {
      if (!asin.test(item?.parent_asin ?? '') || !asin.test(item.asin ?? '') || typeof item.sku !== 'string' ||
          !Array.isArray(item.owners) || item.owners.some(owner => typeof owner !== 'string')) {
        throw new Error('产品目录格式有误，请联系管理员。');
      }
      const group = grouped.get(item.parent_asin) ?? { parent: item.parent_asin, owners: new Set(), children: [] };
      for (const owner of item.owners) { group.owners.add(owner); allOwners.add(owner); }
      group.children.push({ owners: item.owners, searchText: normalize([item.parent_asin,item.asin,item.sku,...item.owners].join(' ')) });
      grouped.set(item.parent_asin, group);
    }
    const compare = (a,b) => collator.compare(a,b);
    return {
      groups: new Map([...grouped].sort(([a],[b]) => compare(a,b)).map(([key,group]) => [key, {...group, owners:[...group.owners].sort(compare)}])),
      owners:[...allOwners].sort(compare),
    };
  }

  function selectTab(key, focus = false) {
    if (!panels[key]) return;
    selectedTab = key;
    for (const tab of tabs) {
      const active = tab.dataset.resultTab === key;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const [name,panel] of Object.entries(panels)) panel.hidden = key !== name;
  }

  function makeCell(row, value, numeric = false) {
    const cell = document.createElement('td');
    cell.textContent = value;
    if (numeric) cell.className = 'results-num';
    row.append(cell);
    return cell;
  }

  function productButton(parentAsin, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'results-link-button';
    button.dataset.resultParent = parentAsin;
    button.textContent = label;
    if (label !== parentAsin) {
      button.dataset.resultNotes = 'true';
      button.setAttribute('aria-label', `${parentAsin} ${label}`);
    }
    return button;
  }

  function renderList() {
    if (!hasList) return;
    const owner = ui.resultOwner.value;
    const tokens = normalize(ui.resultSearch.value.trim()).split(/\s+/).filter(Boolean);
    const groupRows = [...parents.values()].filter(group => group.children.some(child =>
      (!owner || child.owners.includes(owner)) && tokens.every(token => child.searchText.includes(token))));
    ui.resultsCount.textContent = `显示 ${groupRows.length} / ${parents.size} 个父款`;
    ui.clearResultFilters.disabled = !owner && !ui.resultSearch.value;
    ui.parentEmpty.hidden = groupRows.length !== 0;
    ui.parentTable.hidden = groupRows.length === 0;
    const fragment = document.createDocumentFragment();
    for (const group of groupRows) {
      const tr = document.createElement('tr');
      const line = listRows.get(group.parent);
      const ad = listAds.get(group.parent);
      makeCell(tr, '').append(productButton(group.parent, group.parent));
      makeCell(tr, groupLabel(group));
      makeCell(tr, format(line?.sales, usd), true);
      makeCell(tr, format(line?.orders, integer), true);
      makeCell(tr, format(ad?.sp_cost, usd), true);
      makeCell(tr, format(ad?.sp_orders, integer), true);
      const adSales = number(ad?.sp_sales);
      const adCost = number(ad?.sp_cost);
      makeCell(tr, adSales > 0 && adCost !== null ? pct.format(adCost / adSales) : empty, true);
      makeCell(tr, empty, true);
      const filled = line?.notes && [line.notes.operation,line.notes.review_fee,line.notes.offsite_fee,line.notes.other_fee]
        .some(value => value !== null && value !== undefined && value !== '');
      const draft = drafts.has(`${week}/${group.parent}`);
      makeCell(tr, '').append(productButton(group.parent, draft ? '未保存' : filled ? '已填写' : '填写'));
      fragment.append(tr);
    }
    ui.parentResults.replaceChildren(fragment);
  }

  function formValues() {
    return Object.fromEntries(formFields.map(id => [id, ui[id].value]));
  }

  function sameForm(a, b) {
    return !!a && !!b && formFields.every(id => a[id] === b[id]);
  }

  function dbForm(notes) {
    return { operation: notes?.operation ?? '', reviewFee: notes?.review_fee == null ? '' : String(notes.review_fee),
      offsiteFee: notes?.offsite_fee == null ? '' : String(notes.offsite_fee), otherFee: notes?.other_fee == null ? '' : String(notes.other_fee) };
  }

  function renderNotes(line) {
    const key = noteKey();
    activeNoteKey = key;
    const notes = line?.notes;
    noteBase = dbForm(notes);
    activeRevision = notes?.revision ?? 0;
    const draft = drafts.get(key);
    if (draft) activeRevision = draft.revision;
    const values = draft?.values ?? noteBase;
    for (const id of formFields) ui[id].value = values[id];
    ui.weeklyNotesForm.hidden = false;
    updateFormState();
    notice(ui.notesStatus, draft ? '已保留未保存的修改。' : '');
  }

  function updateFormState() {
    const busy = !loadedContext || !parent || !!saveRequest || activeNoteKey !== noteKey();
    for (const id of formFields) ui[id].disabled = busy;
    ui.saveWeeklyNotes.disabled = busy || sameForm(formValues(), noteBase);
  }

  function trafficMessage(days) {
    if (days === 7) return '';
    if (!days) return '这个周次还没有销售与流量数据，仍可填写本周记录。';
    return `销售与流量只到齐 ${days} / 7 天，销售指标暂以「—」显示。`;
  }

  function renderDetail() {
    if (!detail) return;
    window.MCWeeklyResultTables.render(tables, { rows: detail.rows, week, adRows: detail.ads,
      keywordRows: null, attributeRows: null });
    selectTab(selectedTab);
  }

  function rowsFrom(payload, weekStart, parentAsin) {
    if (payload?.week_start !== weekStart || !Array.isArray(payload.rows) || payload.rows.length > 10000 ||
        !payload.rows.some(row => row?.week_start === weekStart) || payload.rows.some(row => !row || !asin.test(row.parent_asin ?? '') ||
          !validWeek(row.week_start) || (parentAsin ? row.parent_asin !== parentAsin || row.week_start > weekStart : row.week_start !== weekStart) ||
          !Number.isInteger(row.traffic_days) || row.traffic_days < 0 || row.traffic_days > 7)) {
      throw new Error('周结果数据格式有误，请联系管理员。');
    }
    return payload.rows;
  }

  async function optionalAds(weekStart, parentAsin, signal) {
    if (adUnavailable) return { rows: null, error: false };
    try {
      const rows = await rpc('mc_weekly_results_sp_read', { p_week_start: weekStart, p_parent_asin: parentAsin }, signal);
      if (!Array.isArray(rows) || rows.length > (parentAsin ? 26 : 10000) || rows.some(row =>
          row?.source_status !== 'sp_advertised_7d' || !asin.test(row.parent_asin ?? '') || !validWeek(row.week_start) ||
          (parentAsin ? row.parent_asin !== parentAsin || row.week_start > weekStart : row.week_start !== weekStart))) {
        throw new Error('Invalid SP data');
      }
      return { rows, error: false };
    } catch (error) {
      if (error.status === 404 || error.code === 'PGRST202') adUnavailable = true;
      return { rows: null, error: !signal.aborted && !adUnavailable };
    }
  }

  async function loadContext() {
    if (!auth || !week || saveRequest) return;
    context?.abort();
    const controller = new AbortController();
    context = controller;
    const weekStart = week;
    const parentAsin = parent || null;
    loadedContext = false;
    hasList = false;
    detail = null;
    activeNoteKey = '';
    noteBase = null;
    ui.resultWeek.disabled = false;
    ui.productList.hidden = !!parentAsin;
    ui.resultProductFilters.hidden = !!parentAsin;
    ui.productResults.hidden = !parentAsin;
    ui.parentResults.replaceChildren();
    ui.parentTable.hidden = true;
    ui.parentEmpty.hidden = true;
    ui.resultsCount.textContent = '';
    ui.weeklyNotesForm.hidden = true;
    for (const table of Object.values(tables)) table.replaceChildren();
    for (const id of formFields) ui[id].value = '';
    updateFormState();
    notice(ui.notesStatus);
    notice(ui.productStatus);
    if (parentAsin) {
      ui.selectedParent.textContent = parentAsin;
      ui.selectedOwner.textContent = groupLabel(parents.get(parentAsin));
      ui.selectedWeek.textContent = weekLabel(weekStart);
      selectTab(selectedTab);
    }
    pageStatus('正在读取所选周的结果…');
    try {
      const [main, ad] = await Promise.all([
        rpc('mc_weekly_results_read',{ p_week_start: weekStart, p_parent_asin: parentAsin },controller.signal),
        optionalAds(weekStart, parentAsin, controller.signal),
      ]);
      if (context !== controller || !auth) return;
      const rows = rowsFrom(main, weekStart, parentAsin);
      const line = rows.find(row => row.week_start === weekStart);
      loadedContext = true;
      if (!parentAsin) {
        listRows = new Map(rows.map(row => [row.parent_asin,row]));
        listAds = new Map((ad.rows ?? []).map(row => [row.parent_asin,row]));
        hasList = true;
        renderList();
        if (returnParent) {
          ui.parentResults.querySelector(`[data-result-parent="${returnParent}"]`)?.focus();
          returnParent = '';
        }
      } else {
        detail = { rows, ads: ad.rows };
        renderDetail();
        renderNotes(line);
        if (focusDetail) {
          (focusDetail === 'notes' ? ui.operation : ui.selectedParent).focus();
          focusDetail = false;
        }
      }
      const messages = [trafficMessage(line?.traffic_days), ad.error ? 'SP 广告数据暂时无法读取。' : ''].filter(Boolean);
      notice(ui.productStatus, parentAsin ? messages.join(' ') : '');
      pageStatus(parentAsin ? '' : messages.join(' '));
    } catch (error) {
      if (context === controller && !controller.signal.aborted && auth) pageStatus(explain(error), 'error', loadContext);
    }
  }

  function chooseParent(value, openNotes = false) {
    if (saveRequest || !parents.has(value)) return;
    parent = value;
    selectedTab = 'summary';
    focusDetail = openNotes ? 'notes' : 'heading';
    void loadContext();
  }

  function captureDraft() {
    if (!loadedContext || activeNoteKey !== noteKey()) return;
    const values = formValues();
    if (sameForm(values, noteBase)) {
      drafts.delete(activeNoteKey);
      notice(ui.notesStatus);
    } else {
      drafts.set(activeNoteKey, { values, revision: activeRevision });
      notice(ui.notesStatus, '有未保存的修改。');
    }
    updateFormState();
  }

  function readFee(raw) {
    const value = raw.trim();
    if (!value) return null;
    if (!/^(?:\d{1,10}(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) {
      throw new Error('费用请填写非负金额，最多两位小数。留空表示未填写。');
    }
    return Number(value);
  }

  async function saveNotes(event) {
    event.preventDefault();
    if (!auth || !loadedContext || !parent || activeNoteKey !== noteKey() || saveRequest) return;
    const key = activeNoteKey;
    const values = formValues();
    if (sameForm(values, noteBase)) return;
    let params;
    try {
      params = { p_week_start: week, p_parent_asin: parent, p_operation: values.operation.trim() || null,
        p_review_fee: readFee(values.reviewFee), p_offsite_fee: readFee(values.offsiteFee),
        p_other_fee: readFee(values.otherFee), p_revision: activeRevision };
    } catch (error) { notice(ui.notesStatus,error.message,'error'); return; }
    const controller = new AbortController();
    saveRequest = controller;
    ui.resultWeek.disabled = true;
    ui.backToProducts.disabled = true;
    updateFormState();
    notice(ui.notesStatus,'正在保存…');
    try {
      const saved = await rpc('mc_weekly_results_notes_save',params,controller.signal);
      if (saveRequest !== controller || !auth || activeNoteKey !== key) return;
      if (!saved || !Number.isInteger(saved.revision) || saved.revision <= activeRevision) throw new Error('保存结果无法确认，请重新读取。');
      const line = detail.rows.find(row => row.week_start === week);
      if (line) line.notes = saved;
      drafts.delete(key);
      noteBase = dbForm(saved);
      activeRevision = saved.revision;
      for (const id of formFields) ui[id].value = noteBase[id];
      renderDetail();
      notice(ui.notesStatus, '已保存本周记录。', 'success');
    } catch (error) {
      if (saveRequest !== controller || controller.signal.aborted) return;
      if (error.code === '40001' || error.status === 409) {
        notice(ui.notesStatus, '这条记录已被其他人更新。请先复制你的修改，再刷新页面查看最新记录。', 'error');
      } else {
        notice(ui.notesStatus, error instanceof RpcError && error.status >= 500
          ? '保存暂未确认，请刷新核对后再试。' : explain(error), 'error');
      }
    } finally {
      if (saveRequest === controller) {
        saveRequest = null;
        ui.resultWeek.disabled = false;
        ui.backToProducts.disabled = false;
        updateFormState();
      }
    }
  }

  function clearPrivate() {
    sessionGeneration++;
    bootstrap?.abort(); context?.abort(); saveRequest?.abort();
    bootstrap = context = saveRequest = null;
    auth = null;
    parents.clear(); listRows.clear(); listAds.clear(); drafts.clear();
    week = parent = activeNoteKey = '';
    detail = noteBase = null;
    loadedContext = hasList = adUnavailable = focusDetail = false;
    returnParent = '';
    ui.results.hidden = ui.productResults.hidden = ui.appShell.hidden = true;
    ui.userEmail.textContent = '';
    ui.resultSearch.value = '';
    ui.resultOwner.replaceChildren(new Option('全部负责人',''));
    ui.resultWeek.replaceChildren();
    ui.parentResults.replaceChildren();
    for (const table of Object.values(tables)) table.replaceChildren();
    for (const id of formFields) ui[id].value = '';
    for (const id of ['selectedParent','selectedOwner','selectedWeek','resultsCount','resultsCatalogDate']) ui[id].textContent = '';
    notice(ui.notesStatus);
    notice(ui.productStatus);
    pageStatus();
    ui.backToProducts.disabled = false;
  }

  async function loadInitial() {
    if (!auth) return;
    bootstrap?.abort();
    const controller = new AbortController();
    bootstrap = controller;
    pageStatus('正在读取周次和产品目录…');
    try {
      const [dates,catalog] = await Promise.all([
        rpc('mc_weekly_results_weeks',{},controller.signal),
        rpc('mc_product_catalog_read',{},controller.signal),
      ]);
      if (bootstrap !== controller || !auth) return;
      if (!Array.isArray(dates) || !dates.length || dates.length > 300 || dates.some(value => !validWeek(value))) {
        throw new Error('周次列表格式有误，请联系管理员。');
      }
      const available = [...new Set(dates)].sort().reverse();
      const parsed = catalogGroups(catalog);
      parents = parsed.groups;
      ui.resultWeek.replaceChildren(...available.map(value => new Option(weekLabel(value),value)));
      ui.resultOwner.replaceChildren(new Option('全部负责人',''),...parsed.owners.map(value => new Option(value,value)));
      ui.resultsCatalogDate.textContent = catalog.snapshot_date;
      ui.resultsCatalogDate.dateTime = catalog.snapshot_date;
      week = available[1] ?? available[0];
      ui.resultWeek.value = week;
      ui.results.hidden = false;
      void loadContext();
    } catch (error) {
      if (bootstrap === controller && !controller.signal.aborted && auth) pageStatus(explain(error),'error',loadInitial);
    }
  }

  async function initialize() {
    const generation = ++sessionGeneration;
    ui.loading.hidden = false;
    ui.loading.textContent = '正在验证登录状态…';
    if (![origin,`${origin}/`].includes(config?.SUPABASE_URL) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.SUPABASE_PUBLISHABLE_KEY ?? '') ||
        typeof window.KBAuth?.requireAuth !== 'function' || typeof window.MCWeeklyResultTables?.render !== 'function') {
      ui.loading.textContent = '周结果页面配置未加载，请刷新或联系管理员。';
      return;
    }
    try {
      const current = await window.KBAuth.requireAuth(login);
      if (sessionGeneration !== generation || !current) return;
      if (!current.session?.access_token || !current.user?.id) { location.replace(login); return; }
      auth = current;
      ui.userEmail.textContent = auth.user.email || empty;
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      void loadInitial();
    } catch {
      if (sessionGeneration === generation) ui.loading.textContent = '登录状态无法验证，请返回登录页重试。';
    }
  }

  ui.resultWeek.addEventListener('change', () => {
    if (saveRequest || !validWeek(ui.resultWeek.value)) return;
    week = ui.resultWeek.value;
    void loadContext();
  });
  ui.resultSearch.addEventListener('input',renderList);
  ui.resultOwner.addEventListener('change',renderList);
  ui.clearResultFilters.addEventListener('click',() => {
    ui.resultSearch.value = ui.resultOwner.value = '';
    renderList();
    ui.resultSearch.focus();
  });
  ui.parentResults.addEventListener('click',event => {
    const button = event.target.closest('[data-result-parent]');
    if (button) chooseParent(button.dataset.resultParent, button.dataset.resultNotes === 'true');
  });
  ui.backToProducts.addEventListener('click',() => {
    if (saveRequest) return;
    returnParent = parent;
    parent = '';
    focusDetail = false;
    void loadContext();
  });
  tabs.forEach((tab,index) => {
    tab.addEventListener('click',() => selectTab(tab.dataset.resultTab));
    tab.addEventListener('keydown',event => {
      const next = { ArrowLeft:(index+tabs.length-1)%tabs.length, ArrowRight:(index+1)%tabs.length,
        Home:0, End:tabs.length-1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      selectTab(tabs[next].dataset.resultTab,true);
    });
  });
  ui.weeklyNotesForm.addEventListener('submit',saveNotes);
  for (const id of formFields) ui[id].addEventListener('input',captureDraft);
  ui.retryResults.addEventListener('click',() => { if (retryAction) void retryAction(); });
  ui.logoutBtn.addEventListener('click',async () => {
    clearPrivate();
    try { await window.KBAuth.logout(); } finally { location.replace(login); }
  });
  window.addEventListener('beforeunload',event => {
    if (drafts.size || saveRequest) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide',clearPrivate);
  window.addEventListener('pageshow',event => { if (event.persisted) void initialize(); });
  window.addEventListener('storage',event => {
    if (event.key !== config?.SESSION_KEY && event.key !== null) return;
    const getUser = raw => { try { return JSON.parse(raw)?.user?.id; } catch { return undefined; } };
    const next = getUser(event.newValue);
    if (next && next === getUser(event.oldValue) && (!auth || next === auth.user.id)) return;
    clearPrivate();
    if (event.newValue) void initialize();
    else location.replace(login);
  });
  void initialize();
})();
