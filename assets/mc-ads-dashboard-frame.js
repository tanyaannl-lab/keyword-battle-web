/* Mount the verified standalone MC report with its own origin and per-account draft storage. */
(() => {
  'use strict';

  const mounts = new WeakMap();
  const reviewKey = 'mc-ads:review:2026-W47:';
  const businessKey = 'mc-us-operating-daily-v1-2026-11-16';
  const placementKey = 'mc-us-sp-placements-2026-w47-v1';

  function validKey(name) {
    return typeof name === 'string' && (
      name === placementKey || name === businessKey ||
      name.startsWith(businessKey + '-') || name.startsWith(reviewKey)
    );
  }

  // This function runs in the opaque frame. Only the review's own storage
  // entries are seeded. No workspace token or other account key enters it.
  function initStorage(entries, channel, parentOrigin, available) {
    const values = new Map(entries);
    const bootstrap = document.currentScript;
    const policy = bootstrap.previousElementSibling;
    bootstrap.remove();
    if (policy && policy.hasAttribute('data-mc-frame-policy')) policy.remove();

    // Fragment links in about:srcdoc otherwise resolve against the host URL.
    // Use its own location so the standalone router and browser Back both work.
    window.addEventListener('click', event => {
      const link = event.target.closest?.('a[href^="#"]');
      if (!link || link.target || event.defaultPrevented || event.button !== 0 ||
          event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      location.hash = link.getAttribute('href');
    });

    let denied = !available;
    const storage = {
      get length() { return values.size; },
      key(index) { return Array.from(values.keys())[index] ?? null; },
      getItem(name) { return values.get(String(name)) ?? null; },
      setItem(name, value) {
        if (denied) throw new DOMException('Storage unavailable', 'QuotaExceededError');
        name = String(name); value = String(value);
        values.set(name, value);
        parent.postMessage({channel, name, value}, parentOrigin);
      },
      removeItem(name) {
        name = String(name);
        values.delete(name);
        parent.postMessage({channel, name, value:null}, parentOrigin);
      }
    };
    Object.defineProperty(window, 'localStorage', {value:storage, configurable:false});
    function warn() {
      if (!document.body || document.getElementById('mc-storage-warning')) return;
      const message = document.createElement('p');
      message.id = 'mc-storage-warning';
      message.setAttribute('role','status');
      message.textContent = '浏览器未能保存更改。关闭看板前，请导出需要保留的草稿或已导入的数据。';
      document.body.prepend(message);
    }
    if (denied) document.addEventListener('DOMContentLoaded', warn, {once:true});
    window.addEventListener('message', event => {
      if (event.source === parent && event.origin === parentOrigin &&
          event.data?.channel === channel && event.data?.storageFailed === true) {
        denied = true;
        warn();
      }
    });
  }

  function clear(iframe) {
    const previous = mounts.get(iframe);
    if (previous) {
      window.removeEventListener('message', previous.onMessage);
      mounts.delete(iframe);
    }
    iframe.removeAttribute('srcdoc');
    iframe.removeAttribute('src');
  }

  function mount(iframe, verifiedHtml, userId, week) {
    if (!userId || week !== '2026-11-16' || typeof verifiedHtml !== 'string' || !/<head\s*>/i.test(verifiedHtml))
      throw new Error('看板文件格式或周次无效。');
    clear(iframe);
    const base = 'mc:ads-dashboard:' + encodeURIComponent(userId) + ':' + week + ':';
    const channel = crypto.randomUUID();
    const entries = [];
    let available = true;
    try {
      for (let i=0; i<localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(base) && validKey(key.slice(base.length))) {
          const value = localStorage.getItem(key);
          if (value !== null) entries.push([key.slice(base.length),value]);
        }
      }
    } catch { available = false; }
    const args = JSON.stringify([entries,channel,location.origin,available])
      .replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
    const init = '<script>(' + initStorage.toString() + ')(...' + args + ');<\/script>';
    const policy = '<meta data-mc-frame-policy http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    const doc = verifiedHtml.replace(/<head\s*>/i, head => head + policy + init);
    function onMessage(event) {
      const data = event.data;
      if (event.source !== iframe.contentWindow || event.origin !== 'null' ||
          !data || data.channel !== channel || !validKey(data.name)) return;
      try {
        if (data.value === null) localStorage.removeItem(base + data.name);
        else if (typeof data.value === 'string') localStorage.setItem(base + data.name, data.value);
      } catch {
        iframe.contentWindow.postMessage({channel,storageFailed:true}, '*');
      }
    }
    mounts.set(iframe,{onMessage});
    iframe.setAttribute('referrerpolicy','no-referrer');
    iframe.setAttribute('sandbox','allow-scripts allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox');
    window.addEventListener('message',onMessage);
    iframe.srcdoc = doc;
  }

  window.MCAdsFrame = Object.freeze({mount,clear});
})();
