'use strict';

(() => {
  const HEADERS = Object.freeze(['子ASIN', '操作', '父ASIN', '开始日期（美西）', '结束日期（美西）']);
  const MIN_DAY = '2000-01-03';
  const MAX_DAY = '2099-12-31';
  const MAX_ROWS = 100;
  const MAX_BYTES = 256 * 1024;
  const ASIN = /^[A-Z0-9]{10}$/;

  function normalizeAsin(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    return /^[A-Za-z0-9]{10}$/.test(value) ? value.toUpperCase() : null;
  }

  function normalizeDay(raw) {
    if (typeof raw !== 'string') return null;
    const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(raw.trim());
    if (!match) return null;
    const day = `${match[1]}-${match[3].padStart(2,'0')}-${match[4].padStart(2,'0')}`;
    if (day < MIN_DAY || day > MAX_DAY) return null;
    const date = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(+date) && date.toISOString().slice(0,10) === day ? day : null;
  }

  function rowFor({child, operation, parent, first, last}) {
    const asin = normalizeAsin(child);
    if (!asin) throw new Error('子 ASIN 必须由 10 位英文字母或数字组成。');
    if (!['设置','独立','清除'].includes(operation)) throw new Error('操作请填「设置」「独立」或「清除」。');
    const enteredParent = typeof parent === 'string' ? parent.trim() : '';
    const action = operation === '清除' ? 'clear' : 'set';
    let parent_asin = null;
    if (operation === '设置') {
      parent_asin = normalizeAsin(enteredParent);
      if (!parent_asin) throw new Error('父 ASIN 必须由 10 位英文字母或数字组成。');
    } else if (enteredParent) throw new Error('使用「独立」或「清除」时，请将父 ASIN 留空。');
    else if (operation === '独立') parent_asin = asin;
    const start_date = normalizeDay(first);
    if (!start_date) throw new Error('请填写有效的美西开始日期，例如 2026-11-09。');
    const permanent = typeof last === 'string' && last.trim() === '长期';
    const end_date = permanent ? null : normalizeDay(last);
    if (!permanent && !end_date) throw new Error('请填写有效的美西结束日期；没有结束日期时填写「长期」。');
    if (end_date && end_date < start_date) throw new Error('结束日期不能早于开始日期。');
    return {asin,parent_asin,start_date,end_date,action};
  }

  const lineError = (line, message) => new Error(`CSV 第 ${line} 行：${message}`);

  function split(line, position) {
    const fields = [];
    let field = '', quoting = false, closed = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoting) {
        if (ch !== '"') field += ch;
        else if (line[i+1] === '"') {field += '"'; i++;}
        else {quoting = false; closed = true;}
      } else if (ch === ',') {
        fields.push(field.trim());
        field = ''; closed = false;
      } else if (closed) {
        if (ch !== ' ' && ch !== '\t') throw lineError(position,'引号后应为逗号或换行。');
      } else if (ch === '"') {
        if (field) throw lineError(position,'引号格式不正确。');
        quoting = true;
      } else field += ch;
    }
    if (quoting) throw lineError(position,'引号未闭合；此模板的字段不能跨行。');
    fields.push(field.trim());
    return fields;
  }

  function parse(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请上传有内容的 CSV 文件。');
    if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) {
      throw new Error('CSV 不得超过 256 KB，请删去多余空行或分成多个文件。');
    }
    if (/[\u0000\uFFFD]/.test(text)) throw new Error('请在 Excel 中另存为「CSV UTF-8（逗号分隔）」。');
    const rows = [], lines = [], prior = new Map();
    let header = false;
    for (const [i,line] of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/).entries()) {
      const number = i + 1;
      if (!line.trim()) continue;
      const cells = split(line,number);
      if (cells.every(v => !v)) continue;
      if (!header) {
        header = true;
        if (cells.length !== HEADERS.length || cells.some((cell,j) => cell.normalize('NFKC') !== HEADERS[j].normalize('NFKC'))) {
          throw lineError(number,'表头不匹配，请下载模板并保留列名和顺序。');
        }
        continue;
      }
      if (cells.length !== HEADERS.length) throw lineError(number,`应有 ${HEADERS.length} 列，请按模板填写。`);
      if (rows.length >= MAX_ROWS) throw lineError(number,`每次最多导入 ${MAX_ROWS} 个子 ASIN，请拆成多个文件。`);
      const [child,operation,parent,first,last] = cells;
      let row;
      try { row = rowFor({child,operation,parent,first,last}); }
      catch (error) { throw lineError(number,error.message); }
      if (prior.has(row.asin)) throw lineError(number,`同一子 ASIN 已在第 ${prior.get(row.asin)} 行填写，请分批处理。`);
      prior.set(row.asin,number);
      rows.push(row);
      lines.push(number);
    }
    if (!header || !rows.length) throw new Error('CSV 没有可处理的记录。');
    return {rows,lines};
  }

  const template = () => `\uFEFF${HEADERS.join(',')}\r\n`;
  const api = Object.freeze({ASIN,MIN_DAY,MAX_DAY,MAX_ROWS,MAX_BYTES,HEADERS,normalizeAsin,normalizeDay,rowFor,parse,template});
  if (typeof module === 'object' && module?.exports) module.exports = api;
  else window.MCProductParentMappingCsv = api;
})();
