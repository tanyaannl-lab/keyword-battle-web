'use strict';

(() => {
  const ui = Object.fromEntries(['status', 'workspace', 'report', 'reportDescription', 'week', 'export', 'appShell', 'loading', 'userEmail', 'logoutBtn']
    .map(id => [id, document.getElementById(id)]));
  const ORIGIN = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const CONFIG = window.KB_CONFIG;
  const LOGIN = '../index.html';
  const ACCESS_TABLE = 'mc_weekly_access';
  const FILES_TABLE = 'mc_ads_weekly_files';
  const EXTRA_TABLE = 'mc_ads_extra_weekly_files';
  const META = 'week_start,week_end,filename,byte_count,sha256,published_at,row_count';
  const MAX_BYTES = 16 * 1024 * 1024;
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const CSV_MIME = 'text/csv;charset=utf-8';
  const REPORTS = Object.freeze({
    sp_advertised: '商品推广 · 推广的商品报告，包含 22 列，按日统计，转化指标采用 7 天归因。',
    sp_placement: '商品推广 · 广告位报告（API 版）。未返回的字段和无法计算的比率留空。',
    sp_search_terms: '商品推广 · 搜索词日报（API 版）。包含曝光、点击、花费和 7 天归因指标，不含展示量份额和排名。',
    sp_sis: '商品推广 · 搜索词展示量份额（后台报表）。周次内有数据的日期以报表为准。',
    sb_campaign: '品牌推广 · 广告活动报告（API 版）。未返回的字段和无法计算的比率留空。',
    sd_campaign: '展示型推广 · 广告活动报告（API 版）。若该周无记录，导出文件仅含表头。',
  });
  let auth;
  let pendingAuth;
  let authGeneration = 0;
  let listRequest;
  let downloadRequest;
  let report = 'sp_advertised';
  let files = new Map();
  const objectUrls = new Set();

  function queryFor(key) {
    return key === 'sp_advertised'
      ? { table: FILES_TABLE, filter: {}, select: META, ext: 'xlsx', mime: XLSX_MIME }
      : { table: EXTRA_TABLE, filter: { report_key: `eq.${key}` }, select: `report_key,${META}`, ext: 'csv', mime: CSV_MIME };
  }

  function notice(message = '', bad = false) {
    ui.status.textContent = message;
    ui.status.hidden = !message;
    if (bad) ui.status.dataset.state = 'error';
    else delete ui.status.dataset.state;
  }

  function setBusy(busy) {
    ui.week.disabled = busy || !files.size;
    ui.export.disabled = busy || !files.has(ui.week.value);
    ui.export.textContent = busy ? '正在下载…' : report === 'sp_advertised' ? '导出 Excel' : '导出 CSV';
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
    if (![ACCESS_TABLE, FILES_TABLE, EXTRA_TABLE].includes(table)) throw new Error('无效的广告报告请求。');
    const endpoint = new URL(`/rest/v1/${table}`, ORIGIN);
    for (const [key, value] of Object.entries(fields)) endpoint.searchParams.set(key, String(value));
    const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const send = token => {
      combined.throwIfAborted();
      return fetch(endpoint, {
        method: 'GET', headers: { Accept: 'application/json', apikey: CONFIG.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
        cache: 'no-store', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', redirect: 'error', signal: combined,
      });
    };
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
      if (response.status === 403) throw new Error('当前账号没有下载 MC 广告报告的权限。');
      if (response.status === 404) throw new Error('广告报告下载服务尚未准备完成，请联系管理员完成首次发布。');
      if (response.status === 429) throw new Error('操作过于频繁，请稍后重试。');
      throw new Error('广告报告暂时无法读取，请稍后重试。');
    }
    let rows;
    try { rows = await response.json(); }
    catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
      throw new Error('广告报告返回格式不正确，请刷新页面后重试。');
    }
    if (!Array.isArray(rows)) throw new Error('广告报告返回格式不正确，请刷新页面后重试。');
    return rows;
  }

  function errorMessage(error) {
    if (error.name === 'TimeoutError') return '读取广告报告超时，请稍后重试。';
    if (error instanceof TypeError) return '暂时无法连接广告报告服务，请稍后重试。';
    return error.message;
  }

  function calendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const day = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+day) && day.toISOString().slice(0, 10) === value ? day : null;
  }

  function validMetadata(file, key) {
    const start = calendarDate(file?.week_start);
    const end = calendarDate(file?.week_end);
    const original = key === 'sp_advertised';
    const prefix = original ? 'MC-ads-' : `MC-ads-${key}-`;
    const extension = original ? 'xlsx' : 'csv';
    return start && end && start.getUTCDay() === 1 && +end - +start === 6 * 86400000 &&
      (original || file.report_key === key) &&
      file.filename === `${prefix}${file.week_start}-to-${file.week_end}.${extension}` &&
      Number.isSafeInteger(file.byte_count) && file.byte_count >= (original ? 100 : 1) && file.byte_count <= MAX_BYTES &&
      Number.isSafeInteger(file.row_count) && file.row_count >= (key === 'sp_sis' ? 1 : 0) && file.row_count <= 500000 &&
      typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256) &&
      typeof file.published_at === 'string' && Number.isFinite(Date.parse(file.published_at));
  }

  function validBase64(encoded, byteCount) {
    if (typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(byteCount / 3)) return false;
    const padding = (3 - byteCount % 3) % 3;
    const end = encoded.length - padding;
    if (encoded.slice(end) !== '='.repeat(padding)) return false;
    for (let i = 0; i < end; i++) {
      const c = encoded.charCodeAt(i);
      if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 47)) return false;
    }
    return true;
  }

  async function loadWeeks() {
    listRequest?.abort();
    downloadRequest?.abort();
    downloadRequest = null;
    const controller = new AbortController();
    const key = report;
    const query = queryFor(key);
    listRequest = controller;
    files.clear();
    ui.week.replaceChildren();
    ui.reportDescription.textContent = REPORTS[key];
    setBusy(false);
    notice('正在读取已发布的广告报告…');
    try {
      const allowed = await get(ACCESS_TABLE, { select: 'user_id', limit: 1 }, controller.signal);
      if (listRequest !== controller || !auth) return;
      if (allowed.length !== 1 || String(allowed[0]?.user_id || '').toLowerCase() !== auth.user.id.toLowerCase()) {
        ui.workspace.hidden = true;
        ui.report.disabled = true;
        throw new Error('当前账号没有下载 MC 广告报告的权限。');
      }
      ui.workspace.hidden = false;
      ui.report.disabled = false;
      const records = new Map();
      const size = 80;
      for (let offset = 0; ; offset += size) {
        if (offset > 5120) throw new Error('广告报告列表过长，请联系管理员。');
        const batch = await get(query.table, { select: query.select, ...query.filter, order: 'week_start.desc', limit: size, offset }, controller.signal);
        if (listRequest !== controller || !auth) return;
        for (const file of batch) {
          if (!validMetadata(file, key) || records.has(file.week_start)) throw new Error('广告报告列表格式不正确，请刷新页面后重试。');
          records.set(file.week_start, file);
        }
        if (batch.length < size) break;
      }
      files = new Map([...records].sort(([a], [b]) => b.localeCompare(a)));
      if (!files.size) {
        notice(key === 'sp_sis'
          ? '暂无已发布的展示量份额报告。要查看曝光、点击、花费和归因指标，请选择「商品推广 · 搜索词日报」。'
          : '暂无已发布的广告报告。服务器发布完成后，刷新页面即可下载。');
        return;
      }
      ui.week.replaceChildren(...[...files].map(([start, file]) => {
        const option = document.createElement('option');
        option.value = start;
        option.textContent = `${start} 至 ${file.week_end}${file.row_count === 0 ? '（无记录）' : ''}`;
        return option;
      }));
      ui.week.value = files.keys().next().value;
      setBusy(false);
      notice();
    } catch (error) {
      if (listRequest === controller && error.name !== 'AbortError') notice(errorMessage(error), true);
    } finally {
      if (listRequest === controller) listRequest = null;
    }
  }

  async function download() {
    if (!auth || downloadRequest || ui.workspace.hidden) return;
    const selected = files.get(ui.week.value);
    if (!selected) return;
    const key = report;
    const query = queryFor(key);
    const controller = new AbortController();
    downloadRequest = controller;
    setBusy(true);
    notice('正在下载广告报告…');
    try {
      const found = await get(query.table, {
        select: query.select + ',content_base64', ...query.filter, week_start: `eq.${selected.week_start}`, limit: 1,
      }, controller.signal);
      if (downloadRequest !== controller || !auth) return;
      const data = found[0];
      if (!data) throw new Error('该周广告报告暂不可用，请刷新页面后重试。');
      if (found.length !== 1 || !validMetadata(data, key) || data.week_start !== selected.week_start || data.week_end !== selected.week_end) {
        throw new Error('广告报告文件信息不正确，未下载。');
      }
      const encoded = data.content_base64;
      if (!validBase64(encoded, data.byte_count)) {
        throw new Error('广告报告文件不完整，请刷新页面后重试。');
      }
      const binary = atob(encoded);
      if (binary.length !== data.byte_count) throw new Error('广告报告文件长度不正确，未下载。');
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      if (query.ext === 'xlsx' && (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4)) {
        throw new Error('广告报告不是有效的 XLSX 文件，未下载。');
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const sha256 = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (sha256 !== data.sha256) throw new Error('广告报告文件校验未通过，请刷新页面后重试。');
      if (downloadRequest !== controller || !auth) return;
      const href = URL.createObjectURL(new Blob([bytes], { type: query.mime }));
      objectUrls.add(href);
      const link = document.createElement('a');
      link.href = href;
      link.download = data.filename;
      link.hidden = true;
      document.body.append(link);
      try { link.click(); }
      finally {
        link.remove();
        setTimeout(() => { URL.revokeObjectURL(href); objectUrls.delete(href); }, 30_000);
      }
      notice(`已发起 ${query.ext.toUpperCase()} 下载。`);
    } catch (error) {
      if (downloadRequest === controller && error.name !== 'AbortError') notice(errorMessage(error), true);
    } finally {
      if (downloadRequest === controller) {
        downloadRequest = null;
        setBusy(false);
      }
    }
  }

  function hidePrivateData() {
    authGeneration++;
    auth = null;
    ui.appShell.hidden = true;
    listRequest?.abort();
    listRequest = null;
    downloadRequest?.abort();
    downloadRequest = null;
    ui.workspace.hidden = true;
    ui.report.disabled = true;
    ui.week.replaceChildren();
    files.clear();
    setBusy(false);
    ui.userEmail.textContent = '';
    notice();
    for (const href of objectUrls) URL.revokeObjectURL(href);
    objectUrls.clear();
  }

  ui.export.addEventListener('click', () => void download());
  ui.report.addEventListener('change', () => {
    if (!auth || !Object.hasOwn(REPORTS, ui.report.value)) return;
    report = ui.report.value;
    void loadWeeks();
  });
  ui.week.addEventListener('change', () => {
    if (!downloadRequest) { setBusy(false); notice(); }
  });
  ui.logoutBtn.addEventListener('click', async () => {
    hidePrivateData();
    try { await KBAuth.logout(); } finally { location.replace(LOGIN); }
  });
  window.addEventListener('pagehide', hidePrivateData);
  window.addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
  window.addEventListener('storage', event => {
    if (event.key === CONFIG?.SESSION_KEY && !event.newValue) { hidePrivateData(); location.replace(LOGIN); }
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
      if (!auth.session?.access_token || !auth.user?.id) { location.replace(LOGIN); return; }
      ui.userEmail.textContent = auth.user?.email || '—';
      ui.report.value = report;
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      void loadWeeks();
    } catch {
      if (generation === authGeneration) ui.loading.textContent = '登录状态无法验证，请返回登录页重试。';
    }
  }
  void initialize();
})();
