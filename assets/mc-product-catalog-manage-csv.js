'use strict';

(() => {
  const LEGACY = Object.freeze(['操作','原子ASIN','原SKU','子ASIN','父ASIN','SKU','负责人','报表开始日期（美西）','报表结束日期（美西）','报表父ASIN']);
  const STAMP = '原目录校验（请勿修改）';
  const PREVIOUS = Object.freeze([...LEGACY,STAMP]);
  const HEADERS = Object.freeze([...LEGACY,'运营名称','产品简称',STAMP]);
  const SOURCE = '目录行v2:';
  const PREVIOUS_SOURCE = '目录行v1:';
  const ACTIONS = new Map([['新增','add'],['修改','edit'],['删除','delete']]);
  const MAX_ROWS = 100;
  // Allow an exported catalog to come back intact; count only marked actions toward the RPC limit.
  const MAX_BYTES = 12 * 1024 * 1024;
  const TEXT = '文本:';
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  const fail = message => { throw new Error(message); };
  const at = (line, message) => new Error(`CSV 第 ${line} 行：${message}`);
  const protect = value => value.startsWith(TEXT) || /^(?:[\s']*[=+@\-.\d]|['\s]|true$|false$|#|sep=)/iu.test(value.normalize('NFKC'));
  const encode = value => protect(value) ? TEXT+value : value;
  const decode = value => value.startsWith(TEXT) && protect(value.slice(TEXT.length)) ? value.slice(TEXT.length) : value;
  const quote = v => /[",\r\n]/.test(v) ? `"${v.replaceAll('"','""')}"` : v;
  const normalizeAsin = value => typeof value === 'string' && /^[A-Za-z\d]{10}$/.test(value) ? value.toUpperCase() : null;

  function normalizeDay(value) {
    const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(value);
    if (!match) return null;
    const day = `${match[1]}-${match[3].padStart(2,'0')}-${match[4].padStart(2,'0')}`;
    if (day < '2000-01-03' || day > '2099-12-31') return null;
    const d = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(+d) && d.toISOString().slice(0,10) === day ? day : null;
  }

  function checkedText(value, max, name) {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value || controls.test(value) || [...value].length > max) {
      fail(`「${name}」须为 1–${max} 个字符，不可有首尾空格、换行或控制字符。`);
    }
    return value;
  }
  function checkedOwners(owners) {
    if (!Array.isArray(owners) || owners.length > 20) fail('负责人请填单个姓名，或包含最多 20 个姓名的 JSON 数组。');
    for (const item of owners) checkedText(item,160,'负责人');
    if (new Set(owners).size !== owners.length) fail('负责人不能重复。');
    return owners;
  }
  const label = (value,name) => value === '' ? '' : checkedText(value,160,name);
  function formatOwners(owners) {
    checkedOwners(owners);
    return owners.length === 1 && !owners[0].startsWith('[') ? owners[0] : JSON.stringify(owners);
  }
  function parseOwners(source, {allowBlank = false} = {}) {
    if (typeof source !== 'string') fail('负责人格式不正确。');
    if (source === '') return allowBlank ? [] : fail('修改时请填写负责人；如需清空，明确填写 []。');
    if (!source.startsWith('[')) return checkedOwners([source]);
    let owners;
    try { owners = JSON.parse(source); } catch { fail('多位负责人请写成 JSON 数组，例如 ["张三","李四"]。'); }
    return checkedOwners(owners);
  }

  function record(line, number) {
    const fields = []; let value = '', quoted = false, closed = false;
    function end() {
      fields.push(value); value = ''; closed = false;
      if (fields.length > HEADERS.length) throw at(number,`应为 ${HEADERS.length} 列，请使用原模板。`);
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c !== '"') value += c;
        else if (line[i+1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (c === ',') end();
      else if (closed) throw at(number,'字段引号后应为逗号或换行。');
      else if (c === '"') {
        if (value) throw at(number,'字段中的引号格式不正确。');
        quoted = true;
      } else value += c;
    }
    if (quoted) throw at(number,'引号未闭合；产品字段中不允许换行。');
    end(); return fields;
  }

  function inputRow(cells) {
    const [op,sourceAsin,sourceSku,newAsin,parentAsin,newSku,ownerText,start,end,reportParent] = cells;
    const action = ACTIONS.get(op.trim());
    if (!action) fail('操作须为「新增」「修改」或「删除」；留空则跳过。');
    const row = {action};
    if (action === 'add') {
      if (sourceAsin || sourceSku) fail('新增时请将「原子ASIN」和「原SKU」留空。');
    } else {
      row.old_asin = normalizeAsin(sourceAsin.trim()) || fail('原子 ASIN 须为 10 位英文字母或数字。');
      row.old_sku = checkedText(sourceSku,128,'原SKU');
    }
    if (action !== 'delete') {
      row.asin = normalizeAsin(newAsin.trim()) || fail('子 ASIN 须为 10 位英文字母或数字。');
      row.parent_asin = normalizeAsin(parentAsin.trim()) || fail('父 ASIN 须为 10 位英文字母或数字。');
      row.sku = checkedText(newSku,128,'SKU');
      row.owners = parseOwners(ownerText, {allowBlank: action === 'add'});
      if (start.trim() || end.trim() || reportParent.trim()) {
        if (reportParent.trim()) row.report_parent_asin = normalizeAsin(reportParent.trim()) || fail('报表父 ASIN 须为 10 位英文字母或数字。');
        row.start_date = normalizeDay(start.trim()) || fail('请填写有效的报表开始日期，例如 2026-11-09。');
        row.end_date = end.trim() === '长期' ? null : normalizeDay(end.trim()) || fail('请填写报表结束日期，无结束日期时须填「长期」。');
        if (row.end_date && row.end_date < row.start_date) fail('报表结束日期早于开始日期。');
      }
    } else {
      if (start.trim() || end.trim() || reportParent.trim()) fail('删除目录行时不能同时设置报表归属或日期。');
      if ((newAsin && normalizeAsin(newAsin.trim()) !== row.old_asin) || (newSku && newSku !== row.old_sku)) {
        fail('删除的原产品与本行子 ASIN 或 SKU 不一致，请重新核对原子 ASIN 和原 SKU。');
      }
    }
    return row;
  }

  // Snapshot of visible identity and values at export, compared with the server-side preview.
  // This is only a stale-edit check, never authorization. Do not submit the snapshot as RPC input.
  function baseline(value,row,hasLabels) {
    if (value === undefined || value === '') return null;
    if (row.action === 'add') fail('新增时请将「原目录校验」留空。');
    const invalid = () => fail('原目录校验列与该行不匹配或已损坏，请重新导出目录。');
    const marker=hasLabels ? SOURCE : PREVIOUS_SOURCE;
    if (!value.startsWith(marker)) invalid();
    let values;
    try { values=JSON.parse(value.slice(marker.length)); } catch { invalid(); }
    if (!Array.isArray(values) || values.length !== (hasLabels ? 6 : 4)) invalid();
    const [asin,sku,parent,owners]=values;
    if (asin !== row.old_asin || sku !== row.old_sku || normalizeAsin(parent) !== parent || typeof parent !== 'string') invalid();
    try { checkedOwners(owners); } catch { invalid(); }
    const original={asin,sku,parent_asin:parent,owners};
    if(hasLabels) {
      try {
        original.operator_name=label(values[4],'运营名称');
        original.product_short_name=label(values[5],'产品简称');
      } catch {invalid();}
    }
    return original;
  }
  function parse(source) {
    if (typeof source !== 'string' || !source.trim()) fail('请上传有内容的 CSV 文件。');
    if (source.length > MAX_BYTES || new TextEncoder().encode(source).length > MAX_BYTES) fail('CSV 超过 12 MiB，请拆分。');
    if (/[\u0000\uFFFD]/.test(source)) fail('文件编码无效，请在 Excel 中另存为「CSV UTF-8（逗号分隔）」。');
    const rows = [], lines = [], baselines = [], oldKeys = new Map(), newKeys = new Map();
    let header = null;
    for (const [index,line] of source.replace(/^\uFEFF/,'').split(/\r\n|\n|\r/).entries()) {
      if (!line.trim()) continue;
      const n = index + 1, cells = record(line,n);
      if (cells.every(cell => cell === '')) continue;
      if (!header) {
        header = cells.length === LEGACY.length ? LEGACY : cells.length === PREVIOUS.length ? PREVIOUS : HEADERS;
        if (cells.length !== header.length || cells.some((c,k) => c.trim().normalize('NFKC') !== header[k].normalize('NFKC'))) throw at(n,'表头不匹配，请下载模板并保留列名和顺序。');
        continue;
      }
      if (cells.length !== header.length) throw at(n,`应为 ${header.length} 列，请使用原模板。`);
      if (!cells[0].trim()) continue;
      if (rows.length >= MAX_ROWS) throw at(n,`一次最多处理 ${MAX_ROWS} 行有操作的产品，请拆开提交。`);
      let row, initial;
      try {
        // Only catalog text columns ever receive the reversible Excel protection marker.
        row = inputRow(cells.map((v,i) => (i >= 1 && i <= 6) || i === 9 ? decode(v) : v));
        const hasLabels=header===HEADERS;
        if(hasLabels && row.action!=='delete'){
          // Empty cells explicitly clear their own field in this version. Earlier
          // formats have neither field: omit both keys so existing values survive.
          row.operator_name=label(decode(cells[10]),'运营名称');
          row.product_short_name=label(decode(cells[11]),'产品简称');
        }
        initial = header===LEGACY ? null : baseline(cells[header.length-1],row,hasLabels);
      } catch (e) { throw at(n,e.message); }
      for (const [keys,child,sku,label] of [[oldKeys,row.old_asin,row.old_sku,'原产品'],[newKeys,row.asin,row.sku,'目标产品']]) {
        if (!child) continue;
        const id = JSON.stringify([child,sku]);
        if (keys.has(id)) throw at(n,`同一${label}已在第 ${keys.get(id)} 行填写。`);
        keys.set(id,n);
      }
      rows.push(row); lines.push(n); baselines.push(initial);
    }
    if (!header) fail('缺少 CSV 表头。');
    if (!rows.length) fail('没有可预览的改动。请在「操作」列标记新增、修改或删除；未标记的行会跳过。');
    return {rows,lines,baselines};
  }
  const template = () => `\uFEFF${HEADERS.join(',')}\r\n`;
  function exportRows(items) {
    if (!Array.isArray(items)) fail('请选择要导出的目录行。');
    return template() + items.map(item => {
      const child = normalizeAsin(item.asin), parent = normalizeAsin(item.parent_asin ?? item.parent);
      if (!child || !parent) fail('目录中存在无效的子 ASIN 或父 ASIN。');
      const sku = checkedText(item.sku,128,'SKU'), owners = formatOwners(item.owners);
      const operator=label(item.operator_name ?? '','运营名称'), nickname=label(item.product_short_name ?? '','产品简称');
      const source = SOURCE + JSON.stringify([child,sku,parent,item.owners,operator,nickname]);
      return ['',child,sku,child,parent,sku,owners,'','','',operator,nickname,source].map(v => quote(encode(v))).join(',')+'\r\n';
    }).join('');
  }
  const api = Object.freeze({HEADERS,MAX_BYTES,MAX_ROWS,parse,template,exportRows,formatOwners,parseOwners,normalizeDay});
  if (typeof module === 'object' && module?.exports) module.exports = api;
  else window.MCProductCatalogManageCsv = api;
})();
