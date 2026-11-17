'use strict';

(() => {
  const ids = ['appShell','loading','userEmail','logoutBtn','batchTemplateForm','batchTemplateDate','batchDownloadCatalog',
    'batchDownloadBlank','batchTemplateStatus','batchPreviewForm','batchFile','batchPreview','batchStatus','batchReview',
    'batchSummary','batchRows','batchPager','batchPrevious','batchPageInfo','batchNext','batchSave',
    'batchCoverageForm','batchCoverageStart','batchCoverageEnd','batchCoverageRun','batchCoverageStatus',
    'batchCoverageResult','batchCoverageSummary','batchCoverageGaps','batchCoverageDays','batchCoverageExport',
    'batchCoveragePartField','batchCoveragePart','batchCoverageDownload','batchCoverageDetailDownload','batchCoverageExportHelp',
    'batchCoverageTable','batchCoverageRows','batchCoveragePager','batchCoveragePrevious','batchCoveragePageInfo',
    'batchCoverageNext'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const login = '../index.html';
  const config = window.KB_CONFIG;
  const csv = window.MCProductCostCsv;
  const br = window.KBAuth;
  const catalogRpc = 'mc_product_catalog_read';
  const previewRpc = 'mc_product_catalog_cost_daily_batch_preview';
  const saveRpc = 'mc_product_catalog_cost_daily_batch_save';
  const coverageRpc = 'mc_product_catalog_cost_daily_coverage_read';
  const fields = [
    ['exchange_rate','汇率',1000000],['product_cost_rmb','产品成本（RMB）',100000000],
    ['inbound_cost_rmb','头程（RMB）',100000000],['fba_fee','FBA 费用（USD）',100000000],
    ['commission_rate','佣金率',1,true],['vat_rate','VAT 税率',1,true],
  ];
  const asinPattern = /^[A-Z0-9]{10}$/;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const firstDay = '2000-01-01';
  const pacific = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
  const counts = ['new_count','update_count','unchanged_count'];
  const statusLabels = {new:'新增',update:'更新',unchanged:'无变化'};
  const pageSize = 35;
  const dayMs = 86_400_000;
  const coverageDays = 31;
  const coverageLimit = 10_000;
  const firstCoverageDay = '2000-01-03';
  const costLabels = Object.fromEntries(fields.map(([key,label]) => [key,label]));
  const reportLabels = {orders_ready:'订单',transactions_ready:'交易',br_ready:'详情页面销售和流量',sp_ready:'SP 广告'};
  const issueLabels = {conflict:'商品归属冲突，请核对目录及报表',unmatched:'未匹配产品目录，请先核对商品'};
  let auth = null;
  let generation = 0;
  let job = null;
  let templateJob = null;
  let coverageJob = null;
  let prepared = null;
  let page = 0;
  let coverage = null;
  let coveragePage = 0;

  function today() {
    const parts = Object.fromEntries(pacific.formatToParts().map(({type,value}) => [type,value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function validDate(date) {
    return validDay(date) && date <= today();
  }

  function validDay(date) {
    if (typeof date !== 'string' || !datePattern.test(date) || date < firstDay) return false;
    const dt = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(+dt) && dt.toISOString().slice(0,10) === date;
  }

  function shiftDay(date, days) {
    return new Date(Date.parse(date) + days * dayMs).toISOString().slice(0,10);
  }

  function updateCoverageLimits() {
    const yesterday = shiftDay(today(),-1);
    ui.batchCoverageStart.max = ui.batchCoverageEnd.max = yesterday;
    return yesterday;
  }

  function status(el, text = '', state = '') {
    el.textContent = text;
    el.hidden = !text;
    if (state) el.dataset.state = state;
    else delete el.dataset.state;
  }

  function updateControls() {
    const saving = job?.type === 'save';
    ui.batchFile.disabled = !auth || saving;
    ui.batchPreview.disabled = !auth || !ui.batchFile.files?.length || !!job;
    ui.batchSave.disabled = !auth || !prepared || !prepared.changed || !!job;
    ui.batchDownloadCatalog.disabled = !auth || !!templateJob;
    ui.batchDownloadBlank.disabled = !auth || !!templateJob;
    ui.batchTemplateDate.disabled = !auth || !!templateJob;
    ui.batchCoverageStart.disabled = !auth;
    ui.batchCoverageEnd.disabled = !auth;
    ui.batchCoverageRun.disabled = !auth || !!coverageJob;
    ui.batchCoverageDownload.disabled = ui.batchCoverageDetailDownload.disabled = !auth || !coverage?.rows.length;
  }

  function clearCoverage(message = '') {
    coverageJob?.controller.abort();
    coverageJob = coverage = null;
    coveragePage = 0;
    ui.batchCoverageResult.hidden = true;
    for (const id of ['batchCoverageDays','batchCoverageRows','batchCoveragePart']) ui[id].replaceChildren();
    ui.batchCoverageSummary.textContent = '';
    ui.batchCoveragePageInfo.textContent = '';
    status(ui.batchCoverageStatus,message);
    updateControls();
  }

  function clearPreview() {
    prepared = null;
    page = 0;
    ui.batchReview.hidden = true;
    ui.batchRows.replaceChildren();
    ui.batchSummary.textContent = '';
    ui.batchPageInfo.textContent = '';
    updateControls();
  }

  function reset() {
    generation++;
    job?.controller.abort();
    templateJob?.controller.abort();
    job = templateJob = auth = null;
    ui.appShell.hidden = true;
    ui.userEmail.textContent = '';
    ui.batchFile.value = '';
    ui.batchTemplateDate.value = '';
    ui.batchCoverageStart.value = ui.batchCoverageEnd.value = '';
    clearPreview();
    clearCoverage();
    status(ui.batchStatus);
    status(ui.batchTemplateStatus);
  }

  function expired() {
    reset();
    location.replace(login);
  }

  function control(type) {
    const controller = new AbortController();
    const user = auth.user.id;
    const forGeneration = generation;
    return {type, controller, user, current: () => generation === forGeneration && auth?.user.id === user &&
      !controller.signal.aborted &&
      (type === 'coverage' ? coverageJob : type === 'template' ? templateJob : job)?.controller === controller};
  }

  class RpcError extends Error {
    constructor(status, body) {
      super('MC_COST_BATCH_RPC');
      this.status = status;
      this.code = body?.code;
      try { this.row = typeof body?.details === 'string' ? JSON.parse(body.details)?.row : body?.details?.row; }
      catch { this.row = undefined; }
    }
  }

  async function rpc(endpoint, body, pending) {
    const session = typeof br.getValidSession === 'function' ? await br.getValidSession() : auth;
    if (!pending.current()) return undefined;
    if (!session?.session?.access_token || session.user?.id !== pending.user) { expired(); return undefined; }
    auth = session;
    const response = await fetch(`${origin}/rest/v1/rpc/${endpoint}`, {
      method:'POST', headers:{Accept:'application/json','Content-Type':'application/json',
        apikey:config.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${session.session.access_token}`},
      body:JSON.stringify(body),cache:'no-store',credentials:'omit',mode:'cors',redirect:'error',referrerPolicy:'no-referrer',
      signal:AbortSignal.any([pending.controller.signal,AbortSignal.timeout(45_000)]),
    });
    if (!pending.current()) return undefined;
    if (response.status === 401) { expired(); return undefined; }
    if (!response.ok) throw new RpcError(response.status,await response.json().catch(() => undefined));
    return response.json();
  }

  function summarize(data, rowCount) {
    if (!data || counts.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0 || data[key] > rowCount) ||
        counts.reduce((sum,key) => sum + data[key],0) !== rowCount) throw new Error('服务器返回的统计结果不完整。');
    return counts.map(key => data[key]);
  }

  function summaryText([added, updated, same]) {
    return `新增 ${added} 条 · 更新 ${updated} 条 · 无变化 ${same} 条`;
  }

  function decodePreview(data, input) {
    const resultCounts = summarize(data,input.length);
    if (!Array.isArray(data.rows) || data.rows.length !== input.length) throw new Error('服务器返回的预览行数不匹配。');
    const actual = [0,0,0];
    const patches = input.map((source,index) => {
      const row = data.rows[index];
      const {asin,report_date,values} = source;
      if (!row || row.asin !== asin || row.report_date !== report_date || !Number.isSafeInteger(row.revision) ||
          row.revision < 0 || row.revision > 2147483647 || !Object.hasOwn(statusLabels,row.status)) {
        throw new Error('服务器返回的预览记录与导入文件不一致。');
      }
      if (!row.before || !row.after) throw new Error('服务器返回的预览缺少变更明细。');
      const sane = (value,max,fx) => value === null || typeof value === 'number' && Number.isFinite(value) &&
        value >= (fx ? 0.000001 : 0) && value <= max;
      for (const [key,,max] of fields) {
        if (!sane(row.before[key],max,key === 'exchange_rate') || !sane(row.after[key],max,key === 'exchange_rate') ||
            row.after[key] !== (Object.hasOwn(values,key) ? values[key] : row.before[key]) ||
            (row.revision === 0 && row.before[key] !== null)) throw new Error('服务器返回的预览与本次成本变更不一致。');
      }
      const changed = fields.some(([key]) => row.before[key] !== row.after[key]);
      const expected = row.revision === 0 ? 'new' : changed ? 'update' : 'unchanged';
      if (row.status !== expected) throw new Error('服务器返回的预览状态不一致。');
      actual[['new','update','unchanged'].indexOf(row.status)]++;
      return {...source,revision:row.revision};
    });
    if (actual.some((count,index) => count !== resultCounts[index])) throw new Error('服务器返回的预览统计不一致。');
    return {patches,lines:input.sourceLines,rows:data.rows,counts:resultCounts,changed:resultCounts[0]+resultCounts[1]};
  }

  function batchError(error, lines, writing = false) {
    const line = Number.isSafeInteger(error.row) && error.row > 0 ? lines?.[error.row - 1] : null;
    const prefix = line ? `CSV 第 ${line} 行：` : '';
    if (error.status === 403 || error.code === '42501') return '当前账号没有更新 MC 产品成本的权限。';
    if (error.status === 404 || error.code === 'PGRST202') return '批量成本服务尚未启用，请联系管理员。';
    if (error.code === '40001') return `${prefix}数据已被他人修改，本批未写入。请重新预览。`;
    if (error.code === '22023') return `${prefix}请核对该行的子 ASIN、日期或成本。${writing ? '本批未写入，请重新预览。' : '文件未写入。'}`;
    if (writing) return '未能确认保存结果。请重新预览，核对当前值后再操作。';
    if (error.name === 'TimeoutError') return '读取超时，请稍后重试。';
    if (error instanceof RpcError || error instanceof TypeError || error instanceof SyntaxError) return '暂时无法读取，请稍后重试。';
    return error.message || '暂时无法读取，请稍后重试。';
  }

  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function display(value, percent) {
    if (value === null) return '—';
    return percent ? `${Number((value*100).toFixed(4))}%` : String(value);
  }

  function render() {
    if (!prepared) return;
    const count = Math.ceil(prepared.rows.length / pageSize);
    ui.batchReview.hidden = false;
    ui.batchSummary.textContent = summaryText(prepared.counts);
    ui.batchPager.hidden = count <= 1;
    ui.batchPrevious.disabled = page === 0;
    ui.batchNext.disabled = page + 1 >= count;
    ui.batchPageInfo.textContent = count > 1 ? `第 ${page + 1} / ${count} 页` : '';
    const visible = prepared.rows.slice(page * pageSize, (page + 1) * pageSize).map((row,index) => {
      const tr = node('tr');
      const changes = node('td');
      const list = node('ul',undefined,'batch-changes');
      for (const [key,label,,percent] of fields) {
        if (row.before[key] !== row.after[key]) list.append(node('li',`${label}：${display(row.before[key],percent)} → ${display(row.after[key],percent)}`));
      }
      if (row.status === 'unchanged') changes.textContent = '—';
      else changes.append(list);
      tr.append(node('td',String(prepared.lines?.[page * pageSize + index] ?? page * pageSize + index + 2)),
        node('td',row.report_date,'catalog-asin'),node('td',row.asin,'catalog-asin'),node('td',statusLabels[row.status]),changes);
      return tr;
    });
    ui.batchRows.replaceChildren(...visible);
    updateControls();
  }

  function decodeCoverage(data, start, end) {
    const length = (Date.parse(end) - Date.parse(start)) / dayMs + 1;
    const malformed = () => { throw new Error('缺项检查返回的数据不完整，请重新检查。'); };
    const within = date => validDay(date) && date >= start && date <= end;
    const optionalAsin = asin => asin === null || typeof asin === 'string' && asinPattern.test(asin);
    if (data?.store !== 'MC' || data.marketplace !== 'amazon.com' || data.start_date !== start || data.end_date !== end ||
        !(data.catalog_date === null || validDay(data.catalog_date)) ||
        !Array.isArray(data.days) || data.days.length !== length || !Array.isArray(data.rows) ||
        !Array.isArray(data.identity_issues) || data.rows.length + data.identity_issues.length > coverageLimit) malformed();
    const reportKeys = Object.keys(reportLabels);
    const gaps = data.days.flatMap((day,index) => {
      if (day?.report_date !== shiftDay(start,index) || reportKeys.some(key => typeof day[key] !== 'boolean')) malformed();
      const missing = reportKeys.filter(key => !day[key]).map(key => reportLabels[key]);
      return missing.length ? [{date:day.report_date,missing}] : [];
    });
    const seen = new Set();
    for (const row of data.rows) {
      if (row?.status !== 'missing_cost' || !within(row.report_date) || typeof row.asin !== 'string' ||
          !asinPattern.test(row.asin) || !optionalAsin(row.parent_asin) || !Array.isArray(row.missing_fields) ||
          row.missing_fields.length === 0 || new Set(row.missing_fields).size !== row.missing_fields.length ||
          row.missing_fields.some(field => typeof field !== 'string' || !Object.hasOwn(costLabels,field))) malformed();
      const key = `${row.report_date}:${row.asin}`;
      if (seen.has(key)) malformed();
      seen.add(key);
    }
    for (const issue of data.identity_issues) {
      if (!(issue && Object.hasOwn(issueLabels,issue.status)) || !within(issue.report_date) ||
          typeof issue.sku !== 'string' || !issue.sku.trim() || [...issue.sku].length > 128 || !optionalAsin(issue.asin)) malformed();
    }
    const items = [...data.rows,...data.identity_issues].sort((a,b) => a.report_date.localeCompare(b.report_date) ||
      (a.asin ?? '').localeCompare(b.asin ?? '') || (a.sku ?? '').localeCompare(b.sku ?? ''));
    return {start,end,gaps,items,catalogDate:data.catalog_date,
      rows:items.filter(item => item.status === 'missing_cost'),issues:data.identity_issues.length};
  }

  function renderCoverageRows() {
    if (!coverage) return;
    const {items} = coverage;
    const pages = Math.ceil(items.length / pageSize);
    ui.batchCoverageTable.hidden = items.length === 0;
    ui.batchCoveragePager.hidden = pages < 2;
    ui.batchCoveragePrevious.disabled = coveragePage === 0;
    ui.batchCoverageNext.disabled = coveragePage + 1 >= pages;
    ui.batchCoveragePageInfo.textContent = pages > 1 ? `第 ${coveragePage + 1} / ${pages} 页` : '';
    const visible = items.slice(coveragePage * pageSize,(coveragePage + 1) * pageSize).map(row => {
      const issue = row.status !== 'missing_cost';
      const tr = node('tr');
      const action = issue ? issueLabels[row.status] : `缺：${row.missing_fields.map(key => costLabels[key]).join('、')}`;
      tr.append(node('td',row.report_date,'catalog-asin'),node('td',row.asin ?? '—','catalog-asin'),
        node('td',(issue ? row.sku : row.parent_asin) ?? '—','catalog-asin'),node('td',action));
      return tr;
    });
    ui.batchCoverageRows.replaceChildren(...visible);
  }

  function renderCoverage() {
    const {rows,gaps,issues,start,end,catalogDate} = coverage;
    ui.batchCoverageResult.hidden = false;
    ui.batchCoverageSummary.textContent =
      `${start} 至 ${end}（美西）：可补录 ${rows.length} 条（子 ASIN × 日期），待核对商品归属 ${issues} 条，${gaps.length} 天报表未齐。` +
      (catalogDate ? `商品按 ${catalogDate} 的目录匹配。` : '暂无产品目录快照。');
    ui.batchCoverageGaps.hidden = gaps.length === 0;
    ui.batchCoverageDays.replaceChildren(...gaps.map(({date,missing}) =>
      node('li',`${date}：缺 ${missing.join('、')}`)));
    const parts = Math.ceil(rows.length / csv.MAX_ROWS);
    ui.batchCoverageExport.hidden = ui.batchCoverageExportHelp.hidden = !parts;
    ui.batchCoveragePartField.hidden = parts < 2;
    ui.batchCoveragePart.replaceChildren(...Array.from({length:parts},(_,index) => {
      const option = node('option',`第 ${index + 1} / ${parts} 批（${Math.min(csv.MAX_ROWS, rows.length - index * csv.MAX_ROWS)} 条）`);
      option.value = String(index);
      return option;
    }));
    ui.batchCoveragePart.value = parts ? '0' : '';
    renderCoverageRows();
    updateControls();
  }

  function coverageError(error) {
    if (error.status === 403 || error.code === '42501') return '当前账号没有检查 MC 产品成本的权限。';
    if (error.status === 404 || error.code === 'PGRST202') return '成本缺项检查尚未启用，请联系管理员。';
    if (error.code === '22023') return '范围内记录太多或日期不再有效，请缩短日期范围后重新检查。';
    return batchError(error);
  }

  async function checkCoverage() {
    if (!auth || coverageJob) return;
    const start = ui.batchCoverageStart.value;
    const end = ui.batchCoverageEnd.value;
    clearCoverage();
    if (!validDay(start) || !validDay(end) || start < firstCoverageDay || start > end || end >= today() ||
        (Date.parse(end) - Date.parse(start)) / dayMs >= coverageDays) {
      status(ui.batchCoverageStatus,`请选择最多 ${coverageDays} 个已结束的美西日期，开始日期不能晚于结束日期。`,'error');
      return;
    }
    const pending = control('coverage');
    coverageJob = pending;
    updateControls();
    status(ui.batchCoverageStatus,'正在比对每日订单、交易、广告和成本…');
    try {
      const data = await rpc(coverageRpc,{p_start_date:start,p_end_date:end},pending);
      if (!pending.current()) return;
      coverage = decodeCoverage(data,start,end);
      renderCoverage();
      const partial = coverage.gaps.length || coverage.issues || !coverage.catalogDate;
      status(ui.batchCoverageStatus,partial ? '检查完成。报表未齐或归属待核对的部分，仍需补齐后重新检查。' :
        coverage.rows.length ? '检查完成，可下载补录 CSV。' : '检查完成，所选范围未发现需补录的成本。',partial ? '' : 'success');
    } catch (error) {
      if (pending.current()) status(ui.batchCoverageStatus,coverageError(error),'error');
    } finally {
      if (coverageJob === pending) { coverageJob = null; updateControls(); }
    }
  }

  function downloadCoverage(details) {
    if (!auth || !coverage) return;
    const value = ui.batchCoveragePart.value;
    const part = Number(value);
    const start = part * csv.MAX_ROWS;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(part) || start >= coverage.rows.length) return;
    const chosen = coverage.rows.slice(start,start + csv.MAX_ROWS);
    // Only validated dates and child ASINs enter these fixed import columns.
    // Every cost value remains blank; the file cannot change any cost as-is.
    const content = details
      ? '\uFEFF日期（美西）,子ASIN,缺失成本字段\r\n' + chosen.map(({report_date,asin,missing_fields}) =>
        [report_date,asin,missing_fields.map(field => costLabels[field]).join('、')].join(',') + '\r\n').join('')
      : csv.template() + chosen.map(({report_date,asin}) =>
        [report_date,asin,...fields.map(() => '')].join(',') + '\r\n').join('');
    const parts = Math.ceil(coverage.rows.length / csv.MAX_ROWS);
    download(content,`MC-${details ? '缺项明细-仅供核对' : '缺项补录'}-${coverage.start}至${coverage.end}-${part + 1}of${parts}.csv`);
  }

  async function preview() {
    if (!auth || job) return;
    const file = ui.batchFile.files?.[0];
    if (!file) return;
    clearPreview();
    if (file.size > csv.MAX_BYTES) {
      status(ui.batchStatus,'CSV 文件超过 1 MB，请分批处理。','error');
      return;
    }
    const pending = control('preview');
    job = pending;
    updateControls();
    status(ui.batchStatus,'正在检查 CSV 和查询当前成本…');
    let input;
    try {
      const bytes = await file.arrayBuffer();
      if (!pending.current()) return;
      let text;
      try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
      catch { throw new Error('无法读取此文件。请在 Excel 中另存为「CSV UTF-8」。'); }
      input = csv.parse(text,{today:today()});
      if (!input.length) throw new Error('没有可保存的记录，请填入至少一项成本。');
      const data = await rpc(previewRpc,{p_rows:input},pending);
      if (!pending.current()) return;
      prepared = decodePreview(data,input);
      render();
      status(ui.batchStatus,prepared.changed ? '预览完成，请核对下方变更。' : '所有记录都无变化，无需保存。','success');
    } catch (error) {
      if (pending.current()) status(ui.batchStatus,batchError(error,input?.sourceLines),'error');
    } finally {
      if (job === pending) { job = null; updateControls(); }
    }
  }

  async function save() {
    if (!auth || job || !prepared?.changed) return;
    const accepted = prepared;
    const pending = control('save');
    job = pending;
    updateControls();
    status(ui.batchStatus,'正在批量保存，请稍候…');
    try {
      const data = await rpc(saveRpc,{p_rows:accepted.patches},pending);
      if (!pending.current()) return;
      const outcome = summarize(data,accepted.patches.length);
      if (outcome.some((count,index) => count !== accepted.counts[index])) throw new Error('结果与预览不匹配');
      clearPreview();
      if (coverage || coverageJob) clearCoverage('成本已更新，请重新检查剩余缺项。');
      ui.batchFile.value = '';
      status(ui.batchStatus,`批量保存成功。${summaryText(outcome)}。`,'success');
    } catch (error) {
      if (!pending.current()) return;
      clearPreview();
      if (coverage || coverageJob) clearCoverage('保存结果已变化或暂无法确认，请重新检查剩余缺项。');
      status(ui.batchStatus,batchError(error,accepted.lines,true),'error');
    } finally {
      if (job === pending) { job = null; updateControls(); }
    }
  }

  function fileChanged() {
    if (job?.type === 'save') return;
    job?.controller.abort();
    job = null;
    clearPreview();
    status(ui.batchStatus);
  }

  function download(content, filename) {
    const url = URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
    const link = node('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  }

  async function template(includeCatalog) {
    if (!auth || templateJob) return;
    if (!includeCatalog) {
      download(csv.template({reportDate:today(),asins:[]}),'MC-每日成本-空白模板.csv');
      status(ui.batchTemplateStatus,'已生成空白模板。','success');
      return;
    }
    const date = ui.batchTemplateDate.value;
    if (!validDate(date)) {
      status(ui.batchTemplateStatus,'请选择有效的美西日期，不可晚于美西今天。','error');
      return;
    }
    const pending = control('template');
    templateJob = pending;
    updateControls();
    status(ui.batchTemplateStatus,'正在读取 MC 产品目录…');
    try {
      const data = await rpc(catalogRpc,{},pending);
      if (!pending.current()) return;
      if (data?.store !== 'MC' || data?.marketplace !== 'amazon.com' || !Array.isArray(data.products) ||
          !data.products.length || data.products.length > 20000 || data.products.some(item => !asinPattern.test(item?.asin ?? ''))) {
        throw new Error('无法读取有效的 MC 产品目录，请使用空白模板。');
      }
      const asins = [...new Set(data.products.map(item => item.asin))].sort();
      if (asins.length > csv.MAX_ROWS) throw new Error(`目录超过 ${csv.MAX_ROWS} 个子 ASIN，请用空白模板分批填写。`);
      download(csv.template({reportDate:date,asins}),`MC-每日成本-${date}-目录模板.csv`);
      status(ui.batchTemplateStatus,`已生成 ${date} 的目录模板，含 ${asins.length} 个子 ASIN。`,'success');
    } catch (error) {
      if (pending.current()) status(ui.batchTemplateStatus,batchError(error),'error');
    } finally {
      if (templateJob === pending) { templateJob = null; updateControls(); }
    }
  }

  async function init() {
    const attempt = ++generation;
    ui.loading.hidden = false;
    ui.loading.textContent = '正在验证登录状态…';
    if (![origin,`${origin}/`].includes(config?.SUPABASE_URL) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.SUPABASE_PUBLISHABLE_KEY || '') ||
        typeof br?.requireAuth !== 'function' || typeof csv?.parse !== 'function' || typeof csv?.template !== 'function') {
      ui.loading.textContent = '批量成本工具未加载，请刷新页面或联系管理员。';
      return;
    }
    try {
      const session = await br.requireAuth(login);
      if (attempt !== generation || !session) return;
      if (!session.user?.id || !session.session?.access_token) { expired(); return; }
      auth = session;
      ui.userEmail.textContent = auth.user.email || '—';
      ui.batchTemplateDate.value = ui.batchTemplateDate.max = today();
      const yesterday = updateCoverageLimits();
      ui.batchCoverageStart.value = shiftDay(yesterday,-6);
      ui.batchCoverageEnd.value = yesterday;
      ui.loading.hidden = true;
      ui.appShell.hidden = false;
      updateControls();
    } catch {
      if (attempt === generation) ui.loading.textContent = '暂时无法验证登录，请返回登录页重试。';
    }
  }

  ui.batchFile.addEventListener('change',fileChanged);
  ui.batchPreviewForm.addEventListener('submit',event => {event.preventDefault(); void preview();});
  ui.batchSave.addEventListener('click',() => { void save(); });
  ui.batchTemplateForm.addEventListener('submit',event => {event.preventDefault(); void template(true);});
  ui.batchDownloadBlank.addEventListener('click',() => { void template(false); });
  ui.batchTemplateDate.addEventListener('focus',() => { ui.batchTemplateDate.max = today(); });
  ui.batchCoverageForm.addEventListener('submit',event => {event.preventDefault(); void checkCoverage();});
  for (const element of [ui.batchCoverageStart,ui.batchCoverageEnd]) {
    element.addEventListener('focus',updateCoverageLimits);
    element.addEventListener('input',() => clearCoverage());
    element.addEventListener('change',() => clearCoverage());
  }
  ui.batchCoverageDownload.addEventListener('click',() => downloadCoverage(false));
  ui.batchCoverageDetailDownload.addEventListener('click',() => downloadCoverage(true));
  ui.batchCoveragePrevious.addEventListener('click',() => {
    if (coveragePage > 0 && coverage) { coveragePage--; renderCoverageRows(); }
  });
  ui.batchCoverageNext.addEventListener('click',() => {
    if (coverage && (coveragePage + 1) * pageSize < coverage.items.length) { coveragePage++; renderCoverageRows(); }
  });
  ui.batchPrevious.addEventListener('click',() => { if (page > 0) {page--; render();} });
  ui.batchNext.addEventListener('click',() => { if (prepared && (page+1)*pageSize < prepared.rows.length) {page++; render();} });
  ui.logoutBtn.addEventListener('click',async () => {
    reset();
    try { await br.logout(); } finally { location.replace(login); }
  });
  window.addEventListener('pagehide',reset);
  window.addEventListener('pageshow',event => { if (event.persisted) void init(); });
  window.addEventListener('storage',event => {
    if (event.key !== config?.SESSION_KEY && event.key !== null) return;
    const userId = v => {try {return JSON.parse(v)?.user?.id;} catch {return undefined;}};
    const before = userId(event.oldValue);
    const after = userId(event.newValue);
    if (after && after === before && (!auth || after === auth.user.id)) return;
    reset();
    if (event.newValue) void init();
    else location.replace(login);
  });
  void init();
})();
