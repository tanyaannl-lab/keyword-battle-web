'use strict';

(() => {
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const cfg = window.KB_CONFIG;
  const model = window.MCYesterdayModel;
  const dateMin = '2000-01-03';
  const asin = /^[A-Z0-9]{10}$/;
  const input = Object.fromEntries(['appShell','loading','logoutBtn','userEmail','yesterdayDate','yesterdayParent',
    'yesterdayReload','yesterdayStatus','yesterdayHeading','yesterdayOverview','yesterdayAdvertising',
    'yesterdayData','yesterdayCoverage'].map(key => [key,document.getElementById(key)]));
  const money = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
  const count = new Intl.NumberFormat('en-US');
  const percent = new Intl.NumberFormat('en-US',{style:'percent',maximumFractionDigits:2});
  const overview = [
    ['date'],['sales',money],['profit',money],['orders',count],['units',count],['visits',count],
    ['unit_session_rate',percent],['returns_rate',percent],['total_ad_cost',money],['sp_cost',money],
    ['sp_orders',count],['sp_acos',percent],['sbv_cost',money],['sb_cost',money],['sd_cost',money],
    ['traffic_days',null,value=>value === 1 ? '已同步' : '未同步'],['review_fee',money],['offsite_fee',money],['other_fee',money],
  ];
  const advertising = [
    ['date'],['scope'],['sales',money],['sp_sales',money],['sp_sales_share',percent],['sp_cost',money],
    ['sp_orders',count],['sp_impressions',count],['sp_clicks',count],['sp_acos',percent],
  ];
  const rpcNames = {
    catalog:'mc_product_catalog_read', traffic:'mc_weekly_results_daily_read', sp:'mc_weekly_results_sp_daily_read',
    otherAds:'mc_weekly_results_other_ads_read', profit:'mc_weekly_results_daily_profit_read',
    returns:'mc_daily_fba_returns_read', fees:'mc_daily_results_fees_read',
  };
  const sourceLabels = {traffic:'销售与流量',sp:'商品推广',otherAds:'品牌和展示型推广',profit:'利润基础',returns:'退货与发货',fees:'每日费用'};
  let auth, refreshAuth, active, generation = 0, parents = new Set();
  const requested = new URLSearchParams(location.search);

  function status(message = '',state = '') {
    input.yesterdayStatus.textContent = message;
    input.yesterdayStatus.hidden = !message;
    if (state) input.yesterdayStatus.dataset.state = state;
    else delete input.yesterdayStatus.dataset.state;
  }

  function clearRows() {
    input.yesterdayData.hidden = true;
    input.yesterdayHeading.textContent = '';
    input.yesterdayOverview.replaceChildren();
    input.yesterdayAdvertising.replaceChildren();
    input.yesterdayCoverage.textContent = '';
    input.yesterdayCoverage.hidden = true;
  }

  function clearPrivate() {
    generation++;
    active?.abort();
    active = auth = refreshAuth = null;
    parents = new Set();
    clearRows();
    input.yesterdayParent.replaceChildren(new Option('请选择父 ASIN',''));
    input.yesterdayParent.disabled = true;
    input.userEmail.textContent = '';
    input.appShell.hidden = true;
    status();
  }

  function rpcIssue(response) {
    return Object.assign(new Error('MC_YESTERDAY_READ_FAILED'),{status:response.status});
  }

  async function read(source,args,signal) {
    const name = Object.hasOwn(rpcNames,source) && rpcNames[source];
    if (!name || !auth?.session?.access_token) throw rpcIssue({status:401});
    const combined = AbortSignal.any([signal,AbortSignal.timeout(25000)]);
    const send = token => fetch(`${origin}/rest/v1/rpc/${name}`,{
      method:'POST',redirect:'error',credentials:'omit',mode:'cors',cache:'no-store',referrerPolicy:'no-referrer',signal:combined,
      headers:{Accept:'application/json','Content-Type':'application/json',
        apikey:cfg.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`},body:JSON.stringify(args),
    });
    const previous = auth;
    const token = previous.session.access_token;
    let response = await send(token);
    if (response.status === 401 && !combined.aborted && auth?.user.id === previous.user.id) {
      if (auth !== previous && auth.session.access_token !== token) response = await send(auth.session.access_token);
      else {
        if (!refreshAuth) {
          const pending = Promise.resolve().then(()=>window.KBAuth.getValidSession());
          refreshAuth = pending;
          const clear = () => {if (refreshAuth === pending) refreshAuth = null;};
          pending.then(clear,clear);
        }
        let current;
        try { current = await refreshAuth; } catch { throw rpcIssue(response); }
        if (!combined.aborted && auth?.user.id === previous.user.id && current?.user?.id === previous.user.id &&
            current.session?.access_token && current.session.access_token !== token) {
          auth = current;
          response = await send(current.session.access_token);
        }
      }
    }
    if (!response.ok) throw rpcIssue(response);
    return await response.json();
  }

  function readCatalog(value) {
    if (value === null) return new Set();
    if (value?.store !== 'MC' || value.marketplace !== 'amazon.com' || !Array.isArray(value.products) || value.products.length > 10000 ||
        value.products.some(product => typeof product?.parent_asin !== 'string' || !asin.test(product.parent_asin))) throw new Error('invalid catalog');
    return new Set(value.products.map(p=>p.parent_asin).sort());
  }

  function readData(source,data,date,parent) {
    const parentRows = rows => Array.isArray(rows) && rows.every(row=>row && row.report_date === date && row.parent_asin === parent);
    if (source === 'traffic') {
      if (data?.start_date !== date || data.end_date !== date || data.days_total !== 1 || ![0,1].includes(data.traffic_days) ||
          !parentRows(data.rows) || data.rows.length !== 1 || data.traffic_days !== data.rows[0].traffic_days) throw new Error('invalid traffic');
      return data.rows[0];
    }
    if (source === 'otherAds') {
      const selectedDay = model.parseDate(date);
      selectedDay.setUTCDate(selectedDay.getUTCDate() - (selectedDay.getUTCDay()+6)%7);
      const week = selectedDay.toISOString().slice(0,10);
      const {rows,coverage} = data ?? {};
      const channels = ['SB','SD'];
      const states = ['empty','mapped','unmapped','partial','missing'];
      if (!parentRows(rows) || rows.length > 2 || new Set(rows.map(row=>row.channel)).size !== rows.length ||
          !Array.isArray(coverage) || coverage.length !== 2 || new Set(coverage.map(row=>row?.channel)).size !== 2 ||
          coverage.some(row=>!row || !channels.includes(row.channel) || row.week_start !== week || !states.includes(row.status)) ||
          rows.some(row=>!coverage.some(value=>value.channel === row.channel && ['mapped','partial'].includes(value.status)))) {
        throw new Error('invalid ads');
      }
      return {rows,coverage};
    }
    if (source === 'returns') {
      if (!Array.isArray(data) || data.length !== 1 || data[0]?.report_date !== date) throw new Error('invalid returns');
    } else if (!parentRows(data) || data.length > 1 || (source !== 'sp' && data.length !== 1)) throw new Error('invalid detail');
    return data[0] ?? null;
  }

  function renderRow(target,columns,record) {
    const row = document.createElement('tr');
    for (const [index,[key,formatter,transform]] of columns.entries()) {
      const cell = document.createElement(index === 0 ? 'th' : 'td');
      if (index === 0) cell.scope = 'row';
      const value = record[key];
      if (formatter) cell.classList.add('results-number');
      if (value === null || value === undefined) cell.classList.add('results-missing');
      cell.textContent = value == null ? '—' : formatter ? formatter.format(value) : transform ? transform(value) : String(value);
      row.append(cell);
    }
    target.replaceChildren(row);
  }

  function makeCoverage(result,failed) {
    const notes = [];
    const v = result.overview;
    const ad = result.advertising;
    if (v.traffic_days === 1 && [v.sales,v.orders,v.units,v.visits].every(value=>value == null)) {
      notes.push('当天销售报表已同步，但没有该父 ASIN 的可核验销售与流量记录。');
    } else if (v.traffic_days !== 1) notes.push('当天销售与流量报表尚未同步。');
    if (ad.sp_cost == null && !failed.includes('sp')) notes.push('当天暂无归到该父 ASIN 的 SP 广告数据。');
    if (ad.ad_pending?.length || ad.ad_missing_reports?.length) notes.push('部分广告尚未到齐或无法归属，广告费仅合计已归属部分。');
    if (v.return_units == null || v.shipped_units == null) notes.push('FBA 退货或发货报表尚未到齐。');
    if (failed.length) notes.push(`未能读取：${failed.map(source=>sourceLabels[source]).join('、')}。`);
    return notes.join(' ');
  }

  function fatal(error) {
    if (error?.status === 401) {
      clearPrivate();
      location.replace(login);
      return;
    }
    status(error?.status === 403 ? '当前账号没有查看 MC 美国站日报的权限。' :
      error?.status === 404 ? '所需的日报接口尚未安装。' : '读取失败，请点击「重新读取」。','error');
  }

  async function loadDay() {
    if (!auth) return;
    active?.abort();
    clearRows();
    const date = input.yesterdayDate.value;
    const parent = input.yesterdayParent.value;
    const limit = model.yesterday();
    input.yesterdayDate.max = limit;
    if (!model.parseDate(date) || date < dateMin || date > limit) {
      status('请选择美西昨天或更早的日期。','error');
      return;
    }
    if (!parents.has(parent)) {
      status('请选择一个父 ASIN 后查看。');
      return;
    }
    const controller = new AbortController();
    active = controller;
    status('正在读取所选日期的指标…');
    const args = {p_start_date:date,p_end_date:date,p_parent_asin:parent};
    const sources = ['traffic','sp','otherAds','profit','returns','fees'];
    const settled = await Promise.allSettled(sources.map(async source=>readData(source,await read(source,args,controller.signal),date,parent)));
    if (active !== controller || controller.signal.aborted || !auth) return;
    const denied = settled.find(item=>item.status === 'rejected' && [401,403].includes(item.reason?.status));
    if (denied) {fatal(denied.reason);return;}
    const failed = sources.filter((_,i)=>settled[i].status === 'rejected');
    if (failed.length === sources.length) {fatal(settled[0].reason);return;}
    try {
      const data = Object.fromEntries(sources.map((source,i)=>[source,settled[i].status === 'fulfilled' ? settled[i].value : null]));
      const state = model.build({...data,date,spError:failed.includes('sp'),
        ...(failed.includes('otherAds') ? {otherAds:{rows:[],coverage:[],error:true}} : {})});
      renderRow(input.yesterdayOverview,overview,state.overview);
      renderRow(input.yesterdayAdvertising,advertising,state.advertising);
      input.yesterdayHeading.textContent = `${parent} · ${date}（美西）`;
      const coverage = makeCoverage(state,failed);
      input.yesterdayCoverage.textContent = coverage;
      input.yesterdayCoverage.hidden = !coverage;
      input.yesterdayData.hidden = false;
      status();
    } catch (error) {fatal(error);}
  }

  async function loadCatalog() {
    if (!auth) return;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    status('正在读取产品目录…');
    input.yesterdayParent.disabled = true;
    try {
      const data = await read('catalog',{},controller.signal);
      if (active !== controller || controller.signal.aborted || !auth) return;
      parents = readCatalog(data);
      if (!parents.size) {status('产品目录里暂无可选父 ASIN。');return;}
      input.yesterdayParent.replaceChildren(...[...parents].map(value=>new Option(value,value)));
      const preferred = requested.get('parent');
      input.yesterdayParent.value = parents.has(preferred) ? preferred : [...parents][0];
      input.yesterdayParent.disabled = false;
      void loadDay();
    } catch (error) {
      if (active === controller && !controller.signal.aborted && auth) fatal(error);
    }
  }

  async function start() {
    const id = ++generation;
    input.loading.hidden = false;
    input.loading.textContent = '正在验证登录状态…';
    if (![origin,`${origin}/`].includes(cfg?.SUPABASE_URL) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(cfg?.SUPABASE_PUBLISHABLE_KEY ?? '') ||
        typeof model?.build !== 'function' || typeof window.KBAuth?.requireAuth !== 'function') {
      input.loading.textContent = '日报页面配置未加载，请刷新或联系管理员。';
      return;
    }
    try {
      const current = await window.KBAuth.requireAuth(login);
      if (generation !== id || !current) return;
      if (!current.user?.id || !current.session?.access_token) {location.replace(login);return;}
      auth = current;
      input.userEmail.textContent = current.user.email ?? '';
      const limit = model.yesterday();
      const preferred = requested.get('date');
      input.yesterdayDate.min = dateMin;
      input.yesterdayDate.max = limit;
      input.yesterdayDate.value = model.parseDate(preferred) && preferred >= dateMin && preferred <= limit ? preferred : limit;
      input.loading.hidden = true;
      input.appShell.hidden = false;
      void loadCatalog();
    } catch {
      if (generation === id) input.loading.textContent = '登录校验失败，请刷新重试。';
    }
  }

  for (const control of [input.yesterdayDate,input.yesterdayParent]) control.addEventListener('change',()=>{
    if (parents.size) void loadDay();
  });
  input.yesterdayReload.addEventListener('click',()=>{if (parents.size) void loadDay();else void loadCatalog();});
  input.logoutBtn.addEventListener('click',async()=>{
    clearPrivate();
    try {await window.KBAuth.logout();} finally {location.replace(login);}
  });
  window.addEventListener('pagehide',clearPrivate);
  window.addEventListener('pageshow',event=>{if (event.persisted) void start();});
  window.addEventListener('storage',event=>{
    if (event.key !== cfg?.SESSION_KEY && event.key !== null) return;
    const user = value=>{try {return JSON.parse(value)?.user?.id;} catch {return null;}};
    const next = user(event.newValue);
    if (next && next === user(event.oldValue) && (!auth || auth.user.id === next)) return;
    clearPrivate();
    if (event.newValue) void start();
    else location.replace(login);
  });
  void start();
})();
