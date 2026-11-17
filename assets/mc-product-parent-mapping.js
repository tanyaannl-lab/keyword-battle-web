'use strict';

(() => {
  const ids = ['appShell','loading','userEmail','logoutBtn','parentChild','parentLookup','parentLookupForm','parentLookupStatus',
    'parentDetails','parentCurrentChild','parentCatalog','parentSkus','parentRanges','parentRangesEmpty','parentRangesTable',
    'parentSingleForm','parentAction','parentTarget','parentTargetField','parentStart','parentEnd','parentEndField','parentLongTerm',
    'parentSinglePreview','parentDownload','parentFile','parentBatchForm','parentBatchPreview','parentStatus','parentReview',
    'parentReviewTitle','parentSummary','parentReviewRows','parentReviewPager','parentPrevious','parentPageInfo','parentNext','parentSave','parentCancel'];
  const ui = Object.fromEntries(ids.map(id => [id,document.getElementById(id)]));
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const csv = window.MCProductParentMappingCsv;
  const config = window.KB_CONFIG;
  const kb = window.KBAuth;
  const endpoint = {
    read:'mc_product_parent_mapping_read',
    preview:'mc_product_parent_mapping_preview',
    save:'mc_product_parent_mapping_save',
  };
  const rangeLimit = 200;
  const pageSize = 16;
  const knownStatus = ['change','unchanged'];
  let auth = null, selected = null, lookup = null, work = null, preview = null, generation = 0;
  let page = 0;

  function status(el,message = '',severity) {
    el.textContent = message;
    el.hidden = !message;
    if (severity) el.dataset.state = severity;
    else delete el.dataset.state;
  }

  function elem(tag,text,className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function update() {
    const saving = work?.kind === 'save';
    const canEdit = !!auth && selected && !saving;
    ui.parentChild.disabled = !auth || saving;
    ui.parentLookup.disabled = !auth || saving || !!lookup;
    ui.parentAction.disabled = ui.parentStart.disabled = ui.parentLongTerm.disabled = !canEdit;
    const noParent = ui.parentAction.value !== '设置';
    ui.parentTargetField.hidden = noParent;
    ui.parentTarget.required = !noParent;
    ui.parentTarget.disabled = noParent || !canEdit;
    ui.parentEndField.hidden = ui.parentLongTerm.checked;
    ui.parentEnd.required = !ui.parentLongTerm.checked;
    ui.parentEnd.disabled = ui.parentLongTerm.checked || !canEdit;
    ui.parentSinglePreview.disabled = !canEdit || !!work || (selected.catalog_parent === null && ui.parentAction.value !== '清除');
    ui.parentFile.disabled = !auth || saving;
    ui.parentBatchPreview.disabled = !auth || !!work || !ui.parentFile.files?.length;
    ui.parentDownload.disabled = !auth;
    ui.parentSave.disabled = !auth || !preview?.changed || !!work;
    ui.parentCancel.disabled = saving;
    for (const button of ui.parentRanges.querySelectorAll('button')) button.disabled = saving;
  }

  function resetPreview() {
    if (work?.kind === 'preview') {
      work.controller.abort();
      work = null;
    }
    preview = null;
    page = 0;
    ui.parentReview.hidden = true;
    ui.parentReviewRows.replaceChildren();
    ui.parentSummary.textContent = '';
    ui.parentReviewPager.hidden = true;
    update();
  }

  function discardDetails() {
    lookup?.controller.abort();
    lookup = selected = null;
    ui.parentDetails.hidden = true;
    ui.parentRanges.replaceChildren();
    ui.parentCurrentChild.textContent = ui.parentCatalog.textContent = ui.parentSkus.textContent = '';
    ui.parentAction.value = '设置';
    ui.parentTarget.value = ui.parentStart.value = ui.parentEnd.value = '';
    ui.parentLongTerm.checked = false;
    update();
  }

  function reset() {
    generation++;
    work?.controller.abort();
    work = null;
    auth = null;
    resetPreview();
    discardDetails();
    ui.appShell.hidden = true;
    ui.userEmail.textContent = '';
    ui.parentChild.value = ui.parentFile.value = '';
    status(ui.parentLookupStatus);
    status(ui.parentStatus);
    update();
  }

  function expired() {
    reset();
    location.replace(login);
  }

  function control(kind,pointer) {
    const attempt = generation, user = auth.user.id;
    const controller = new AbortController();
    const state = {kind,user,controller,current:() => generation === attempt && auth?.user.id === user &&
      pointer() === state && !controller.signal.aborted};
    return state;
  }

  class RpcError extends Error {
    constructor(statusCode,data) {
      super('MC_PARENT_MAPPING_RPC');
      this.status = statusCode;
      this.code = data?.code;
      try { this.row = typeof data?.details === 'string' ? JSON.parse(data.details)?.row : data?.details?.row; }
      catch { this.row = undefined; }
    }
  }

  async function rpc(kind,body,pending) {
    const session = typeof kb.getValidSession === 'function' ? await kb.getValidSession() : auth;
    if (!pending.current()) return undefined;
    if (!session?.session?.access_token || session.user?.id !== pending.user) {
      expired();
      return undefined;
    }
    auth = session;
    const res = await fetch(`${origin}/rest/v1/rpc/${endpoint[kind]}`,{
      method:'POST',cache:'no-store',credentials:'omit',mode:'cors',redirect:'error',referrerPolicy:'no-referrer',
      headers:{Accept:'application/json','Content-Type':'application/json',apikey:config.SUPABASE_PUBLISHABLE_KEY,
        Authorization:`Bearer ${session.session.access_token}`},
      body:JSON.stringify(body),signal:AbortSignal.any([pending.controller.signal,AbortSignal.timeout(45_000)]),
    });
    if (!pending.current()) return undefined;
    if (res.status === 401) {
      expired();
      return undefined;
    }
    if (!res.ok) throw new RpcError(res.status,await res.json().catch(()=>null));
    return res.json();
  }

  function problem(error,kind,lines) {
    const line = Number.isSafeInteger(error?.row) && error.row >= 1 ? lines?.[error.row-1] : null;
    const prefix = line ? `CSV 第 ${line} 行：` : '';
    if (error?.status === 403 || error?.code === '42501') return '当前账号没有此项权限。';
    if (error?.status === 404 || error?.code === 'PGRST202') return '父 ASIN 维护服务尚未启用，请联系管理员。';
    if (error?.code === '40001') return `${prefix}归属规则已更新，本次未保存。请重新预览后再确认。`;
    if (error?.code === '22023') {
      if (kind === 'read') return '未找到这个子 ASIN。请核对 MC 美国站商品目录中的子 ASIN。';
      return `${prefix}请核对商品目录中的 ASIN、操作和日期范围。本次未写入。`;
    }
    if (kind === 'save') return '未能确认保存结果。请重新查询或预览，核对当前规则后再操作。';
    if (error?.name === 'TimeoutError') return '读取超时，请稍后再试。';
    if (error instanceof RpcError || error instanceof TypeError || error instanceof SyntaxError) return '暂时无法读取，请稍后再试。';
    return error.message || '暂时无法读取，请稍后再试。';
  }

  const validAsin = value => typeof value === 'string' && csv.ASIN.test(value);
  const validDay = value => typeof value === 'string' && csv.normalizeDay(value) === value;
  const validRevision = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
  const validCatalog = value => value === null || validAsin(value);

  function validateRanges(ranges) {
    return Array.isArray(ranges) && ranges.length <= rangeLimit && ranges.every((item,i) =>
      item && validDay(item.start_date) &&
      (item.end_date === null || validDay(item.end_date) && item.end_date >= item.start_date) &&
      (i === 0 || ranges[i-1]?.end_date && ranges[i-1].end_date < item.start_date) && validAsin(item.parent_asin));
  }

  function readDetails(data,asin) {
    if (!data || data.store !== 'MC' || data.marketplace !== 'amazon.com' || data.asin !== asin ||
        !validCatalog(data.catalog_parent) || !validRevision(data.revision) ||
        !Array.isArray(data.skus) || data.skus.some(sku => typeof sku !== 'string' || !sku.trim()) || !validateRanges(data.ranges)) {
      throw new Error('服务器返回的商品归属记录不完整，请重新查询。');
    }
    return data;
  }

  const parentLabel = (parent,asin) => parent === null ? '目录未收录' : parent === asin ? `独立商品（${asin}）` : parent;
  const interval = item => item.end_date === item.start_date ? item.start_date : `${item.start_date} 至 ${item.end_date ?? '长期'}`;

  function fillRule(rule) {
    if (!selected || work?.kind === 'save') return;
    resetPreview();
    status(ui.parentStatus);
    ui.parentAction.value = rule.parent_asin === selected.asin ? '独立' : '设置';
    ui.parentTarget.value = rule.parent_asin === selected.asin ? '' : rule.parent_asin;
    ui.parentStart.value = rule.start_date;
    ui.parentEnd.value = rule.end_date ?? '';
    ui.parentLongTerm.checked = rule.end_date === null;
    if (selected.catalog_parent === null) ui.parentAction.value = '清除';
    update();
    ui.parentAction.focus();
  }

  function renderDetails() {
    ui.parentDetails.hidden = false;
    ui.parentCurrentChild.textContent = selected.asin;
    ui.parentCatalog.textContent = parentLabel(selected.catalog_parent,selected.asin);
    ui.parentSkus.textContent = selected.skus.join('、') || '—';
    const ranges = selected.ranges.map(rule => {
      const tr = elem('tr');
      const link = elem('button','载入此段','catalog-button');
      link.type = 'button';
      link.addEventListener('click',() => fillRule(rule));
      const last = elem('td');
      last.append(link);
      tr.append(elem('td',rule.start_date),elem('td',rule.end_date ?? '长期'),elem('td',parentLabel(rule.parent_asin,selected.asin)),last);
      return tr;
    });
    ui.parentRanges.replaceChildren(...ranges);
    ui.parentRangesEmpty.hidden = !!ranges.length;
    ui.parentRangesTable.hidden = !ranges.length;
    if (selected.catalog_parent === null) ui.parentAction.value = '清除';
    update();
  }

  async function lookupChild({preserveStatus = false} = {}) {
    if (!auth || work?.kind === 'save') return;
    const asin = csv.normalizeAsin(ui.parentChild.value);
    discardDetails();
    resetPreview();
    if (!preserveStatus) status(ui.parentStatus);
    if (!asin) {
      status(ui.parentLookupStatus,'请输入 10 位子 ASIN。','error');
      return;
    }
    ui.parentChild.value = asin;
    const pending = control('read',()=>lookup);
    lookup = pending;
    update();
    status(ui.parentLookupStatus,'正在查询商品目录和已保存的调整…');
    try {
      const data = await rpc('read',{p_asin:asin},pending);
      if (!pending.current()) return;
      selected = readDetails(data,asin);
      renderDetails();
      status(ui.parentLookupStatus,selected.catalog_parent === null ? '该商品已不在目录中，只能清除已有调整。' : '');
    } catch (error) {
      if (pending.current()) status(ui.parentLookupStatus,problem(error,'read'),'error');
    } finally {
      if (lookup === pending) {
        lookup = null;
        update();
      }
    }
  }

  function counts(data,size) {
    const changed = data?.changed_count, same = data?.unchanged_count;
    if (!Number.isSafeInteger(changed) || !Number.isSafeInteger(same) || changed < 0 || same < 0 || changed + same !== size) {
      throw new Error('服务器返回的变更统计与本次操作不一致。');
    }
    return {changed,same};
  }

  function decodePreview(data,rows,lines) {
    const {changed,same} = counts(data,rows.length);
    const fields = ['asin','parent_asin','start_date','end_date','action'];
    if (!Array.isArray(data.rows) || data.rows.length !== rows.length || data.rows.some((row,i) =>
      !row || fields.some(key=>row[key] !== rows[i][key]) || !validRevision(row.revision) ||
      !validCatalog(row.catalog_parent) || !knownStatus.includes(row.status) ||
      !validateRanges(row.before) || !validateRanges(row.after)) || data.rows.filter(row=>row.status === 'change').length !== changed) {
      throw new Error('服务器返回的预览与本次输入不一致，请重新预览。');
    }
    const patches = rows.map((row,i)=>({...row,revision:data.rows[i].revision}));
    return {changed,same,rows:data.rows,patches,lines};
  }

  function describe(ranges,asin) {
    const cell = elem('td');
    if (!ranges.length) cell.textContent = '无手动调整';
    else {
      const list = elem('ul',undefined,'parent-range-list');
      list.append(...ranges.map(range=>elem('li',`${interval(range)}：${parentLabel(range.parent_asin,asin)}`)));
      cell.append(list);
    }
    return cell;
  }

  function renderPreview(plan,focus = false) {
    const pages = Math.ceil(plan.rows.length / pageSize);
    const from = page * pageSize;
    const items = plan.rows.slice(from,from + pageSize).map((row,index) => {
      const tr = elem('tr');
      const child = elem('td',row.asin,'catalog-asin');
      if (plan.lines?.[from+index]) child.append(elem('small',`CSV 第 ${plan.lines[from+index]} 行`,'parent-review-subnote'));
      const direction = row.action === 'clear' ? '清除这段日期的调整' : parentLabel(row.parent_asin,row.asin);
      const operation = elem('td',`${interval(row)} · ${direction}`);
      operation.append(elem('small',row.status === 'unchanged' ? '无变化' :
        `目录原值：${parentLabel(row.catalog_parent,row.asin)}`,'parent-review-subnote'));
      tr.append(child,operation,describe(row.before,row.asin),describe(row.after,row.asin));
      return tr;
    });
    ui.parentReviewRows.replaceChildren(...items);
    ui.parentSummary.textContent = `有变化 ${plan.changed} 个子 ASIN · 无变化 ${plan.same} 个`;
    ui.parentReview.hidden = false;
    ui.parentReviewPager.hidden = pages < 2;
    ui.parentPrevious.disabled = page === 0;
    ui.parentNext.disabled = page + 1 >= pages;
    ui.parentPageInfo.textContent = `第 ${page + 1} / ${pages} 页`;
    if (focus) ui.parentReviewTitle.focus();
  }

  async function startPreview(kind) {
    if (!auth || work) return;
    resetPreview();
    const pending = control('preview',()=>work);
    work = pending;
    update();
    status(ui.parentStatus,'正在检查可保存的变更…');
    let lines;
    try {
      let rows;
      if (kind === 'batch') {
        const file = ui.parentFile.files?.[0];
        if (!file) throw new Error('请先选择 CSV 文件。');
        if (file.size > csv.MAX_BYTES) throw new Error('CSV 不得超过 256 KB，请分批处理。');
        ({rows,lines} = csv.parse(await file.text()));
      } else {
        if (!selected || csv.normalizeAsin(ui.parentChild.value) !== selected.asin) throw new Error('请先查询这个子 ASIN。');
        rows = [csv.rowFor({child:selected.asin,operation:ui.parentAction.value,
          parent:ui.parentAction.value === '设置' ? ui.parentTarget.value : '',
          first:ui.parentStart.value,last:ui.parentLongTerm.checked ? '长期' : ui.parentEnd.value})];
      }
      if (!pending.current()) return;
      const data = await rpc('preview',{p_rows:rows},pending);
      if (!pending.current()) return;
      preview = decodePreview(data,rows,lines);
      renderPreview(preview,true);
      status(ui.parentStatus,preview.changed ? '预览已生成。核对日期和父 ASIN 后再保存。' : '预览没有发现需要保存的变化。');
    } catch (error) {
      if (pending.current()) status(ui.parentStatus,problem(error,'preview',lines),'error');
    } finally {
      if (work === pending) {
        work = null;
        update();
      }
    }
  }

  async function save() {
    if (!auth || work || !preview?.changed) return;
    const plan = preview;
    const pending = control('save',()=>work);
    work = pending;
    update();
    status(ui.parentStatus,'正在保存归属调整…');
    let refresh = false;
    try {
      const data = await rpc('save',{p_rows:plan.patches},pending);
      if (!pending.current()) return;
      const {changed,same} = counts(data,plan.rows.length);
      if (changed !== plan.changed || same !== plan.same) throw new Error('无法确认保存数量。');
      ui.parentFile.value = '';
      refresh = plan.patches.some(row => row.asin === csv.normalizeAsin(ui.parentChild.value));
      status(ui.parentStatus,`已保存 ${changed} 个子 ASIN 的调整。请核对对应日期的经营报表。`,'success');
    } catch (error) {
      if (pending.current()) status(ui.parentStatus,problem(error,'save',plan.lines),'error');
    } finally {
      if (work === pending) {
        work = null;
        resetPreview();
      }
    }
    if (refresh) void lookupChild({preserveStatus:true});
  }

  function exportTemplate() {
    if (!auth) return;
    const blob = new Blob([csv.template()],{type:'text/csv;charset=utf-8'});
    const href = URL.createObjectURL(blob);
    const link = elem('a');
    link.href = href;
    link.download = 'MC-parent-ASIN-template.csv';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(href),1000);
  }

  function change() {
    if (work?.kind === 'save') return;
    resetPreview();
    status(ui.parentStatus);
  }

  async function init() {
    const attempt = ++generation;
    ui.loading.hidden = false;
    ui.loading.textContent = '正在验证登录状态…';
    if (![origin,`${origin}/`].includes(config?.SUPABASE_URL) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.SUPABASE_PUBLISHABLE_KEY || '') ||
        typeof kb?.requireAuth !== 'function' || typeof csv?.parse !== 'function') {
      ui.loading.textContent = '父 ASIN 维护页面未加载，请刷新页面或联系管理员。';
      return;
    }
    try {
      const session = await kb.requireAuth(login);
      if (attempt !== generation || !session) return;
      if (!session.user?.id || !session.session?.access_token) { expired(); return; }
      auth = session;
      ui.userEmail.textContent = auth.user.email || '—';
      ui.parentAction.value = '设置';
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      update();
      const prefill = csv.normalizeAsin(new URLSearchParams(location.search || '').get('asin'));
      if (prefill) {
        ui.parentChild.value = prefill;
        void lookupChild();
      }
    } catch {
      if (attempt === generation) ui.loading.textContent = '暂时无法验证登录，请返回登录页重试。';
    }
  }

  ui.parentLookupForm.addEventListener('submit',event=>{event.preventDefault(); void lookupChild();});
  ui.parentSingleForm.addEventListener('submit',event=>{event.preventDefault(); void startPreview('single');});
  ui.parentBatchForm.addEventListener('submit',event=>{event.preventDefault(); void startPreview('batch');});
  ui.parentChild.addEventListener('input',()=>{
    discardDetails();
    change();
    status(ui.parentLookupStatus);
  });
  for (const item of [ui.parentStart,ui.parentEnd,ui.parentTarget]) item.addEventListener('input',change);
  for (const item of [ui.parentAction,ui.parentLongTerm,ui.parentFile]) item.addEventListener('change',change);
  ui.parentDownload.addEventListener('click',exportTemplate);
  ui.parentSave.addEventListener('click',()=>{void save();});
  ui.parentCancel.addEventListener('click',change);
  ui.parentPrevious.addEventListener('click',()=>{
    if (preview && page > 0) { page--; renderPreview(preview); }
  });
  ui.parentNext.addEventListener('click',()=>{
    if (preview && (page+1)*pageSize < preview.rows.length) { page++; renderPreview(preview); }
  });
  ui.logoutBtn.addEventListener('click',async ()=>{
    reset();
    try { await kb.logout(); } finally { location.replace(login); }
  });
  window.addEventListener('pagehide',reset);
  window.addEventListener('pageshow',event=>{if (event.persisted) void init();});
  window.addEventListener('storage',event=>{
    if (event.key !== config?.SESSION_KEY && event.key !== null) return;
    const id = value=>{try {return JSON.parse(value)?.user?.id;} catch {return undefined;}};
    const before = id(event.oldValue), after = id(event.newValue);
    if (after && before === after && (!auth || auth.user.id === after)) return;
    reset();
    if (event.newValue) void init();
    else location.replace(login);
  });
  void init();
})();
