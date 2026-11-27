(function () {
  'use strict';

  const DAY = 86400000;
  const HEIGHT = 215;
  const SVG = 'http://www.w3.org/2000/svg';
  const metrics = {
    units: { label: '销量', unit: '件' },
    sales_amount: { label: '销售额', unit: 'USD' },
    orders_count: { label: '订单量', unit: '单' }
  };
  const numbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  let root, plot, svg, body, status, readout, cursor, marker;
  let metric = 'units';
  let first, last, dayCount = 0, selected = 0;
  let rows = new Map();
  let values = new Map();
  let x, y, plotLeft, plotWidth;

  function dateNumber(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return NaN;
    const ms = Date.parse(iso + 'T00:00:00Z');
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso ? ms / DAY : NaN;
  }

  function dateAt(index) {
    return new Date((first + index) * DAY).toISOString().slice(0, 10);
  }

  function valueOf(row) {
    const raw = row[metric];
    if (raw == null || typeof raw === 'boolean' || String(raw).trim() === '') return null;
    if (metric === 'sales_amount' && String(row.currency || 'USD').toUpperCase() !== 'USD') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || (metric !== 'sales_amount' && (!Number.isSafeInteger(n) || n < 0))) return null;
    return n;
  }

  function svgNode(tag, attrs, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    svg.appendChild(node);
    return node;
  }

  function initialize() {
    root = document.getElementById('historyTrend');
    if (!root) return false;
    root.innerHTML = `
      <div class="card-head sales-trend-head">
        <h2>每日销售趋势</h2>
        <div class="sales-range-controls sales-trend-controls" role="group" aria-label="趋势指标">
          <button type="button" data-trend-metric="units" aria-pressed="true">销量</button>
          <button type="button" data-trend-metric="sales_amount" aria-pressed="false">销售额</button>
          <button type="button" data-trend-metric="orders_count" aria-pressed="false">订单量</button>
        </div>
      </div>
      <p class="sales-trend-status" data-trend-status role="status" hidden></p>
      <div class="sales-trend-body" data-trend-body hidden>
        <div class="sales-trend-meta">
          <span class="sales-trend-unit" data-trend-unit></span>
          <output data-trend-readout aria-live="off"></output>
        </div>
        <div class="sales-trend-plot" data-trend-plot role="slider" tabindex="0" aria-label="逐日查看趋势数值" aria-describedby="historyTrendKeys" aria-valuemin="1">
          <svg role="img" aria-label="所选日期的销售折线图"></svg>
        </div>
        <span class="sales-sr-only" id="historyTrendKeys">使用左右方向键逐日查看，Home 和 End 跳到开始或结束日期。</span>
      </div>`;
    plot = root.querySelector('[data-trend-plot]');
    svg = plot.querySelector('svg');
    body = root.querySelector('[data-trend-body]');
    status = root.querySelector('[data-trend-status]');
    readout = root.querySelector('[data-trend-readout]');
    for (const button of root.querySelectorAll('[data-trend-metric]')) {
      button.addEventListener('click', () => {
        metric = button.dataset.trendMetric;
        for (const other of root.querySelectorAll('[data-trend-metric]')) other.setAttribute('aria-pressed', String(other === button));
        refresh();
      });
    }
    const pointAt = e => {
      if (body.hidden || !plotWidth || !dayCount) return;
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const localX = (e.clientX - box.left) * svg.viewBox.baseVal.width / box.width;
      select(Math.round((localX - plotLeft) / plotWidth * (dayCount - 1)));
    };
    plot.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') pointAt(e); });
    plot.addEventListener('click', pointAt);
    plot.addEventListener('keydown', e => {
      const destination = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: dayCount - 1 };
      if (!Object.hasOwn(destination, e.key)) return;
      e.preventDefault();
      select(destination[e.key]);
    });
    if (window.ResizeObserver) new ResizeObserver(() => { if (!body.hidden && plot.clientWidth) draw(); }).observe(plot);
    else window.addEventListener('resize', () => { if (!body.hidden) draw(); });
    return true;
  }

  function select(index) {
    selected = Math.max(0, Math.min(dayCount - 1, index));
    const value = values.get(selected);
    const date = dateAt(selected);
    const measure = metrics[metric];
    let label = '无数据';
    if (value !== undefined) label = metric === 'sales_amount' ? dollars.format(value) : numbers.format(value) + ' ' + measure.unit;
    const time = document.createElement('time');
    time.dateTime = date;
    time.textContent = date;
    const amount = document.createElement('strong');
    amount.textContent = label;
    readout.replaceChildren(time, amount);
    if (metric === 'sales_amount' && value !== undefined) {
      const flags = window.KBSalesModel?.priceFlags(rows.get(selected)) || [];
      for (const flag of flags) {
        const badge = document.createElement('span');
        badge.className = 'sales-price-badge ' + flag.type;
        badge.textContent = flag.label;
        badge.title = flag.text;
        readout.appendChild(badge);
      }
    }
    plot.setAttribute('aria-valuenow', String(selected + 1));
    plot.setAttribute('aria-valuetext', date + ' ' + measure.label + ' ' + label);
    const left = x(selected);
    cursor.setAttribute('x1', left);
    cursor.setAttribute('x2', left);
    marker.style.display = value === undefined ? 'none' : '';
    if (value !== undefined) {
      marker.setAttribute('cx', left);
      marker.setAttribute('cy', y(value));
    }
  }

  function draw() {
    const width = Math.max(250, plot.clientWidth || 700);
    const top = 9, bottom = HEIGHT - 30;
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + HEIGHT);
    svg.replaceChildren();
    let min = 0, max = 0;
    for (const value of values.values()) { min = Math.min(min, value); max = Math.max(max, value); }
    const rawStep = Math.max(metric === 'sales_amount' ? .01 : 1, (max - min) / 4);
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = ([1, 2, 5, 10].find(n => n * magnitude >= rawStep) || 10) * magnitude;
    const lowTick = Math.floor(min / step);
    const highTick = Math.max(lowTick + 1, Math.ceil(max / step));
    const tickLabel = tick => numbers.format(Number((tick * step).toFixed(2)));
    plotLeft = Math.max(38, Math.max(tickLabel(lowTick).length, tickLabel(highTick).length) * 7 + 14);
    plotWidth = Math.max(1, width - plotLeft - 12);
    x = index => plotLeft + (dayCount === 1 ? .5 : index / (dayCount - 1)) * plotWidth;
    y = value => bottom - ((value / step - lowTick) / (highTick - lowTick)) * (bottom - top);
    for (let tick = lowTick; tick <= highTick; tick++) {
      const rowY = y(tick * step);
      svgNode('line', { x1: plotLeft, x2: plotLeft + plotWidth, y1: rowY, y2: rowY, class: 'sales-trend-grid' });
      svgNode('text', { x: plotLeft - 8, y: rowY + 4, 'text-anchor': 'end', class: 'sales-trend-axis' }, tickLabel(tick));
    }
    const crossYear = dateAt(0).slice(0, 4) !== dateAt(dayCount - 1).slice(0, 4);
    const maxTicks = Math.max(2, Math.min(8, Math.floor(plotWidth / (crossYear ? 85 : 62))));
    const labels = Math.min(maxTicks, dayCount);
    for (let i = 0; i < labels; i++) {
      const index = labels === 1 ? 0 : Math.round(i * (dayCount - 1) / (labels - 1));
      const anchor = labels === 1 ? 'middle' : i === 0 ? 'start' : i === labels - 1 ? 'end' : 'middle';
      const date = dateAt(index);
      svgNode('text', { x: x(index), y: HEIGHT - 7, 'text-anchor': anchor, class: 'sales-trend-axis' }, crossYear ? date : date.slice(5).replace('-', '/'));
    }
    const points = [...values].sort((a, b) => a[0] - b[0]);
    let previous = -2;
    const path = [];
    for (const [i, value] of points) {
      path.push((i === previous + 1 ? 'L' : 'M') + x(i).toFixed(2) + ',' + y(value).toFixed(2));
      previous = i;
    }
    svgNode('path', { d: path.join(' '), class: 'sales-trend-line' });
    for (const [i, value] of points) {
      if (dayCount <= 31 || (!values.has(i - 1) && !values.has(i + 1))) {
        svgNode('circle', { cx: x(i), cy: y(value), r: 3, class: 'sales-trend-dot' });
      }
    }
    cursor = svgNode('line', { y1: top, y2: bottom, class: 'sales-trend-cursor' });
    marker = svgNode('circle', { r: 5, class: 'sales-trend-marker' });
    select(selected);
  }

  let stateMessage = '';
  function refresh() {
    values = new Map();
    for (const [index, row] of rows) {
      const value = valueOf(row);
      if (value != null) values.set(index, value);
    }
    const measure = metrics[metric];
    const unavailable = !!stateMessage || !dayCount || !values.size;
    body.hidden = unavailable;
    if (unavailable) {
      status.textContent = stateMessage || ('所选日期暂无可用的' + measure.label + '数据。');
      status.hidden = false;
      svg.replaceChildren();
      readout.replaceChildren();
      return;
    }
    status.hidden = values.size === dayCount;
    status.textContent = status.hidden ? '' : '所选 ' + dayCount + ' 天中，有 ' + (dayCount - values.size) + ' 天缺少' + measure.label + '数据，图中留空。';
    root.querySelector('[data-trend-unit]').textContent = measure.label + '（' + measure.unit + '）';
    svg.setAttribute('aria-label', dateAt(0) + ' 至 ' + dateAt(dayCount - 1) + '，每日' + measure.label);
    plot.setAttribute('aria-valuemax', String(dayCount));
    draw();
  }

  function render({ start, end, days = [], message = '' }) {
    if (!root && !initialize()) return;
    const nextFirst = dateNumber(start), nextLast = dateNumber(end);
    const changed = first !== nextFirst || last !== nextLast;
    first = nextFirst;
    last = nextLast;
    dayCount = Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first + 1 : 0;
    rows = new Map();
    for (const row of Array.isArray(days) ? days : []) {
      const index = dateNumber(row?.date) - first;
      if (index >= 0 && index < dayCount) rows.set(index, row);
    }
    if (changed) selected = Math.max(0, dayCount - 1);
    stateMessage = message;
    refresh();
  }

  window.MCSalesHistoryChart = { render };
})();
