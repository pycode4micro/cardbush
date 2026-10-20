type XmlNode = Record<string, any>;
const list = (value: XmlNode | XmlNode[] | undefined): XmlNode[] => value ? Array.isArray(value) ? value : [value] : [];

/** Normalize cached categories into the pinned parser's existing strRef path.
 * PptxGenJS emits multiLvlStrRef even for one plain row of labels. */
export function normalizeChartCategories(series: XmlNode | XmlNode[] | undefined): typeof series {
  if (!series) return series;
  if (Array.isArray(series)) return series.map(item => normalizeChartCategories(item) as XmlNode);
  const cat = series['c:cat'];
  if (!cat || cat['c:strRef'] || cat['c:numRef']) return series;
  const cache = cat['c:multiLvlStrRef']?.['c:multiLvlStrCache'];
  let points: XmlNode[];
  if (cache) {
    const levels = list(cache['c:lvl']).map(level => new Map(list(level['c:pt']).map(point => [String(point.attrs.idx), String(point['c:v'] ?? '')])));
    const indices = [...new Set(levels.flatMap(level => [...level.keys()]))].sort((a, b) => Number(a) - Number(b));
    points = indices.map(index => ({ attrs: { idx: index }, 'c:v': levels.map(level => level.get(index)).filter(Boolean).join(' / ') }));
  } else {
    const literal = cat['c:strLit'] ?? cat['c:numLit'];
    if (!literal) return series;
    points = list(literal['c:pt']);
  }
  return { ...series, 'c:cat': { ...cat, 'c:strRef': { 'c:strCache': { 'c:pt': points } } } };
}
