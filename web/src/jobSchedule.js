export const presets = {
  manual: '手动 / 事件触发',
  once: '一次性',
  hourly: '每小时整点',
  hours: '每隔若干小时',
  daily: '每天',
  weekdays: '工作日（周一至周五）',
  weekends: '周末（周六、周日）',
  weekly: '每周指定星期',
  interval: '每隔若干天',
  'month-first': '每月第一天',
  'month-last': '每月最后一天',
  'month-end': '每月最后两天',
  'monthly-days': '每月固定日期 / 倒数第几天',
  'monthly-workday': '每月首个 / 末个工作日',
  yearly: '每年固定日期',
  custom: '自定义周期规则（RRULE）',
};

export const weekdays = {
  MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日',
};
const weekdayOrder = Object.keys(weekdays);
const workweek = 'MO,TU,WE,TH,FR';
const weekend = 'SA,SU';
const fixedRules = {
  hourly: 'FREQ=HOURLY;BYMINUTE=0;BYSECOND=0',
  daily: 'FREQ=DAILY',
  weekdays: `FREQ=WEEKLY;BYDAY=${workweek}`,
  weekends: `FREQ=WEEKLY;BYDAY=${weekend}`,
  'month-first': 'FREQ=MONTHLY;BYMONTHDAY=1',
  'month-last': 'FREQ=MONTHLY;BYMONTHDAY=-1',
  'month-end': 'FREQ=MONTHLY;BYMONTHDAY=-2,-1',
};

function calendarDate(ymd) {
  return new Date(`${ymd}T00:00:00Z`);
}

function formatDate(date) {
  if (date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999) return date.toISOString().slice(0, 10);
  throw new Error('请选择有效日期');
}

export function shiftLocalDate(ymd, days) {
  if (!Number.isSafeInteger(days)) throw new Error('日期偏移须为整数');
  const date = calendarDate(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

export function monthEndLocalDate(ymd) {
  const date = calendarDate(ymd);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return formatDate(date);
}

function monthDays(value) {
  const parts = value.split(/[,，]/).map(part => part.trim());
  if (!parts.every(part => /^[+-]?\d+$/.test(part))) return null;
  const days = parts.map(Number);
  return days.every(day => day !== 0 && Math.abs(day) <= 31) ? [...new Set(days)] : null;
}

export function readScheduleFields(schedule, startDate, time, today) {
  const start = calendarDate(startDate);
  const anchor = Number.isNaN(start.getTime()) ? calendarDate(today) : start;
  const fields = {
    preset: schedule.type || 'manual', startDate, time, hours: '1', days: '3', weeks: '1',
    selectedDays: [weekdayOrder[(anchor.getUTCDay() + 6) % 7]],
    monthDays: String(anchor.getUTCDate()), workdayPosition: '1',
    yearMonth: String(anchor.getUTCMonth() + 1), yearDay: String(anchor.getUTCDate()),
    rrule: schedule.rrule || '',
  };
  if (schedule.type !== 'recurring') return fields;

  fields.preset = 'custom';
  const entries = fields.rrule.trim().replace(/^RRULE:/i, '').split(';');
  if (entries.some(entry => !/^[a-z]+=[^=\s]+$/i.test(entry))) return fields;
  const parts = Object.fromEntries(entries.map(entry => entry.toUpperCase().split('=')));
  if (Object.keys(parts).length !== entries.length) return fields;

  const { FREQ: freq, INTERVAL: interval, BYDAY: byday, BYMONTHDAY: bymonthday, BYSETPOS: position } = parts;
  const only = (...keys) => Object.keys(parts).every(key => key === 'FREQ' || keys.includes(key));
  const validInterval = interval === undefined || (/^\d+$/.test(interval) && Number(interval) >= 1 && Number(interval) <= 10000);
  if (!validInterval) return fields;

  if (freq === 'HOURLY' && only('BYMINUTE', 'BYSECOND') && parts.BYMINUTE === '0' && parts.BYSECOND === '0') {
    return { ...fields, preset: 'hourly' };
  }
  if (freq === 'HOURLY' && only('INTERVAL')) return { ...fields, preset: 'hours', hours: interval || '1' };
  if (freq === 'DAILY' && only('INTERVAL')) return interval ? { ...fields, preset: 'interval', days: interval } : { ...fields, preset: 'daily' };

  const bydayValues = byday?.split(',');
  const selected = weekdayOrder.filter(day => bydayValues?.includes(day));
  const plainWeekdays = selected.length === bydayValues?.length;
  if (freq === 'WEEKLY' && only('BYDAY', 'INTERVAL') && (!byday || plainWeekdays)) {
    const days = selected.join(',');
    if (Number(interval || 1) === 1 && days === workweek) return { ...fields, preset: 'weekdays' };
    if (Number(interval || 1) === 1 && days === weekend) return { ...fields, preset: 'weekends' };
    return { ...fields, preset: 'weekly', selectedDays: byday ? selected : fields.selectedDays, weeks: interval || '1' };
  }

  if (freq === 'MONTHLY' && Number(interval || 1) === 1 && only('BYMONTHDAY', 'INTERVAL')) {
    if (!bymonthday) return { ...fields, preset: 'monthly-days' };
    const days = monthDays(bymonthday);
    if (!days) return fields;
    const preset = { '1': 'month-first', '-1': 'month-last', '-2,-1': 'month-end' }[days.slice().sort((a, b) => a - b).join(',')];
    return { ...fields, preset: preset || 'monthly-days', monthDays: days.join(',') };
  }
  if (freq === 'MONTHLY' && only('BYDAY', 'BYSETPOS') && plainWeekdays && selected.join(',') === workweek && ['1', '-1'].includes(position)) {
    return { ...fields, preset: 'monthly-workday', workdayPosition: position };
  }
  if (freq === 'YEARLY' && only('BYMONTH', 'BYMONTHDAY') && /^(?:[1-9]|1[0-2])$/.test(parts.BYMONTH) && /^(?:[1-9]|[12]\d|3[01])$/.test(bymonthday)) {
    return { ...fields, preset: 'yearly', yearMonth: parts.BYMONTH, yearDay: bymonthday };
  }
  return fields;
}

export function buildSchedule(fields) {
  const { preset, startDate, time, hours, days, weeks, selectedDays, workdayPosition, yearMonth, yearDay } = fields;
  if (preset === 'manual') return { type: 'manual' };
  if (preset === 'once') return { type: 'once', at: new Date(`${startDate}T${time}:00+08:00`).toISOString() };

  let rrule = fixedRules[preset];
  switch (preset) {
    case 'hours': rrule = `FREQ=HOURLY;INTERVAL=${Number(hours)}`; break;
    case 'interval': rrule = `FREQ=DAILY;INTERVAL=${Number(days)}`; break;
    case 'weekly':
      if (!selectedDays.length) throw new Error('请至少选择一个星期几');
      rrule = `FREQ=WEEKLY;BYDAY=${weekdayOrder.filter(day => selectedDays.includes(day)).join(',')}`;
      if (Number(weeks) > 1) rrule += `;INTERVAL=${Number(weeks)}`;
      break;
    case 'monthly-days': {
      const daysOfMonth = monthDays(fields.monthDays);
      if (!daysOfMonth) throw new Error('请输入逗号分隔的月内日期，每个值须为 -31 到 31 的整数，且不能为 0');
      rrule = `FREQ=MONTHLY;BYMONTHDAY=${daysOfMonth.join(',')}`;
      break;
    }
    case 'monthly-workday': rrule = `FREQ=MONTHLY;BYDAY=${workweek};BYSETPOS=${workdayPosition}`; break;
    case 'yearly':
      rrule = `FREQ=YEARLY;BYMONTH=${yearMonth};BYMONTHDAY=${yearDay}`;
      break;
    case 'custom': rrule = fields.rrule.trim(); break;
  }
  return { type: 'recurring', rrule, time: preset === 'hourly' ? '00:00' : time, startDate };
}

export function describeSchedule(fields) {
  const { preset, startDate, time, hours, days, weeks, selectedDays, workdayPosition, yearMonth, yearDay } = fields;
  const weekdaysText = weekdayOrder.filter(day => selectedDays.includes(day)).map(day => weekdays[day]).join('、');
  let frequency = presets[preset];
  switch (preset) {
    case 'manual': return '手动执行或收到关联事件时触发';
    case 'once': return startDate && time ? `将于 ${startDate} ${time}（北京时间）触发一次` : '请选择触发日期和时间';
    case 'hourly': return '将在每小时整点触发';
    case 'hours': return hours && time ? `从 ${startDate} ${time} 起每隔 ${hours} 小时触发` : '请设置间隔小时数和时间';
    case 'interval': frequency = days ? `每隔 ${days} 天` : ''; break;
    case 'weekly':
      if (!weekdaysText) return '请至少选择一个星期几';
      frequency = Number(weeks) > 1 ? `每隔 ${weeks} 周的${weekdaysText}` : `每${weekdaysText}`;
      break;
    case 'monthly-days': {
      const daysOfMonth = monthDays(fields.monthDays);
      if (!daysOfMonth) return '请输入 -31 到 31 的月内日期，日期不能为 0';
      frequency = `每月${daysOfMonth.map(day => day > 0 ? `${day} 日` : `倒数第 ${-day} 天`).join('、')}`;
      break;
    }
    case 'monthly-workday': frequency = workdayPosition === '1' ? '每月第 1 个工作日' : '每月最后 1 个工作日'; break;
    case 'yearly': frequency = `每年 ${yearMonth} 月 ${yearDay} 日`; break;
    case 'custom': return fields.rrule.trim() ? `将按自定义规则触发，起点为 ${startDate} ${time}` : '请输入周期规则（RRULE）';
  }
  return frequency && time ? `将在${frequency} ${time} 触发` : '请设置周期间隔和时间';
}
