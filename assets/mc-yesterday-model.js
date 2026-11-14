(function () {
  'use strict';

  const pacificCalendar = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const otherChannels = ['SB', 'SD'];
  const feeKeys = ['review_fee', 'offsite_fee', 'other_fee'];
  const calendarShape = /^\d{4}-\d{2}-\d{2}$/u;

  function parseDate(value) {
    if (typeof value !== 'string' || value.length !== 10 || !calendarShape.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null;
  }

  function yesterday(now = Date.now()) {
    if (!(now instanceof Date) && !Number.isFinite(now)) return null;
    if (!Number.isFinite(+now)) return null;
    const parts = Object.fromEntries(pacificCalendar.formatToParts(now).map(({ type, value }) => [type, value]));
    const pacificDay = parseDate(`${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`);
    if (!pacificDay) return null;
    pacificDay.setUTCDate(pacificDay.getUTCDate() - 1);
    return pacificDay.toISOString().slice(0, 10);
  }

  function number(value, min = 0) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/u.test(value.trim()))) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? parsed : null;
  }

  function count(value) {
    const parsed = number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function ratio(lhs, rhs) {
    return lhs !== null && rhs !== null && rhs > 0 ? lhs / rhs : null;
  }

  function knownTotal(values) {
    if (!values.length || values.some(value => value === null)) return null;
    return number(values.reduce((total, value) => total + value, 0));
  }

  function fee(value) {
    const parsed = number(value);
    return parsed !== null && parsed <= 9_999_999_999.99 && parsed === Math.round(parsed * 100) / 100 ? parsed : null;
  }

  function oneDay(row, date) {
    return row?.report_date === date ? row : null;
  }

  function build({ date, traffic, sp, profit, returns, fees, otherAds, spError = false } = {}) {
    const week = parseDate(date);
    if (!week) throw new TypeError('Invalid MC report date');
    week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7);
    const monday = week.toISOString().slice(0, 10);
    traffic = oneDay(traffic, date);
    sp = spError ? null : oneDay(sp, date);
    profit = oneDay(profit, date);
    returns = oneDay(returns, date);
    fees = oneDay(fees, date);

    const trafficDays = [0, 1].includes(traffic?.traffic_days) ? traffic.traffic_days : null;
    const currentTraffic = trafficDays === 1 ? traffic : null;
    const sales = number(currentTraffic?.sales);
    const orders = count(currentTraffic?.orders);
    const units = count(currentTraffic?.units);
    const visits = count(currentTraffic?.visits);

    const spCost = number(sp?.sp_cost);
    const spSales = number(sp?.sp_sales);
    const spOrders = count(sp?.sp_orders);
    const spValues = { cost: spCost, sales: spSales, orders: spOrders };
    const channels = new Map();
    if (Object.values(spValues).some(value => value !== null)) channels.set('SP', spValues);
    const otherRows = !otherAds?.error && Array.isArray(otherAds?.rows) ? otherAds.rows : [];
    for (const name of otherChannels) {
      const found = otherRows.filter(row => row?.channel === name && row.report_date === date);
      if (found.length === 1) {
        const row = found[0];
        const values = { cost: number(row.cost), sales: number(row.sales), orders: count(row.orders) };
        if (Object.values(values).some(value => value !== null)) channels.set(name, values);
      }
    }
    const scope = [...channels.keys()];
    const [totalAdCost, totalAdSales, totalAdOrders] = ['cost', 'sales', 'orders']
      .map(metric => knownTotal([...channels.values()].map(channel => channel[metric])));
    const coverage = new Map((Array.isArray(otherAds?.coverage) ? otherAds.coverage : [])
      .filter(row => row?.week_start === monday && otherChannels.includes(row.channel))
      .map(row => [row.channel, row.status]));
    const fromStatuses = statuses => otherChannels.filter(name => statuses.includes(coverage.get(name)));

    const feeValues = Object.fromEntries(feeKeys.map(key => [key, fee(fees?.[key])]));
    const feeTotalCents = knownTotal(feeKeys.map(key => feeValues[key] === null ? null : Math.round(feeValues[key] * 100)));
    const beforeAds = number(profit?.profit_before_ads, -Number.MAX_SAFE_INTEGER);
    const salesBasis = number(profit?.sales_basis);
    const estimate = !spError && !otherAds?.error && beforeAds !== null && totalAdCost !== null &&
      feeTotalCents !== null && salesBasis !== null && salesBasis === sales
      ? beforeAds - totalAdCost - feeTotalCents / 100 : null;
    const returnUnits = count(returns?.return_units);
    const shippedUnits = count(returns?.shipped_units);

    return {
      overview: {
        date, sales, profit: estimate, orders, units, visits,
        unit_session_rate: ratio(units, visits), returns_rate: ratio(returnUnits, shippedUnits),
        return_units: returnUnits, shipped_units: shippedUnits, traffic_days: trafficDays,
        total_ad_cost: totalAdCost, sp_cost: spCost, sp_orders: spOrders, sp_acos: ratio(spCost, spSales),
        sbv_cost: null, sb_cost: channels.get('SB')?.cost ?? null, sd_cost: channels.get('SD')?.cost ?? null,
        ...feeValues,
      },
      advertising: {
        date, scope: channels.has('SP') ? '仅 SP' : null,
        ad_channels: scope, ad_missing_reports: fromStatuses(['missing']),
        ad_pending: fromStatuses(['unmapped', 'partial']), ad_empty: fromStatuses(['empty']),
        ad_cost: totalAdCost, ad_sales: totalAdSales, ad_orders: totalAdOrders,
        sales, sp_sales: spSales, sp_sales_share: ratio(spSales, sales), sp_cost: spCost, sp_orders: spOrders,
        sp_impressions: count(sp?.sp_impressions), sp_clicks: count(sp?.sp_clicks), sp_acos: ratio(spCost, spSales),
      },
    };
  }

  const model = Object.freeze({ yesterday, parseDate, build });
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  if (typeof window !== 'undefined') window.MCYesterdayModel = model;
})();
