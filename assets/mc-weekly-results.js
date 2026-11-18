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
    'resultTabSummary','resultTabAds','resultsAdsTitle','resultsWeeklyListHint','resultsDailyListHint',
    'dailyFeesForm','dailyFeesDate','dailyReviewFee','dailyOffsiteFee','dailyOtherFee','saveDailyFees',
    'reloadDailyFees','dailyFeesStatus','dailyFeesHint','weeklyNotesHint','skuPreviewNotice',
    'resultWeekOptions','resultWeekSummary','applyResultWeeks','resultWeekCount','resultFeeWeek','resultFeeWeekField'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const tabs = [...document.querySelectorAll('[data-result-tab]')];
  const weeklyElements = [...document.querySelectorAll('[data-week-only]')];
  const dailyElements = [...document.querySelectorAll('[data-day-only]')];
  const panels = { summary: ui.resultSummary, ads: ui.resultAds, keywords: ui.resultKeywords, attributes: ui.resultAttributes };
  const tables = { summary: ui.summaryResults, ads: ui.adsResults, keywords: ui.keywordResults, attributes: ui.attributeResults };
  const config = window.KB_CONFIG;
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const allowedRpc = new Set(['mc_product_catalog_read','mc_weekly_results_weeks','mc_weekly_results_notes_read',
    'mc_weekly_results_notes_save','mc_weekly_results_search_daily_read',
    'mc_weekly_results_other_ads_read','mc_daily_fba_returns_read','mc_daily_results_fees_read','mc_daily_results_fees_save',
    'mc_weekly_results_sku_list','mc_weekly_results_sku_read']);
  const previewParams = new URLSearchParams(window.location?.search ?? '');
  const skuSources = ['br','sp','orders','transactions'];
  const skuMetricKeys = ['sessions_browser','sessions_app','sessions','br_orders','br_units','br_sales',
    'sp_impressions','sp_clicks','sp_cost','sp_orders','sp_units','sp_sales','order_orders','order_units',
    'order_sales','order_profit','order_profit_cny','txn_orders','txn_units','txn_sales','txn_total',
    'txn_refund','txn_profit','txn_profit_cny'];
  const asin = /^[A-Z0-9]{10}$/;
  const normalize = text => text.normalize('NFKC').toLowerCase();
  const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const integer = new Intl.NumberFormat('en-US');
  const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const empty = '—';
  const feeFields = ['reviewFee','offsiteFee','otherFee'];
  const dailyFeeFields = {dailyReviewFee:'review_fee',dailyOffsiteFee:'offsite_fee',dailyOtherFee:'other_fee'};
  const dayLimit = 92;
  const weekLimit = 26;
  const earliestDay = '2000-01-01';
  const earliestSkuDay = '2000-01-03';
  const latestSkuDay = '2099-12-31';
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
  let chosenWeeks=[],availableWeeks=[],weekChecks=[];
  let mode = 'week';
  let dayStart = '';
  let dayEnd = '';
  let parent = '';
  let selectedTab = 'summary';
  let listRows = new Map();
  let listAds = new Map();
  let listVisible = null;
  let detail = null;
  let hasList = false;
  let loadedContext = false;
  let activeNoteKey = '';
  let activeRevision = 0;
  let noteBase = null;
  let retryAction = null;
  let focusDetail = false;
  let returnParent = '';
  const drafts = new Map();
  const dailyFeeDrafts = new Map();
  const dailyFeeUnconfirmed = new Set();
  let dailyFeeRefreshing = false;

  const feeWeek = () => detail?.periods ? ui.resultFeeWeek.value : week;
  const noteKey = () => `${feeWeek()}/${parent}`;
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
  const weekLabel = value => window.MCWeeklyResultTables.weekLabel(value);
  const pacificToday = () => {
    const parts = Object.fromEntries(pacificCalendar.formatToParts(new Date()).map(({ type,value }) => [type,value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const number = value => value !== null && value !== '' &&
    (typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value)) ? Number(value) : null;
  const validSkuRange = (start,end) => validDay(start) && validDay(end) && start >= earliestSkuDay &&
    end <= latestSkuDay && start <= end && dayCount(start,end) <= dayLimit;
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
        !Array.isArray(data.products) || data.products.length > 10000) {
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
    // The optional list is sourced from past directories and approved overrides. Add
    // navigation entries only for parents absent from the original catalog.
    if (Array.isArray(data.report_parent_choices) && data.report_parent_choices.length <= 10000) {
      for (const value of data.report_parent_choices) {
        if (typeof value !== 'string' || !asin.test(value) || grouped.has(value)) continue;
        grouped.set(value, { parent:value, owners:new Set(), ruleOnly:true,
          children:[{owners:[],searchText:normalize(value)}] });
      }
    }
    const compare = (a,b) => collator.compare(a,b);
    return {
      groups: new Map([...grouped].sort(([a],[b]) => compare(a,b)).map(([key,group]) => [key, {...group, owners:[...group.owners].sort(compare)}])),
      owners:[...allOwners].sort(compare),
    };
  }

  function selectedWeekText() {
    if (chosenWeeks.length < 2) return week ? weekLabel(week) : '选择周次';
    const compact = chosenWeeks.map(w => weekLabel(w).split(' | ')[0].replace('US·',''));
    return `已选 ${chosenWeeks.length} 周 · ${compact.slice(0,3).join('、')}${compact.length>3?'…':''}`;
  }
  function setChosenWeeks(values) {
    const wanted = new Set(values);
    chosenWeeks = availableWeeks.filter(value=>wanted.has(value));
    if (!chosenWeeks.length) return;
    week = chosenWeeks[0];
    ui.resultWeekSummary.textContent = selectedWeekText();
    ui.resultWeekSummary.title = chosenWeeks.map(weekLabel).join('；');
    weekChecks.forEach(check=>{check.checked=wanted.has(check.value);});
    updateWeekCount();
  }
  function updateWeekCount() {
    const count = weekChecks.filter(check=>check.checked).length;
    ui.resultWeekCount.textContent = count ? `已勾选 ${count} 周` : '请至少选择一周';
    ui.applyResultWeeks.disabled = !count || !!saveRequest;
  }
  function buildWeekPicker(values) {
    availableWeeks = values.slice();
    weekChecks = [];
    const fragment = document.createDocumentFragment();
    for (const value of values) {
      const label = document.createElement('label'); label.className='results-week-option';
      const box = document.createElement('input'); box.type='checkbox'; box.value=value;
      const text = document.createElement('span'); text.textContent=weekLabel(value);
      label.append(box,text); fragment.append(label); weekChecks.push(box);
    }
    ui.resultWeekOptions.replaceChildren(fragment);
  }
  function dismissWeeks() {
    setChosenWeeks(chosenWeeks);
    ui.resultWeek.open=false;
  }
  function lockWeeks(locked) {
    ui.resultWeek.inert = locked;
    ui.resultFeeWeek.disabled = locked;
    if (locked) dismissWeeks();
    updateWeekCount();
  }
  async function mapWeeks(weeks,controller,fn) {
    const results = Array(weeks.length);
    let index=0;
    async function worker() {
      while (index<weeks.length && context===controller && !controller.signal.aborted) {
        const n=index++; results[n]=await fn(weeks[n]);
      }
    }
    await Promise.all(Array.from({length:Math.min(2,weeks.length)},worker));
    return results;
  }
  function weekSection(target,start) {
    const section = document.createElement('section');
    section.className='results-week-block'; section.dataset.resultWeekSection=start;
    const heading = document.createElement('h4'); heading.textContent=weekLabel(start);
    const body = document.createElement('div');
    section.append(heading,body); target.append(section);
    return body;
  }
  function renderMultiDetail() {
    for (const period of detail.periods) {
      const w=period.week;
      if (!period.targets) period.targets=Object.fromEntries(
        Object.entries(tables).map(([key,target])=>[key,weekSection(target,w)]));
      window.MCWeeklyResultTables.renderSku({summary:period.targets.summary,ads:period.targets.ads},{
        sku:period.sku,week:w,otherAds:period.otherAds,returns:period.returns,weeklyNotes:period.rows[0]});
    }
    selectTab(selectedTab);
  }
  function changeFeeWeek() {
    if (!detail?.periods || saveRequest) return;
    const w=ui.resultFeeWeek.value, row=detail.rows.find(r=>r.week_start===w);
    if (!row) {
      activeNoteKey=''; noteBase=null;
      feeFields.forEach(id=>ui[id].value=''); updateFormState();
      notice(ui.notesStatus,'所选周的费用暂时无法读取，不能保存。','error');return;
    }
    renderNotes(row);
  }
  async function loadMultiWeeks(controller,weeks,parentAsin) {
    const values=await mapWeeks(weeks,controller,w=>parentAsin
      ? fetchSkuPeriod(controller,false,w,w,shiftDay(w,6),parentAsin)
      : fetchSkuList(controller,w,shiftDay(w,6)));
    if (context!==controller || controller.signal.aborted || !auth) return;
    loadedContext=true;
    if (!parentAsin) {
      const sumMap=(prop,fields)=>new Map([...parents.keys()].map(key=>[key,
        Object.fromEntries(fields.map(field=>{
          const nums=values.map(part=>number(part[prop].get(key)?.[field]));
          return [field,nums.every(v=>v!==null)?nums.reduce((a,b)=>a+b,0):null];
        }))]));
      listVisible=values.every(v=>v.visibleParents instanceof Set)
        ?new Set(values.flatMap(v=>[...v.visibleParents])):null;
      listRows=sumMap('listRows',['sales','orders','units','visits']);
      listAds=sumMap('listAds',['sp_cost','sp_sales','sp_orders']);
      hasList=true;renderList();
      if(returnParent){ui.parentResults.querySelector(`[data-result-parent="${returnParent}"]`)?.focus();returnParent='';}
      const missing=weeks.filter((w,i)=>values[i].error);
      pageStatus(`父款列表合计所选 ${weeks.length} 周；任一选中周缺值，对应合计显示「—」。`+
        (missing.length ? ' 待读取：'+missing.map(w=>weekLabel(w)).join('；') : ''),missing.length?'warning':'',
        missing.length?loadContext:null);
      return;
    }
    detail={periods:weeks.map((w,i)=>({...values[i],week:w})),rows:values.flatMap(v=>v.rows),search:{state:'idle'}};
    renderMultiDetail();
    ui.resultFeeWeekField.hidden=false;
    ui.resultFeeWeek.replaceChildren(...weeks.map(w=>new Option(weekLabel(w),w)));
    ui.resultFeeWeek.value=weeks[0];ui.weeklyNotesForm.hidden=false;
    changeFeeWeek();
    notice(ui.productStatus,`已选 ${weeks.length} 周；各表按所选周分别展示，费用只保存到指定周。`);
    if(focusDetail){(focusDetail==='notes'?ui.resultFeeWeek:ui.selectedParent).focus();focusDetail=false;}
    const failed=weeks.filter((w,i)=>values[i].sku?.error);
    pageStatus(failed.length ? '部分周经营明细读取失败：'+failed.map(weekLabel).join('；') : '',
      failed.length?'warning':'',failed.length?loadContext:null);
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
    if (label !== parentAsin) button.setAttribute('aria-label', `${parentAsin} ${label}`);
    if (label === '管理费用' || label === '费用未保存') {
      button.dataset.resultNotes = 'true';
    }
    return button;
  }

  function renderList() {
    if (!hasList) return;
    const owner = ui.resultOwner.value;
    const tokens = normalize(ui.resultSearch.value.trim()).split(/\s+/).filter(Boolean);
    const eligible = [...parents.values()].filter(g=>!listVisible || listVisible.has(g.parent));
    const groupRows = eligible.filter(group => group.children.some(child =>
      (!owner || child.owners.includes(owner)) && tokens.every(token => child.searchText.includes(token))));
    ui.resultsCount.textContent = `显示 ${groupRows.length} / ${eligible.length} 个父款`;
    ui.clearResultFilters.disabled = !owner && !ui.resultSearch.value;
    ui.parentEmpty.hidden = groupRows.length !== 0;
    ui.parentTable.hidden = groupRows.length === 0;
    const fragment = document.createDocumentFragment();
    for (const group of groupRows) {
      const tr = document.createElement('tr');
      const line = listRows.get(group.parent);
      const ad = listAds.get(group.parent);
      const parentCell = makeCell(tr, '');
      parentCell.append(productButton(group.parent, group.parent));
      if (group.ruleOnly) {
        const label = document.createElement('small');
        label.textContent = ' · 历史或指定归属';
        parentCell.append(label);
      }
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
      makeCell(tr, '', true).append(productButton(group.parent, '查看毛利'));
      const draft = chosenWeeks.some(w=>drafts.has(`${w}/${group.parent}`));
      makeCell(tr, '').append(productButton(group.parent, draft ? '费用未保存' : '管理费用'));
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

  function renderDetail() {
    if (!detail) return;
    if (detail.periods) { renderMultiDetail(); return; }
    renderSkuPanels(tables);
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
    ui.resultStartDate.min = ui.resultEndDate.min = earliestSkuDay;
    renderSkuSource();
  }

  function renderSkuSource() {
    const daily = mode === 'day';
    notice(ui.skuPreviewNotice,'销售、流量、SP、订单和交易均来自每日经营明细。');
    ui.resultsSummaryHint.textContent = daily ? '每个美西自然日一行；未到齐的指标显示「—」。' :
      '按周汇总每日经营明细；某项指标缺任意一天，只留空该项。';
    ui.dailyFeesHint.textContent = '按父 ASIN 和美西日期保存，单位 USD，计入当天的订单毛利估算。';
    ui.weeklyNotesHint.textContent = '按父 ASIN 和周次保存，单位 USD，计入对应周的订单毛利估算。';
  }

  function changeMode(next) {
    if (!['day','week'].includes(next) || saveRequest || mode === next || !week) return;
    mode = next;
    notice(ui.resultDateFeedback);
    if (mode === 'day') {
      const weekEnd = shiftDay(week,6);
      if (parents.has(parent) && validSkuRange(week,weekEnd) && weekEnd < pacificToday()) {
        dayStart = week;
        dayEnd = weekEnd;
      }
      setDateControls();
      selectedTab = 'summary';
    } else if (chosenWeeks.length===1 && parents.has(parent) && validDay(dayEnd)) {
      const dayWeek=weekOf(dayEnd);
      if (availableWeeks.includes(dayWeek)) setChosenWeeks([dayWeek]);
    }
    dismissWeeks();
    renderMode();
    void loadContext();
  }

  function setDateControls() {
    const today = pacificToday();
    const latest = shiftDay(today,-1);
    if (!dayStart) {
      dayStart = dayEnd = shiftDay(today,-1);
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
    const latest = shiftDay(today,-1);
    ui.resultStartDate.max = ui.resultEndDate.max = latest;
    if (!validDay(start) || !validDay(end) || start < earliestSkuDay || end < start || end > latest) {
      notice(ui.resultDateFeedback,'请选择有效日期，结束日期不能早于开始日期或晚于美西昨天。','error');
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

  function renderDailySummary() {
    if (detail?.sku) renderSkuPanels({summary:tables.summary});
  }

  function renderSkuPanels(targets) {
    if (typeof window.MCWeeklyResultTables.renderSku !== 'function') throw new Error('SKU 核对表未加载，请刷新页面。');
    window.MCWeeklyResultTables.renderSku(targets, { sku:detail.sku, week:mode === 'week' ? week : '',
      otherAds:detail.otherAds, returns:detail.returns, dailyFees:detail.dailyFees,
      weeklyNotes:detail.rows.find(row=>row.week_start === week) });
  }

  function renderSearchState(search, targets=tables, retryAction=loadSearchAnalysis) {
    if (search.state === 'ready') {
      window.MCWeeklyResultTables.renderSearch(targets, search.data ?? {});
      return;
    }
    const loading = search.state === 'loading';
    const canRetry = search.state === 'waiting' || search.state === 'error';
    const message = loading ? '正在读取搜索词分析…' : search.message;
    for (const target of [targets.keywords, targets.attributes]) {
      const status = document.createElement('p');
      status.className = 'results-state';
      status.setAttribute('role', 'status');
      status.textContent = message;
      target.replaceChildren(status);
      if (canRetry) {
        if (search.state === 'error') status.dataset.state = 'error';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'results-button';
        retry.textContent = '重新加载分析';
        retry.addEventListener('click',()=>void retryAction());
        target.append(retry);
      }
    }
  }

  function validateSearchRows(data) {
    const validRows = (rows, key) => Array.isArray(rows) && rows.length <= 100000 && rows.every(row =>
      row && !Array.isArray(row) && typeof row[key] === 'string' && row[key].trim());
    if (data !== null && (!validRows(data?.keyword_rows, 'term') || !validRows(data?.attribute_rows, 'attribute') ||
        data.keyword_rows.length + data.attribute_rows.length > 100000)) {
      throw new Error('搜索词分析数据格式有误，请联系管理员。');
    }
  }

  function searchCoveredDays(data, start, end) {
    if (data === null) return 0;
    const dates = data.dates_available;
    if (!Array.isArray(dates) || dates.length < 1 || dates.length > dayCount(start,end) ||
        dates.some((day,i) => !validDay(day) || day < start || day > end || (i && day <= dates[i-1]))) {
      throw new Error('搜索词日报的覆盖日期有误，请联系管理员。');
    }
    return dates.length;
  }

  async function readSearchPeriod(controller,start,end,parentAsin,daily) {
    const lastClosed=shiftDay(pacificToday(),-1);
    if (!daily && end>lastClosed) return {state:'open-week',message:'本周按美西时间尚未结束。可切换到按日查看已发布的搜索词日报。'};
    const wanted = dayCount(start,end);
    try {
      const data=await rpc('mc_weekly_results_search_daily_read',{
        p_start_date:start,p_end_date:end,p_parent_asin:parentAsin},controller.signal);
      validateSearchRows(data);
      const covered=searchCoveredDays(data,start,end);
      if (!covered || (!daily && covered<wanted)) return {state:'waiting',
        message:`搜索词日报待同步（${covered}/${wanted} 天）。${daily?'':'七天齐备后显示本周分析。'}`};
      return {state:'ready',data:{...data,period:daily?'day':'week',rangeNotice:
        covered===wanted ? `按已发布的搜索词日报汇总（${covered}/${wanted} 天）。` :
        `只汇总已发布的搜索词日报（${covered}/${wanted} 天），其余日期未计入。`}};
    } catch(e) {
      return {state:'error',message:['PGRST202','42883'].includes(e.code)||e.status===404
        ? '搜索词日报读取接口尚未启用。' : explain(e)};
    }
  }
  async function loadSearchAnalysis() {
    const controller=context, current=detail;
    if (!auth || !controller || controller.signal.aborted || !current || !parent ||
        !['idle','error','waiting'].includes(current.search.state)) return;
    const stillCurrent=()=>context===controller && detail===current && !!auth && !controller.signal.aborted;
    const parentAsin=parent;
    if (current.periods) {
      current.search.state='loading';
      const map=new Map(current.periods.map(p=>[p.week,p]));
      async function refresh(w) {
        const period=map.get(w);
        period.search={state:'loading'};
        renderSearchState(period.search,period.targets,()=>{});
        period.search=await readSearchPeriod(controller,w,shiftDay(w,6),parentAsin,false);
        if(stillCurrent())renderSearchState(period.search,period.targets,()=>{if(stillCurrent())void refresh(w);});
      }
      await mapWeeks([...map.keys()],controller,refresh);
      if(stillCurrent())current.search.state='ready';
      return;
    }
    const daily=mode==='day';const start=daily?dayStart:week,end=daily?dayEnd:shiftDay(week,6);
    current.search={state:'loading'};renderSearchState(current.search);
    const search=await readSearchPeriod(controller,start,end,parentAsin,daily);
    if(!stillCurrent())return;
    current.search=search;renderSearchState(search);
  }



  async function readFbaMovements(start,end,parentAsin,signal) {
    const validCount = n => n === null || (Number.isSafeInteger(n) && n >= 0);
    try {
      const rows = await rpc('mc_daily_fba_returns_read',{p_start_date:start,p_end_date:end,p_parent_asin:parentAsin},signal);
      if (!Array.isArray(rows) || rows.length !== dayCount(start,end) || new Set(rows.map(r=>r?.report_date)).size !== rows.length ||
          rows.some(r=>!validDay(r?.report_date) || r.report_date < start || r.report_date > end ||
            !validCount(r.return_units) || !validCount(r.shipped_units))) throw new Error('退货或发货的格式有误。');
      return {rows,error:false};
    } catch { return {rows:[],error:!signal.aborted}; }
  }

  function validDailyFees(row, expectedDate, expectedParent) {
    return row?.report_date === expectedDate && row.parent_asin === expectedParent &&
      Number.isSafeInteger(row.revision) && row.revision >= 0 && row.revision <= 2147483647 &&
      Object.values(dailyFeeFields).every(key => typeof row[key] === 'number' && Number.isFinite(row[key]) &&
        row[key] >= 0 && row[key] <= 9999999999.99 && Math.abs(row[key] - Math.round(row[key] * 100) / 100) < 0.000001);
  }

  async function readDailyFees(start,end,parentAsin,signal) {
    if (!parentAsin) return {rows:[],error:false};
    try {
      const rows = await rpc('mc_daily_results_fees_read',{p_start_date:start,p_end_date:end,p_parent_asin:parentAsin},signal);
      if (!Array.isArray(rows) || rows.length !== dayCount(start,end) ||
          rows.some((row,index)=>!validDailyFees(row,shiftDay(end,-index),parentAsin))) {
        throw new Error('每日费用返回格式有误。');
      }
      return {rows,error:false};
    } catch (error) {
      const unavailable = error.status === 404 || error.code === 'PGRST202';
      return {rows:[],error:true,message:unavailable ? '每日费用服务尚未启用。' : '暂时无法读取每日费用，请重试。'};
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
      return {...blank,error:!signal.aborted};
    }
  }

  async function readSkuPeriod(start,end,lastClosed,parentAsin,signal) {
    const dates = Array.from({length:dayCount(start,end)},(_,index)=>shiftDay(end,-index));
    const days = new Map();
    const completeEnd = end <= lastClosed ? end : lastClosed;
    const validMetric = value => value === null ||
      ((typeof value === 'number' || typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value)) &&
        number(value) !== null && Math.abs(number(value)) <= Number.MAX_SAFE_INTEGER);
    const validMetrics = row => row && typeof row === 'object' && !Array.isArray(row) &&
      skuMetricKeys.every(key=>validMetric(row[key])) &&
      Number.isSafeInteger(row.conflict_count) && row.conflict_count >= 0;
    let totals = null;
    let error = '';
    if (start <= completeEnd) {
      try {
        const payload = await rpc('mc_weekly_results_sku_read',{
          p_start_date:start,p_end_date:completeEnd,p_parent_asin:parentAsin,
        },signal);
        if (payload?.parent_asin !== parentAsin || !Array.isArray(payload.days) ||
            payload.days.length !== dayCount(start,completeEnd) || !validMetrics(payload.totals)) {
          throw new Error('Invalid SKU preview response');
        }
        for (const row of payload.days) {
          if (!validMetrics(row) || !validDay(row.report_date) || row.report_date < start || row.report_date > completeEnd ||
              days.has(row.report_date) || !skuSources.every(key=>['ready','missing'].includes(row.coverage?.[key]))) {
            throw new Error('Invalid SKU preview date');
          }
          days.set(row.report_date,row);
        }
        if (completeEnd === end) totals = payload.totals;
      } catch (err) {
        days.clear();
        error = err.status === 404 || err.code === 'PGRST202' ? 'SKU 汇总接口尚未启用。' : '暂时无法读取 SKU 汇总，请重新加载。';
      }
    }
    const missingCoverage = Object.fromEntries(skuSources.map(key=>[key,'missing']));
    return {days:dates.map(report_date=>days.get(report_date) ?? {report_date,coverage:missingCoverage}),
      totals,error,unfinished:completeEnd < end};
  }

  async function readSkuWeeklyNotes(weekStart,parentAsin,signal) {
    try {
      const p = await rpc('mc_weekly_results_notes_read',{p_week_start:weekStart,p_parent_asin:parentAsin},signal);
      if (!p || p.week_start!==weekStart || p.parent_asin!==parentAsin) return [];
      const n=p.notes;
      if (n!==null && (!n || !Number.isSafeInteger(n.revision) || n.revision<1 ||
          (n.operation!==null && typeof n.operation!=='string') ||
          Object.values(dailyFeeFields).some(k=>!(k in n) || (n[k]!==null &&
            (number(n[k])===null || number(n[k])<0 || number(n[k])>9999999999.99))))) return [];
      return [p]; // notes:null is a confirmed empty record; a failed read returns [].
    } catch { return []; }
  }

  async function fetchSkuList(controller,start,end) {
    const emptyList = (error,visibleParents=null) => ({listRows:new Map(),listAds:new Map(),visibleParents,error});
    if (end >= pacificToday()) return emptyList('所选期间尚未结束，整期合计待齐。点开父 ASIN 可查看各数据源进度。',
      new Set([...parents.values()].filter(g=>!g.ruleOnly).map(g=>g.parent)));
    try {
      const entries=await rpc('mc_weekly_results_sku_list',{p_start_date:start,p_end_date:end},controller.signal);
      const fields=['br_sales','br_orders','br_units','sessions','sp_cost','sp_orders','sp_sales'];
      if (!Array.isArray(entries) || entries.length>10000 || new Set(entries.map(v=>v?.parent_asin)).size!==entries.length ||
          entries.some(r=>!r || !asin.test(r.parent_asin ?? '') || fields.some(k=>!(k in r) || (r[k]!==null && number(r[k])===null)))) {
        throw new Error('父款经营明细列表格式有误。');
      }
      return {listRows:new Map(entries.map(r=>[r.parent_asin,{sales:r.br_sales,orders:r.br_orders,units:r.br_units,visits:r.sessions}])),
        listAds:new Map(entries.map(r=>[r.parent_asin,{sp_cost:r.sp_cost,sp_orders:r.sp_orders,sp_sales:r.sp_sales}])),visibleParents:new Set(entries.map(r=>r.parent_asin)),error:''};
    } catch (e) {
      if (e.status===401 || e.status===403) throw e;
      return emptyList(e.status===404 || e.code==='PGRST202' ? '父款经营明细列表接口尚未安装；可打开父 ASIN 查看明细。' :
        '暂时无法读取父款汇总。可重试，或点开父 ASIN 查看明细。');
    }
  }

  async function fetchSkuPeriod(controller,daily,weekStart,start,end,parentAsin) {
    const lastClosed = shiftDay(pacificToday(),-1);
    const from = daily ? start : weekStart;
    const to = daily ? end : shiftDay(weekStart,6);
    const closed = to < lastClosed ? to : lastClosed;
    const subsidiary = from <= closed;
    const signal = controller.signal;
    const [sku,otherAds,returns,dailyFees,rows] = await Promise.all([
      readSkuPeriod(from,to,lastClosed,parentAsin,signal),
      subsidiary ? optionalOtherAds(from,closed,parentAsin,signal) : blankOtherAds(),
      subsidiary ? readFbaMovements(from,closed,parentAsin,signal) : {rows:[],error:false},
      daily ? readDailyFees(from,to,parentAsin,signal) : null,
      daily ? [] : readSkuWeeklyNotes(weekStart,parentAsin,signal),
    ]);
    return {sku,otherAds,returns,dailyFees,rows,search:{state:'idle'}};
  }

  async function loadSkuContext(controller,daily,weekStart,start,end,parentAsin) {
    const loaded = await fetchSkuPeriod(controller,daily,weekStart,start,end,parentAsin);
    if (context !== controller || controller.signal.aborted || !auth) return;
    const {rows,sku} = loaded;
    detail = loaded;
    loadedContext = true;
    renderDetail();
    if (daily) showDailyFees();
    else if (rows.length) renderNotes(rows[0]);
    notice(ui.productStatus,daily || rows.length ? '' : '暂时无法读取本周费用，订单毛利估算留空。', 'warning');
    if (focusDetail) {
      (focusDetail === 'notes' && rows.length ? ui.reviewFee : ui.selectedParent).focus();
      focusDetail = false;
    }
    pageStatus(sku.error,sku.error ? 'error' : '',sku.error ? loadContext : null);
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
    renderSkuSource();
    loadedContext = false;
    hasList = false;
    detail = null;
    activeNoteKey = '';
    noteBase = null;
    lockWeeks(false);
    ui.productList.hidden = !!parentAsin;
    ui.resultProductFilters.hidden = !!parentAsin;
    ui.productResults.hidden = !parentAsin;
    ui.parentResults.replaceChildren();
    ui.parentTable.hidden = true;
    ui.parentEmpty.hidden = true;
    ui.resultsCount.textContent = '';
    ui.resultsDailyListHint.hidden = true;
    ui.weeklyNotesForm.hidden = true;
    ui.resultFeeWeekField.hidden = true;
    resetDailyFees();
    for (const table of Object.values(tables)) table.replaceChildren();
    for (const id of feeFields) ui[id].value = '0';
    updateFormState();
    notice(ui.notesStatus);
    notice(ui.productStatus);
    if (parentAsin) {
      ui.selectedParent.textContent = parentAsin;
      ui.selectedOwner.textContent = groupLabel(parents.get(parentAsin));
      ui.selectedWeek.textContent = daily ? rangeLabel(start,end) : selectedWeekText();
      selectTab(selectedTab);
    }
    pageStatus(daily ? '正在读取所选日期的结果…' : '正在读取所选周的结果…');
    try {
      if (!daily && chosenWeeks.length > 1) { await loadMultiWeeks(controller,chosenWeeks.slice(),parentAsin); return; }
      if (parentAsin) {
        await loadSkuContext(controller,daily,weekStart,start,end,parentAsin);
        return;
      }
      const from = daily ? start : weekStart, to = daily ? end : shiftDay(weekStart,6);
      const loaded = await fetchSkuList(controller,from,to);
      if (context !== controller || controller.signal.aborted || !auth) return;
      listVisible = loaded.visibleParents; listRows = loaded.listRows; listAds = loaded.listAds; hasList = loadedContext = true;
      renderList();
      if (daily) notice(ui.resultsDailyListHint,'销售和流量按所选日汇总；缺日的指标留空，点开父 ASIN 可查看每日明细。');
      if (returnParent) {
        ui.parentResults.querySelector(`[data-result-parent="${returnParent}"]`)?.focus();
        returnParent = '';
      }
      pageStatus(loaded.error,loaded.error ? 'warning' : '',loaded.error && to < pacificToday() ? loadContext : null);
    } catch (error) {
      if (context === controller && !controller.signal.aborted && auth) pageStatus(explain(error),'error',loadContext);
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

  function resetDailyFees() {
    dailyFeeRefreshing = false;
    ui.dailyFeesForm.hidden = true;
    ui.dailyFeesDate.replaceChildren();
    ui.dailyFeesDate.disabled = ui.saveDailyFees.disabled = true;
    ui.reloadDailyFees.hidden = true;
    ui.reloadDailyFees.disabled = false;
    for (const id of Object.keys(dailyFeeFields)) {
      ui[id].value = '0';
      ui[id].disabled = true;
    }
    notice(ui.dailyFeesStatus);
  }

  const dailyFeeKey = day => `${parent}/${day}`;
  const currentDailyFee = () => detail?.dailyFees?.rows.find(row => row.report_date === ui.dailyFeesDate.value);

  function dailyFeeValues() {
    return Object.fromEntries(Object.keys(dailyFeeFields).map(id=>[id,ui[id].value]));
  }

  function sameDailyFees(values, row) {
    return !!row && Object.entries(dailyFeeFields).every(([id,key])=>{
      try { return !ui[id].validity?.badInput && readFee(values[id]) === row[key]; } catch { return false; }
    });
  }

  function updateDailyFeesState() {
    const row = currentDailyFee();
    const key = dailyFeeKey(ui.dailyFeesDate.value);
    const needsReload = dailyFeeUnconfirmed.has(key) || !!detail?.dailyFees?.error ||
      (!!row && dailyFeeDrafts.has(key) && dailyFeeDrafts.get(key).revision !== row.revision);
    const busy = mode !== 'day' || !auth || !parent || !!saveRequest || dailyFeeRefreshing;
    ui.dailyFeesDate.disabled = busy || !row;
    for (const id of Object.keys(dailyFeeFields)) ui[id].disabled = busy || !row;
    ui.saveDailyFees.disabled = busy || needsReload || sameDailyFees(dailyFeeValues(),row) || !row;
    ui.reloadDailyFees.hidden = !needsReload;
    ui.reloadDailyFees.disabled = busy;
  }

  function showDailyFees(selected = '', message = '') {
    ui.dailyFeesForm.hidden = false;
    const rows = detail.dailyFees.rows;
    ui.dailyFeesDate.replaceChildren(...rows.map(row=>new Option(row.report_date,row.report_date)));
    if (rows.some(row=>row.report_date === selected)) ui.dailyFeesDate.value = selected;
    else if (rows.length) ui.dailyFeesDate.value = rows[0].report_date;
    selectDailyFeesDate(message);
  }

  function selectDailyFeesDate(message = '') {
    const row = currentDailyFee();
    const key = dailyFeeKey(ui.dailyFeesDate.value);
    const draft = dailyFeeDrafts.get(key);
    for (const [id,field] of Object.entries(dailyFeeFields)) ui[id].value = draft?.values[id] ?? String(row?.[field] ?? 0);
    if (detail?.dailyFees?.error) notice(ui.dailyFeesStatus,detail.dailyFees.message,'error');
    else if (dailyFeeUnconfirmed.has(key) || (row && draft && draft.revision !== row.revision)) {
      notice(ui.dailyFeesStatus,'这笔费用可能已有更新，请先读取最新费用。','error');
    } else notice(ui.dailyFeesStatus,message || (draft ? '已保留未保存的修改。' : ''));
    updateDailyFeesState();
  }

  function captureDailyFeeDraft() {
    const row = currentDailyFee();
    if (mode !== 'day' || !row || saveRequest || dailyFeeRefreshing) return;
    const key = dailyFeeKey(row.report_date);
    const values = dailyFeeValues();
    const original = dailyFeeDrafts.get(key)?.base ?? row;
    if (sameDailyFees(values,row)) dailyFeeDrafts.delete(key);
    else dailyFeeDrafts.set(key,{values,revision:original.revision,base:original});
    if (!dailyFeeUnconfirmed.has(key) && (!dailyFeeDrafts.has(key) || dailyFeeDrafts.get(key).revision === row.revision)) {
      notice(ui.dailyFeesStatus,dailyFeeDrafts.has(key) ? '有未保存的修改。' : '');
    }
    updateDailyFeesState();
  }

  async function reloadDailyFees() {
    if (mode !== 'day' || !auth || !parent || !detail || !context || saveRequest || dailyFeeRefreshing) return;
    const previous = detail;
    const load = context;
    const day = ui.dailyFeesDate.value;
    const key = dailyFeeKey(day);
    dailyFeeRefreshing = true;
    updateDailyFeesState();
    notice(ui.dailyFeesStatus,'正在读取最新费用…');
    const result = await readDailyFees(dayStart,dayEnd,parent,load.signal);
    if (context !== load || detail !== previous || load.signal.aborted || !auth) return;
    dailyFeeRefreshing = false;
    if (result.error) {
      notice(ui.dailyFeesStatus,result.message,'error');
      updateDailyFeesState();
      return;
    }
    detail.dailyFees = result;
    const saved = result.rows.find(row=>row.report_date === day);
    const draft = dailyFeeDrafts.get(key);
    dailyFeeUnconfirmed.delete(key);
    if (saved && draft) {
      const values = Object.fromEntries(Object.entries(dailyFeeFields).map(([id,field])=>{
        let unchanged = false;
        try { unchanged = readFee(draft.values[id]) === draft.base[field]; } catch { /* preserve invalid draft for correction */ }
        return [id,unchanged ? String(saved[field]) : draft.values[id]];
      }));
      if (sameDailyFees(values,saved)) dailyFeeDrafts.delete(key);
      else dailyFeeDrafts.set(key,{values,revision:saved.revision,base:saved});
    }
    renderDailySummary();
    showDailyFees(day,dailyFeeDrafts.has(key) ? '表格已显示最新费用，输入框保留你的修改。核对后再保存。' : '已读取最新费用。');
  }

  async function saveDailyFees(event) {
    event.preventDefault();
    const row = currentDailyFee();
    if (mode !== 'day' || !auth || !parent || !row || saveRequest || dailyFeeRefreshing || ui.saveDailyFees.disabled) return;
    const key = dailyFeeKey(row.report_date);
    const values = dailyFeeValues();
    let amounts;
    try {
      amounts = Object.fromEntries(Object.entries(dailyFeeFields).map(([id,field])=>{
        if (ui[id].validity?.badInput) throw new Error('费用请填写非负金额，最多两位小数。');
        return [`p_${field}`,readFee(values[id])];
      }));
    } catch (error) { notice(ui.dailyFeesStatus,error.message,'error'); return; }
    const params = {p_report_date:row.report_date,p_parent_asin:row.parent_asin,p_revision:row.revision,...amounts};
    const controller = new AbortController();
    saveRequest = controller;
    const controls = [ui.resultView,ui.backToProducts,ui.resultStartDate,ui.resultEndDate,
      ...ui.resultDateFilter.querySelectorAll('button')];
    for (const input of controls) input.disabled = true;
    updateDailyFeesState();
    notice(ui.dailyFeesStatus,'正在保存…');
    try {
      const saved = await rpc('mc_daily_results_fees_save',params,controller.signal);
      if (saveRequest !== controller || !auth || dailyFeeKey(ui.dailyFeesDate.value) !== key) return;
      if (!validDailyFees(saved,row.report_date,row.parent_asin) || saved.revision <= row.revision ||
          !Object.values(dailyFeeFields).every(field=>saved[field] === amounts[`p_${field}`])) {
        throw new Error('保存结果无法确认，请读取最新费用。');
      }
      detail.dailyFees.rows = detail.dailyFees.rows.map(item=>item.report_date === saved.report_date ? saved : item);
      dailyFeeDrafts.delete(key);
      dailyFeeUnconfirmed.delete(key);
      selectDailyFeesDate();
      renderDailySummary();
      notice(ui.dailyFeesStatus,`${saved.report_date} 费用已保存，表格已重新计算。`,'success');
    } catch (error) {
      if (saveRequest !== controller || controller.signal.aborted) return;
      dailyFeeUnconfirmed.add(key);
      const conflict = error.code === '40001' || error.status === 409;
      notice(ui.dailyFeesStatus,conflict ? '这笔费用已被其他人更新。请读取最新费用，核对后再保存。'
        : '保存结果暂未确认。请读取最新费用后再试。','error');
    } finally {
      if (saveRequest === controller) {
        saveRequest = null;
        for (const input of controls) input.disabled = false;
        updateDailyFeesState();
      }
    }
  }

  async function saveNotes(event) {
    event.preventDefault();
    if (mode !== 'week' || !auth || !loadedContext || !parent || activeNoteKey !== noteKey() || saveRequest) return;
    const key = activeNoteKey;
    const values = formValues();
    if (sameForm(values, noteBase)) return;
    let params;
    const selectedFeeWeek=feeWeek();
    const line = detail.rows.find(row => row.week_start === selectedFeeWeek);
    if(!line)return;
    try {
      // The existing RPC writes all fields. Preserve the stored text while editing fees only.
      params = { p_week_start: selectedFeeWeek, p_parent_asin: parent, p_operation: line?.notes?.operation ?? null,
        p_review_fee: readFee(values.reviewFee), p_offsite_fee: readFee(values.offsiteFee),
        p_other_fee: readFee(values.otherFee), p_revision: activeRevision };
    } catch (error) { notice(ui.notesStatus,error.message,'error'); return; }
    const controller = new AbortController();
    saveRequest = controller;
    lockWeeks(true);
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
      notice(ui.notesStatus, `${weekLabel(selectedFeeWeek)} 费用已保存。`, 'success');
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
        lockWeeks(false);
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
    parents.clear(); listRows.clear(); listAds.clear(); listVisible=null; drafts.clear();
    dailyFeeDrafts.clear(); dailyFeeUnconfirmed.clear();
    week = parent = activeNoteKey = dayStart = dayEnd = '';
    mode = 'week';
    selectedTab = 'summary';
    detail = noteBase = null;
    loadedContext = hasList = focusDetail = false;
    returnParent = '';
    ui.results.hidden = ui.productResults.hidden = ui.appShell.hidden = true;
    ui.userEmail.textContent = '';
    ui.resultSearch.value = '';
    ui.resultOwner.replaceChildren(new Option('全部负责人',''));
    chosenWeeks=[]; availableWeeks=[]; weekChecks=[]; ui.resultWeekOptions.replaceChildren();
    ui.resultWeek.open=false;ui.resultWeek.inert=false;ui.resultWeekSummary.textContent='选择周次';ui.resultFeeWeek.replaceChildren();
    ui.resultStartDate.value = ui.resultEndDate.value = '';
    for (const input of [ui.resultStartDate,ui.resultEndDate,...ui.resultDateFilter.querySelectorAll('button')]) input.disabled = false;
    ui.resultView.disabled = false;
    ui.parentResults.replaceChildren();
    for (const table of Object.values(tables)) table.replaceChildren();
    for (const id of feeFields) ui[id].value = '0';
    resetDailyFees();
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
      buildWeekPicker(available);
      ui.resultOwner.replaceChildren(new Option('全部负责人',''),...parsed.owners.map(value => new Option(value,value)));
      ui.resultsCatalogDate.textContent = catalog.snapshot_date;
      ui.resultsCatalogDate.dateTime = catalog.snapshot_date;
      week = available[1] ?? available[0];
      mode = 'day';
      const linkedWeek = previewParams.get('week');
      const linkedDate = previewParams.get('date');
      const linkedParent = previewParams.get('parent');
      const weekLink = validWeek(linkedWeek) && available.includes(linkedWeek);
      const today = pacificToday();
      const dayLink = validDay(linkedDate) && linkedDate >= earliestSkuDay &&
        linkedDate <= shiftDay(today,-1);
      if (weekLink || dayLink) {
        if (weekLink) {
          week = linkedWeek;
          mode = 'week';
        } else if (dayLink) {
          dayStart = dayEnd = linkedDate;
        }
        if (parents.has(linkedParent)) parent = linkedParent;
      }
      setChosenWeeks([week]);
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
        typeof window.KBAuth?.requireAuth !== 'function' || typeof window.MCWeeklyResultTables?.renderSku !== 'function' ||
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

  ui.resultWeekOptions.addEventListener('change',updateWeekCount);
  ui.resultWeek.addEventListener('toggle',()=>{ if(!ui.resultWeek.open && chosenWeeks.length) setChosenWeeks(chosenWeeks); });
  ui.resultWeek.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();dismissWeeks();ui.resultWeekSummary.focus();}
  });
  document.addEventListener?.('click',event=>{
    if(ui.resultWeek.open && !ui.resultWeek.contains(event.target)) dismissWeeks();
  });
  ui.applyResultWeeks.addEventListener('click',()=>{
    if(mode!=='week' || saveRequest) return;
    const wanted=weekChecks.filter(check=>check.checked).map(check=>check.value);
    if(!wanted.length)return;
    const changed=chosenWeeks.join(',')!==wanted.join(',');
    setChosenWeeks(wanted);ui.resultWeek.open=false;ui.resultWeekSummary.focus();
    if(changed)void loadContext();
  });
  ui.resultFeeWeek.addEventListener('change',changeFeeWeek);
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
  ui.dailyFeesForm.addEventListener('submit',saveDailyFees);
  ui.dailyFeesDate.addEventListener('change',()=>selectDailyFeesDate());
  ui.reloadDailyFees.addEventListener('click',()=>void reloadDailyFees());
  for (const id of Object.keys(dailyFeeFields)) {
    ui[id].addEventListener('input',captureDailyFeeDraft);
    ui[id].addEventListener('blur',()=>{
      if (ui[id].value === '' && !ui[id].validity?.badInput) {
        ui[id].value = '0';
        captureDailyFeeDraft();
      }
    });
  }
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
    if (drafts.size || dailyFeeDrafts.size || saveRequest) { event.preventDefault(); event.returnValue = ''; }
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
