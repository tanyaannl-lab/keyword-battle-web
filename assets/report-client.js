(function () {
  const cfg = window.KB_CONFIG;
  if (!cfg) throw new Error('KB_CONFIG 未加载');

  const base = cfg.SUPABASE_URL.replace(/\/$/, '');

  function authHeaders(accessToken) {
    return {
      'apikey': cfg.SUPABASE_PUBLISHABLE_KEY,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  async function readJson(res) {
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (res.ok) return body;
    const msg = body?.error || body?.message || body?.msg || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = body;
    throw err;
  }

  function humanizeError(error) {
    const raw = String(error?.message || error || '未知错误');
    const s = raw.toLowerCase();
    if (s.includes('任务不存在') || s.includes('无权访问')) return '任务不存在，或这个任务不属于当前登录账号。';
    if (s.includes('尚未生成完成')) return '报告还在处理中，请稍后刷新。';
    if (s.includes('没有报告文件')) return '任务已完成，但没有找到报告文件。';
    if (s.includes('报告路径异常')) return '报告路径异常，请检查任务记录。';
    if (s.includes('failed to fetch') || s.includes('network')) return '网络请求失败，请检查网络后重试。';
    return `加载报告失败：${raw}`;
  }

  async function getSignedReportUrl(auth, taskId) {
    const accessToken = auth?.session?.access_token;
    if (!accessToken) throw new Error('登录状态已失效，请重新登录。');

    const res = await fetch(`${base}/functions/v1/get-report-url`, {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({ taskId })
    });

    const data = await readJson(res);
    if (!data?.url) throw new Error('签名服务没有返回报告地址。');
    return data;
  }

  async function fetchReportHtml(signedUrl) {
    let res;
    try {
      res = await fetch(signedUrl, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (error) {
      const wrapped = new Error('浏览器无法读取 OSS 报告。很可能是 OSS CORS 尚未允许当前前台来源。');
      wrapped.cause = error;
      wrapped.code = 'OSS_CORS';
      throw wrapped;
    }

    if (!res.ok) {
      throw new Error(`OSS 报告读取失败：HTTP ${res.status}`);
    }

    return res.text();
  }

  window.KBReport = {
    getSignedReportUrl,
    fetchReportHtml,
    humanizeError
  };
})();
