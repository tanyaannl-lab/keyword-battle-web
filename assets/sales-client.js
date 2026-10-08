(function () {
  const cfg = window.KB_CONFIG;
  if (!cfg) throw new Error('KB_CONFIG 未加载');

  async function getSnapshot(auth) {
    const token = auth?.session?.access_token;
    if (!token) throw new Error('登录状态已失效，请重新登录。');

    const base = cfg.SUPABASE_URL.replace(/\/$/, '');
    const url = new URL(`${base}/rest/v1/sales_dashboard_snapshots`);
    url.searchParams.set('select', 'payload,generated_at');
    url.searchParams.set('scope', 'eq.us_market');
    url.searchParams.set('limit', '1');

    const response = await fetch(url.toString(), {
      method: 'GET',
      cache: 'no-store',
      headers: {
        apikey: cfg.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch (_) {}
      const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('销量数据格式异常。');
    return rows[0] || null;
  }

  window.KBSales = { getSnapshot };
})();
