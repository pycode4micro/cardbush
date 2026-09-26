// Explicit maintenance command only. The application reads the checked-in JSON
// offline and never downloads or enables calendars at startup.
import { mkdir, writeFile } from 'node:fs/promises';
import { chineseDate } from '../assets/skills/cardbush-docs/scripts/calendar-date.mjs';
const startYear = 2020, endYear = 2050;
const from = `${startYear}-01-01`, to = `${endYear + 1}-01-01`;
const dateKey = date => date.toISOString().slice(0, 10);
const key = (year, month, day) => dateKey(new Date(Date.UTC(year, month - 1, day)));
const china = [], us = [];
const add = (entries, date, title, description) => entries.push({ id: `${date}-${title}`, date, title, kind: 'holiday', ...(description ? { description } : {}) });
const lunarFestivals = new Map([['1-1','春节'],['1-15','元宵节'],['5-5','端午节'],['7-7','七夕'],['7-15','中元节'],['8-15','中秋节'],['9-9','重阳节'],['12-8','腊八节']]);
const monthNames = ['正','二','三','四','五','六','七','八','九','十','十一','十二'];
const dayNames = ['初一','初二','初三','初四','初五','初六','初七','初八','初九','初十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十','廿一','廿二','廿三','廿四','廿五','廿六','廿七','廿八','廿九','三十'];
async function chineseYear(year) {
  const response = await fetch(`https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T${year}c.txt`);
  if (!response.ok) throw Error(`HKO ${year}: HTTP ${response.status}`);
  const text = await response.text();
  let { month, leapMonth } = chineseDate(`${year}-01-01`), rows = 0, qingming = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d{4})年(\d+)月(\d+)日\s+(\S+)\s+星期\S+\s*(.*)$/.exec(line);
    if (!match) continue;
    rows++;
    const date = key(Number(match[1]), Number(match[2]), Number(match[3])), lunar = match[4];
    let day;
    if (lunar.endsWith('月')) {
      leapMonth = lunar.startsWith('閏'); month = monthNames.indexOf(lunar.replace(/^閏/, '').slice(0, -1)) + 1; day = 1;
    } else day = dayNames.indexOf(lunar) + 1;
    if (!month || !day) throw Error(`Unrecognized HKO lunar date: ${line}`);
    const festival = !leapMonth && lunarFestivals.get(`${month}-${day}`);
    if (festival) add(china, date, festival);
    if (!leapMonth && month === 1 && day === 1) add(china, dateKey(new Date(Date.parse(date+'T12:00:00Z')-86400000)), '除夕');
    if (match[5].includes('清明')) { add(china, date, '清明节'); qingming++; }
  }
  const expected = (Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000;
  if (rows !== expected || qingming !== 1) throw Error(`Incomplete HKO table ${year}: ${rows} rows, ${qingming} Qingming dates`);
  for (const [month, day, title] of [[1,1,'元旦'],[5,1,'劳动节'],[6,1,'儿童节'],[9,10,'教师节'],[10,1,'国庆节']]) add(china,key(year,month,day),title);
}
for (let year = startYear; year <= endYear; year += 4) {
  await Promise.all(Array.from({length: Math.min(4,endYear-year+1)},(_,offset)=>chineseYear(year+offset)));
  console.log(`Chinese calendar: ${year}–${Math.min(year+3,endYear)}`);
}
const weekday = (year, month, day, occurrence) => {
  const first = new Date(Date.UTC(year,month-1,1)).getUTCDay();
  return key(year,month,1+(day-first+7)%7+(occurrence-1)*7);
};
function fixedUS(year, month, day, title) {
  const date = key(year,month,day); add(us,date,title);
  const weekday = new Date(date+'T12:00:00Z').getUTCDay();
  if (weekday === 0 || weekday === 6) add(us,key(year,month,day+(weekday === 0 ? 1 : -1)),`${title}（补休 / observed）`, '按美国联邦雇员周一至周五工作制的周末补休规则。');
}
for (let year=startYear;year<=endYear+1;year++) {
  fixedUS(year,1,1,'元旦 / New Year’s Day');
  add(us,weekday(year,1,1,3),'马丁·路德·金纪念日 / Martin Luther King Jr. Day');
  add(us,weekday(year,2,1,3),'华盛顿诞辰日 / Washington’s Birthday');
  const lastMay = new Date(Date.UTC(year,5,0));
  add(us,key(year,5,lastMay.getUTCDate()-(lastMay.getUTCDay()+6)%7),'阵亡将士纪念日 / Memorial Day');
  if(year>=2021) fixedUS(year,6,19,'六月节 / Juneteenth');
  fixedUS(year,7,4,'独立日 / Independence Day');
  add(us,weekday(year,9,1,1),'劳动节 / Labor Day');
  add(us,weekday(year,10,1,2),'哥伦布日 / Columbus Day');
  fixedUS(year,11,11,'退伍军人节 / Veterans Day');
  add(us,weekday(year,11,4,4),'感恩节 / Thanksgiving Day');
  fixedUS(year,12,25,'圣诞节 / Christmas Day');
}
const make = (id,name,timeZone,source,entries) => ({protocol:'cardbush.calendar.v1',id,name,timeZone,source,recurrenceWindow:{from,to},entries:entries.filter(e=>e.date>=from&&e.date<to).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id))});
await mkdir('assets/calendars',{recursive:true});
for (const [file,data] of [
  ['china',make('cardbush.chinese','中国农历与节日','Asia/Shanghai','香港天文台公历与农历日期对照表 https://www.hko.gov.hk/tc/gts/time/conversion.htm；常见传统节日与公历节日，不包含年度调休安排。',china)],
  ['us',make('cardbush.us','美国日历与节日','America/New_York','U.S. Office of Personnel Management https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/；全国联邦节日及标准周末补休，不包含地区性、临时行政假日。',us)],
]) await writeFile(`assets/calendars/${file}.json`,JSON.stringify(data,null,2)+'\n');
