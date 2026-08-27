(function () {
  const cfg = window.KB_CONFIG;
  if (!cfg) throw new Error('KB_CONFIG 未加载');

  const base = cfg.SUPABASE_URL.replace(/\/$/, '');
  const sessionKey = cfg.SESSION_KEY;

  function headers(accessToken) {
    const h = {
      'apikey': cfg.SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json'
    };
    if (accessToken) h.Authorization = `Bearer ${accessToken}`;
    return h;
  }

  function saveSession(session) {
    if (!session || !session.access_token) return;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = session.expires_at || (session.expires_in ? now + Number(session.expires_in) : null);
    localStorage.setItem(sessionKey, JSON.stringify({ ...session, expires_at: expiresAt }));
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(sessionKey);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      clearSession();
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(sessionKey);
  }

  async function readJson(res) {
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (res.ok) return body;
    const msg = body?.msg || body?.message || body?.error_description || body?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = body;
    throw err;
  }

  function humanizeError(error) {
    const s = String(error?.message || error || '').toLowerCase();
    if (s.includes('invalid login credentials')) return '邮箱或密码不正确。';
    if (s.includes('email not confirmed')) return '邮箱尚未确认，请先完成邮箱确认。';
    if (s.includes('user already registered') || s.includes('already been registered')) return '这个邮箱已经注册，请直接登录。';
    if (s.includes('password should be at least') || s.includes('weak password')) return '密码强度不足，请至少使用 6 位并避免过于简单。';
    if (s.includes('unable to validate email') || s.includes('invalid email')) return '邮箱格式不正确。';
    if (s.includes('rate limit') || s.includes('too many requests')) return '操作太频繁，请稍后再试。';
    if (s.includes('failed to fetch') || s.includes('network')) return '网络连接失败，请检查网络后重试。';
    return `操作失败：${error?.message || '未知错误'}`;
  }

  async function login(email, password) {
    const res = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email, password })
    });
    const data = await readJson(res);
    saveSession(data);
    return data;
  }

  async function signup(email, password) {
    const res = await fetch(`${base}/auth/v1/signup`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email, password })
    });
    const data = await readJson(res);
    if (data?.access_token) saveSession(data);
    return data;
  }

  async function refreshSession(refreshToken) {
    const res = await fetch(`${base}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const data = await readJson(res);
    saveSession(data);
    return data;
  }

  async function getUser(accessToken) {
    const res = await fetch(`${base}/auth/v1/user`, {
      method: 'GET',
      headers: headers(accessToken)
    });
    return readJson(res);
  }

  async function getValidSession() {
    let session = loadSession();
    if (!session?.access_token) return null;

    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at && Number(session.expires_at) <= now + 30) {
      if (!session.refresh_token) {
        clearSession();
        return null;
      }
      try {
        session = await refreshSession(session.refresh_token);
      } catch (_) {
        clearSession();
        return null;
      }
    }

    try {
      const user = await getUser(session.access_token);
      return { session, user };
    } catch (error) {
      if (session.refresh_token) {
        try {
          session = await refreshSession(session.refresh_token);
          const user = await getUser(session.access_token);
          return { session, user };
        } catch (_) {}
      }
      clearSession();
      return null;
    }
  }

  async function logout() {
    const session = loadSession();
    try {
      if (session?.access_token) {
        await fetch(`${base}/auth/v1/logout`, {
          method: 'POST',
          headers: headers(session.access_token)
        });
      }
    } finally {
      clearSession();
    }
  }

  async function requireAuth(loginUrl) {
    const auth = await getValidSession();
    if (!auth) {
      location.replace(loginUrl);
      return null;
    }
    return auth;
  }

  window.KBAuth = {
    login,
    signup,
    logout,
    loadSession,
    clearSession,
    getValidSession,
    requireAuth,
    humanizeError
  };
})();
