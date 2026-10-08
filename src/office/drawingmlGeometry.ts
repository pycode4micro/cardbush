import catalog from './presetShapes.json';

type Formula = [string, string];
type Point = { x: string; y: string };
type Command = { kind: string; points: Point[]; wR?: string; hR?: string; stAng?: string; swAng?: string };
type ShapePath = { w?: string; h?: string; fill?: string; stroke?: string; commands: Command[] };
type Preset = { adjustments: Formula[]; guides: Formula[]; paths: ShapePath[] };
type GuideNode = { attrs?: { name?: string; fmla?: string } };
export type GeometryPath = { d: string; fill: string; stroke: boolean };
const presets = catalog.presets as unknown as Record<string, Preset>;
const radians = Math.PI / 10800000;
const excluded = /^(?:line(?:Inv)?|straightConnector1|(?:bent|curved)Connector[2-5])$/;
const number = (value: number) => {
  if (!Number.isFinite(value)) throw Error('Non-finite DrawingML coordinate');
  return String(Math.abs(value) < 1e-8 ? 0 : Math.round(value * 1e6) / 1e6);
};

// DrawingML guides are a small arithmetic language, never JavaScript/eval.
export function evaluateGuide(formula: string, resolve: (name: string) => number): number {
  const [operator, ...args] = formula.trim().split(/\s+/);
  const [a = 0, b = 0, c = 0] = args.map(resolve);
  switch (operator) {
    case 'val': return a;
    case '*/': return b === 0 || a === 0 ? 0 : a * b / c;
    case '+-': return a + b - c;
    case '+/': return (a + b) / c;
    case '?:': return a > 0 ? b : c;
    case 'abs': return Math.abs(a);
    case 'at2': return Math.atan2(b, a) / radians;
    case 'cat2': return a * Math.cos(Math.atan2(c, b));
    case 'sat2': return a * Math.sin(Math.atan2(c, b));
    case 'cos': return a * Math.cos(b * radians);
    case 'sin': return a * Math.sin(b * radians);
    case 'tan': return a * Math.tan(b * radians);
    case 'max': return Math.max(a, b);
    case 'min': return Math.min(a, b);
    case 'mod': return Math.hypot(a, b, c);
    case 'pin': return Math.max(a, Math.min(b, c));
    case 'sqrt': return Math.sqrt(Math.max(0, a));
    default: throw Error(`Unsupported DrawingML formula: ${operator}`);
  }
}

export function presetGeometry(name: string, width: number, height: number,
  adjustments: Record<string, string | number> = {}): GeometryPath[] | null {
  const preset = presets[name];
  if (!preset || excluded.test(name)) return null;
  if (!(width > 0 && height > 0)) return [];
  const values: Record<string, number> = { w: width, h: height, l: 0, t: 0, r: width, b: height,
    hc: width / 2, vc: height / 2, ss: Math.min(width, height), ls: Math.max(width, height),
    cd2: 10800000, cd4: 5400000, cd8: 2700000, '3cd4': 16200000, '3cd8': 8100000, '5cd8': 13500000, '7cd8': 18900000 };
  const resolve = (token: string): number => {
    if (token in values) return values[token];
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
    const divisor = /^(wd|hd|ssd)(\d+)$/.exec(token);
    if (divisor) return (divisor[1] === 'wd' ? width : divisor[1] === 'hd' ? height : values.ss) / Number(divisor[2]);
    // POI's authoritative catalog contains the historical cd3 / cd6 aliases.
    const angle = /^cd(\d+)$/.exec(token);
    if (angle) return 21600000 / Number(angle[1]);
    throw Error(`Unknown DrawingML guide ${token} in ${name}`);
  };
  for (const [key, formula] of preset.adjustments) {
    const override = adjustments[key];
    values[key] = typeof override === 'number' ? override : evaluateGuide(override ?? formula, resolve);
  }
  for (const [key, formula] of preset.guides) values[key] = evaluateGuide(formula, resolve);
  return preset.paths.map(path => {
    // Path-space scaling applies to the whole path. Default/zero dimensions use
    // the shape's coordinate space, rather than stretching radii independently.
    const sx = Number(path.w) > 0 ? width / Number(path.w) : 1;
    const sy = Number(path.h) > 0 ? height / Number(path.h) : 1;
    let x = 0, y = 0, startX = 0, startY = 0;
    const data: string[] = [];
    const point = (p: Point) => [resolve(p.x), resolve(p.y)] as const;
    const xy = (px: number, py: number) => `${number(px * sx)},${number(py * sy)}`;
    for (const command of path.commands) {
      if (command.kind === 'close') {
        data.push('Z'); x = startX; y = startY;
      } else if (command.kind === 'arcTo') {
        const rx = Math.abs(resolve(command.wR!)), ry = Math.abs(resolve(command.hR!));
        const angle = resolve(command.stAng!) * radians;
        const sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, resolve(command.swAng!) * radians));
        // OOXML angles describe the ray from the ellipse's center. SVG angles
        // parameterize the ellipse; use its actual intersection with that ray.
        const offset = (a: number) => {
          const c = Math.cos(a), s = Math.sin(a), denominator = Math.hypot(ry * c, rx * s);
          return denominator ? [rx * ry * c / denominator, rx * ry * s / denominator] : [0, 0];
        };
        const [ox, oy] = offset(angle), cx = x - ox, cy = y - oy;
        // A full circle needs at least two SVG arcs. Smaller sweeps are split as
        // well, avoiding both the identical-endpoint and large-arc ambiguities.
        const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
        for (let i = 1; i <= pieces; i++) {
          const [dx, dy] = offset(angle + sweep * i / pieces);
          x = cx + dx; y = cy + dy;
          data.push(rx && ry ? `A${number(rx * sx)},${number(ry * sy)} 0 0 ${sweep >= 0 ? 1 : 0} ${xy(x, y)}` : `L${xy(x, y)}`);
        }
      } else {
        const points = command.points.map(point);
        const end = points.at(-1);
        if (!end) throw Error(`Missing DrawingML path point in ${name}`);
        [x, y] = end;
        if (command.kind === 'moveTo') { startX = x; startY = y; data.push(`M${xy(x, y)}`); }
        else if (command.kind === 'lnTo') data.push(`L${xy(x, y)}`);
        else if (command.kind === 'quadBezTo') data.push(`Q${points.map(p => xy(...p)).join(' ')}`);
        else if (command.kind === 'cubicBezTo') data.push(`C${points.map(p => xy(...p)).join(' ')}`);
        else throw Error(`Unsupported DrawingML path command ${command.kind}`);
      }
    }
    return { d: data.join(' '), fill: path.fill ?? 'norm', stroke: path.stroke !== 'false' && path.stroke !== '0' };
  });
}

function attribute(value: unknown) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function nativePresetMarkup(name: string, width: number, height: number, rawGuides: GuideNode | GuideNode[] | undefined,
  paint: { fill: string; stroke: string; width: number; dash: string }): string | null {
  const adjustments: Record<string, string> = {};
  for (const guide of rawGuides ? Array.isArray(rawGuides) ? rawGuides : [rawGuides] : []) {
    if (guide.attrs?.name && guide.attrs.fmla) adjustments[guide.attrs.name] = guide.attrs.fmla;
  }
  const paths = presetGeometry(name, width, height, adjustments);
  if (paths == null) return null;
  return paths.map(path => {
    const shape = `d='${attribute(path.d)}'`;
    const stroke = path.stroke ? `stroke='${attribute(paint.stroke)}' stroke-width='${attribute(paint.width)}' stroke-dasharray='${attribute(paint.dash)}'` : "stroke='none'";
    const fill = attribute(path.fill === 'none' ? 'none' : paint.fill);
    const base = `<path ${shape} fill='${fill}' ${stroke}/>`;
    const shaded = path.fill.match(/^(lighten|darken)(Less)?$/);
    if (!shaded || paint.fill === 'none') return base;
    // Preserve gradients/image fills, then apply the DrawingML shade uniformly.
    return `<path ${shape} fill='${fill}' stroke='none'/>` +
      `<path ${shape} fill='${shaded[1] === 'lighten' ? '#fff' : '#000'}' opacity='${shaded[2] ? .2 : .4}' stroke='none'/>` +
      `<path ${shape} fill='none' ${stroke}/>`;
  }).join('');
}
