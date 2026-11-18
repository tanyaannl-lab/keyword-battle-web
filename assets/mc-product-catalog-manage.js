'use strict';

(() => {
  const origin = 'https://peykqsnlistkhrqsiulx.supabase.co';
  const limit = 100;
  const key = item => JSON.stringify([item.asin, item.sku]);
  const actions = { add:'新增', edit:'修改', delete:'删除' };
  const labelKeys = ['operator_name','product_short_name'];
  const allowedAsin = /^[A-Z0-9]{10}$/;
  const sameDisplayValues = (expected, actual) => expected && actual &&
    expected.asin===actual.asin && expected.sku===actual.sku && expected.parent_asin===actual.parent_asin &&
    Array.isArray(expected.owners) && Array.isArray(actual.owners) &&
    labelKeys.every(k=>!Object.hasOwn(expected,k) || (expected[k] ?? '')===(actual[k] ?? '')) &&
    JSON.stringify([...expected.owners].sort())===JSON.stringify([...actual.owners].sort());
  const needReload = message => Object.assign(Error(message), {reload:true});
  const asProduct = row => ({ asin:row.asin, parent_asin:row.parent, sku:row.sku, owners:[...row.owners],
    operator_name:row.operator_name ?? '', product_short_name:row.product_short_name ?? '' });
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '2000-01-03' &&
    value <= '2099-12-31' && !Number.isNaN(Date.parse(value+'T00:00:00Z')) &&
    new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
  function asin(raw) {
    const value = raw.trim().toUpperCase();
    if (!allowedAsin.test(value)) throw Error('父 ASIN 和子 ASIN 均需填写 10 位字母或数字。');
    return value;
  }
  function owners(raw) {
    const list = raw.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (list.length > 20 || list.some(name => [...name].length > 160 || /[\u0000-\u001F\u007F-\u009F]/u.test(name))) throw Error('负责人最多 20 位，每个名字最多 160 个字符；请每行填写一位。');
    if (new Set(list).size !== list.length) throw Error('负责人重复，请核对。');
    return list;
  }
  function inputLabel(raw, name) {
    if (typeof raw!=='string' || raw!==raw.trim() || [...raw].length>160 || /[\u0000-\u001F\u007F-\u009F]/u.test(raw)) throw Error(name+'最多 160 个字符，不能包含控制字符或首尾空格。');
    return raw;
  }
  function sku(raw) {
    if (!raw || raw.trim() !== raw || [...raw].length > 128 || /[\u0000-\u001F\u007F-\u009F]/u.test(raw)) throw Error('请填写 SKU，勿包含首尾空格、换行或控制字符。');
    return raw;
  }
  function mount(host) {
    const csv = window.MCProductCatalogManageCsv;
    const ids = 'Add Page Selected Filtered Clear Batch Drop Import Export Notice Panel Title Desc Siblings Single Asin Parent Sku Owners Operator ShortName Multi SetParent NewParent SetOwners NewOwners SetOperator NewOperator SetShortName NewShortName Report Bind Dates ReportParent Start End Long Csv Format SourceHelp ManageHelp Template File Status Review Totals PreviewRows Close Preview Save Reload Unverified OriginalWarning AcceptOriginal'.split(' ');
    const ui = Object.fromEntries(ids.map(id => [id, document.getElementById('cm'+id)]));
    let selected = new Map(), mode = '', targets = [], importRows = [], lines = [], baselines = [];
    let preview = null, active = null, stamp = 0, saving = false, loaded = false, readingFile = false, sourceNotice = '';
    const action = (el, fn) => el.addEventListener('click', fn);
    const el = (tag, text) => {
      const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n;
    };
    const msg = (at, text='', state='') => {
      at.textContent = text; at.hidden = !text;
      if (state) at.dataset.state = state; else delete at.dataset.state;
    };
    function invalidate() {
      stamp++; active?.abort(); active = null; preview = null;
      ui.Review.hidden = true; ui.PreviewRows.replaceChildren(); ui.Totals.textContent = '';
      ui.Save.disabled = true; ui.Preview.disabled = saving;
      ui.Reload.hidden = true; ui.Unverified.hidden = true; ui.OriginalWarning.textContent=''; ui.AcceptOriginal.checked=false;
      msg(ui.Status);
    }
    function refresh() {
      loaded = true;host.setFiltersBusy(saving);
      const available = host.getVisible(), page = host.getPage();
      const outside=selected.size-available.reduce((n,r)=>n+Number(selected.has(key(r))),0);
      ui.Selected.textContent = '已选 '+selected.size+' 行'+(outside?'（其中 '+outside+' 行不在当前筛选中）':'');
      ui.Filtered.disabled = !available.length || saving;
      ui.Page.disabled = !page.length || saving;
      const checked = page.filter(row => selected.has(key(row))).length;
      ui.Page.checked = !!page.length && page.length === checked; ui.Page.indeterminate = checked > 0 && checked !== page.length;
      ui.Batch.disabled = ui.Drop.disabled = ui.Clear.disabled = !selected.size || saving;
      ui.Add.disabled = ui.Import.disabled = saving;
      ui.Export.disabled = saving || !available.length;
    }
    function close() {
      invalidate(); sourceNotice=''; mode = ''; targets = []; importRows = []; lines = []; baselines = [];
      ui.Panel.hidden = true; ui.Csv.hidden = true; ui.Siblings.hidden = true; readingFile = false;
      ui.Format.value='manage'; ui.File.value = ''; ui.File.disabled = false;
      for (const field of ['Asin','Parent','Sku','Owners','Operator','ShortName','NewParent','NewOwners','NewOperator','NewShortName','ReportParent','Start','End']) ui[field].value = '';
      for (const field of ['SetParent','SetOwners','SetOperator','SetShortName','Bind','Long']) ui[field].checked = false;
      ui.Title.textContent = ''; ui.Desc.textContent = '';
      controls();
    }
    function reset() {
      saving = false; loaded = false; host.setFiltersBusy(false); close(); selected.clear(); msg(ui.Notice);
      ui.Add.disabled = true; ui.Selected.textContent = '已选 0 行';
    }
    function controls() {
      ui.Single.hidden = !['add','edit'].includes(mode); ui.Multi.hidden = mode !== 'batch';
      ui.Report.hidden = !['add','edit','batch'].includes(mode); ui.Csv.hidden = mode !== 'import';
      const source=ui.Format.value==='source';
      ui.SourceHelp.hidden=!source; ui.ManageHelp.hidden=ui.Template.hidden=source; ui.Format.disabled=saving;
      ui.Dates.hidden = !ui.Bind.checked; ui.End.disabled = saving || ui.Long.checked;
      ui.NewParent.disabled = saving || !ui.SetParent.checked; ui.NewOwners.disabled = saving || !ui.SetOwners.checked;
      ui.NewOperator.disabled=saving || !ui.SetOperator.checked; ui.NewShortName.disabled=saving || !ui.SetShortName.checked;
      for (const x of ['SetParent','SetOwners','SetOperator','SetShortName','Bind','ReportParent','Start','Long','Asin','Parent','Sku','Owners','Operator','ShortName','Close','Template','File']) ui[x].disabled = saving;
      ui.Preview.disabled = !!active || saving || readingFile; ui.Save.disabled = !preview || !preview.changed || (preview.unverified && !ui.AcceptOriginal.checked) || saving;
    }
    function open(next, rows=[]) {
      if (!host.getAuth() || !loaded || saving) return;
      close(); mode = next; targets = rows;
      const n = rows.length, first = rows[0], title = {add:'新增产品', edit:'修改产品', delete:'删除产品', batch:'批量修改产品', drop:'批量删除产品', import:'从 CSV 批量管理产品'};
      ui.Title.textContent = title[next];
      const desc = {
        add:'填写一行产品目录。子 ASIN 与 SKU 确定一行，成本按子 ASIN 和日期维护。',
        edit:first ? '正在修改 '+first.asin+' / '+first.sku+'。目录修改从保存的美西当日起用于每日经营明细和周结果的 SKU 数据。更换子 ASIN 或 SKU 不会搬移原标识下的成本或报表事实。' : '',
        delete:'将从当前产品目录移除所选产品。历史成本、订单、广告等原始数据保留；使用当前目录匹配的报表展示可能受影响。',
        drop:'将从当前产品目录移除所选 '+n+' 行。历史成本和原始报表保留；依赖目录匹配的报表展示可能受影响。请在预览中核对每一行。',
        batch:'将修改所选 '+n+' 行。只勾选需要更改的字段；要给每行填不同的值，请使用 CSV。',
        import:'可在同一个文件里新增、修改或删除产品。系统会先列出变更，确认后才会保存。'
      };
      ui.Desc.textContent = desc[next];
      if(first && next==='edit') {
        const count=host.getProducts().filter(r=>r.asin===first.asin).length;
        if(count>1) {
          ui.Desc.textContent += ' 此子 ASIN 共有 '+count+' 个 SKU；如要更改目录父 ASIN，请一并修改。';
          ui.Siblings.hidden=false;
          ui.Siblings.textContent='一起修改该子 ASIN 的 '+count+' 个 SKU';
        }
      }
      if (first && next === 'edit') {
        ui.Asin.value = first.asin; ui.Parent.value = first.parent; ui.Sku.value = first.sku;
        ui.Owners.value = first.owners.join('\n');
        ui.Operator.value=first.operator_name; ui.ShortName.value=first.product_short_name;
      }
      ui.Save.textContent = ['delete','drop'].includes(next) ? '确认删除' : '确认保存';
      ui.Panel.hidden = false; controls(); msg(ui.Notice); ui.Title.focus();
    }
    function updateSelection(items, add) {
      if (saving || !loaded) return;
      const next = new Map(selected);
      for (const row of items) { if (add) next.set(key(row),row); else next.delete(key(row)); }
      if (next.size > limit) {
        msg(ui.Notice,'一次最多可操作 100 行，请缩小筛选范围或分批选择。','error'); host.render(); return;
      }
      if (mode==='batch' || mode==='drop') close();
      selected = next; msg(ui.Notice); host.render();
    }
    function filterChanged() {
      if (!loaded || saving) return;
      const wasSelected=selected.size;
      selected.clear();
      const closed=mode==='batch' || mode==='drop' || mode==='delete';
      if (closed) close();
      if (wasSelected || closed) {
        msg(ui.Notice,'筛选条件已更改，原勾选和待执行的批量操作已清除。请按当前结果重新选择。');
        refresh();
      }
    }
    function decorate(row, selectCell, actionsCell) {
      const box = el('input'); box.type='checkbox'; box.className='cm-row-check';
      box.checked = selected.has(key(row)); box.disabled = saving; box.setAttribute('aria-label','选择 '+row.asin+' / '+row.sku);
      box.addEventListener('change',()=>updateSelection([row],box.checked)); selectCell.append(box);
      for (const op of ['edit','delete']) {
        const b = el('button',actions[op]); b.type='button'; b.className='cm-action'+(op==='delete'?' cm-danger':''); b.disabled = saving;
        b.setAttribute('aria-label',actions[op]+'产品 '+row.asin+' / '+row.sku); action(b,()=>open(op,[row])); actionsCell.append(b);
      }
    }
    function dateFields() {
      if (!ui.Bind.checked) return {};
      if (!validDate(ui.Start.value)) throw Error('请选择报表归属开始日期。');
      if (!ui.Long.checked && (!validDate(ui.End.value) || ui.End.value < ui.Start.value)) throw Error('请选择有效的结束日期；没有截止日请明确勾选「长期生效」。');
      return {start_date:ui.Start.value, end_date:ui.Long.checked ? null : ui.End.value,
        ...(ui.ReportParent.value.trim() ? {report_parent_asin:asin(ui.ReportParent.value)} : {})};
    }
    function getRows() {
      if (mode==='import') {
        if (!importRows.length) throw Error('请选择包含操作行的 CSV 文件。');
        return importRows;
      }
      if (mode==='delete'||mode==='drop') return targets.map(x=>({action:'delete',old_asin:x.asin,old_sku:x.sku}));
      const dates = dateFields();
      if (mode==='batch') {
        if (!(ui.SetParent.checked || ui.SetOwners.checked || ui.SetOperator.checked || ui.SetShortName.checked || ui.Bind.checked)) throw Error('请至少选择一项修改，或确认报表日期内的父 ASIN 归属。');
        const data = {};
        if (ui.SetParent.checked) data.parent_asin = asin(ui.NewParent.value);
        if (ui.SetOwners.checked) data.owners = owners(ui.NewOwners.value);
        if (ui.SetOperator.checked) data.operator_name=inputLabel(ui.NewOperator.value,'运营名称');
        if (ui.SetShortName.checked) data.product_short_name=inputLabel(ui.NewShortName.value,'产品简称');
        return targets.map(x=>({action:'edit',old_asin:x.asin,old_sku:x.sku,asin:x.asin,parent_asin:x.parent,sku:x.sku,owners:[...x.owners],...data,...dates}));
      }
      if (!['edit','add'].includes(mode)) throw Error('请先选择要进行的操作。');
      const item = {action:mode,asin:asin(ui.Asin.value),parent_asin:asin(ui.Parent.value),sku:sku(ui.Sku.value),owners:owners(ui.Owners.value),...dates};
      for(const [k,value] of [['operator_name',inputLabel(ui.Operator.value,'运营名称')],['product_short_name',inputLabel(ui.ShortName.value,'产品简称')]]) {
        if(mode==='add' ? value!=='' : value!==targets[0][k]) item[k]=value;
      }
      if (mode==='edit') { item.old_asin = targets[0].asin; item.old_sku = targets[0].sku; }
      return [item];
    }
    function renderPlan(data, rows) {
      if (!data || typeof data.token !== 'string' || !data.token || !Array.isArray(data.rows) || data.rows.length !== rows.length ||
        !['added','edited','deleted','unchanged'].every(k => Number.isInteger(data[k]) && data[k]>=0) ||
        data.rows.some((r,i) => r.action !== rows[i].action || !Number.isInteger(r.input_row) || r.input_row!==i+1 ||
          (r.action !== 'add' && !r.before) || (r.action !== 'delete' && !r.after))) throw Error('预览结果格式有误，请重新预览。');
      const existing=new Map(host.getProducts().map(r=>[key(r),asProduct(r)]));
      let unverified=0;
      data.rows.forEach((r,i)=>{
        const op=rows[i]; if(op.action==='add')return;
        const id=JSON.stringify([op.old_asin,op.old_sku]);
        const fileOriginal=mode==='import'?baselines[i]:null;
        const expected=fileOriginal || existing.get(id);
        if(!sameDisplayValues(expected,r.before)){
          const row=mode==='import' && lines[i]?'CSV 第 '+lines[i]+' 行 · ':'';
          throw needReload(row+op.old_asin+' / '+op.old_sku+' 的目录资料已变化，本批未保存。'+
            (fileOriginal?'请重新导出最新目录，核对该行后再导入。':'请重新读取目录，核对该行后再预览。'));
        }
        if(mode==='import' && (!fileOriginal || (op.action==='delete' && labelKeys.some(k=>!Object.hasOwn(fileOriginal,k)))))unverified++;
      });
      const label = x => x ? '子：'+x.asin+'\n父：'+x.parent_asin+'\nSKU：'+x.sku+'\n负责人：'+(x.owners?.join('、') || '未指定')+'\n运营名称：'+(x.operator_name || '—')+'\n产品简称：'+(x.product_short_name || '—') : '—';
      const fragment = document.createDocumentFragment();
      data.rows.forEach((r,i) => {
        const tr = el('tr'), state=r.status==='unchanged'?'（未变）':r.report_changed?'（含报表归属）':'';
        let dates='—';
        if (r.start_date) {
          if(!Array.isArray(r.report_before)) throw Error('请先安装本次更新包的 SQL，然后重新预览报表归属。');
          const prior=r.report_before.map(v=>v.parent_asin+'（'+v.start_date+' 至 '+(v.end_date || '长期')+'）');
          dates='原指定：'+(prior.length?prior.join('；'):'无')+'\n新：'+
            (r.report_parent_asin || rows[i].report_parent_asin || r.after?.parent_asin)+'\n'+r.start_date+' 至 '+(r.end_date || '长期');
        }
        tr.append(el('td',(mode === 'import' && lines[i] ? 'CSV 第 '+lines[i]+' 行 · ' : '')+actions[r.action]+state),
          el('td',label(r.before)),el('td',label(r.after)),el('td',dates));
        fragment.append(tr);
      });
      ui.PreviewRows.replaceChildren(fragment);
      const summary = totals(data);
      ui.Totals.textContent = summary+'。请核对原标识、新标识及报表日期。'+(mode==='import'&&ui.Format.value==='source'?sourceNotice:'');
      ui.Review.hidden = false;
      preview = {token:data.token, rows, counts:['added','edited','deleted','unchanged'].map(k=>data[k]), unverified,
        changed:data.added + data.edited + data.deleted};
      ui.Unverified.hidden=!unverified;
      if(unverified)ui.OriginalWarning.textContent=ui.Format.value==='source' ?
        '源表中有 '+unverified+' 行将更新已有产品。请将目录原值与运营源表逐行核对，确认后再保存。' :
        '有 '+unverified+' 条修改或删除缺少完整的导出原值，无法判断填表期间是否有人改过。建议使用新导出的模板；如需继续，请核对下面每一行的修改前后。';
      ui.Save.textContent = data.deleted ? '确认保存（含删除 '+data.deleted+' 行）':'确认保存';
      msg(ui.Status,preview.changed ? '预览完成，还未写入。' : '没有需要保存的变更。');
    }
    function totals(data) { return '新增 '+data.added+' 行，修改 '+data.edited+' 行，删除 '+data.deleted+' 行，未变 '+data.unchanged+' 行'; }
    async function send(write) {
      if (!loaded || !host.getAuth() || !mode || saving || active || (write && (!preview?.changed || (preview.unverified && !ui.AcceptOriginal.checked)))) return;
      let rows, token;
      if (write) { rows=preview.rows; token=preview.token; } else {
        invalidate(); try { rows=getRows(); } catch(e) { msg(ui.Status,e.message,'error'); return; }
      }
      const mine=++stamp, user=host.getAuth().user.id;
      const controller=new AbortController(); active=controller; saving=write;
      const current=()=> active===controller && stamp===mine && host.getAuth()?.user?.id===user;
      controls(); host.render(); msg(ui.Status,write?'正在保存，请稍候…':'正在预览…');
      try {
        const session=await window.KBAuth.getValidSession();
        if (!current()) return;
        if (!session?.session?.access_token || session.user?.id!==user) { host.signedOut(); return; }
        const endpoint='mc_product_catalog_manage_'+(write?'save':'preview');
        const resp=await fetch(origin+'/rest/v1/rpc/'+endpoint,{method:'POST',headers:{
          Accept:'application/json','Content-Type':'application/json',apikey:window.KB_CONFIG.SUPABASE_PUBLISHABLE_KEY,
          Authorization:'Bearer '+session.session.access_token},body:JSON.stringify(write?{p_rows:rows,p_token:token}:{p_rows:rows}),
          mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
          signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
        if (!current()) return;
        if (resp.status===401) {host.signedOut();return;}
        const data=await resp.json().catch(()=>null);
        if (!current()) return;
        if (!resp.ok) {
          if(resp.status===403 || data?.code==='42501') throw Error('当前账号没有维护 MC 产品目录的权限。');
          if(resp.status===404 || data?.code==='PGRST202') throw Error('产品目录管理接口尚未启用，请先安装本次更新包内的 SQL。');
          if(data?.code==='40001') throw needReload('目录或报表归属已变化，本次未保存。请重新预览并核对最新内容。');
          const isInput=['22023','23505','23514','P0001'].includes(data?.code);
          if(isInput) {
            let detail; try {detail=JSON.parse(data.details||'null');} catch {}
            const i=detail?.row || detail?.input_row;
            const prefix=Number.isInteger(i) ? (mode==='import' && lines[i-1] ? 'CSV 第 '+lines[i-1]+' 行：' : '第 '+i+' 行：') : '';
            throw Error(prefix+String(data.message || '目录数据未通过校验，请核对原行、SKU 和父 ASIN。').slice(0,350));
          }
          if(write) throw needReload('暂时无法确认是否已保存，请重新读取目录核对。');
          throw Error('暂时无法预览，请重试。');
        }
        if(write) {
          if(!data || !['added','edited','deleted','unchanged'].every((name,i)=>data[name]===preview.counts[i])) throw needReload('无法确认本批保存结果，请重新读取目录核对。');
          const summary='已保存：'+totals(data)+'。';
          saving=false; active=null; close(); selected.clear();
          const ok=await host.reload(session);
          if(host.getAuth()?.user?.id===user) {
            if(ok)msg(ui.Notice,summary,'success'); else host.saveRefreshFailed(summary);
          }
        } else renderPlan(data,rows);
      } catch(e) {
        if(!current()) return;
        const message=e instanceof TypeError || e.name==='TimeoutError' ? (write?'网络中断或超时，请重新载入目录核对保存结果。':'网络中断或超时，请重新预览。') : e.message;
        preview=null; ui.Review.hidden=true; ui.PreviewRows.replaceChildren();
        ui.Reload.hidden=!(e.reload || write); msg(ui.Status,message,'error');
      } finally {
        if(current()) { active=null; saving=false; controls(); host.render(); }
      }
    }
    const download = (filename,content) => {
      const a=el('a'), url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
      a.href=url; a.download=filename; document.body.append(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    async function importFile() {
      if(saving || mode!=='import') return;
      readingFile=false; sourceNotice=''; invalidate(); importRows=[]; lines=[]; baselines=[]; const mine=stamp, file=ui.File.files?.[0];
      controls(); if(!file) return;
      readingFile = true; controls();
      try {
        if(file.size>12*1024*1024) throw Error('CSV 文件过大，请拆分后导入。');
        const text=await file.text(); if(mine!==stamp || mode!=='import')return;
        let parsed;
        if(ui.Format.value==='source') {
          if(typeof window.MCProductCatalogSourceCsv?.parse!=='function') throw Error('源表导入工具未加载，请刷新页面后重试。');
          parsed=window.MCProductCatalogSourceCsv.parse(text,host.getProducts());
          if(!Array.isArray(parsed.rows) || parsed.rows.length>limit || parsed.rows.some(r=>!['add','edit'].includes(r.action))) throw Error('运营产品源表只允许新增或更新，每批最多 100 行。');
        } else if(ui.Format.value==='manage') parsed=csv.parse(text);
        else throw Error('请选择文件格式。');
        importRows=parsed.rows; lines=parsed.lines; baselines=parsed.baselines || []; sourceNotice=parsed.notice || '';
        msg(ui.Status,'已读取 '+importRows.length+' 行操作，点击「预览变更」核对。'+(parsed.notice || ''));
      } catch(e) {if(mine===stamp)msg(ui.Status,e.message,'error');}
      finally {if(mine===stamp){readingFile=false; controls();}}
    }
    action(ui.Siblings,()=>{
      if(saving || mode!=='edit' || !targets[0])return;
      const list=host.getProducts().filter(r=>r.asin===targets[0].asin);
      if(list.length>limit){msg(ui.Status,'同一子 ASIN 的 SKU 超过单批上限，请联系管理员。','error');return;}
      selected=new Map(list.map(row=>[key(row),row])); host.render(); open('batch',list);
      ui.SetParent.checked=true; ui.NewParent.value=list[0].parent; controls();
    });
    action(ui.Add,()=>open('add')); action(ui.Batch,()=>open('batch',[...selected.values()]));
    action(ui.Drop,()=>open('drop',[...selected.values()])); action(ui.Import,()=>open('import'));
    action(ui.Close,()=>{if(!saving){close();ui.Add.focus();}});
    action(ui.Filtered,()=>updateSelection(host.getVisible(),true));
    action(ui.Clear,()=>updateSelection([...selected.values()],false));
    ui.Page.addEventListener('change',()=>updateSelection(host.getPage(),ui.Page.checked));
    action(ui.Reload,async()=>{
      const id=host.getAuth()?.user?.id, mine=stamp;
      if(!loaded || !id || active || saving)return;
      try {
        const session=await window.KBAuth.getValidSession();
        if(host.getAuth()?.user?.id!==id || mine!==stamp || active || saving)return;
        if(session?.user?.id!==id || !session?.session?.access_token){host.signedOut();return;}
        await host.reload(session);
      } catch {if(host.getAuth()?.user?.id===id)msg(ui.Status,'重新读取失败，请刷新页面后核对。','error');}
    });
    ui.AcceptOriginal.addEventListener('change',controls);
    action(ui.Preview,()=>void send(false)); action(ui.Save,()=>void send(true));
    ui.Format.addEventListener('change',()=>{
      if(saving || mode!=='import')return;
      invalidate(); readingFile=false; sourceNotice=''; importRows=[]; lines=[]; baselines=[]; ui.File.value=''; controls();
      msg(ui.Status,'请选择与文件格式相符的 CSV。');
    });
    ui.File.addEventListener('change',()=>void importFile());
    for(const id of ['Asin','Parent','Sku','Owners','Operator','ShortName','NewParent','NewOwners','NewOperator','NewShortName','ReportParent','Start','End','SetParent','SetOwners','SetOperator','SetShortName','Bind','Long']) {
      const changed=()=>{if(!saving){invalidate(); controls();}};
      ui[id].addEventListener('input',changed); ui[id].addEventListener('change',changed);
    }
    action(ui.Template,()=>{if(!saving && loaded)download('MC-产品目录批量模板.csv',csv.template());});
    action(ui.Export,()=>{
      if (!loaded || saving || !host.getAuth()) return;
      try { download('MC-产品目录-筛选结果.csv',csv.exportRows(host.getVisible().map(asProduct))); msg(ui.Notice,'已导出筛选结果，操作列留空的行在导入时会跳过。'); }
      catch(e){msg(ui.Notice,e.message,'error');}
    });
    return Object.freeze({reset,refresh,decorate,filterChanged});
  }
  window.MCProductCatalogManage=Object.freeze({mount});
})();
