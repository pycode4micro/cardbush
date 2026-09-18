import { chineseDate, gregorianFromChinese } from './calendar-date.mjs';
try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'gregorian' && args.length === 1) console.log(JSON.stringify({ gregorian: args[0], chinese: chineseDate(args[0]) }));
  else if (mode === 'chinese' && (args.length === 3 || args.length === 4) && (!args[3] || args[3] === '--leap')) {
    const date = gregorianFromChinese(...args.slice(0, 3).map(Number), args[3] === '--leap');
    console.log(JSON.stringify({ gregorian: date, chinese: chineseDate(date) }));
  } else throw Error('Usage: node convert-date.mjs gregorian YYYY-MM-DD | chinese YEAR MONTH DAY [--leap]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
