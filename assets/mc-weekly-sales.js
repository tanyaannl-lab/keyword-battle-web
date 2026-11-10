'use strict';

(() => {
  const ui = Object.fromEntries([
    'refresh', 'status', 'workspace', 'week', 'saved-at', 'metric-files', 'metric-traffic',
    'metric-orders', 'reports-status', 'reports', 'preview', 'report-title', 'report-meta',
    'export', 'search-form', 'search', 'clear-search', 'report-status', 'table-wrap',
    'table-head', 'table-body', 'pagination', 'page-info', 'previous', 'next',
    'export-status', 'appShell', 'loading', 'userEmail', 'logoutBtn',
  ].map(id => [id, document.getElementById(id)]));
  const state = { weeks: [], week: '', file: null, query: '', page: 1, pages: 1 };
  const PAGE_SIZE = 50;
  const ORIGIN = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const CONFIG = window.KB_CONFIG;
  const LOGIN = '../index.html';
  const ACCESS_TABLE = 'mc_weekly_access';
  const REPORTS_TABLE = 'mc_weekly_reports';
  const META = 'week_start,week_end,file_id,report_date,kind,display_name,row_count,published_at';
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
  const num = new Intl.NumberFormat('zh-CN');
  const dateTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
  });
  let weekRequest;
  let previewRequest;
  let auth;
  let pendingAuth;
  let reportData;
  let authGeneration = 0;

  function count(value, fallback = 0) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  }

  function text(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  }

  function label(file) {
    if (file.kind === 'order_summary') return '订单汇总';
    if (DAY.test(file.report_date || '')) return `${file.report_date} 销售流量`;
    return text(file.display_name) || '销售流量';
  }

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

  function exportLink(active) {
    const show = Boolean(active && state.file);
    ui.export.hidden = !show;
    ui.export.disabled = !show;
  }

  function csvCell(value) {
    const first = value.replace(/^[\s\p{Cc}\p{Cf}]*/u, '');
    const numeric = /^-\d+(?:,\d{3})*(?:\.\d+)?%?$/.test(value);
    const safe = /^[=+@-]/.test(first) && !numeric ? "'" + value : value;
    return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  }

  function downloadReport() {
    if (!auth || !state.file || !reportData || ui.export.hidden) return;
    const csv = '\uFEFF' + [reportData.columns, ...reportData.rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = state.file.kind === 'traffic' ? `MC[${state.file.report_date}].csv` : 'MC订单汇总.csv';
    link.hidden = true;
    document.body.append(link);
    try { link.click(); }
    finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    }
    notice(ui['export-status'], '已发起 CSV 下载。');
  }

  function clearPreview() {
    previewRequest?.abort();
    previewRequest = null;
    reportData = null;
    state.file = null;
    state.query = '';
    state.page = 1;
    state.pages = 1;
    ui.preview.hidden = true;
    ui['search-form'].hidden = true;
    ui['table-wrap'].hidden = true;
    ui.pagination.hidden = true;
    ui['table-head'].replaceChildren();
    ui['table-body'].replaceChildren();
    ui.search.value = '';
    ui['clear-search'].hidden = true;
    exportLink(false);
    notice(ui['report-status']);
    notice(ui['export-status']);
  }

  function updateMetrics(week) {
    const set = (id, value) => { ui[id].textContent = num.format(count(value)); };
    set('metric-files', week.files);
    set('metric-traffic', week.traffic_rows);
    set('metric-orders', week.order_rows);
    const saved = new Date(week.saved_at || '');
    ui['saved-at'].hidden = !Number.isFinite(saved.getTime());
    ui['saved-at'].textContent = ui['saved-at'].hidden ? '' : `最近更新：${dateTime.format(saved)}（北京时间）`;
  }

  function assembleWeeks(records) {
    const groups = new Map();
    for (const file of records) {
      if (!DAY.test(file?.week_start || '') || !DAY.test(file?.week_end || '') || file.week_start > file.week_end ||
          !Number.isSafeInteger(file.row_count) || file.row_count < 0 || file.row_count > 100000 ||
          !(file.kind === 'traffic' && DAY.test(file.report_date || '') && file.report_date >= file.week_start &&
            file.report_date <= file.week_end && file.file_id === `traffic-${file.report_date}` ||
            file.kind === 'order_summary' && file.report_date === null && file.file_id === 'order-summary')) {
        throw new Error('报表列表格式不正确，请刷新数据后重试。');
      }
      const group = groups.get(file.week_start) || { week_start: file.week_start, week_end: file.week_end,
        files: 0, traffic_rows: 0, order_rows: 0, saved_at: null, reports: [] };
      if (group.week_end !== file.week_end || group.reports.some(existing => existing.file_id === file.file_id)) {
        throw new Error('报表列表格式不正确，请刷新数据后重试。');
      }
      group.files++;
      group[file.kind === 'traffic' ? 'traffic_rows' : 'order_rows'] += file.row_count;
      if (typeof file.published_at === 'string' && Number.isFinite(Date.parse(file.published_at)) &&
          (!group.saved_at || Date.parse(file.published_at) > Date.parse(group.saved_at))) group.saved_at = file.published_at;
      group.reports.push(file);
      groups.set(file.week_start, group);
    }
    return [...groups.values()].sort((a, b) => b.week_start.localeCompare(a.week_start));
  }

  async function loadWeeks() {
    const prior = { week: state.week, file: state.file?.file_id, query: state.query };
    weekRequest?.abort();
    clearPreview();
    const controller = new AbortController();
    weekRequest = controller;
    ui.refresh.disabled = true;
    ui.workspace.hidden = true;
    notice(ui.status, '正在读取已发布的周报…');
    try {
      const allowed = await get(ACCESS_TABLE, { select: 'user_id', limit: 1 }, controller.signal);
      if (weekRequest !== controller || !auth) return;
      if (allowed.length !== 1 || String(allowed[0]?.user_id || '').toLowerCase() !== String(auth.user?.id || '').toLowerCase()) {
        throw new Error('当前账号没有查看 MC 周报的权限。');
      }
      const records = [];
      const size = 80;
      for (let offset = 0; ; offset += size) {
        if (offset > 5120) throw new Error('报表列表过长，请联系管理员。');
        const batch = await get(REPORTS_TABLE, {
          select: META, order: 'week_start.desc,file_id.asc', limit: size, offset,
        }, controller.signal);
        if (weekRequest !== controller) return;
        records.push(...batch);
        if (batch.length < size) break;
      }
      if (weekRequest !== controller) return;
      ui.refresh.textContent = '刷新数据';
      state.weeks = assembleWeeks(records);
      if (!state.weeks.length) {
        state.week = '';
        notice(ui.status, '尚无已发布的周报。报表发布后，可在此刷新查看。');
        return;
      }
      const current = state.weeks.find(week => week.week_start === prior.week) || state.weeks[0];
      const options = state.weeks.map(week => {
        const option = document.createElement('option');
        option.value = week.week_start;
        option.textContent = `${week.week_start} 至 ${week.week_end}`;
        return option;
      });
      ui.week.replaceChildren(...options);
      ui.week.value = current.week_start;
      ui.workspace.hidden = false;
      notice(ui.status);
      loadFiles(current.week_start, current.week_start === prior.week ? prior : null);
    } catch (error) {
      if (weekRequest === controller && error.name !== 'AbortError') notice(ui.status, errorMessage(error), true);
    } finally {
      if (weekRequest === controller) {
        weekRequest = null;
        ui.refresh.disabled = false;
      }
    }
  }

  function loadFiles(weekStart, prior = null) {
    const week = state.weeks.find(item => item.week_start === weekStart);
    if (!week) return;
    state.week = weekStart;
    clearPreview();
    updateMetrics(week);
    ui.reports.replaceChildren();
    const files = [...week.reports]
      .sort((a, b) => (a.kind === 'order_summary') - (b.kind === 'order_summary') || text(a.report_date).localeCompare(text(b.report_date)));
    if (!files.length) {
      notice(ui['reports-status'], '该周没有可查看的报表。');
      return;
    }
    for (const file of files) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      const strong = document.createElement('strong');
      const small = document.createElement('small');
      button.type = 'button';
      button.className = 'report-button';
      button.dataset.file = file.file_id;
      button.setAttribute('aria-pressed', 'false');
      strong.textContent = label(file);
      small.textContent = `${num.format(count(file.row_count))} 行`;
      button.append(strong, small);
      button.addEventListener('click', () => { void selectFile(file); });
      li.append(button);
      ui.reports.append(li);
    }
    notice(ui['reports-status']);
    const chosen = files.find(file => file.file_id === prior?.file) || files[0];
    void selectFile(chosen, chosen.file_id === prior?.file ? prior.query : '');
  }

  async function selectFile(file, query = '') {
    clearPreview();
    state.file = file;
    state.query = query;
    state.page = 1;
    state.pages = 1;
    for (const button of ui.reports.querySelectorAll('button[data-file]')) {
      button.setAttribute('aria-pressed', String(button.dataset.file === file.file_id));
    }
    ui.preview.hidden = false;
    ui['report-title'].textContent = label(file);
    ui['report-meta'].textContent = `${file.kind === 'order_summary' ? '仅展示汇总结果' : text(file.display_name) || '销售流量'} · ${num.format(count(file.row_count))} 行`;
    ui.search.value = query;
    notice(ui['report-status'], '正在读取报表数据…');
    const controller = new AbortController();
    previewRequest = controller;
    try {
      const found = await get(REPORTS_TABLE, {
        select: 'week_start,file_id,kind,columns,rows,row_count',
        week_start: `eq.${file.week_start}`, file_id: `eq.${file.file_id}`, limit: 1,
      }, controller.signal);
      if (previewRequest !== controller) return;
      const data = found[0];
      if (!data) throw new Error('这份报表暂不可用，请刷新或确认账号权限。');
      const columns = file.kind === 'traffic' ? TRAFFIC_COLUMNS : ORDER_COLUMNS;
      if (found.length !== 1 || data.week_start !== file.week_start || data.file_id !== file.file_id || data.kind !== file.kind ||
          !Array.isArray(data.columns) || data.columns.length !== columns.length || columns.some((name, i) => name !== data.columns[i]) ||
          !Array.isArray(data.rows) || data.rows.length !== data.row_count || data.rows.length > 100000 ||
          !data.rows.every(row => Array.isArray(row) && row.length === columns.length && row.every(cell => typeof cell === 'string'))) {
        throw new Error('报表数据格式不正确，请刷新数据后重试。');
      }
      reportData = data;
      ui['search-form'].hidden = false;
      ui['clear-search'].hidden = !query;
      loadPage(1);
    } catch (error) {
      if (previewRequest === controller && error.name !== 'AbortError') notice(ui['report-status'], errorMessage(error), true);
    } finally {
      if (previewRequest === controller) previewRequest = null;
    }
  }

  function drawTable(columns, rows) {
    const head = document.createElement('tr');
    for (const heading of columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text(heading);
      head.append(th);
    }
    ui['table-head'].replaceChildren(head);
    const body = document.createDocumentFragment();
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const column of row) {
        const td = document.createElement('td');
        const cell = text(column);
        td.textContent = cell;
        if (typeof column === 'number' || /^(?:[$￥¥])?-?\d+(?:[.,]\d+)*%?$/.test(cell)) td.className = 'numeric';
        tr.append(td);
      }
      body.append(tr);
    }
    ui['table-body'].replaceChildren(body);
    ui['table-wrap'].scrollTop = 0;
    ui['table-wrap'].hidden = false;
  }

  function loadPage(page) {
    if (!auth || !reportData || !state.file) return;
    const term = state.query.toLowerCase();
    const all = term ? reportData.rows.filter(row => row.some(cell => cell.toLowerCase().includes(term))) : reportData.rows;
    const total = all.length;
    state.pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    state.page = Math.max(1, Math.min(page, state.pages));
    const start = (state.page - 1) * PAGE_SIZE;
    const rows = all.slice(start, start + PAGE_SIZE);
    ui['table-wrap'].hidden = true;
    exportLink(true);
    if (rows.length) {
      drawTable(reportData.columns, rows);
      notice(ui['report-status']);
    } else {
      ui['table-head'].replaceChildren();
      ui['table-body'].replaceChildren();
      notice(ui['report-status'], state.query ? '没有符合条件的数据。可以更换关键词或清除搜索。' : '该报表没有数据行。');
    }
    ui['page-info'].textContent = `第 ${num.format(state.page)} / ${num.format(state.pages)} 页 · ${state.query ? '筛选结果' : '共'} ${num.format(total)} 行`;
    ui.previous.disabled = state.page <= 1;
    ui.next.disabled = state.page >= state.pages;
    ui.pagination.hidden = !rows.length;
  }

  ui.refresh.addEventListener('click', () => void loadWeeks());
  ui.export.addEventListener('click', downloadReport);
  ui.week.addEventListener('change', () => loadFiles(ui.week.value));
  ui['search-form'].addEventListener('submit', event => {
    event.preventDefault();
    state.query = ui.search.value.trim();
    ui['clear-search'].hidden = !state.query;
    void loadPage(1);
  });
  ui['clear-search'].addEventListener('click', () => {
    state.query = '';
    ui.search.value = '';
    ui['clear-search'].hidden = true;
    ui.search.focus();
    void loadPage(1);
  });
  ui.previous.addEventListener('click', () => { if (state.page > 1) void loadPage(state.page - 1); });
  ui.next.addEventListener('click', () => { if (state.page < state.pages) void loadPage(state.page + 1); });
  function hidePrivateData() {
    authGeneration++;
    auth = null;
    ui.appShell.hidden = true;
    weekRequest?.abort();
    weekRequest = null;
    clearPreview();
    ui.workspace.hidden = true;
    ui.reports.replaceChildren();
    ui.week.replaceChildren();
    state.weeks = [];
    state.week = '';
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
