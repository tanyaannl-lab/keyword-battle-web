'use strict';

(() => {
  const ids = ['appShell','loading','userEmail','logoutBtn','batchTemplateForm','batchTemplateDate','batchDownloadCatalog',
    'batchDownloadBlank','batchTemplateStatus','batchPreviewForm','batchFile','batchPreview','batchStatus','batchReview',
    'batchSummary','batchRows','batchPager','batchPrevious','batchPageInfo','batchNext','batchSave',
    'batchCoverageForm','batchCoverageStart','batchCoverageEnd','batchCoverageRun','batchCoverageStatus',
    'batchCoverageResult','batchCoverageSummary','batchCoverageGaps','batchCoverageDays','batchCoverageExport',
    'batchCoveragePartField','batchCoveragePart','batchCoverageDownload','batchCoverageDetailDownload','batchCoverageExportHelp',
    'batchCoverageTable','batchCoverageRows','batchCoveragePager','batchCoveragePrevious','batchCoveragePageInfo',
    'batchCoverageNext','batchMode','batchRangeOptions','batchRangeStart','batchRangeEnd','batchPolicy',
    'batchTemplatePanel','batchTemplateDateField','batchManualPanel','batchFileField','batchAsins','batchSampleInfo','batchInputHeading',
    'batchRatePanel','batchRateMode','batchOverwriteCheck','batchOverwriteField','batchCatalogPicker','batchFind','batchFindAdd','batchFindStatus','batchFindList',
    ...Array.from({length:6},(_,i)=>'batchValue'+i)];
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
  const rangePreviewRpc='mc_product_catalog_cost_range_preview';
  const rangeSaveRpc='mc_product_catalog_cost_range_save';
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
  let pickerJob = null;
  let pickerItems = null;
  const mode=()=>ui.batchMode.value;
  const manual=()=>mode()==='manual';
  const ranged=()=>mode()!=='dated';
  const vInputs=fields.map((_,i)=>ui['batchValue'+i]);
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
    ui.batchRangeOptions.hidden=!ranged();
    ui.batchManualPanel.hidden=!manual();
    ui.batchTemplatePanel.hidden=ui.batchFileField.hidden=manual();
    ui.batchTemplateDateField.hidden=ranged();
    ui.batchFile.required=!manual(); ui.batchRatePanel.hidden=manual(); ui.batchRateMode.disabled=manual()||saving||!auth;
    ui.batchMode.disabled=!auth || saving;
    for(const el of [ui.batchRangeStart,ui.batchRangeEnd,ui.batchPolicy]) el.disabled=!auth || saving || !ranged();
    for(const el of [ui.batchAsins,ui.batchFind,...vInputs]) el.disabled=!auth || saving || !manual();
    ui.batchFile.disabled = !auth || saving || manual();
    ui.batchOverwriteCheck.disabled=saving || !auth;
    ui.batchPreview.disabled = !auth || (manual() ? !ui.batchAsins.value.trim() || !vInputs.some(el=>el.value.trim()) : !ui.batchFile.files?.length) || !!job;
    ui.batchSave.disabled = !auth || !prepared || !prepared.changed || (!!prepared.overwrite && !ui.batchOverwriteCheck.checked) || !!job;
    ui.batchDownloadCatalog.disabled = !auth || !!templateJob;
    ui.batchDownloadBlank.disabled = !auth || !!templateJob;
    ui.batchTemplateDate.disabled = !auth || !!templateJob || ranged();
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
    ui.batchOverwriteCheck.checked=false; ui.batchOverwriteField.hidden=true;
    ui.batchRows.replaceChildren();
    ui.batchSummary.textContent = '';
    ui.batchPageInfo.textContent = '';
    updateControls();
  }

  function reset() {
    generation++;
    job?.controller.abort();
    templateJob?.controller.abort();
    pickerJob?.controller.abort(); pickerJob=null; pickerItems=null; ui.batchCatalogPicker.open=false; ui.batchFind.value=''; ui.batchFindList.replaceChildren(); ui.batchFindStatus.textContent='';
    job = templateJob = auth = null;
    ui.appShell.hidden = true;
    ui.userEmail.textContent = '';
    ui.batchFile.value = '';
    ui.batchAsins.value=''; vInputs.forEach(el=>el.value=''); ui.batchRangeStart.value=ui.batchRangeEnd.value='';
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
      (type === 'picker' ? pickerJob : type === 'coverage' ? coverageJob : type === 'template' ? templateJob : job)?.controller === controller};
  }

  class RpcError extends Error {
    constructor(status, body) {
      super('MC_COST_BATCH_RPC');
      this.status = status;
      this.code = body?.code;
      this.detailMessage=typeof body?.message==='string'?body.message:'';
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
    if (error.code==='22023' && /^子 ASIN 不在当前 MC 目录中/.test(error.detailMessage))
      return error.detailMessage.slice(0,220)+'。本批未写入。';
    if (error.code === '22023') return `${prefix}请核对该行的子 ASIN、日期或成本。${writing ? '本批未写入，请重新预览。' : '文件未写入。'}`;
    if (writing) return '未能确认保存结果。请重新预览，核对当前值后再操作。';
    if (error.name === 'TimeoutError') return '读取超时，请稍后重试。';
    if (error instanceof RpcError || error instanceof TypeError || error instanceof SyntaxError) return '暂时无法读取，请稍后重试。';
    return error.message || '暂时无法读取，请稍后重试。';
  }

  function importError(err,lines,writing=false) {
    if(ranged() && (err.code==='PGRST202'||err.status===404))return '日期区间功能尚未启用，请先在 MC 数据库安装区间成本更新。';
    let message=batchError(err,lines,writing);
    if(manual())message=message.replace(/^CSV 第 (\d+) 行：/,'第 $1 个子 ASIN：');
    return message;
  }

  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function display(value, percent) {
    if (value === null || value === undefined) return '—';
    return percent ? `${Number((value*100).toFixed(4))}%` : String(value);
  }

  function render() {
    if (!prepared) return;
    const count = Math.ceil(prepared.rows.length / pageSize);
    ui.batchReview.hidden = false;
    const range=prepared.range;
    ui.batchSummary.textContent = (range ? range.start+' 至 '+range.end+'（美西，含首尾） · '+range.items.length+' 个子 ASIN × '+range.days+' 天，共 '+range.total+' 条每日记录。' : '')+summaryText(prepared.counts);
    ui.batchSampleInfo.hidden=!range;
    ui.batchInputHeading.textContent=manual()?'产品序号':'CSV 行';
    if (range) ui.batchSampleInfo.textContent=(prepared.overwrite?'覆盖本次填写的字段':'只补空字段，已有值（包括 0）保留')+'。下方展示 '+prepared.rows.length+' 条样例，先列出已存成本的变更；上面的统计包含全部日期和产品。';
    ui.batchOverwriteField.hidden=!prepared.overwrite;
    if(prepared.rateNote)ui.batchSummary.textContent+='。'+prepared.rateNote;
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
    if (error.code==='22023' && /^子 ASIN 不在当前 MC 目录中/.test(error.detailMessage))
      return error.detailMessage.slice(0,220)+'。本批未写入。';
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

  function rangeDates() {
    const start=ui.batchRangeStart.value,end=ui.batchRangeEnd.value,policy=ui.batchPolicy.value;
    const days=(Date.parse(end)-Date.parse(start))/dayMs+1;
    if(!validDate(start)||!validDate(end)||!Number.isInteger(days)||days<1||days>92)
      throw new Error('请选择连续 1–92 天的美西日期，结束日期最晚为美西今天。');
    if(!['fill_missing','overwrite'].includes(policy))throw new Error('请选择已有成本的处理方式。');
    return {start,end,days,policy};
  }

  function enteredAsins(){
    return [...new Set(ui.batchAsins.value.toUpperCase().trim().split(/[\s,，、;；]+/).filter(Boolean))];
  }
  function manualRows() {
    const ids=enteredAsins();
    if(!ids.length || ids.length>csv.MAX_ROWS)throw new Error('请填写 1–1,000 个子 ASIN。');
    const bad=ids.find(v=>!asinPattern.test(v));
    if(bad)throw new Error('无效的子 ASIN：'+bad.slice(0,30)+'。请填写 10 位数字或英文字母。');
    const values=vInputs.map(el=>el.value.trim());
    if(values.every(v=>!v))throw new Error('请至少填一个成本字段。');
    const cells=values.map(v=>'"'+v.replace(/"/g,'""')+'"').join(',');
    // Parse just one set of amounts with the same numeric and percentage rules as the CSV form.
    let row;
    try {row=csv.parse(csv.HEADERS.join(',')+'\n'+today()+','+ids[0]+','+cells,{today:today(),rateMode:'percent'})[0];}
    catch(err){throw new Error(err.message.replace(/^CSV 第 \d+ 行：/,''));}
    const out=ids.map(asin=>({asin,values:row.values}));
    Object.defineProperty(out,'sourceLines',{value:ids.map((_,i)=>i+1)});
    return out;
  }

  function decodeRange(data,range,payload,lines) {
    const counts=summarize(data,range.total);
    const bad=()=>{throw new Error('区间预览与选择的产品或日期不一致，请重新预览。');};
    if(typeof data.token!=='string' || !/^[a-f0-9]{64}$/.test(data.token) ||
       data.asin_count!==range.items.length||data.day_count!==range.days||data.total_count!==range.total||
       !Array.isArray(data.rows)||data.rows.length!==Math.min(30,range.total))bad();
    const inputs=new Map(range.items.map((v,i)=>[v.asin,{item:v,index:i}]));
    const seen=new Set(), fieldKeys=fields.map(([k])=>k);
    const sampleLines=[],sampleCounts={new:0,update:0,unchanged:0};
    for(const row of data.rows){
      if(!row || !inputs.has(row.asin) || !validDate(row.report_date)||row.report_date<range.start||row.report_date>range.end||
        !Object.hasOwn(statusLabels,row.status)||!row.before||Array.isArray(row.before)||typeof row.before!=='object'||
        !row.after||Array.isArray(row.after)||typeof row.after!=='object')bad();
      const pair=row.report_date+':'+row.asin;
      if(seen.has(pair))bad(); seen.add(pair);
      const {item,index}=inputs.get(row.asin);
      if([...Object.keys(row.before),...Object.keys(row.after)].some(k=>!fieldKeys.includes(k)))bad();
      const changed=fieldKeys.some(k=>row.before[k]!==row.after[k]);
      if((row.status==='new'&&Object.keys(row.before).length) || (row.status==='unchanged')===changed)bad();
      for(const [key,,max] of fields){
        const before=row.before[key],after=row.after[key];
        for(const v of [before,after]) if(v!==undefined&&!(typeof v==='number'&&Number.isFinite(v)&&v>=(key==='exchange_rate'?0.000001:0)&&v<=max))bad();
        const expected=range.policy==='fill_missing' ? before??item.values[key] : item.values[key]??before;
        if(after!==expected)bad();
      }
      sampleLines.push(lines?.[index]??index+1);
      sampleCounts[row.status]++;
    }
    if(['new','update','unchanged'].some((k,i)=>sampleCounts[k]>counts[i]))bad();
    return {range,payload,token:data.token,rows:data.rows,lines:sampleLines,inputLines:lines,counts,
      changed:counts[0]+counts[1],overwrite:range.policy==='overwrite'&&counts[1]>0};
  }

  function filteredPicker(){
    const q=ui.batchFind.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (pickerItems||[]).filter(x=>q.every(term=>x.search.includes(term)));
  }
  function drawPicker(){
    if(!pickerItems)return;
    const list=filteredPicker(), q=ui.batchFind.value.trim();
    ui.batchFindStatus.textContent='匹配 '+list.length+' 个子 ASIN，显示前 '+Math.min(list.length,30)+' 个。点击产品添加；也可以先搜索，再添加全部匹配。';
    ui.batchFindAdd.disabled=!auth || job?.type==='save' || !q || !list.length || list.length>csv.MAX_ROWS;
    ui.batchFindList.replaceChildren(...list.slice(0,30).map(item=>{
      const b=node('button',item.asin+' · '+item.label,'catalog-button');
      b.type='button'; b.addEventListener('click',()=>addAsins([item.asin]));return b;
    }));
  }
  function addAsins(values){
    if(!auth || !manual() || job?.type==='save' || !values.length)return;
    const ids=[...new Set([...enteredAsins(),...values])];
    if(ids.length>csv.MAX_ROWS){status(ui.batchStatus,'每次最多 1,000 个子 ASIN，请缩小匹配范围。','error');return;}
    ui.batchAsins.value=ids.join('\n');fileChanged();
  }
  async function loadPicker(){
    if(!auth || pickerJob || !manual())return;
    if(pickerItems){drawPicker();return;}
    const pending=control('picker');pickerJob=pending;
    ui.batchFindStatus.textContent='正在读取目录…';
    try{
      const d=await rpc(catalogRpc,{},pending);
      if(!pending.current())return;
      if(d?.store!=='MC'||d.marketplace!=='amazon.com'||!Array.isArray(d.products)||d.products.length>20000)throw new Error('目录格式有误。');
      const rows=new Map();
      for(const r of d.products){
        if(!asinPattern.test(r.asin)||typeof r.sku!=='string')continue;
        const item=rows.get(r.asin)||{asin:r.asin,label:r.sku,search:''};
        const pieces=[r.asin,r.sku,r.parent_asin,...(Array.isArray(r.owners)?r.owners:[]),r.operator_name,r.product_short_name];
        item.search+=' '+pieces.filter(v=>typeof v==='string').join(' ').toLowerCase();rows.set(r.asin,item);
      }
      pickerItems=[...rows.values()];drawPicker();
    }catch(e){if(pending.current())ui.batchFindStatus.textContent=batchError(e)+' 可直接粘贴子 ASIN，或重新展开目录重试。';}
    finally{if(pickerJob===pending)pickerJob=null;}
  }

  async function preview() {
    if (!auth || job) return;
    const file = manual()?null:ui.batchFile.files?.[0];
    if (!manual() && !file) return;
    clearPreview();
    if (file && file.size > csv.MAX_BYTES) {
      status(ui.batchStatus,'CSV 文件超过 1 MB，请分批处理。','error');
      return;
    }
    const pending = control('preview');
    job = pending;
    updateControls();
    status(ui.batchStatus,'正在核对填写内容和已有成本…');
    let input;
    try {
      const range=ranged()?rangeDates():null;
      if(manual()) input=manualRows();
      else {
        const bytes=await file.arrayBuffer();
        if(!pending.current())return;
        const str=csv.decode(bytes);
        input=range ? csv.parseRange(str,{today:today(),rateMode:ui.batchRateMode.value}) : csv.parse(str,{today:today(),rateMode:ui.batchRateMode.value});
      }
      if (!input.length) throw new Error('请填入至少一项成本。');
      if(range) {
        range.items=input.map(({asin,values})=>({asin,values}));
        range.total=range.items.length*range.days;
        const payload={p_start_date:range.start,p_end_date:range.end,p_mode:range.policy,p_rows:range.items};
        const data=await rpc(rangePreviewRpc,payload,pending);
        if(!pending.current())return;
        prepared=decodeRange(data,range,payload,input.sourceLines);
      } else {
        const data=await rpc(previewRpc,{p_rows:input},pending);
        if(!pending.current())return;
        prepared=decodePreview(data,input);
      }
      const rateNotes=[];
      for(const [key,label] of [['commission_rate','佣金率'],['vat_rate','VAT 税率']]){
        const rates=[...new Set(input.map(row=>row.values[key]).filter(v=>v!==undefined))].sort((a,b)=>a-b);
        if(rates.length)rateNotes.push(label+' '+rates.slice(0,5).map(v=>display(v,true)).join('、')+(rates.length>5?' 等 '+rates.length+' 种':''));
      }
      prepared.rateNote=rateNotes.length?'本次填写：'+rateNotes.join('；'):'';
      render();
      status(ui.batchStatus,prepared.changed ? '预览完成，请核对下方变更。' : '所有记录都无变化，无需保存。','success');
    } catch (error) {
      if (pending.current()) status(ui.batchStatus,importError(error,input?.sourceLines),'error');
    } finally {
      if (job === pending) { job = null; updateControls(); }
    }
  }

  async function save() {
    if (!auth || job || !prepared?.changed || (prepared.overwrite && !ui.batchOverwriteCheck.checked)) return;
    const accepted = prepared;
    const pending = control('save');
    job = pending;
    updateControls();
    status(ui.batchStatus,'正在批量保存，请稍候…');
    try {
      const data = await rpc(accepted.range ? rangeSaveRpc : saveRpc,accepted.range ? {...accepted.payload,p_token:accepted.token} : {p_rows:accepted.patches},pending);
      if (!pending.current()) return;
      const outcome = summarize(data,accepted.range?.total ?? accepted.patches.length);
      if(accepted.range && (!data?.saved || data.asin_count!==accepted.range.items.length || data.day_count!==accepted.range.days || data.total_count!==accepted.range.total)) throw new Error('保存结果与预览不匹配');
      if (outcome.some((count,index) => count !== accepted.counts[index])) throw new Error('结果与预览不匹配');
      clearPreview();
      if (coverage || coverageJob) clearCoverage('成本已更新，请重新检查剩余缺项。');
      if(!manual()){ui.batchFile.value='';ui.batchRateMode.value='auto';}
      status(ui.batchStatus,`批量保存成功。${accepted.range?accepted.range.start+' 至 '+accepted.range.end+'（美西），已逐日保存。':''}${summaryText(outcome)}。`,'success');
    } catch (error) {
      if (!pending.current()) return;
      clearPreview();
      if (coverage || coverageJob) clearCoverage('保存结果已变化或暂无法确认，请重新检查剩余缺项。');
      status(ui.batchStatus,importError(error,accepted.inputLines??accepted.lines,true),'error');
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
      if(ranged())download(csv.templateRange({asins:[]}),'MC-区间成本-空白模板.csv');
      else download(csv.template({reportDate:today(),asins:[]}),'MC-每日成本-空白模板.csv');
      status(ui.batchTemplateStatus,'已生成空白模板。','success');
      return;
    }
    const date = ranged()?today():ui.batchTemplateDate.value;
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
      if(ranged())download(csv.templateRange({asins}), 'MC-区间成本-目录模板.csv');
      else download(csv.template({reportDate:date,asins}),`MC-每日成本-${date}-目录模板.csv`);
      status(ui.batchTemplateStatus,ranged()?`已生成目录模板，含 ${asins.length} 个子 ASIN。每个产品只填一次，日期以页面选择为准。`:`已生成 ${date} 的目录模板，含 ${asins.length} 个子 ASIN。`,'success');
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
        typeof br?.requireAuth !== 'function' || !['parse','parseRange','decode','template','templateRange'].every(k=>typeof csv?.[k]==='function')) {
      ui.loading.textContent = '批量成本工具未加载，请刷新页面或联系管理员。';
      return;
    }
    try {
      const session = await br.requireAuth(login);
      if (attempt !== generation || !session) return;
      if (!session.user?.id || !session.session?.access_token) { expired(); return; }
      auth = session;
      ui.userEmail.textContent = auth.user.email || '—';
      ui.batchRateMode.value='auto'; ui.batchMode.value='range_csv'; ui.batchPolicy.value='fill_missing';
      ui.batchRangeStart.value=ui.batchRangeEnd.value=ui.batchRangeStart.max=ui.batchRangeEnd.max=today();
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

  ui.batchMode.addEventListener('change',()=>{if(job?.type==='save')return;fileChanged(); ui.batchPolicy.value='fill_missing';ui.batchRateMode.value='auto';updateControls();});
  for(const el of [ui.batchRateMode,ui.batchPolicy,ui.batchRangeStart,ui.batchRangeEnd,ui.batchAsins,...vInputs]){
    el.addEventListener('input',fileChanged);el.addEventListener('change',fileChanged);
  }
  ui.batchCatalogPicker.addEventListener('toggle',()=>{ if(ui.batchCatalogPicker.open)void loadPicker(); });
  ui.batchFind.addEventListener('input',drawPicker);
  ui.batchFindAdd.addEventListener('click',()=>{if(ui.batchFind.value.trim())addAsins(filteredPicker().map(item=>item.asin));});
  ui.batchOverwriteCheck.addEventListener('change',updateControls);
  ui.batchFile.addEventListener('change',()=>{if(job?.type==='save')return; ui.batchRateMode.value='auto';fileChanged();});
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
