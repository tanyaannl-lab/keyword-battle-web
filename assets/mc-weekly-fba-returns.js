'use strict';

(() => {
  const ids = ['appShell', 'loading', 'userEmail', 'logoutBtn', 'returnsForm', 'returnDate',
    'queryReturns', 'exportReturns', 'returnsStatus'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const config = window.KB_CONFIG;
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const earliest = '2000-01-01';
  const dayMs = 86_400_000;
  const calendar = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  let auth;
  let generation = 0;
  let request;
  let selection;
  let refreshSession;
  const objectUrls = new Set();

  function yesterdayPacific() {
    const parts = Object.fromEntries(calendar.formatToParts().map(({ type, value }) => [type, value]));
    const utcMidnight = Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
    return new Date(utcMidnight - dayMs).toISOString().slice(0, 10);
  }

  function validDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < earliest || day > yesterdayPacific()) return false;
    const parsed = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === day;
  }

  function notice(message = '', error = false) {
    ui.returnsStatus.textContent = message;
    ui.returnsStatus.hidden = !message;
    if (error) ui.returnsStatus.dataset.state = 'error';
    else delete ui.returnsStatus.dataset.state;
  }

  function updateButtons() {
    ui.queryReturns.disabled = !auth || !!request;
    ui.exportReturns.disabled = !auth || !!request || selection?.day !== ui.returnDate.value;
  }

  function clearPrivate() {
    generation++;
    auth = null;
    request?.abort();
    request = null;
    selection = null;
    ui.appShell.hidden = true;
    ui.returnsForm.hidden = true;
    ui.userEmail.textContent = '';
    notice();
    updateButtons();
    for (const href of objectUrls) URL.revokeObjectURL(href);
    objectUrls.clear();
  }

  async function readSource(day, signal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
    const send = token => fetch(`${origin}/rest/v1/rpc/mc_daily_fba_returns_source`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        apikey: config.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ p_report_date: day }), cache: 'no-store', credentials: 'omit', mode: 'cors',
      redirect: 'error', referrerPolicy: 'no-referrer', signal: combined,
    });
    const id = auth.user.id;
    const token = auth.session.access_token;
    let response = await send(token);
    if (response.status === 401 && auth?.user.id === id && !combined.aborted) {
      if (!refreshSession) refreshSession = window.KBAuth.getValidSession().finally(() => { refreshSession = null; });
      const fresh = await refreshSession;
      if (!combined.aborted && auth?.user.id === id && fresh?.user?.id === id && fresh?.session?.access_token &&
          fresh.session.access_token !== token) {
        auth = fresh;
        response = await send(fresh.session.access_token);
      }
    }
    if (!response.ok) {
      if (response.status === 401 && auth?.user.id === id && !combined.aborted) {
        clearPrivate();
        location.replace(login);
      }
      if (response.status === 403) throw new Error('当前账号没有查看 MC 退货表的权限。');
      if (response.status === 404) throw new Error('退货表服务尚未启用，请联系管理员。');
      if (response.status === 429) throw new Error('查询过于频繁，请稍后重试。');
      throw new Error('暂时无法读取退货表，请稍后重试。');
    }
    const value = await response.json();
    if (value?.report_date !== day || !(value.rows === null || Array.isArray(value.rows))) {
      throw new Error('退货表返回格式有误，请联系管理员。');
    }
    if (value.rows === null) return null;
    const seen = new Set();
    return value.rows.map(row => {
      if (row?.report_date !== day || typeof row.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(row.asin) ||
          !Number.isSafeInteger(row.return_units) || row.return_units <= 0 || seen.has(row.asin)) {
        throw new Error('退货表包含无效记录，请联系管理员。');
      }
      seen.add(row.asin);
      return { asin: row.asin, return_units: row.return_units };
    });
  }

  async function query() {
    if (!auth) return;
    const day = ui.returnDate.value;
    request?.abort();
    request = null;
    selection = null;
    if (!validDay(day)) {
      updateButtons();
      notice('请选择美国太平洋时间已经结束的日期。', true);
      return;
    }
    const controller = new AbortController();
    request = controller;
    updateButtons();
    notice('正在读取退货表…');
    try {
      const rows = await readSource(day, controller.signal);
      if (request !== controller || !auth) return;
      if (rows === null) notice(`${day} 的退货报表尚未发布。`);
      else {
        selection = { day, rows };
        notice(rows.length ? `${day} 已发布，共 ${rows.length} 个子 ASIN。` : `${day} 已发布，FBA 退货为 0 件。`);
      }
    } catch (error) {
      if (request !== controller || error.name === 'AbortError') return;
      notice(error.name === 'TimeoutError' ? '查询超时，请重试。'
        : error instanceof TypeError || error instanceof SyntaxError ? '暂时无法读取退货表，请重试。' : error.message, true);
    } finally {
      if (request === controller) {
        request = null;
        updateButtons();
      }
    }
  }

  function download() {
    if (!auth || request || !selection || selection.day !== ui.returnDate.value) return;
    const { day, rows } = selection;
    const csv = 'report_date,asin,return_units\r\n' + rows.map(row => `${day},${row.asin},${row.return_units}\r\n`).join('');
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    objectUrls.add(href);
    const link = document.createElement('a');
    link.href = href;
    link.download = `MC-FBA-returns-${day}.csv`;
    link.hidden = true;
    document.body.append(link);
    try { link.click(); }
    finally {
      link.remove();
      setTimeout(() => { if (objectUrls.delete(href)) URL.revokeObjectURL(href); }, 30_000);
    }
  }

  async function initialize() {
    const current = ++generation;
    ui.loading.hidden = false;
    ui.loading.textContent = '正在验证登录状态…';
    if (![origin, origin + '/'].includes(config?.SUPABASE_URL) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.SUPABASE_PUBLISHABLE_KEY || '') ||
        typeof window.KBAuth?.requireAuth !== 'function') {
      ui.loading.textContent = '站点登录配置不可用，请联系管理员。';
      return;
    }
    try {
      const verified = await window.KBAuth.requireAuth(login);
      if (current !== generation || !verified) return;
      if (!verified.session?.access_token || !verified.user?.id) { location.replace(login); return; }
      auth = verified;
      ui.userEmail.textContent = verified.user.email || '—';
      ui.returnDate.max = yesterdayPacific();
      ui.returnDate.value = new Date(Date.parse(`${ui.returnDate.max}T00:00:00Z`) - dayMs).toISOString().slice(0, 10);
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      ui.returnsForm.hidden = false;
      void query();
    } catch {
      if (current === generation) ui.loading.textContent = '登录状态无法验证，请返回登录页重试。';
    }
  }

  ui.returnsForm.addEventListener('submit', event => { event.preventDefault(); void query(); });
  ui.returnDate.addEventListener('input', () => {
    request?.abort();
    request = null;
    selection = null;
    notice();
    updateButtons();
  });
  ui.exportReturns.addEventListener('click', download);
  ui.logoutBtn.addEventListener('click', async () => {
    clearPrivate();
    try { await window.KBAuth.logout(); } finally { location.replace(login); }
  });
  window.addEventListener('pagehide', clearPrivate);
  window.addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
  window.addEventListener('storage', event => {
    if (event.key === config?.SESSION_KEY && !event.newValue) {
      clearPrivate();
      location.replace(login);
    }
  });
  void initialize();
})();
