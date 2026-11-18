'use strict';

// Merge the operator's workbook (Excel → UTF-8 CSV). Absence is not deletion.
// This decoder never writes, sets monetary values, or changes dated parent rules.
(() => {
  const HEADERS = Object.freeze(['SKU','公司SKU','ASIN','父ASIN','汇率','产品成本(RMB)','头程(RMB)','FBA费用(原币)','佣金率','VAT税率','负责人','产品简称','运营名称']);
  const MAX_ROWS = 100, MAX_BYTES = 2 * 1024 * 1024;
  const normalizeHeader = v => v.normalize('NFKC').trim();
  const fail = message => { throw Error(message); };
  const bad = (n,m) => fail('运营源表第 '+n+' 行：'+m);
  const key = (a,s) => JSON.stringify([a,s]);
  function splitRecord(line,n) {
    const values = [];
    let value = '', quoted = false, closed = false;
    const end = () => {
      values.push(value); value=''; closed=false;
      if(values.length>HEADERS.length) bad(n,'列数过多，请保留运营源表的 13 个表头。');
    };
    for(let i=0;i<line.length;i++) {
      const c=line[i];
      if(quoted) {
        if(c!=='"') value+=c;
        else if(line[i+1]==='"') {value+='"'; i++;}
        else {quoted=false; closed=true;}
      } else if(c===',') end();
      else if(closed) bad(n,'字段引号后出现了其他字符。');
      else if(c==='"') {
        if(value!=='') bad(n,'字段中的引号格式错误。');
        quoted=true;
      } else value+=c;
    }
    if(quoted) bad(n,'存在未闭合的引号或跨行的字段；目录字段请写在一行内。');
    end();return values;
  }
  function text(v,limit,name,n,optional=false) {
    if(optional && v==='')return v;
    if(!v || v!==v.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(v) || [...v].length>limit)bad(n,name+' 长度或内容有误；请检查空格、换行及控制字符。');
    return v;
  }
  function asin(v,name,n) {
    if(!/^[A-Za-z\d]{10}$/.test(v))bad(n,name+' 需为 10 位字母或数字。');
    return v.toUpperCase();
  }
  function parse(source,catalog) {
    if(typeof source!=='string' || !source.trim())fail('请选择从运营源表另存的 CSV UTF-8 文件。');
    if(source.length>MAX_BYTES || new TextEncoder().encode(source).length>MAX_BYTES)fail('运营源表 CSV 超过 2 MiB，请拆分。');
    if(/[\u0000\uFFFD]/u.test(source))fail('运营源表编码无效，请另存为 CSV UTF-8（逗号分隔）。');
    if(!Array.isArray(catalog))fail('请先加载当前目录后再选文件。');
    const known=new Map(),currentSkus=new Map();
    for(const p of catalog) {
      known.set(key(p.asin,p.sku),p);
      const children=currentSkus.get(p.sku) || new Set();
      children.add(p.asin);currentSkus.set(p.sku,children);
    }
    const rows=[],lines=[],baselines=[],seen=new Map(),seenSku=new Map(),family=new Map();
    let col,companyRows=0;
    for(const [idx,raw] of source.replace(/^\uFEFF/,'').split(/\r\n|\n|\r/).entries()) {
      if(!raw.trim())continue;
      const n=idx+1, cells=splitRecord(raw,n);
      if(cells.every(v=>v===''))continue;
      if(!col) {
        const headers=cells.map(normalizeHeader);
        if(headers.length!==HEADERS.length || !HEADERS.every(v=>headers.includes(v)))bad(n,'表头不匹配。运营源表须保留 SKU、公司SKU、ASIN、父ASIN、六项成本、负责人、产品简称、运营名称共 13 列。');
        col=Object.fromEntries(headers.map((v,i)=>[v,i]));continue;
      }
      if(rows.length>=MAX_ROWS)bad(n,'每批最多 100 条源表记录，请拆开导入。');
      if(cells.length!==HEADERS.length)bad(n,'列数和表头不一致。');
      const get=h=>cells[col[h]], child=asin(get('ASIN'),'ASIN',n), parent=asin(get('父ASIN'),'父ASIN',n);
      const sku=text(get('SKU'),128,'SKU',n), id=key(child,sku);
      if(seen.has(id))bad(n,'与第 '+seen.get(id)+' 行的子 ASIN、SKU 重复。');
      seen.set(id,n);
      if(seenSku.has(sku) && seenSku.get(sku)!==child)bad(n,'同一 SKU 在文件中对应不同子 ASIN。');
      seenSku.set(sku,child);
      if(family.has(child) && family.get(child)!==parent)bad(n,'同一子 ASIN 在文件中对应不同父 ASIN。');
      family.set(child,parent);
      const inCatalog=currentSkus.get(sku);
      if(inCatalog && (inCatalog.size!==1 || !inCatalog.has(child)))bad(n,'此 SKU 已在当前目录对应其他子 ASIN；请核对，修改标识请用目录的「修改」。');
      const base=known.get(id), owner=text(get('负责人'),160,'负责人',n,true),
        nickname=text(get('产品简称'),160,'产品简称',n,true),operator=text(get('运营名称'),160,'运营名称',n,true);
      const row={action:base?'edit':'add',asin:child,sku,parent_asin:parent,
        owners:owner?[owner]:[...(base?.owners || [])],
        operator_name:operator || base?.operator_name || '',product_short_name:nickname || base?.product_short_name || ''};
      if(base){row.old_asin=child;row.old_sku=sku;}
      if(get('公司SKU')!=='')companyRows++;
      rows.push(row);lines.push(n);baselines.push(null);
    }
    if(!rows.length)fail('运营源表没有产品数据行。');
    for(const p of catalog) {
      if(family.has(p.asin) && !seen.has(key(p.asin,p.sku)) && (p.parent_asin ?? p.parent)!==family.get(p.asin)) {
        fail('子 ASIN '+p.asin+' 的父 ASIN 会与未导入的 SKU 不一致；请核对并包含该子 ASIN 的所有相关行。');
      }
    }
    const edits=rows.filter(r=>r.action==='edit').length;
    const notice='源表匹配：已有 '+edits+' 行，新增 '+(rows.length-edits)+' 行。未列产品保留；六项成本列不导入，仍按美西日期维护。'
      +(companyRows?'有 '+companyRows+' 行填写了公司SKU，此入口不更新公司SKU。':'');
    return {rows,lines,baselines,notice};
  }
  const api=Object.freeze({HEADERS,MAX_ROWS,MAX_BYTES,parse});
  if(typeof module==='object' && module?.exports)module.exports=api;else window.MCProductCatalogSourceCsv=api;
})();
