export type FriendDesign = { name: string; description: string; svg: string };
export type FriendCharacter = 'sprout' | 'bunny' | 'cat';
export type FriendAppearance = { type: 'builtin'; character: FriendCharacter } | {
  type: 'generated'; design: FriendDesign; model: string; createdAt: string; sessionId: string;
};

const tags = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polygon', 'polyline', 'defs', 'linearGradient', 'radialGradient', 'stop']);
const numeric = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'fx', 'fy', 'offset', 'opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'stroke-width']);
const colors = new Set(['fill', 'stroke', 'stop-color']);
const namespace = 'http://www.w3.org/2000/svg';

/** An inert image document, never executable HTML. No scripts, CSS, URLs or external resources. */
export function validFriendSvg(svg: unknown): svg is string {
  if (typeof svg !== 'string' || svg.length > 60000 || /<!DOCTYPE|<!ENTITY|<\?/i.test(svg)) return false;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg' || root.namespaceURI !== namespace || root.getAttribute('viewBox') !== '0 0 240 240') return false;
  const elements = [...doc.querySelectorAll('*')], ids = new Set<string>(), references: string[] = [];
  if (elements.length < 2 || elements.length > 160) return false;
  let visibleShapes = 0;
  for (const element of elements) {
    if (!tags.has(element.localName) || element.namespaceURI !== namespace) return false;
    if (['path', 'circle', 'ellipse', 'rect', 'line', 'polygon', 'polyline'].includes(element.localName)) visibleShapes++;
    for (const attr of [...element.attributes]) {
      const { name, value } = attr;
      if (name === 'xmlns' && element === root && value === namespace) continue;
      if (name === 'viewBox' && element === root && value === '0 0 240 240') continue;
      if (name === 'id' && /^[a-zA-Z][\w-]{0,40}$/.test(value)) {
        if (ids.has(value)) return false;
        ids.add(value); continue;
      }
      if (numeric.has(name) && /^-?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value) && Math.abs(parseFloat(value)) <= 1000) continue;
      if (colors.has(name)) {
        if (/^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|none)$/i.test(value)) continue;
        const ref = /^url\(#([a-zA-Z][\w-]{0,40})\)$/.exec(value);
        if (ref) { references.push(ref[1]); continue; }
      }
      if (name === 'd' && value.length <= 8000 && /^[MmZzLlHhVvCcSsQqTtAa\d.,eE+\s-]+$/.test(value)) continue;
      if (name === 'points' && value.length <= 4000 && /^[\d.,+\s-]+$/.test(value)) continue;
      if (name === 'transform' && /^(?:(?:translate|scale|rotate|matrix|skewX|skewY)\([-\d.,\s]+\)\s*)+$/.test(value) && value.length < 300) continue;
      if (name === 'stroke-linecap' && ['round', 'butt', 'square'].includes(value)) continue;
      if (name === 'stroke-linejoin' && ['round', 'miter', 'bevel'].includes(value)) continue;
      if (name === 'fill-rule' && ['evenodd', 'nonzero'].includes(value)) continue;
      if (name === 'gradientUnits' && ['userSpaceOnUse', 'objectBoundingBox'].includes(value)) continue;
      return false;
    }
  }
  return visibleShapes > 0 && references.every(id => ids.has(id));
}

export function validFriendDesign(value: unknown): value is FriendDesign {
  if (!value || typeof value !== 'object') return false;
  const design = value as FriendDesign;
  return typeof design.name === 'string' && Boolean(design.name.trim()) && design.name.length <= 60 &&
    typeof design.description === 'string' && design.description.length <= 600 && validFriendSvg(design.svg);
}

export function parseFriendDesign(text: string): FriendDesign {
  const json = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  const value: unknown = JSON.parse(json);
  if (!validFriendDesign(value)) throw Error('FRIEND_DESIGN_INVALID');
  return { name: value.name, description: value.description, svg: value.svg };
}

export function validFriendAppearance(value: unknown): value is FriendAppearance | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const appearance = value as FriendAppearance;
  return (appearance.type === 'builtin' && ['sprout', 'bunny', 'cat'].includes(appearance.character)) || (appearance.type === 'generated' && validFriendDesign(appearance.design) &&
    typeof appearance.model === 'string' && typeof appearance.sessionId === 'string' &&
    typeof appearance.createdAt === 'string' && Number.isFinite(Date.parse(appearance.createdAt)));
}
