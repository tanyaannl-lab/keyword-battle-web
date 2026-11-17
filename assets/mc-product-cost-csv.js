'use strict';

(() => {
  const HEADERS = Object.freeze([
    '日期（美西）', '子ASIN', '汇率', '产品成本（RMB）', '头程（RMB）', 'FBA费用（USD）', '佣金率（%）', 'VAT税率（%）',
  ]);
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

  function checkedNumber(field, rawInput, column, line) {
    const input = field.percent ? rawInput.replace(/[%％]$/, '').trim() : rawInput;
    const value = Number(input);
    if (input.length > 32 || !field.numeric.test(input) || !Number.isFinite(value) || value < field.min || value > field.max) {
      const upper = field.percent ? `${field.max}%` : field.max;
      const lower = field.percent ? `${field.min}%` : field.min;
      throw fromLine(line, `「${column}」请输入 ${lower} 至 ${upper} 的数字，最多 ${field.decimals} 位小数。`);
    }
    return field.percent ? Number((value / 100).toFixed(6)) : value;
  }

  function parse(text, { today = todayPacific(), maxRows = MAX_ROWS } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请上传有内容的 CSV 文件。');
    if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('CSV 文件不能超过 1 MiB。');
    if (/[\u0000\uFFFD]/.test(text)) throw new Error('无法读取文件编码，请在 Excel 中另存为「CSV UTF-8（逗号分隔）」。');
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) throw new Error(`每次最多导入 ${MAX_ROWS} 行成本。`);
    const maxDay = normalizeDate(today);
    if (!maxDay) throw new Error('无法确认当天的美西日期。');

    const rows = [];
    const sourceLines = [];
    const prior = new Map();
    let sawHeader = false;
    for (const record of records(text.replace(/^\uFEFF/, ''))) {
      const { line } = record;
      const cells = record.values.map(cell => cell.trim());
      if (cells.every(cell => cell === '')) continue;
      if (!sawHeader) {
        if (cells.length !== HEADERS.length || cells.some((cell, index) => cell.normalize('NFKC') !== HEADERS[index].normalize('NFKC'))) {
          throw fromLine(line, '表头不匹配，请下载模板并保留列名和顺序。');
        }
        sawHeader = true;
        continue;
      }
      if (cells.length !== HEADERS.length) throw fromLine(line, `应有 ${HEADERS.length} 列，请使用原模板。`);
      // Rows left blank in the downloaded, populated template are not updates.
      if (cells.slice(2).every(cell => cell === '')) continue;
      if (rows.length >= maxRows) throw fromLine(line, `每次最多导入 ${maxRows} 行成本，请拆成多个文件。`);
      const report_date = normalizeDate(cells[0]);
      if (!report_date || report_date > maxDay) {
        throw fromLine(line, `美西日期请填 YYYY-MM-DD 或 YYYY/M/D，且不能晚于 ${maxDay}。`);
      }
      const asin = normalizeAsin(cells[1]);
      if (!asin) throw fromLine(line, '子 ASIN 必须由 10 位英文字母或数字组成。');
      const identity = `${asin}:${report_date}`;
      if (prior.has(identity)) throw fromLine(line, `子 ASIN 与日期重复（见第 ${prior.get(identity)} 行）。`);
      prior.set(identity, line);
      const values = {};
      for (const [index, field] of COST_FIELDS.entries()) {
        if (cells[index + 2] !== '') values[field.key] = checkedNumber(field, cells[index + 2], HEADERS[index + 2], line);
      }
      rows.push({ asin, report_date, values });
      sourceLines.push(line);
    }
    if (!sawHeader) throw new Error('CSV 缺少表头，请使用下载的模板。');
    if (!rows.length) throw new Error('没有可导入的成本。请至少填写一行的一项成本。');
    Object.defineProperty(rows, 'sourceLines', { value: Object.freeze(sourceLines) });
    return rows;
  }

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

  const api = Object.freeze({ parse, template, HEADERS, MAX_BYTES, MAX_ROWS });
  if (typeof module === 'object' && module?.exports) module.exports = api;
  else window.MCProductCostCsv = api;
})();
