/* Mount the verified standalone MC report with its own origin and per-account draft storage. */
(() => {
  'use strict';

  const mounts = new WeakMap();
  // The outer storage prefix separates accounts and reporting weeks. Only
  // adjustment drafts are carried forward; operating metrics come from the backend.
  function validKey(name) {
    return typeof name === 'string' && name.startsWith('mc-ads:review:') && name.length <= 256;
  }

  function safeJSON(value) {
    return JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  }

  // This function runs in the opaque frame. Only the review's own storage
  // entries are seeded. No workspace token or other account key enters it.
  function initStorage(entries, channel, parentOrigin, available, week, weekOptions) {
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


    const published = new Set(weekOptions.map(option => option.value));
    let sequence = 0;
    let queue = Promise.resolve();
    function fetchPeriodWeek(requestedWeek, signal) {
      if (signal?.aborted) throw new DOMException('已取消读取。', 'AbortError');
      if (requestedWeek === week && typeof feed !== 'undefined' && feed.week === week) return feed;
      const id = ++sequence;
      const pipe = new MessageChannel();
      return new Promise((resolve, reject) => {
        function clean() {
          signal?.removeEventListener('abort', abort);
          pipe.port1.close();
        }
        function abort() {
          clean();
          parent.postMessage({channel, periodCancel:id}, parentOrigin);
          reject(new DOMException('已取消读取。', 'AbortError'));
        }
        pipe.port1.onmessage = event => {
          clean();
          const result = event.data;
          if (result?.id === id && result.week === requestedWeek && result.feed?.week === requestedWeek) {
            resolve(result.feed);
          } else {
            reject(new Error('周报读取失败，可重新加载该周期。'));
          }
        };
        pipe.port1.onmessageerror = () => {
          clean();
          reject(new Error('周报传输失败，可重新加载该周期。'));
        };
        signal?.addEventListener('abort', abort, {once:true});
        try {
          parent.postMessage({channel, periodRead:{id, week:requestedWeek}}, parentOrigin, [pipe.port2]);
        } catch (error) {
          clean();
          pipe.port2.close();
          reject(error);
        }
      });
    }
    Object.defineProperty(window, 'MCAdsPeriodSource', {value:Object.freeze({
      listWeeks() { return Array.from(published); },
      readWeek(requestedWeek, signal) {
        if (!published.has(requestedWeek)) return Promise.reject(new Error('所选周尚未发布。'));
        // Back-pressure the historical RPC and release each large payload as soon as consumed.
        const read = queue.then(() => fetchPeriodWeek(requestedWeek, signal));
        queue = read.then(() => undefined, () => undefined);
        return read;
      }
    })});

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
      message.textContent = '浏览器未能保存更改。关闭看板前，请导出需要保留的调整草稿。';
      document.body.prepend(message);
    }
    document.addEventListener('DOMContentLoaded', () => {
      const picker = document.getElementById('filter-week');
      if (picker && weekOptions.some(option => option.value === week)) {
        picker.replaceChildren(...weekOptions.map(option => new Option(option.label, option.value)));
        picker.value = week;
        picker.closest('label').hidden = false;
        picker.addEventListener('change', () => {
          parent.postMessage({channel, selectWeek:picker.value}, parentOrigin);
        });
      }
      parent.postMessage({channel, ready:true}, parentOrigin);
    }, {once:true});
    if (denied) document.addEventListener('DOMContentLoaded', warn, {once:true});
    window.addEventListener('message', event => {
      if (event.source !== parent || event.origin !== parentOrigin || event.data?.channel !== channel) return;
      if (event.data.business) window.MCAdsBusiness?.update(week, event.data.business);
      if (event.data.storageFailed === true) {
        denied = true;
        warn();
      }
    });
  }

  function clear(iframe) {
    const previous = mounts.get(iframe);
    if (previous) {
      previous.cancelPeriodRead();
      window.removeEventListener('message', previous.onMessage);
      mounts.delete(iframe);
    }
    iframe.removeAttribute('srcdoc');
    iframe.removeAttribute('src');
  }

  function mount(iframe, template, userId, feed, business, weekOptions = [], onSelectWeek, onReadPeriodWeek) {
    const week = feed.week;
    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(week) || typeof template !== 'string' || !/<head\s*>/i.test(template))
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
    const args = safeJSON([entries,channel,location.origin,available,week,weekOptions]);
    const runtime = '<script type="application/json" id="mc-ads-runtime">' + safeJSON({feed,business}) + '<\/script>';
    const init = '<script>(' + initStorage.toString() + ')(...' + args + ');<\/script>';
    const policy = '<meta data-mc-frame-policy http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    const slot = '<script id="mc-ads-runtime" type="application/json"></script>';
    if (!template.includes(slot)) throw new Error('看板页面版本不匹配，请刷新后重试。');
    const doc = template.replace(slot, () => runtime).replace(/<head\s*>/i, head => head + policy + init);
    const state = {onMessage, ready:false, week, channel, business, periodRead:null, cancelPeriodRead};

    function cancelPeriodRead() {
      const active = state.periodRead;
      if (!active) return;
      state.periodRead = null;
      active.controller.abort();
      active.port.close();
    }
    async function sendPeriodWeek(query, port) {
      if (!port) return;
      const {id, week:requestedWeek} = query;
      if (!Number.isSafeInteger(id) || id <= 0 || !weekOptions.some(option => option.value === requestedWeek) ||
          typeof onReadPeriodWeek !== 'function' || state.periodRead) {
        try { port.postMessage({id, week:requestedWeek, error:true}); } finally { port.close(); }
        return;
      }
      const active = {id, port, controller:new AbortController()};
      state.periodRead = active;
      const ownsRequest = () => mounts.get(iframe) === state && state.periodRead === active;
      try {
        const historicalFeed = await onReadPeriodWeek(requestedWeek, active.controller.signal);
        if (ownsRequest()) port.postMessage({id, week:requestedWeek, feed:historicalFeed});
      } catch {
        if (ownsRequest()) port.postMessage({id, week:requestedWeek, error:true});
      } finally {
        if (state.periodRead === active) state.periodRead = null;
        port.close();
      }
    }

    function onMessage(event) {
      const data = event.data;
      if (event.source !== iframe.contentWindow || event.origin !== 'null' ||
          !data || data.channel !== channel) return;
      if (data.periodRead && typeof data.periodRead === 'object') {
        void sendPeriodWeek(data.periodRead, event.ports[0]);
        return;
      }
      if (Number.isSafeInteger(data.periodCancel)) {
        if (state.periodRead?.id === data.periodCancel) cancelPeriodRead();
        return;
      }
      if (data.ready === true) {
        state.ready = true;
        updateBusiness(iframe, week, state.business);
        return;
      }
      if (typeof data.selectWeek === 'string') {
        if (data.selectWeek !== week && weekOptions.some(option => option.value === data.selectWeek)) {
          onSelectWeek?.(data.selectWeek);
        }
        return;
      }
      if (!validKey(data.name)) return;
      try {
        if (data.value === null) localStorage.removeItem(base + data.name);
        else if (typeof data.value === 'string') localStorage.setItem(base + data.name, data.value);
      } catch {
        iframe.contentWindow.postMessage({channel,storageFailed:true}, '*');
      }
    }
    mounts.set(iframe,state);
    iframe.setAttribute('referrerpolicy','no-referrer');
    iframe.setAttribute('sandbox','allow-scripts allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox');
    window.addEventListener('message',onMessage);
    iframe.srcdoc = doc;
  }

  function updateBusiness(iframe, week, business) {
    const state = mounts.get(iframe);
    if (!state || state.week !== week) return;
    state.business = business;
    if (state.ready) iframe.contentWindow.postMessage({channel:state.channel, business}, '*');
  }

  window.MCAdsFrame = Object.freeze({mount,clear,updateBusiness});
})();
