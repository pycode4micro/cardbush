const numbers = new Intl.DateTimeFormat('en-u-ca-chinese', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
const names = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', timeZone: 'UTC' });
const digits = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export function chineseDate(gregorian) {
  const date = new Date(`${gregorian}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gregorian) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== gregorian || gregorian < '1900-01-01' || gregorian > '2199-12-31') throw Error('Expected a valid Gregorian date within 1900–2199.');
  const parts = Object.fromEntries(numbers.formatToParts(date).map(part => [part.type, part.value]));
  const day = Number(parts.day), month = parseInt(parts.month, 10), leapMonth = parts.month.endsWith('bis');
  const dayName = day === 10 ? '初十' : day === 20 ? '二十' : day === 30 ? '三十' : (day < 10 ? '初' : day < 20 ? '十' : '廿') + digits[(day - 1) % 10];
  const monthName = names.format(date);
  return { year: Number(parts.relatedYear), month, day, leapMonth, label: day === 1 ? monthName : dayName, fullLabel: `${monthName}${dayName}` };
}
export function gregorianFromChinese(year, month, day, leapMonth = false) {
  if (![year, month, day].every(Number.isInteger) || year < 1900 || year > 2198 || month < 1 || month > 12 || day < 1 || day > 30 || typeof leapMonth !== 'boolean') throw Error('Invalid Chinese calendar date.');
  // Scan only the requested lunar year's possible civil range, never an
  // unbounded calendar. Leap months must match explicitly.
  for (let at = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 2, 1); at < end; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10), lunar = chineseDate(date);
    if (lunar.year === year && lunar.month === month && lunar.day === day && lunar.leapMonth === leapMonth) return date;
  }
  throw Error('This lunar date or leap month does not exist in the specified year.');
}
