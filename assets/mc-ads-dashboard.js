(() => {
  'use strict';
  const id = name => document.getElementById(name);
  const shell = id('appShell'), frame = id('adsFrame'), panel = id('statusPanel');
  const loading = id('loading'), status = id('status'), retry = id('retry');
  const config = window.KB_CONFIG;
  const project = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html?next=ads-dashboard';
  const release = {
    week: '2026-11-16', bytes: 1920570,
    sha256: '4f3caf182f2b0fa8ae5655d7c26eeb2a29de7e1d2b72f03596382941824c9253',
  };
  let request = null;
  let activeUser = null;

  function reset() {
    request?.abort();
    request = null;
    window.MCAdsFrame?.clear(frame);
    frame.hidden = true;
    shell.hidden = true;
    panel.hidden = false;
    retry.hidden = true;
    id('userEmail').textContent = '';
    activeUser = null;
  }

  async function readDashboard(value) {
    if (!value || value.week !== release.week || value.encoding !== 'gzip+base64' ||
        value.bytes !== release.bytes || value.sha256 !== release.sha256 ||
        typeof value.content !== 'string' || value.content.length > 4 * 1024 * 1024) {
      throw new Error('看板文件与当前页面版本不一致，请刷新页面后重试。');
    }
    if (!window.DecompressionStream || !window.crypto?.subtle) {
      throw new Error('请用新版 Chrome、Edge、Safari 或 Firefox 打开广告看板。');
    }
    const zipped = Uint8Array.from(atob(value.content), c => c.charCodeAt(0));
    const reader = new Blob([zipped]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const data = new Uint8Array(release.bytes);
    let offset = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (offset + part.value.length > data.length) {
          await reader.cancel();
          throw new Error('看板文件大小异常。');
        }
        data.set(part.value, offset);
        offset += part.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    if (offset !== release.bytes || Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') !== release.sha256) {
      throw new Error('看板文件校验失败，请重新加载。');
    }
    return new TextDecoder('utf-8', {fatal: true}).decode(data);
  }

  async function openDashboard() {
    reset();
    const current = new AbortController();
    request = current;
    loading.hidden = false;
    loading.textContent = '正在验证登录状态…';
    status.textContent = '正在读取广告看板…';
    try {
      if (config?.SUPABASE_URL?.replace(/\/$/, '') !== project || !window.KBAuth || !window.MCAdsFrame) {
        throw new Error('站点配置未就绪，请刷新页面。');
      }
      const auth = await KBAuth.requireAuth(login);
      if (request !== current || !auth) return;
      if (!auth.session?.access_token || !auth.user?.id) { location.replace(login); return; }
      activeUser = auth.user.id;
      id('userEmail').textContent = auth.user.email || '';
      loading.hidden = true;
      shell.hidden = false;
      const res = await fetch(project + '/rest/v1/rpc/mc_ads_dashboard_review_read', {
        method: 'POST', cache: 'no-store', redirect: 'error', signal: current.signal,
        headers: { 'Content-Type': 'application/json', apikey: config.SUPABASE_PUBLISHABLE_KEY,
          Authorization: 'Bearer ' + auth.session.access_token },
        body: '{}',
      });
      if (request !== current) return;
      if (res.status === 403) throw new Error('当前账号没有 MC 美国站广告看板的查看权限。');
      if (res.status === 401) throw new Error('登录已过期，请重新加载后登录。');
      if (res.status === 404) throw new Error('广告看板数据尚未发布。');
      if (!res.ok) throw new Error('广告看板暂时无法读取，请重试。');
      const html = await readDashboard(await res.json());
      if (request !== current) return;
      await MCAdsFrame.mount(frame, html, activeUser, release.week);
      if (request !== current) return;
      panel.hidden = true;
      frame.hidden = false;
    } catch (error) {
      if (request !== current || current.signal.aborted) return;
      const message = error instanceof TypeError ? '网络连接或文件读取失败，请重新加载。' : error.message;
      if (shell.hidden) {
        loading.textContent = message;
      } else {
        status.textContent = message;
        retry.hidden = false;
      }
    }
  }

  retry.addEventListener('click', openDashboard);
  id('logoutBtn').addEventListener('click', async () => {
    reset();
    try { await KBAuth.logout(); } finally { location.replace('../index.html'); }
  });
  window.addEventListener('pagehide', reset);
  window.addEventListener('pageshow', event => { if (event.persisted) void openDashboard(); });
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== config?.SESSION_KEY) return;
    const saved = window.KBAuth?.loadSession();
    if (!saved?.access_token) { reset(); location.replace(login); }
    else if (saved.user?.id !== activeUser) void openDashboard();
  });
  void openDashboard();
})();
