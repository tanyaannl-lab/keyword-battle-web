(() => {
  'use strict';
  const id = name => document.getElementById(name);
  const shell = id('appShell'), frame = id('adsFrame'), panel = id('statusPanel');
  const loading = id('loading'), status = id('status'), retry = id('retry');
  const picker = id('adWeek'), config = window.KB_CONFIG;
  const login = '../index.html?next=ads-dashboard';
  const project = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const maxRaw = 64 * 1024 * 1024, maxPacked = 16 * 1024 * 1024;
  let request, selection, auth, template, weeks = [];

  function clearWeek() {
    selection?.abort();
    selection = null;
    window.MCAdsFrame?.clear(frame);
    frame.hidden = true;
    panel.hidden = false;
    retry.hidden = true;
  }

  function reset() {
    request?.abort();
    request = null;
    clearWeek();
    auth = null;
    weeks = [];
    picker.replaceChildren();
    id('weekControl').hidden = true;
    id('userEmail').textContent = '';
    shell.hidden = true;
    loading.hidden = false;
    loading.textContent = '正在验证登录状态…';
  }

  async function rpc(name, args, signal) {
    const res = await fetch(project + '/rest/v1/rpc/' + name, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal,
      headers: {'Content-Type':'application/json', apikey:config.SUPABASE_PUBLISHABLE_KEY,
        Authorization:'Bearer ' + auth.session.access_token}, body:JSON.stringify(args)
    });
    if (res.status === 401) throw new Error('登录已过期，请重新加载。');
    if (res.status === 403) throw new Error('当前账号没有 MC 美国站广告看板的查看权限。');
    if (res.status === 404) throw new Error('数据库的广告周报更新尚未安装，请先运行本次 SQL。');
    if (!res.ok) throw new Error('后台暂时无法读取，请重试。');
    return res.json();
  }

  async function readFeed(value, week) {
    if (!value || value.week !== week || value.format !== 'json-v1' || value.encoding !== 'gzip+base64' ||
        !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maxRaw ||
        !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.content !== 'string' ||
        value.content.length > 4 * Math.ceil(maxPacked / 3)) throw new Error('后台返回的周报格式或大小异常。');
    if (!window.DecompressionStream || !window.crypto?.subtle) throw new Error('请用新版浏览器打开广告看板。');
    const zipped = Uint8Array.from(atob(value.content), x => x.charCodeAt(0));
    const reader = new Blob([zipped]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const data = new Uint8Array(value.bytes);
    let offset = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (offset + part.value.length > data.length) {
          await reader.cancel();
          throw new Error('周报文件大小异常。');
        }
        data.set(part.value,offset);
        offset += part.value.length;
      }
    } finally { reader.releaseLock(); }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',data));
    if (offset !== value.bytes || Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('') !== value.sha256) {
      throw new Error('周报数据校验失败，请重新加载。');
    }
    const feed = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
    if (feed.week !== week || !Array.isArray(feed.catalog) || !feed.actualPack) throw new Error('广告数据与所选报表周不一致。');
    return feed;
  }

  async function getTemplate(signal) {
    if (template) return template;
    const res = await fetch('../assets/mc-ads-view.html?v=20261127-search-term-rows1', {signal,redirect:'error'});
    if (!res.ok) throw new Error('看板页面文件未能加载，请检查网页包是否已完整发布。');
    template = await res.text();
    return template;
  }

  function validWeek(week) {
    if (typeof week !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return false;
    const day = new Date(week + 'T00:00:00Z');
    return Number.isFinite(day.getTime()) && day.getUTCDay() === 1 && day.toISOString().slice(0,10) === week;
  }

  function weekLabel(week) {
    const end = new Date(week + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate()+6);
    return week.replaceAll('-','/') + '–' + end.toISOString().slice(5,10).replace('-','/');
  }

  function showError(error) {
    status.textContent = error instanceof TypeError ? '网络连接或数据加载失败，请重新加载。' : error.message;
    panel.hidden = false;
    retry.hidden = false;
  }

  // The directory describes the most recently synchronized account configuration.
  // Weekly performance can still open while the first directory is pending.
  async function readInventory(signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, {once:true});
    const timeout = setTimeout(cancel, 15000);
    try {
      const value = await rpc('mc_ads_dashboard_inventory_read', {}, controller.signal);
      if (value === null) return {status:'unavailable', data:null};
      if (value?.version !== 1 || !Number.isFinite(Date.parse(value.capturedAt)) ||
          !Array.isArray(value.campaigns) || !value.campaigns.every(c =>
            typeof c?.id === 'string' && typeof c.name === 'string' &&
            Array.isArray(c.types) && Array.isArray(c.groups) && c.groups.every(g =>
              typeof g?.id === 'string' && Array.isArray(g.types) && typeof g.unmapped === 'boolean' &&
              Array.isArray(g.owners) && g.owners.every(o => Array.isArray(o) &&
                o.length === 2 && o.every(s => typeof s === 'string'))))) {
        return {status:'error', data:null};
      }
      return {status:'ready', data:value};
    } catch {
      return {status:'error', data:null};
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }

  async function chooseWeek(week) {
    clearWeek();
    const run = new AbortController();
    selection = run;
    status.textContent = '正在读取所选周的广告数据…';
    let business = {status:'loading',week,rows:[],loadedDays:0,failedDates:[]};
    function receive(value) {
      if (selection !== run) return;
      business = value;
      MCAdsFrame.updateBusiness(frame,week,value);
    }
    void MCAdsBusiness.readWeek(week,rpc,run.signal,receive).then(receive).catch(() => {
      receive({...business,status:business.loadedDays ? 'partial':'error'});
    });
    try {
      const [html,inventory,feed] = await Promise.all([getTemplate(run.signal), readInventory(run.signal),
        rpc('mc_ads_dashboard_week_read',{p_week:week},run.signal).then(data=>readFeed(data,week))]);
      if (selection !== run) return;
      const options = Array.from(picker.options, option => ({value:option.value, label:option.text}));
      const account = auth.user.id;
      async function readPeriodWeek(requestedWeek, signal) {
        function checkAccess() {
          if (selection !== run || run.signal.aborted || signal.aborted || auth?.user?.id !== account) {
            throw new DOMException('看板已切换。', 'AbortError');
          }
          if (!validWeek(requestedWeek) || !weeks.includes(requestedWeek)) {
            throw new Error('所选周尚未发布。');
          }
        }
        checkAccess();
        const data = await rpc('mc_ads_dashboard_week_read', {p_week:requestedWeek}, signal);
        checkAccess();
        const historicalFeed = await readFeed(data, requestedWeek);
        checkAccess();
        return historicalFeed;
      }
      MCAdsFrame.mount(frame,html,account,feed,business,options,selectWeek,readPeriodWeek,inventory);
      panel.hidden = true;
      frame.hidden = false;
    } catch (error) {
      if (selection !== run) return;
      run.abort();
      showError(error);
    }
  }

  async function openDashboard() {
    const preferred = picker.value || new URL(location.href).searchParams.get('week');
    reset();
    const run = new AbortController();
    request = run;
    try {
      if (config?.SUPABASE_URL?.replace(/\/$/,'') !== project || !window.KBAuth || !window.MCAdsFrame || !window.MCAdsBusiness) {
        throw new Error('站点文件未就绪，请刷新页面。');
      }
      const result = await KBAuth.requireAuth(login);
      if (request !== run || !result) return;
      if (!result.session?.access_token || !result.user?.id) { location.replace(login); return; }
      auth = result;
      id('userEmail').textContent = auth.user.email || '';
      loading.hidden = true;
      shell.hidden = false;
      status.textContent = '正在读取可查看的报表周…';
      const available = await rpc('mc_ads_dashboard_weeks',{},run.signal);
      if (request !== run) return;
      if (!Array.isArray(available)) throw new Error('周报目录格式异常，请重新加载。');
      weeks = [...new Set(available.filter(x=>x?.format === 'json-v1' && validWeek(x.week)).map(x=>x.week))].sort().reverse();
      if (!weeks.length) throw new Error('还没有已发布的广告周报。');
      picker.replaceChildren(...weeks.map(w=>new Option(weekLabel(w),w)));
      id('weekControl').hidden = false;
      picker.value = weeks.includes(preferred) ? preferred : weeks[0];
      await chooseWeek(picker.value);
    } catch (error) {
      if (request !== run) return;
      if (shell.hidden) loading.textContent = error.message;
      else showError(error);
    }
  }

  function selectWeek(week) {
    if (!weeks.includes(week)) return;
    picker.value = week;
    const address = new URL(location.href);
    address.searchParams.set('week',week);
    history.replaceState(null,'',address);
    void chooseWeek(week);
  }
  picker.addEventListener('change', () => selectWeek(picker.value));
  retry.addEventListener('click',openDashboard);
  id('logoutBtn').addEventListener('click', async () => {
    reset();
    try { await KBAuth.logout(); } finally { location.replace('../index.html'); }
  });
  window.addEventListener('pagehide',reset);
  window.addEventListener('pageshow',e=>{if(e.persisted) void openDashboard();});
  window.addEventListener('storage',e=>{
    if (e.key !== null && e.key !== config?.SESSION_KEY) return;
    const saved = window.KBAuth?.loadSession();
    if (!saved?.access_token) { reset(); location.replace(login); }
    else if (saved.user?.id !== auth?.user?.id) void openDashboard();
  });
  void openDashboard();
})();
