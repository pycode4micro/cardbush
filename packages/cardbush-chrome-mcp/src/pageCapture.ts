import { ChromeConnectorError } from './bridgeClient.js';

export type PageCommand = (command: string, params?: Record<string, unknown>) => Promise<unknown>;
export type Viewport = { width: number; height: number; deviceScaleFactor?: number };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const dimensionsOf = (value: unknown) => {
  const dimensions = object(value);
  return { width: Number(dimensions.width), height: Number(dimensions.height), deviceScaleFactor: Number(dimensions.deviceScaleFactor) || 1 };
};
const pageZoom = (metrics: Record<string, unknown>) => {
  const zoom = Number(object(metrics.cssVisualViewport ?? metrics.visualViewport).zoom ?? 1);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
};

export async function evaluate(command: PageCommand, expression: string) {
  const result = object(await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false }));
  if (result.exceptionDetails) throw new ChromeConnectorError('javascript_exception', JSON.stringify(result.exceptionDetails));
  return object(result.result).value;
}

export async function setViewport(command: PageCommand, viewport: Viewport) {
  if (viewport.width * viewport.height * (viewport.deviceScaleFactor ?? 1) ** 2 > 16_000_000) {
    throw new ChromeConnectorError('viewport_too_large', 'Use a smaller viewport or deviceScaleFactor (maximum 16 megapixels).');
  }
  // CDP emulation uses device-independent pixels; innerWidth uses CSS pixels.
  // Preserve the user's page zoom and compensate in this target's override.
  const metrics = object(await command('Page.getLayoutMetrics'));
  const zoom = pageZoom(metrics);
  const deviceScaleFactor = viewport.deviceScaleFactor ?? 1;
  await command('Emulation.setDeviceMetricsOverride', {
    width: Math.max(1, Math.round(viewport.width * zoom)), height: Math.max(1, Math.round(viewport.height * zoom)),
    deviceScaleFactor: deviceScaleFactor / zoom, mobile: false,
  });
  await evaluate(command, `Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))),new Promise(resolve=>setTimeout(()=>resolve(true),250))])`);
  const dimensions = await readViewport(command);
  // Integer CDP dimensions can differ by one CSS pixel at fractional zoom.
  // Report the actual dimensions, never the unverified requested ones.
  const tolerance = Math.abs(zoom - 1) < 0.0001 ? 0 : Math.ceil(0.5 / zoom);
  if (!(dimensions.width > 0 && dimensions.height > 0) ||
      Math.abs(dimensions.width - viewport.width) > tolerance || Math.abs(dimensions.height - viewport.height) > tolerance ||
      Math.abs(dimensions.deviceScaleFactor - deviceScaleFactor) > 0.001) {
    throw new ChromeConnectorError('viewport_not_applied', 'Chrome did not apply the requested CSS viewport. Inspect the current page before trying another size.',
      { requested: viewport, dimensions, pageZoom: zoom });
  }
  return dimensions;
}

const readViewport = async (command: PageCommand) => dimensionsOf(await evaluate(command,
  '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})'));

export async function prepareCapture(command: PageCommand, viewport?: Viewport, autoViewport = true) {
  let dimensions = viewport ? await setViewport(command, viewport) : await readViewport(command);
  const adjusted = !viewport && autoViewport && (dimensions.width < 320 || dimensions.height < 180);
  if (adjusted) {
    dimensions = await setViewport(command, { width: 1280, height: 800, deviceScaleFactor: 1 });
  }
  if (!(dimensions.width > 0 && dimensions.height > 0)) throw new ChromeConnectorError('viewport_unavailable', 'The page has no usable viewport. Navigate to a loaded page first.');
  await evaluate(command, `(async()=>{
    await Promise.race([Promise.all([document.fonts?.ready, ...Array.from(document.images).map(image=>image.decode().catch(()=>{}))]),new Promise(resolve=>setTimeout(resolve,2000))]);
    await Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,250))]);
    return true;
  })()`);
  return { width: dimensions.width as number, height: dimensions.height as number,
    deviceScaleFactor: dimensions.deviceScaleFactor as number, adjusted };
}

export async function captureClip(command: PageCommand, fullPage?: boolean, selector?: string, deviceScaleFactor = 1) {
  if (!fullPage && !selector) return undefined;
  const metrics = object(await command('Page.getLayoutMetrics'));
  let bounds: Record<string, unknown> | undefined;
  if (selector) {
    bounds = object(await evaluate(command, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});
      if(!element)throw new Error('Screenshot element not found');
      const box=element.getBoundingClientRect();return {x:box.x+scrollX,y:box.y+scrollY,width:box.width,height:box.height};})()`));
  } else if (fullPage) {
    bounds = object(metrics.cssContentSize ?? metrics.contentSize);
  }
  if (!bounds) return undefined;
  const width = Number(bounds.width), height = Number(bounds.height);
  if (!(width > 0 && height > 0 && Number.isFinite(width * height))) throw new ChromeConnectorError('screenshot_region_empty', 'The screenshot region is empty.');
  const scale = Math.min(1, 8192 / (Math.max(width, height) * deviceScaleFactor), Math.sqrt(16_000_000 / (width * height * deviceScaleFactor ** 2)));
  const cssClip = { x: Math.max(0, Number(bounds.x) || 0), y: Math.max(0, Number(bounds.y) || 0), width, height, scale };
  const zoom = pageZoom(metrics);
  // DOM bounds and public receipts use CSS pixels; CDP clips use DIPs. Convert
  // offsets as well as size so scrolled element crops target the same region.
  return { cssClip, deviceClip: { x: cssClip.x * zoom, y: cssClip.y * zoom, width: width * zoom, height: height * zoom, scale } };
}

/** Canvas pixels are exported intact. SVGs and other elements use browser rendering via screenshot. */
export function canvasExportExpression(selector: string, format: string, quality?: number) {
  return `(()=>{const element=document.querySelector(${JSON.stringify(selector)});
    if(!(element instanceof HTMLCanvasElement))throw new Error('Select a canvas, or use take_screenshot with selector for SVG/HTML');
    return element.toDataURL(${JSON.stringify(`image/${format}`)},${quality === undefined ? 'undefined' : quality / 100});})()`;
}
