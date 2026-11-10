'use strict';

(() => {
  const ui = Object.fromEntries([
    'status', 'workspace', 'week', 'report', 'export', 'appShell', 'loading', 'userEmail', 'logoutBtn',
  ].map(id => [id, document.getElementById(id)]));
  const ORIGIN = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const CONFIG = window.KB_CONFIG;
  const LOGIN = '../index.html';
  const ACCESS_TABLE = 'mc_weekly_access';
  const REPORTS_TABLE = 'mc_weekly_reports';
  const META = 'week_start,week_end,file_id,report_date,kind';
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const TRAFFIC_COLUMNS = [
    '（父）ASIN', '（子）ASIN', '标题', '会话 - 移动应用', '会话 - 浏览器', '会话数 - 总计',
    '会话百分比 - 移动应用', '会话百分比 - 浏览器', '转化率 - 总计', '页面浏览量 - 移动应用',
    '页面浏览量 - 浏览器', '页面浏览量 - 总计 ', '页面浏览量百分比 - 移动应用',
    '页面浏览量百分比 - 浏览器', '页面浏览量百分比 - 总计', '推荐报价（推荐报价展示位）百分比 ',
    '已订购商品数量', '已订购商品数量 - B2B', '商品会话百分比', '商品会话百分比 - B2B',
    '已订购商品销售额', '已订购商品销售额 - B2B', '订单商品总数', '订单商品总数 - B2B',
  ];
  const ORDER_COLUMNS = ['日期（美国太平洋时间）', '订单状态', '币种', '订单明细行数', '商品件数', '商品金额'];

  let listRequest;
  let downloadRequest;
  let auth;
  let pendingAuth;
  let authGeneration = 0;
  let weeks = new Map();

  function notice(el, message = '', bad = false) {
    el.textContent = message;
    el.hidden = !message;
    if (bad) el.dataset.state = 'error';
    else delete el.dataset.state;
  }

  function url(table, fields = {}) {
    if (![ACCESS_TABLE, REPORTS_TABLE].includes(table)) throw new Error('无效的周报请求。');
    const endpoint = new URL(`/rest/v1/${table}`, ORIGIN);
    for (const [key, value] of Object.entries(fields)) endpoint.searchParams.set(key, String(value));
    return endpoint;
  }

  async function accessToken(force = false) {
    if (!auth?.session?.access_token) throw new Error('登录已过期，请重新登录。');
    const expiredSoon = auth.session.expires_at && Number(auth.session.expires_at) <= Date.now() / 1000 + 30;
    if (force || expiredSoon) {
      if (!pendingAuth) pendingAuth = KBAuth.getValidSession().finally(() => { pendingAuth = null; });
      const fresh = await pendingAuth;
      if (!auth) throw new Error('登录已过期，请重新登录。');
      if (!fresh?.session?.access_token || fresh.user?.id !== auth.user?.id) {
        hidePrivateData();
        location.replace(LOGIN);
        throw new Error('登录已过期，请重新登录。');
      }
      auth = fresh;
    }
    return auth.session.access_token;
  }

  async function get(table, fields, signal) {
    const endpoint = url(table, fields);
    const timeout = AbortSignal.timeout(20_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const send = token => fetch(endpoint, {
      method: 'GET', headers: { Accept: 'application/json', apikey: CONFIG.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      cache: 'no-store', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer',
      redirect: 'error', signal: combined,
    });
    const token = await accessToken();
    let response = await send(token);
    if (response.status === 401) {
      const fresh = await accessToken(true);
      if (fresh !== token) {
        void response.body?.cancel().catch(() => {});
        response = await send(fresh);
      }
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('登录已过期，请重新登录。');
      if (response.status === 403) throw new Error('当前账号没有查看 MC 周报的权限。');
      if (response.status === 404) throw new Error('每周报表尚未发布，请等待管理员完成首次发布。');
      if (response.status === 429) throw new Error('操作过于频繁，请稍后重试。');
      throw new Error('MC 周报服务暂未就绪，请稍后刷新；如持续出现，请联系管理员。');
    }
    let rows;
    try { rows = await response.json(); }
    catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
      throw new Error('报表返回格式不正确，请刷新数据后重试。');
    }
    if (!Array.isArray(rows)) throw new Error('报表返回格式不正确，请刷新数据后重试。');
    return rows;
  }

  function errorMessage(error) {
    if (error.name === 'TimeoutError') return '读取 MC 周报超时，请稍后刷新。';
    if (error instanceof TypeError) return '暂时无法连接 MC 周报服务，请稍后刷新；如持续出现，请联系管理员。';
    return error.message;
  }

  function csvCell(value) {
    const first = value.replace(/^[\s\p{Cc}\p{Cf}]*/u, '');
    const numeric = /^-\d+(?:,\d{3})*(?:\.\d+)?%?$/.test(value);
    const safe = /^[=+@-]/.test(first) && !numeric ? "'" + value : value;
    return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  }

  function option(value, text) {
    const entry = document.createElement('option');
    entry.value = value;
    entry.textContent = text;
    return entry;
  }

  function setDownloadBusy(busy) {
    ui.week.disabled = busy;
    ui.report.disabled = busy;
    ui.export.disabled = busy || !ui.report.value;
    ui.export.textContent = busy ? '准备下载…' : '下载 CSV';
  }

  function setReports() {
    const files = weeks.get(ui.week.value)?.reports || [];
    ui.report.replaceChildren(...files.map(file => option(file.file_id,
      file.kind === 'traffic' ? `${file.report_date} 销售流量` : '订单汇总')));
    ui.report.value = files[0]?.file_id || '';
    setDownloadBusy(false);
    notice(ui.status);
  }

  function assembleWeeks(records) {
    const groups = new Map();
    for (const file of records) {
      if (!DAY.test(file?.week_start || '') || !DAY.test(file?.week_end || '') || file.week_start > file.week_end ||
          !(file.kind === 'traffic' && DAY.test(file.report_date || '') && file.report_date >= file.week_start &&
            file.report_date <= file.week_end && file.file_id === `traffic-${file.report_date}` ||
            file.kind === 'order_summary' && file.report_date === null && file.file_id === 'order-summary')) {
        throw new Error('报表列表格式不正确，请刷新页面后重试。');
      }
      const group = groups.get(file.week_start) || { end: file.week_end, reports: [] };
      if (group.end !== file.week_end || group.reports.some(existing => existing.file_id === file.file_id)) {
        throw new Error('报表列表格式不正确，请刷新页面后重试。');
      }
      group.reports.push(file);
      groups.set(file.week_start, group);
    }
    for (const group of groups.values()) {
      group.reports.sort((a, b) => (a.report_date || '9999').localeCompare(b.report_date || '9999'));
    }
    return new Map([...groups].sort(([a], [b]) => b.localeCompare(a)));
  }

  async function loadWeeks() {
    listRequest?.abort();
    const controller = new AbortController();
    listRequest = controller;
    ui.workspace.hidden = true;
    notice(ui.status, '正在读取已发布的周报…');
    try {
      const allowed = await get(ACCESS_TABLE, { select: 'user_id', limit: 1 }, controller.signal);
      if (listRequest !== controller || !auth) return;
      if (allowed.length !== 1 || String(allowed[0]?.user_id || '').toLowerCase() !== auth.user.id.toLowerCase()) {
        throw new Error('当前账号没有查看 MC 周报的权限。');
      }
      const records = [];
      const size = 80;
      for (let offset = 0; ; offset += size) {
        if (offset > 5120) throw new Error('报表列表过长，请联系管理员。');
        const batch = await get(REPORTS_TABLE, {
          select: META, order: 'week_start.desc,file_id.asc', limit: size, offset,
        }, controller.signal);
        if (listRequest !== controller) return;
        records.push(...batch);
        if (batch.length < size) break;
      }
      weeks = assembleWeeks(records);
      if (!weeks.size) {
        notice(ui.status, '暂无可下载的周报。报表发布后，刷新页面即可下载。');
        return;
      }
      ui.week.replaceChildren(...[...weeks].map(([start, group]) => option(start, `${start} 至 ${group.end}`)));
      ui.week.value = weeks.keys().next().value;
      setReports();
      ui.workspace.hidden = false;
    } catch (error) {
      if (listRequest === controller && error.name !== 'AbortError') notice(ui.status, errorMessage(error), true);
    } finally {
      if (listRequest === controller) listRequest = null;
    }
  }

  async function downloadReport() {
    if (!auth || downloadRequest || ui.workspace.hidden) return;
    const file = weeks.get(ui.week.value)?.reports.find(item => item.file_id === ui.report.value);
    if (!file) return;
    const controller = new AbortController();
    downloadRequest = controller;
    setDownloadBusy(true);
    notice(ui.status, '正在准备 CSV…');
    try {
      const found = await get(REPORTS_TABLE, {
        select: 'week_start,file_id,kind,columns,rows,row_count',
        week_start: `eq.${file.week_start}`, file_id: `eq.${file.file_id}`, limit: 1,
      }, controller.signal);
      if (downloadRequest !== controller || !auth) return;
      const data = found[0];
      if (!data) throw new Error('这份报表暂不可用，请刷新页面后重试。');
      const columns = file.kind === 'traffic' ? TRAFFIC_COLUMNS : ORDER_COLUMNS;
      if (found.length !== 1 || data.week_start !== file.week_start || data.file_id !== file.file_id || data.kind !== file.kind ||
          !Array.isArray(data.columns) || data.columns.length !== columns.length || columns.some((name, i) => name !== data.columns[i]) ||
          !Array.isArray(data.rows) || data.rows.length !== data.row_count || data.rows.length > 100000 ||
          !data.rows.every(row => Array.isArray(row) && row.length === columns.length && row.every(cell => typeof cell === 'string'))) {
        throw new Error('报表数据格式不正确，请刷新页面后重试。');
      }
      const csv = '\uFEFF' + [data.columns, ...data.rows].map(row => row.map(csvCell).join(',')).join('\r\n');
      const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = href;
      link.download = file.kind === 'traffic' ? `MC[${file.report_date}].csv` : 'MC订单汇总.csv';
      link.hidden = true;
      document.body.append(link);
      try { link.click(); }
      finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(href), 30_000);
      }
      notice(ui.status, '已发起 CSV 下载。');
    } catch (error) {
      if (downloadRequest === controller && error.name !== 'AbortError') notice(ui.status, errorMessage(error), true);
    } finally {
      if (downloadRequest === controller) {
        downloadRequest = null;
        setDownloadBusy(false);
      }
    }
  }

  ui.export.addEventListener('click', () => void downloadReport());
  ui.week.addEventListener('change', () => { if (!downloadRequest) setReports(); });
  ui.report.addEventListener('change', () => {
    if (downloadRequest) return;
    setDownloadBusy(false);
    notice(ui.status);
  });

  function hidePrivateData() {
    authGeneration++;
    auth = null;
    ui.appShell.hidden = true;
    listRequest?.abort();
    listRequest = null;
    downloadRequest?.abort();
    downloadRequest = null;
    ui.workspace.hidden = true;
    ui.week.replaceChildren();
    ui.report.replaceChildren();
    ui.export.disabled = true;
    ui.userEmail.textContent = '';
    notice(ui.status);
    weeks.clear();
  }

  ui.logoutBtn.addEventListener('click', async () => {
    hidePrivateData();
    try { await KBAuth.logout(); } finally { location.replace(LOGIN); }
  });
  window.addEventListener('pagehide', hidePrivateData);
  window.addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
  window.addEventListener('storage', event => {
    if (event.key === CONFIG?.SESSION_KEY && !event.newValue) {
      hidePrivateData();
      location.replace(LOGIN);
    }
  });

  async function initialize() {
    const generation = ++authGeneration;
    ui.loading.hidden = false;
    ui.loading.textContent = '正在验证登录状态…';
    if (![ORIGIN, ORIGIN + '/'].includes(CONFIG?.SUPABASE_URL) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(CONFIG?.SUPABASE_PUBLISHABLE_KEY || '') ||
        typeof window.KBAuth?.requireAuth !== 'function') {
      ui.loading.textContent = '站点登录配置不可用，请联系管理员。';
      return;
    }
    try {
      const current = await KBAuth.requireAuth(LOGIN);
      if (generation !== authGeneration) return;
      auth = current;
      if (!auth) return;
      if (!auth.session?.access_token || !auth.user?.id) {
        location.replace(LOGIN);
        return;
      }
      ui.userEmail.textContent = auth.user?.email || '—';
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      void loadWeeks();
    } catch {
      if (generation === authGeneration) ui.loading.textContent = '登录状态无法验证，请返回登录页重试。';
    }
  }

  void initialize();
})();
