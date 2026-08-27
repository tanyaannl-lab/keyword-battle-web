(function () {
  const cfg = window.KB_CONFIG;
  if (!cfg) throw new Error('KB_CONFIG 未加载');

  const base = cfg.SUPABASE_URL.replace(/\/$/, '');
  const bucket = 'keyword-battle-inbox';
  const maxFileBytes = 20 * 1024 * 1024;
  const allowedExts = new Set(['xlsx', 'csv']);

  function authHeaders(accessToken, json = true) {
    const h = {
      'apikey': cfg.SUPABASE_PUBLISHABLE_KEY,
      'Authorization': `Bearer ${accessToken}`
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async function readJson(res) {
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (res.ok) return body;
    const msg = body?.message || body?.msg || body?.error_description || body?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = body;
    throw err;
  }

  function humanizeError(error) {
    const raw = String(error?.message || error || '未知错误');
    const s = raw.toLowerCase();
    if (s.includes('row-level security') || s.includes('permission denied')) return '没有权限执行这个操作，请重新登录后再试。';
    if (s.includes('duplicate') || s.includes('already exists')) return '这个文件或任务已经存在，请刷新任务列表后检查。';
    if (s.includes('payload too large') || s.includes('too large')) return '文件太大，请上传 20 MB 以内的报表。';
    if (s.includes('failed to fetch') || s.includes('network')) return '网络连接失败，请检查网络后重试。';
    return `操作失败：${raw}`;
  }

  function getExtension(filename) {
    const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function validateAsin(asin) {
    return /^B0[A-Z0-9]{8}$/.test(String(asin || '').trim().toUpperCase());
  }

  function validateFile(file) {
    if (!file) throw new Error('请先选择广告报表。');
    const ext = getExtension(file.name);
    if (!allowedExts.has(ext)) throw new Error('只支持 .xlsx 或 .csv 文件。');
    if (file.size <= 0) throw new Error('文件为空，请重新选择。');
    if (file.size > maxFileBytes) throw new Error('文件太大，请上传 20 MB 以内的报表。');
    return ext;
  }

  function encodeObjectPath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  async function uploadInboxFile(accessToken, objectPath, file) {
    const url = `${base}/storage/v1/object/${bucket}/${encodeObjectPath(objectPath)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': cfg.SUPABASE_PUBLISHABLE_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': file.type || (getExtension(file.name) === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        'x-upsert': 'false'
      },
      body: file
    });
    return readJson(res);
  }

  async function insertTask(accessToken, row) {
    const res = await fetch(`${base}/rest/v1/tasks`, {
      method: 'POST',
      headers: {
        ...authHeaders(accessToken),
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(row)
    });
    const data = await readJson(res);
    return Array.isArray(data) ? data[0] : data;
  }

  async function createTask(auth, asinInput, file) {
    const asin = String(asinInput || '').trim().toUpperCase();
    if (!validateAsin(asin)) throw new Error('ASIN 格式不正确：请输入 10 位、B0 开头。');
    const ext = validateFile(file);
    const userId = auth?.user?.id;
    const accessToken = auth?.session?.access_token;
    if (!userId || !accessToken) throw new Error('登录状态已失效，请重新登录。');

    const taskId = crypto.randomUUID();
    const objectPath = `${userId}/${taskId}.${ext}`;

    await uploadInboxFile(accessToken, objectPath, file);

    try {
      return await insertTask(accessToken, {
        id: taskId,
        user_id: userId,
        asin,
        report_file_path: objectPath,
        status: '待处理'
      });
    } catch (error) {
      const wrapped = new Error(`文件已上传，但任务创建失败；这个孤儿文件不会被 worker 处理。${error.message || ''}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async function listTasks(auth, limit = 20) {
    const userId = auth?.user?.id;
    const accessToken = auth?.session?.access_token;
    if (!userId || !accessToken) throw new Error('登录状态已失效，请重新登录。');

    const url = new URL(`${base}/rest/v1/tasks`);
    url.searchParams.set('select', 'id,asin,status,failure_reason,report_url,created_at');
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('order', 'created_at.desc');
    url.searchParams.set('limit', String(limit));

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: authHeaders(accessToken, false)
    });
    return readJson(res);
  }

  window.KBTask = {
    createTask,
    listTasks,
    validateAsin,
    validateFile,
    humanizeError,
    maxFileBytes
  };
})();
