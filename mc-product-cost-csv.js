'use strict';

(() => {
  const HEADERS = Object.freeze([
    '日期（美西）', '子ASIN', '汇率', '产品成本（RMB）', '头程（RMB）', 'FBA费用（USD）', '佣金率（%）', 'VAT税率（%）',
  ]);
  const RANGE_HEADERS = Object.freeze(HEADERS.slice(1));
  const COST_FIELDS = [
    { key: 'exchange_rate', decimals: 6, min: 0.000001, max: 1000000 },
    { key: 'product_cost_rmb', decimals: 6, min: 0, max: 100000000 },
    { key: 'inbound_cost_rmb', decimals: 6, min: 0, max: 100000000 },
    { key: 'fba_fee', decimals: 6, min: 0, max: 100000000 },
    { key: 'commission_rate', decimals: 4, min: 0, max: 100, percent: true },
    { key: 'vat_rate', decimals: 4, min: 0, max: 100, percent: true },
  ].map(field => ({ ...field, numeric: new RegExp(`^(?:\\d+(?:\\.\\d{1,${field.decimals}})?|\\.\\d{1,${field.decimals}})$`) }));
  const MAX_BYTES = 1024 * 1024;
  const MAX_ROWS = 1000;
  const MIN_DAY = '2000-01-01';
  const MAX_DAY = '2099-12-31';
  const pacificDay = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  function todayPacific() {
    const parts = Object.fromEntries(pacificDay.formatToParts().map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function normalizeDate(value) {
    if (typeof value !== 'string') return null;
    // Excel may export year-first dates using slashes or omit the leading zeros.
    // Do not infer a day/month order when the year is last.
    const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(value.trim());
    if (!match) return null;
    const day = `${match[1]}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}`;
    if (day < MIN_DAY || day > MAX_DAY) return null;
    const date = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === day ? day : null;
  }

  function normalizeAsin(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return /^[A-Za-z0-9]{10}$/.test(text) ? text.toUpperCase() : null;
  }

  const fromLine = (line, message) => new Error(`CSV 第 ${line} 行：${message}`);

  function* records(source) {
    let values = [];
    let value = '';
    let line = 1;
    let firstLine = 1;
    let state = 'unquoted';
    const enterField = () => {
      if (values.length >= HEADERS.length) throw fromLine(firstLine, `应有 ${HEADERS.length} 列，请使用原模板。`);
      values.push(value);
      value = '';
      state = 'unquoted';
    };
    for (let index = 0; index < source.length; index++) {
      const symbol = source[index];
      if (state === 'quoted') {
        if (symbol === '"') {
          if (source[index + 1] === '"') { value += '"'; index++; }
          else state = 'closed';
        } else if (symbol === '\r' || symbol === '\n') {
          if (symbol === '\r' && source[index + 1] === '\n') index++;
          value += '\n';
          line++;
        } else value += symbol;
        continue;
      }
      if (symbol === ',') enterField();
      else if (symbol === '\r' || symbol === '\n') {
        if (symbol === '\r' && source[index + 1] === '\n') index++;
        enterField();
        yield { values, line: firstLine };
        values = [];
        firstLine = ++line;
      } else if (state === 'closed') {
        if (symbol !== ' ' && symbol !== '\t') throw fromLine(firstLine, '引号后应为逗号或换行。');
      } else if (symbol === '"') {
        if (value) throw fromLine(firstLine, '字段中的引号格式不正确。');
        state = 'quoted';
      } else value += symbol;
    }
    if (state === 'quoted') throw fromLine(firstLine, '字段引号未闭合。');
    if (values.length || value || state === 'closed') {
      enterField();
      yield { values, line: firstLine };
    }
  }

  function decode(bytes) {
    let raw;
    if (ArrayBuffer.isView(bytes)) raw = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else if (Object.prototype.toString.call(bytes) === '[object ArrayBuffer]') raw = new Uint8Array(bytes);
    else throw new Error('未能读取 CSV 文件，请重新选择。');
    if (raw.byteLength > MAX_BYTES) throw new Error('CSV 文件不能超过 1 MiB。');
    const xls = raw[0] === 0x50 && raw[1] === 0x4b || raw[0] === 0xd0 && raw[1] === 0xcf;
    if (xls) throw new Error('这是 Excel 工作簿。请另存为 CSV 后选择，不要只改文件扩展名。');
    const bom = raw[0] === 0xff && raw[1] === 0xfe ? 'utf-16le' :
      raw[0] === 0xfe && raw[1] === 0xff ? 'utf-16be' :
      raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 'utf-8' : null;
    for (const encoding of bom ? [bom] : ['utf-8', 'gb18030']) {
      try {
        const value = new TextDecoder(encoding, {fatal:true}).decode(raw);
        if (!/[\u0000\uFFFD]/.test(value)) return value;
      } catch { /* Try the next supported encoding. */ }
    }
    throw new Error('无法读取文件编码，支持 CSV UTF-8、中文 Excel CSV（GBK/GB18030），以及带 BOM 的 UTF-16 CSV。');
  }

  function checkedNumber(field, rawInput, column, line, rateMode, examples) {
    const explicit = field.percent && /[%％]$/.test(rawInput);
    const input = explicit ? rawInput.slice(0,-1).trim() : rawInput;
    const value = Number(input);
    const decimal = field.percent && !explicit && (rateMode === 'decimal' || rateMode === 'fraction');
    const rule = decimal ? /^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/ : field.numeric;
    if (input.length > 32 || !rule.test(input) || !Number.isFinite(value) || value < field.min || value > (decimal ? 1 : field.max)) {
      if (decimal) throw fromLine(line, `「${column}」按小数比例时请填 0 至 1（最多 6 位小数），也可直接写 20.5%。`);
      const upper = field.percent ? `${field.max}%` : field.max;
      const lower = field.percent ? `${field.min}%` : field.min;
      throw fromLine(line, `「${column}」请输入 ${lower} 至 ${upper} 的数字，最多 ${field.decimals} 位小数。`);
    }
    if (field.percent && !explicit && value > 0 && value < 1) {
      if (examples.size < 5) examples.add(input);
      if (rateMode === 'auto') throw fromLine(line, `「${column}」的 ${input} 没有百分号。按百分数是 ${input}%，按小数比例是 ${Number((value*100).toFixed(4))}%。请先选择费率填写方式再预览。`);
    }
    return field.percent && !decimal ? Number((value / 100).toFixed(6)) : value;
  }

  function parseRows(text, { today = todayPacific(), maxRows = MAX_ROWS, rateMode = 'percent' } = {}, range = false) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请上传有内容的 CSV 文件。');
    if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('CSV 文件不能超过 1 MiB。');
    if (/[\u0000\uFFFD]/.test(text)) throw new Error('无法读取文件编码，请在 Excel 中另存为「CSV UTF-8（逗号分隔）」。');
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) throw new Error(`每次最多导入 ${MAX_ROWS} 行成本。`);
    if (!['auto','percent','decimal','fraction'].includes(rateMode)) throw new Error('请选择有效的费率填写方式。');
    const maxDay = normalizeDate(today);
    if (!range && !maxDay) throw new Error('无法确认当天的美西日期。');

    const rows = [], sourceLines = [], examples = new Set(), prior = new Map();
    let columns = null;
    for (const record of records(text.replace(/^\uFEFF/, ''))) {
      const { line } = record;
      const cells = record.values.map(cell => cell.trim());
      if (cells.every(cell => cell === '')) continue;
      if (!columns) {
        columns = (range ? [HEADERS,RANGE_HEADERS] : [HEADERS]).find(candidate =>
          cells.length === candidate.length && cells.every((cell,i) => cell.normalize('NFKC') === candidate[i].normalize('NFKC')));
        if (!columns) throw fromLine(line, '表头不匹配，请下载模板并保留列名和顺序。');
        continue;
      }
      if (cells.length !== columns.length) throw fromLine(line, `应有 ${columns.length} 列，请使用原模板。`);
      const ai=columns === HEADERS ? 1 : 0, ci=ai+1;
      if (cells.slice(ci).every(cell => cell === '')) continue;
      if (rows.length >= maxRows) throw fromLine(line, `每次最多导入 ${maxRows} 行成本，请拆成多个文件。`);
      const report_date = range ? null : normalizeDate(cells[0]);
      if (!range && (!report_date || report_date > maxDay)) {
        throw fromLine(line, `美西日期请填 YYYY-MM-DD 或 YYYY/M/D，且不能晚于 ${maxDay}。`);
      }
      const asin = normalizeAsin(cells[ai]);
      if (!asin) throw fromLine(line, '子 ASIN 必须由 10 位英文字母或数字组成。');
      const identity = range ? asin : `${asin}:${report_date}`;
      if (prior.has(identity)) throw fromLine(line, `${range ? '区间导入时同一子 ASIN 只填一行，子 ASIN 重复' : '子 ASIN 与日期重复'}（见第 ${prior.get(identity)} 行）。`);
      prior.set(identity, line);
      const values = {};
      for (const [index, field] of COST_FIELDS.entries()) {
        if (cells[index + ci] !== '') values[field.key] = checkedNumber(field, cells[index + ci], columns[index + ci], line, rateMode, examples);
      }
      rows.push(range ? { asin, values } : { asin, report_date, values });
      sourceLines.push(line);
    }
    if (!columns) throw new Error('CSV 缺少表头，请使用下载的模板。');
    if (!rows.length) throw new Error('没有可导入的成本。请至少填写一行的一项成本。');
    Object.defineProperties(rows,{sourceLines:{value:Object.freeze(sourceLines)},ambiguousRates:{value:Object.freeze([...examples])}});
    return rows;
  }
  function parse(text,options) { return parseRows(text,options,false); }
  function parseRange(text,options) { return parseRows(text,options,true); }

  function template({ reportDate, asins = [] } = {}) {
    if (!Array.isArray(asins)) throw new Error('无法生成子 ASIN 列表。');
    const day = normalizeDate(reportDate);
    if (asins.length && !day) throw new Error('请先选择有效的美西日期。');
    const ids = [...new Set(asins.map(normalizeAsin))];
    if (ids.includes(null)) throw new Error('子 ASIN 列表中存在无效记录。');
    if (ids.length > MAX_ROWS) throw new Error(`单份模板最多可填 ${MAX_ROWS} 个子 ASIN。`);
    const lines = [HEADERS.join(','), ...ids.map(asin => [day, asin, '', '', '', '', '', ''].join(','))];
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  function templateRange({asins=[]}={}) {
    if (!Array.isArray(asins)) throw new Error('无法生成子 ASIN 列表。');
    const ids=[...new Set(asins.map(normalizeAsin))];
    if (ids.includes(null)) throw new Error('子 ASIN 列表中存在无效记录。');
    if (ids.length>MAX_ROWS) throw new Error(`单份模板最多可填 ${MAX_ROWS} 个子 ASIN。`);
    return '\uFEFF'+[RANGE_HEADERS.join(','),...ids.map(asin=>asin+',,,,,,')].join('\r\n')+'\r\n';
  }
  const api = Object.freeze({ parse, parseRange, decode, template, templateRange, HEADERS, RANGE_HEADERS, MAX_BYTES, MAX_ROWS });
  if (typeof module === 'object' && module?.exports) module.exports = api;
  else window.MCProductCostCsv = api;
})();
