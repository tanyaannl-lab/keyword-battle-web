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
  const LOCAL = 'http://127.0.0.1:8789';
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const num = new Intl.NumberFormat('zh-CN');
  const dateTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
  });
  let weekRequest;
  let listRequest;
  let previewRequest;

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

  function url(route, fields = {}) {
    const query = new URLSearchParams(fields).toString();
    return LOCAL + (query ? `${route}?${query}` : route);
  }

  function request(route, fields, signal, accept) {
    return fetch(url(route, fields), {
      method: 'GET', headers: { Accept: accept }, cache: 'no-store', credentials: 'omit',
      mode: 'cors', targetAddressSpace: 'loopback', referrerPolicy: 'no-referrer',
      redirect: 'error', signal,
    });
  }

  async function get(route, fields, signal) {
    const response = await request(route, fields, signal, 'application/json');
    if (!response.ok) {
      if (response.status === 403) throw new Error('连接被拒绝，请确认周报服务已更新，并从销量观察打开。');
      if (response.status === 404) throw new Error('未找到报表，请刷新数据后重试。');
      throw new Error('暂时无法读取报表，请稍后重试。');
    }
    try { return await response.json(); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('报表返回格式不正确，请刷新数据后重试。');
    }
  }

  function errorMessage(error) {
    return error instanceof TypeError ? '无法连接 MC 周报。请确认 SSH 隧道仍在运行；如果浏览器拦截了本机访问，可在此站点的权限设置中允许，再重试。' : error.message;
  }

  function exportLink(active) {
    const show = Boolean(active && state.file);
    ui.export.hidden = !show;
    ui.export.disabled = !show || downloading;
  }

  function exportName(response, file) {
    const header = response.headers.get('Content-Disposition') || '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
    let name = text(file.display_name) || `MC-${file.file_id}.csv`;
    if (encoded) {
      try { name = decodeURIComponent(encoded); } catch (_) {}
    }
    name = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 160).replace(/\.csv$/i, '');
    return name + '.csv';
  }

  let downloading = false;
  async function downloadReport() {
    const file = state.file;
    const week = state.week;
    if (!file || downloading || ui.export.hidden) return;
    downloading = true;
    ui.export.disabled = true;
    notice(ui['export-status'], '正在生成 CSV…');
    try {
      const response = await request('/api/export', { week, file: file.file_id }, undefined, 'text/csv');
      if (!response.ok) throw new Error(response.status === 413 ? '此报表超过下载限制，可继续分页查看。' : '下载失败，请刷新报表后重试。');
      if (!/^text\/csv\b/i.test(response.headers.get('Content-Type') || '')) throw new Error('CSV 格式不正确。');
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = href;
      link.download = exportName(response, file);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
      if (state.file === file && state.week === week) notice(ui['export-status']);
    } catch (error) {
      if (state.file === file && state.week === week) notice(ui['export-status'], errorMessage(error), true);
    } finally {
      downloading = false;
      if (!ui.export.hidden) ui.export.disabled = false;
    }
  }

  function clearPreview() {
    previewRequest?.abort();
    previewRequest = null;
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
    ui['saved-at'].textContent = ui['saved-at'].hidden ? '' : `最近入库：${dateTime.format(saved)}（北京时间）`;
  }

  async function loadWeeks() {
    const prior = { week: state.week, file: state.file?.file_id, query: state.query };
    weekRequest?.abort();
    listRequest?.abort();
    listRequest = null;
    clearPreview();
    const controller = new AbortController();
    weekRequest = controller;
    ui.refresh.disabled = true;
    ui.workspace.hidden = true;
    notice(ui.status, '正在读取已入库的周报…');
    try {
      const data = await get('/api/weeks', {}, controller.signal);
      if (weekRequest !== controller) return;
      if (!Array.isArray(data?.weeks)) throw new Error('周报列表格式不正确，请刷新数据后重试。');
      ui.refresh.textContent = '刷新数据';
      state.weeks = data.weeks.filter(week => DAY.test(week?.week_start || '') && DAY.test(week?.week_end || ''))
        .sort((a, b) => b.week_start.localeCompare(a.week_start));
      if (!state.weeks.length) {
        state.week = '';
        notice(ui.status, '尚无已入库的周报。采集任务完成后，可在此刷新查看。');
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
      void loadFiles(current.week_start, current.week_start === prior.week ? prior : null);
    } catch (error) {
      if (weekRequest === controller && error.name !== 'AbortError') notice(ui.status, errorMessage(error), true);
    } finally {
      if (weekRequest === controller) {
        weekRequest = null;
        ui.refresh.disabled = false;
      }
    }
  }

  async function loadFiles(weekStart, prior = null) {
    const week = state.weeks.find(item => item.week_start === weekStart);
    if (!week) return;
    state.week = weekStart;
    listRequest?.abort();
    clearPreview();
    updateMetrics(week);
    ui.reports.replaceChildren();
    notice(ui['reports-status'], '正在读取报表列表…');
    const controller = new AbortController();
    listRequest = controller;
    try {
      const data = await get('/api/reports', { week: weekStart }, controller.signal);
      if (listRequest !== controller) return;
      if (!Array.isArray(data?.reports)) throw new Error('报表列表格式不正确，请刷新数据后重试。');
      const files = data.reports.filter(file => typeof file?.file_id === 'string' && ['traffic', 'order_summary'].includes(file.kind))
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
        button.addEventListener('click', () => selectFile(file));
        li.append(button);
        ui.reports.append(li);
      }
      notice(ui['reports-status']);
      const chosen = files.find(file => file.file_id === prior?.file) || files[0];
      selectFile(chosen, chosen.file_id === prior?.file ? prior.query : '');
    } catch (error) {
      if (listRequest === controller && error.name !== 'AbortError') notice(ui['reports-status'], errorMessage(error), true);
    } finally {
      if (listRequest === controller) listRequest = null;
    }
  }

  function selectFile(file, query = '') {
    previewRequest?.abort();
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
    ui['search-form'].hidden = false;
    ui['clear-search'].hidden = !query;
    exportLink(false);
    notice(ui['export-status']);
    void loadPage(1);
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

  async function loadPage(page) {
    const file = state.file;
    if (!file) return;
    previewRequest?.abort();
    const controller = new AbortController();
    previewRequest = controller;
    const fields = { week: state.week, file: file.file_id, page, limit: PAGE_SIZE };
    if (state.query) fields.q = state.query;
    ui['table-wrap'].hidden = true;
    ui.pagination.hidden = true;
    notice(ui['report-status'], '正在读取报表数据…');
    try {
      const data = await get('/api/report', fields, controller.signal);
      if (previewRequest !== controller) return;
      if (!Array.isArray(data?.columns) || !data.columns.length || !Array.isArray(data?.rows) ||
          !data.rows.every(row => Array.isArray(row) && row.length === data.columns.length)) {
        throw new Error('报表数据格式不正确，请刷新数据后重试。');
      }
      const total = count(data.total, data.rows.length);
      const limit = count(data.limit, PAGE_SIZE) || PAGE_SIZE;
      const pages = Math.max(1, Math.ceil(total / limit));
      const currentPage = count(data.page, page) || page;
      if (!data.rows.length && total && currentPage > pages && page !== pages) {
        void loadPage(pages);
        return;
      }
      state.page = Math.min(currentPage, pages);
      state.pages = pages;
      exportLink(true);
      if (data.rows.length) {
        drawTable(data.columns, data.rows);
        notice(ui['report-status']);
      } else {
        ui['table-head'].replaceChildren();
        ui['table-body'].replaceChildren();
        notice(ui['report-status'], state.query ? '没有符合条件的数据。可以更换关键词或清除搜索。' : '该报表没有数据行。');
      }
      ui['page-info'].textContent = `第 ${num.format(state.page)} / ${num.format(pages)} 页 · ${state.query ? '筛选结果' : '共'} ${num.format(total)} 行`;
      ui.previous.disabled = state.page <= 1;
      ui.next.disabled = state.page >= pages;
      ui.pagination.hidden = !data.rows.length;
    } catch (error) {
      if (previewRequest === controller && error.name !== 'AbortError') notice(ui['report-status'], errorMessage(error), true);
    } finally {
      if (previewRequest === controller) previewRequest = null;
    }
  }

  ui.refresh.addEventListener('click', () => void loadWeeks());
  ui.export.addEventListener('click', () => void downloadReport());
  ui.week.addEventListener('change', () => void loadFiles(ui.week.value));
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
  ui.logoutBtn.addEventListener('click', async () => {
    try { await KBAuth.logout(); } finally { location.replace('../index.html'); }
  });
  (async () => {
    try {
      const auth = await KBAuth.requireAuth('../index.html');
      if (!auth) return;
      ui.userEmail.textContent = auth.user?.email || '—';
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      ui.refresh.disabled = false;
    } catch {
      ui.loading.textContent = '登录状态无法验证，请返回登录页重试。';
    }
  })();
})();
