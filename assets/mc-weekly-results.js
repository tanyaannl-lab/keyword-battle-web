'use strict';

(() => {
  const ids = ['appShell','loading','userEmail','logoutBtn','results','resultsStatus','retryResults',
    'resultWeek','resultSearch','resultOwner','clearResultFilters','resultsCount','resultsCatalogDate',
    'parentResults','parentTable','parentEmpty','productList','resultProductFilters','productStatus',
    'productResults','selectedParent','selectedOwner','selectedWeek','backToProducts',
    'resultSummary','resultAds','resultKeywords','resultAttributes','summaryResults','adsResults',
    'keywordResults','attributeResults','weeklyNotesForm','reviewFee','offsiteFee','otherFee',
    'saveWeeklyNotes','notesStatus','resultView','resultWeeklyFilter','resultDateFilter','resultStartDate',
    'resultEndDate','resultDateFeedback','weekTimeZone','resultsSummaryTitle','resultsSummaryHint',
    'resultTabSummary','resultTabAds','resultsAdsTitle','resultsWeeklyListHint','resultsDailyListHint'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const tabs = [...document.querySelectorAll('[data-result-tab]')];
  const weeklyElements = [...document.querySelectorAll('[data-week-only]')];
  const dailyElements = [...document.querySelectorAll('[data-day-only]')];
  const panels = { summary: ui.resultSummary, ads: ui.resultAds, keywords: ui.resultKeywords, attributes: ui.resultAttributes };
  const tables = { summary: ui.summaryResults, ads: ui.adsResults, keywords: ui.keywordResults, attributes: ui.attributeResults };
  const config = window.KB_CONFIG;
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const allowedRpc = new Set(['mc_product_catalog_read','mc_weekly_results_weeks','mc_weekly_results_read',
    'mc_weekly_results_notes_save','mc_weekly_results_sp_read','mc_weekly_results_search','mc_weekly_results_daily_read',
    'mc_weekly_results_sp_daily_read','mc_weekly_results_search_daily_read','mc_weekly_results_other_ads_read',
    'mc_weekly_results_daily_profit_read','mc_daily_fba_returns_read']);
  const asin = /^[A-Z0-9]{10}$/;
  const normalize = text => text.normalize('NFKC').toLowerCase();
  const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const integer = new Intl.NumberFormat('en-US');
  const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const empty = '—';
  const feeFields = ['reviewFee','offsiteFee','otherFee'];
  const dayLimit = 92;
  const earliestDay = '2000-01-01';
  const dayMs = 86_400_000;
  const pacificCalendar = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  let auth;
  let sessionGeneration = 0;
  let refreshSession;
  let bootstrap;
  let context;
  let saveRequest;
  let parents = new Map();
  let week = '';
  let mode = 'week';
  let dayStart = '';
  let dayEnd = '';
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
  const validDay = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+parsed) && parsed.toISOString().slice(0,10) === value;
  };
  const validWeek = value => validDay(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1;
  const shiftDay = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * dayMs).toISOString().slice(0,10);
  const weekOf = day => shiftDay(day,-((new Date(`${day}T00:00:00Z`).getUTCDay()+6)%7));
  const dayCount = (start, end) => (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / dayMs + 1;
  const rangeLabel = (start, end) => start === end ? start : `${start} 至 ${end}`;
  const weekLabel = value => rangeLabel(value, shiftDay(value, 6));
  const pacificToday = () => {
    const parts = Object.fromEntries(pacificCalendar.formatToParts().map(({ type,value }) => [type,value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
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
    if ((key === 'keywords' || key === 'attributes') && detail?.search.state === 'idle') void loadSearchAnalysis();
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
      if (mode === 'day') {
        makeCell(tr, format(line?.units, integer), true);
        makeCell(tr, format(line?.visits, integer), true);
        fragment.append(tr);
        continue;
      }
      makeCell(tr, format(ad?.sp_cost, usd), true);
      makeCell(tr, format(ad?.sp_orders, integer), true);
      const adSales = number(ad?.sp_sales);
      const adCost = number(ad?.sp_cost);
      makeCell(tr, adSales > 0 && adCost !== null ? pct.format(adCost / adSales) : empty, true);
      makeCell(tr, empty, true);
      const filled = line?.notes && [line.notes.review_fee,line.notes.offsite_fee,line.notes.other_fee]
        .some(value => value !== null && value !== undefined && value !== '');
      const draft = drafts.has(`${week}/${group.parent}`);
      makeCell(tr, '').append(productButton(group.parent, draft ? '费用未保存' : filled ? '编辑费用' : '填写费用'));
      fragment.append(tr);
    }
    ui.parentResults.replaceChildren(fragment);
  }

  function formValues() {
    return Object.fromEntries(feeFields.map(id => [id, ui[id].value]));
  }

  function sameForm(a, b) {
    return !!a && !!b && feeFields.every(id => {
      try { return readFee(a[id]) === readFee(b[id]); } catch { return a[id] === b[id]; }
    });
  }

  function dbForm(notes) {
    return { reviewFee: String(notes?.review_fee ?? 0), offsiteFee: String(notes?.offsite_fee ?? 0),
      otherFee: String(notes?.other_fee ?? 0) };
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
    for (const id of feeFields) ui[id].value = values[id];
    ui.weeklyNotesForm.hidden = false;
    updateFormState();
    notice(ui.notesStatus, draft ? '已保留未保存的修改。' : '');
  }

  function updateFormState() {
    const busy = !loadedContext || !parent || !!saveRequest || activeNoteKey !== noteKey();
    for (const id of feeFields) ui[id].disabled = busy;
    ui.saveWeeklyNotes.disabled = busy || sameForm(formValues(), noteBase);
  }

  function trafficMessage(days) {
    if (days === 7) return '';
    if (!days) return '这个周次还没有销售与流量数据，仍可填写本周费用。';
    return `销售与流量只到齐 ${days} / 7 天，销售指标暂以「—」显示。`;
  }

  function renderDetail() {
    if (!detail) return;
    window.MCWeeklyResultTables.render(tables, { rows: detail.rows, week, adRows: detail.ads, otherAds: detail.otherAds, spError:detail.spError });
    selectTab(selectedTab);
  }

  function renderMode() {
    const daily = mode === 'day';
    ui.resultView.value = mode;
    ui.resultWeeklyFilter.hidden = daily;
    ui.resultDateFilter.hidden = !daily;
    for (const element of weeklyElements) element.hidden = daily;
    for (const element of dailyElements) element.hidden = !daily;
    ui.resultsWeeklyListHint.hidden = daily;
    ui.resultsDailyListHint.hidden = true;
    ui.weekTimeZone.textContent = daily ? '默认显示美国太平洋时间的前一天，可查询最多 92 天。' : '周次按美国太平洋时间计算，周一至周日。';
    ui.resultTabSummary.textContent = daily ? '每日明细' : '周总结';
    ui.resultTabAds.textContent = daily ? '每日广告' : '产品广告结构';
    ui.resultsAdsTitle.textContent = daily ? '每日广告表现' : '产品广告结构';
    ui.resultsSummaryTitle.textContent = daily ? '每日明细' : '每周复盘';
    ui.resultsSummaryHint.textContent = daily ? '每个自然日一行。「—」表示当天没有可核验的数据。本周费用请切回按周查看。' :
      '选中的周高亮。「—」表示缺少数据。未填写的三项手动费用按 0 显示。';
  }

  function changeMode(next) {
    if (!['day','week'].includes(next) || saveRequest || mode === next || !week) return;
    mode = next;
    notice(ui.resultDateFeedback);
    if (mode === 'day') {
      setDateControls();
      selectedTab = 'summary';
    }
    renderMode();
    void loadContext();
  }

  function setDateControls() {
    const latest = pacificToday();
    if (!dayStart) {
      dayStart = dayEnd = shiftDay(latest,-1);
    }
    ui.resultStartDate.max = ui.resultEndDate.max = latest;
    ui.resultStartDate.value = dayStart;
    ui.resultEndDate.value = dayEnd;
  }

  function queryDays(event) {
    event.preventDefault();
    if (mode !== 'day' || saveRequest) return;
    const start = ui.resultStartDate.value;
    const end = ui.resultEndDate.value;
    const today = pacificToday();
    ui.resultStartDate.max = ui.resultEndDate.max = today;
    if (!validDay(start) || !validDay(end) || start < earliestDay || end < start || end > today) {
      notice(ui.resultDateFeedback,'请选择有效的开始和结束日期，结束日期不能早于开始日期或晚于今天。','error');
      return;
    }
    if (dayCount(start,end) > dayLimit) {
      notice(ui.resultDateFeedback,`日期范围最多 ${dayLimit} 天。`,'error');
      return;
    }
    notice(ui.resultDateFeedback);
    dayStart = start;
    dayEnd = end;
    void loadContext();
  }

  function dailyRowsFrom(payload, start, end, parentAsin) {
    const days = dayCount(start,end);
    const rows = payload?.rows;
    const inRange = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
    if (payload?.start_date !== start || payload?.end_date !== end || payload.days_total !== days ||
        !inRange(payload.traffic_days,days) || !Array.isArray(rows) ||
        (parentAsin ? rows.length !== days : rows.length > 10000) ||
        rows.some((row, index) => !row || !asin.test(row.parent_asin ?? '') ||
          !inRange(row.traffic_days,parentAsin ? 1 : days) ||
          (parentAsin ? row.parent_asin !== parentAsin || row.report_date !== shiftDay(end,-index) :
            !parents.has(row.parent_asin) || row.traffic_days !== payload.traffic_days))) {
      throw new Error('每日销售与流量的数据格式有误，请联系管理员。');
    }
    if (parentAsin && rows.reduce((total, row) => total + row.traffic_days,0) !== payload.traffic_days) {
      throw new Error('每日销售与流量的覆盖日期有误，请联系管理员。');
    }
    if (!parentAsin && new Set(rows.map(row => row.parent_asin)).size !== rows.length) {
      throw new Error('每日销售与流量的父 ASIN 重复，请联系管理员。');
    }
    return rows;
  }

  function renderWeeklyFallback(target, text) {
    const message = document.createElement('p');
    message.className = 'results-empty results-period-message';
    message.textContent = text;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'results-button';
    button.textContent = '切换到按周';
    button.addEventListener('click', () => {
      if (mode === 'day' && validDay(dayEnd)) {
        const endWeek = weekOf(dayEnd);
        if (Array.from(ui.resultWeek.options ?? ui.resultWeek.children).some(option=>option.value === endWeek)) {
          week = ui.resultWeek.value = endWeek;
        }
      }
      changeMode('week');
      ui.resultView.focus();
    });
    target.replaceChildren(message,button);
  }

  function renderDailyPanels(rows, ads, otherAds, profit, returns) {
    if (typeof window.MCWeeklyResultTables.renderDaily !== 'function') throw new Error('每日明细组件未加载，请刷新页面。');
    window.MCWeeklyResultTables.renderDaily(tables.summary, { rows, adRows:ads.rows, otherAds, spError:ads.error, profit, returns });
    if (ads.rows?.length || otherAds.rows.length || otherAds.coverage.length || otherAds.error) {
      window.MCWeeklyResultTables.renderDailyAds(tables.ads,{ rows, adRows:ads.rows, otherAds, spError:ads.error });
    } else {
      renderWeeklyFallback(tables.ads, ads.error ? '暂时无法读取每日广告数据。' : '这个父 ASIN 在所选日期范围内暂无已发布的广告日报。');
    }
    selectTab(selectedTab);
  }

  function renderSearchState(search) {
    if (search.state === 'ready') {
      window.MCWeeklyResultTables.renderSearch(tables, search.data ?? {});
      return;
    }
    if (search.state === 'weekly-only') {
      for (const target of [tables.keywords, tables.attributes]) renderWeeklyFallback(target,search.message);
      return;
    }
    const loading = search.state === 'loading';
    const message = loading ? '正在读取搜索词分析…' : search.message;
    for (const target of [tables.keywords, tables.attributes]) {
      const status = document.createElement('p');
      status.className = 'results-state';
      status.setAttribute('role', 'status');
      status.textContent = message;
      target.replaceChildren(status);
      if (!loading) {
        status.dataset.state = 'error';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'results-button';
        retry.textContent = '重新加载分析';
        retry.addEventListener('click', () => { if (detail?.search === search) void loadSearchAnalysis(); });
        target.append(retry);
      }
    }
  }

  async function loadSearchAnalysis() {
    const controller = context;
    const current = detail;
    if (!auth || !controller || controller.signal.aborted || !current || !parent || !week ||
        !['idle','error'].includes(current.search.state)) return;
    const daily = mode === 'day';
    const start = dayStart, end = dayEnd;
    const args = daily ? { p_start_date: start, p_end_date: end, p_parent_asin: parent } : { p_week_start: week, p_parent_asin: parent };
    const endpoint = daily ? 'mc_weekly_results_search_daily_read' : 'mc_weekly_results_search';
    const stillCurrent = () => context === controller && detail === current && !!auth && !controller.signal.aborted;
    current.search = { state: 'loading' };
    renderSearchState(current.search);
    try {
      const data = await rpc(endpoint, args, controller.signal);
      if (!stillCurrent()) return;
      const validRows = (rows, key) => Array.isArray(rows) && rows.length <= 100000 && rows.every(row =>
        row && !Array.isArray(row) && typeof row[key] === 'string' && row[key].trim());
      if (data !== null && (!validRows(data?.keyword_rows, 'term') || !validRows(data?.attribute_rows, 'attribute') ||
          data.keyword_rows.length + data.attribute_rows.length > 100000)) {
        throw new Error('搜索词分析数据格式有误，请联系管理员。');
      }
      if (!daily) current.search = { state: 'ready', data };
      else if (data === null) {
        current.search = { state: 'weekly-only', message: '所选日期范围暂无已发布的搜索词日报。' };
      } else {
        const dates = data.dates_available;
        if (!Array.isArray(dates) || dates.length < 1 || dates.length > dayCount(start,end) ||
            dates.some((day,i) => !validDay(day) || day < start || day > end || (i && day <= dates[i-1]))) {
          throw new Error('搜索词日报的覆盖日期有误，请联系管理员。');
        }
        const total = dayCount(start,end);
        const rangeNotice = dates.length === total ? `按所选日期范围汇总（${dates.length} 天）。` :
          `只汇总已发布的搜索词日报（${dates.length} / ${total} 天），其余日期未计入。`;
        current.search = { state: 'ready', data: { ...data,rangeNotice } };
      }
    } catch (error) {
      if (!stillCurrent()) return;
      const unavailable = error.status === 404 || error.code === 'PGRST202';
      current.search = unavailable && daily
        ? { state:'weekly-only', message:'按日期筛选的搜索词分析尚未启用。' }
        : { state:'error', message:unavailable ? '搜索词分析尚未启用。' : explain(error) };
    }
    renderSearchState(current.search);
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

  async function optionalDailyAds(start,end,parentAsin,signal) {
    if (!parentAsin) return {rows:[],error:false};
    try {
      const rows = await rpc('mc_weekly_results_sp_daily_read',{
        p_start_date:start,p_end_date:end,p_parent_asin:parentAsin,
      },signal);
      if (!Array.isArray(rows) || rows.length > dayCount(start,end) ||
          new Set(rows.map(row=>row?.report_date)).size !== rows.length || rows.some(row=>
            !row || row.parent_asin !== parentAsin || !validDay(row.report_date) || row.report_date < start || row.report_date > end ||
            ['sp_cost','sp_sales','sp_orders','sp_impressions','sp_clicks'].some(key=>number(row[key]) === null || number(row[key]) < 0))) {
        throw new Error('每日商品推广数据格式有误。');
      }
      return {rows,error:false};
    } catch (error) {
      return {rows:[],error:!signal.aborted && error.status !== 404 && error.code !== 'PGRST202'};
    }
  }

  async function optionalDailyMetrics(source,start,end,parentAsin,signal) {
    if (!parentAsin) return {rows:[],error:false};
    const profit = source === 'profit';
    const endpoint = profit ? 'mc_weekly_results_daily_profit_read' : 'mc_daily_fba_returns_read';
    const validValue = (value, min, whole = false) => value === null ||
      (typeof value === 'number' && Number.isFinite(value) && value >= min && Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
        (!whole || Number.isSafeInteger(value)));
    try {
      const rows = await rpc(endpoint,{p_start_date:start,p_end_date:end,p_parent_asin:parentAsin},signal);
      if (!Array.isArray(rows) || rows.length !== dayCount(start,end) ||
          new Set(rows.map(row=>row?.report_date)).size !== rows.length || rows.some(row=>
            !validDay(row?.report_date) || row.report_date < start || row.report_date > end ||
            (profit ? row.parent_asin !== parentAsin || !validValue(row.profit_before_ads,-Number.MAX_SAFE_INTEGER) ||
              !validValue(row.sales_basis,0) || (row.sales_basis === null && row.profit_before_ads !== null) :
              !validValue(row.return_units,0,true) || !validValue(row.shipped_units,0,true)))) {
        throw new Error('每日补充指标格式有误。');
      }
      return {rows,error:false};
    } catch (error) {
      return {rows:[],error:!signal.aborted && error.status !== 404 && error.code !== 'PGRST202'};
    }
  }

  function blankOtherAds() {
    return {rows:[], coverage:[], pending:[], error:false};
  }

  async function optionalOtherAds(start,end,parentAsin,signal) {
    const blank = blankOtherAds();
    if (!parentAsin) return blank;
    const channels = ['SB','SD'];
    const states = ['empty','mapped','unmapped','partial','missing'];
    const firstWeek = weekOf(start);
    const lastWeek = weekOf(end);
    const span = dayCount(start,end);
    try {
      const data = await rpc('mc_weekly_results_other_ads_read',{
        p_start_date:start,p_end_date:end,p_parent_asin:parentAsin,
      },signal);
      const {rows,coverage} = data ?? {};
      const unique = (list,key) => new Set(list.map(key)).size === list.length;
      const validMetric = (value,integerOnly) => value === null ||
        (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER &&
          (!integerOnly || Number.isSafeInteger(value)));
      if (!Array.isArray(coverage) || coverage.length !== 2 * (1 + Math.floor((dayCount(firstWeek,lastWeek)-1)/7)) ||
          coverage.some(row=>!row || !channels.includes(row.channel) || !states.includes(row.status) ||
            !validWeek(row.week_start) || row.week_start < firstWeek || row.week_start > lastWeek) ||
          !unique(coverage,row=>`${row.channel}/${row.week_start}`) || !Array.isArray(rows) || rows.length > span * 2 ||
          rows.some(row=>!row || row.parent_asin !== parentAsin || !channels.includes(row.channel) ||
            !validDay(row.report_date) || row.report_date < start || row.report_date > end ||
            !validMetric(row.cost,false) || !validMetric(row.sales,false) || !validMetric(row.orders,true) ||
            [row.cost,row.sales,row.orders].every(value=>value===null)) || !unique(rows,row=>`${row.channel}/${row.report_date}`)) {
        throw new Error('品牌推广或展示型推广的数据格式有误。');
      }
      const confirmed = new Set(coverage.filter(row=>['mapped','partial'].includes(row.status)).map(row=>`${row.channel}/${row.week_start}`));
      if (rows.some(row=>!confirmed.has(`${row.channel}/${weekOf(row.report_date)}`))) {
        throw new Error('品牌推广或展示型推广的数据范围有误。');
      }
      return {rows,coverage,pending:coverage.filter(row=>!['empty','mapped'].includes(row.status)),error:false};
    } catch (error) {
      return {...blank,error:!signal.aborted && error.status !== 404 && error.code !== 'PGRST202'};
    }
  }

  async function weeklyOtherAds(weeks,parentAsin,signal) {
    const ranges = [];
    const today = pacificToday();
    for (const day of [...new Set(weeks)].filter(day=>validWeek(day)&&day>=earliestDay&&day<=today).sort()) {
      const proposedEnd = shiftDay(day,6);
      const end = proposedEnd <= today ? proposedEnd : today;
      const last = ranges.at(-1);
      if (last && dayCount(last.start,end) <= 182) last.end = end;
      else ranges.push({start:day,end});
    }
    const snapshots = [];
    for (let i = 0; i < ranges.length && !signal.aborted; i += 3) {
      snapshots.push(...await Promise.all(ranges.slice(i,i+3).map(({start,end})=>optionalOtherAds(start,end,parentAsin,signal))));
    }
    return {rows:snapshots.flatMap(value=>value.rows),coverage:snapshots.flatMap(value=>value.coverage),
      pending:snapshots.flatMap(value=>value.pending),error:snapshots.some(value=>value.error)};
  }

  async function loadContext() {
    if (!auth || !week || saveRequest) return;
    context?.abort();
    const controller = new AbortController();
    context = controller;
    const weekStart = week;
    const daily = mode === 'day';
    const start = dayStart;
    const end = dayEnd;
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
    ui.resultsDailyListHint.hidden = true;
    ui.weeklyNotesForm.hidden = true;
    for (const table of Object.values(tables)) table.replaceChildren();
    for (const id of feeFields) ui[id].value = '0';
    updateFormState();
    notice(ui.notesStatus);
    notice(ui.productStatus);
    if (parentAsin) {
      ui.selectedParent.textContent = parentAsin;
      ui.selectedOwner.textContent = groupLabel(parents.get(parentAsin));
      ui.selectedWeek.textContent = daily ? rangeLabel(start,end) : weekLabel(weekStart);
      selectTab(selectedTab);
    }
    pageStatus(daily ? '正在读取所选日期的结果…' : '正在读取所选周的结果…');
    try {
      if (daily) {
        const [main,ads,otherAds,profit,returns] = await Promise.all([
          rpc('mc_weekly_results_daily_read',{
            p_start_date: start, p_end_date: end, p_parent_asin: parentAsin,
          },controller.signal),
          optionalDailyAds(start,end,parentAsin,controller.signal),
          optionalOtherAds(start,end,parentAsin,controller.signal),
          optionalDailyMetrics('profit',start,end,parentAsin,controller.signal),
          optionalDailyMetrics('returns',start,end,parentAsin,controller.signal),
        ]);
        if (context !== controller || controller.signal.aborted || !auth) return;
        const rows = dailyRowsFrom(main,start,end,parentAsin);
        const coverage = `销售和流量报表已到齐 ${main.traffic_days} / ${main.days_total} 天。`;
        if (!parentAsin) {
          listRows = new Map(rows.map(row => [row.parent_asin,row]));
          listAds = new Map();
          hasList = true;
          renderList();
          notice(ui.resultsDailyListHint,`${rangeLabel(start,end)} · ${coverage} 日期范围未到齐时不显示合计，点开父 ASIN 可看已到齐的每日数据。`);
          if (returnParent) {
            ui.parentResults.querySelector(`[data-result-parent="${returnParent}"]`)?.focus();
            returnParent = '';
          }
        } else {
          detail = { rows, ads:ads.rows, otherAds, search: { state:'idle' } };
          renderDailyPanels(rows,ads,otherAds,profit,returns);
          notice(ui.productStatus,coverage);
          if (focusDetail) {
            ui.selectedParent.focus();
            focusDetail = false;
          }
        }
        pageStatus();
        return;
      }
      const [main, ad] = await Promise.all([
        rpc('mc_weekly_results_read',{ p_week_start: weekStart, p_parent_asin: parentAsin },controller.signal),
        optionalAds(weekStart, parentAsin, controller.signal),
      ]);
      if (context !== controller || !auth) return;
      const rows = rowsFrom(main, weekStart, parentAsin);
      const line = rows.find(row => row.week_start === weekStart);
      const otherAds = parentAsin
        ? await weeklyOtherAds([
          ...Array.from({length:26},(_,i)=>shiftDay(weekStart,-i*7)),
          ...rows.map(row=>row.week_start),...(ad.rows ?? []).map(row=>row.week_start),
        ],parentAsin,controller.signal)
        : blankOtherAds();
      if (context !== controller || controller.signal.aborted || !auth) return;
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
        detail = { rows, ads: ad.rows, otherAds, spError:ad.error, search: { state: 'idle' } };
        renderDetail();
        renderNotes(line);
        if (focusDetail) {
          (focusDetail === 'notes' ? ui.reviewFee : ui.selectedParent).focus();
          focusDetail = false;
        }
      }
      const messages = [trafficMessage(line?.traffic_days), ad.error ? 'SP 广告数据暂时无法读取。' : ''].filter(Boolean);
      notice(ui.productStatus, parentAsin ? messages.join(' ') : '');
      pageStatus(parentAsin ? '' : messages.join(' '));
    } catch (error) {
      if (context === controller && !controller.signal.aborted && auth) {
        const missingDaily = daily && (error.status === 404 || error.code === 'PGRST202');
        pageStatus(missingDaily ? '每日明细尚未启用。可以切回按周查看。' : explain(error), 'error',loadContext);
      }
    }
  }

  function chooseParent(value, openNotes = false) {
    if (saveRequest || !parents.has(value)) return;
    parent = value;
    selectedTab = 'summary';
    focusDetail = mode === 'week' && openNotes ? 'notes' : 'heading';
    void loadContext();
  }

  function captureDraft() {
    if (mode !== 'week' || !loadedContext || activeNoteKey !== noteKey()) return;
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
    if (!value) return 0;
    if (!/^(?:\d{1,10}(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) {
      throw new Error('费用请填写非负金额，最多两位小数。');
    }
    return Number(value);
  }

  async function saveNotes(event) {
    event.preventDefault();
    if (mode !== 'week' || !auth || !loadedContext || !parent || activeNoteKey !== noteKey() || saveRequest) return;
    const key = activeNoteKey;
    const values = formValues();
    if (sameForm(values, noteBase)) return;
    let params;
    const line = detail.rows.find(row => row.week_start === week);
    try {
      // The existing RPC writes all fields. Preserve the stored text while editing fees only.
      params = { p_week_start: week, p_parent_asin: parent, p_operation: line?.notes?.operation ?? null,
        p_review_fee: readFee(values.reviewFee), p_offsite_fee: readFee(values.offsiteFee),
        p_other_fee: readFee(values.otherFee), p_revision: activeRevision };
    } catch (error) { notice(ui.notesStatus,error.message,'error'); return; }
    const controller = new AbortController();
    saveRequest = controller;
    ui.resultWeek.disabled = true;
    ui.resultView.disabled = true;
    ui.backToProducts.disabled = true;
    updateFormState();
    notice(ui.notesStatus,'正在保存…');
    try {
      const saved = await rpc('mc_weekly_results_notes_save',params,controller.signal);
      if (saveRequest !== controller || !auth || activeNoteKey !== key) return;
      if (!saved || !Number.isInteger(saved.revision) || saved.revision <= activeRevision) throw new Error('保存结果无法确认，请重新读取。');
      if (line) line.notes = saved;
      drafts.delete(key);
      noteBase = dbForm(saved);
      activeRevision = saved.revision;
      for (const id of feeFields) ui[id].value = noteBase[id];
      renderDetail();
      notice(ui.notesStatus, '已保存本周费用。', 'success');
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
        ui.resultView.disabled = false;
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
    week = parent = activeNoteKey = dayStart = dayEnd = '';
    mode = 'week';
    selectedTab = 'summary';
    detail = noteBase = null;
    loadedContext = hasList = adUnavailable = focusDetail = false;
    returnParent = '';
    ui.results.hidden = ui.productResults.hidden = ui.appShell.hidden = true;
    ui.userEmail.textContent = '';
    ui.resultSearch.value = '';
    ui.resultOwner.replaceChildren(new Option('全部负责人',''));
    ui.resultWeek.replaceChildren();
    ui.resultStartDate.value = ui.resultEndDate.value = '';
    ui.resultView.disabled = false;
    ui.parentResults.replaceChildren();
    for (const table of Object.values(tables)) table.replaceChildren();
    for (const id of feeFields) ui[id].value = '0';
    for (const id of ['selectedParent','selectedOwner','selectedWeek','resultsCount','resultsCatalogDate']) ui[id].textContent = '';
    notice(ui.notesStatus);
    notice(ui.productStatus);
    notice(ui.resultDateFeedback);
    notice(ui.resultsDailyListHint);
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
      mode = 'day';
      setDateControls();
      renderMode();
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
        typeof window.KBAuth?.requireAuth !== 'function' || typeof window.MCWeeklyResultTables?.render !== 'function' ||
        typeof window.MCWeeklyResultTables?.renderSearch !== 'function') {
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
    if (mode !== 'week' || saveRequest || !validWeek(ui.resultWeek.value)) return;
    week = ui.resultWeek.value;
    void loadContext();
  });
  ui.resultView.addEventListener('change',() => changeMode(ui.resultView.value));
  ui.resultDateFilter.addEventListener('submit',queryDays);
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
  for (const id of feeFields) {
    ui[id].addEventListener('input',captureDraft);
    ui[id].addEventListener('blur',() => {
      if (ui[id].value === '' && !ui[id].validity?.badInput) {
        ui[id].value = '0';
        captureDraft();
      }
    });
  }
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
