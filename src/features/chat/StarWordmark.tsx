import { useEffect, useRef } from 'react';

const TAU = Math.PI * 2;

/** Local time, with a small seasonal/day variation and smooth hourly transitions. */
export function starPalette(date: Date, light: boolean) {
  const day = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 86400000);
  const hour = date.getHours() + date.getMinutes() / 60;
  const stops = [[0, 232], [5, 266], [8, 32], [12, 188], [16, 206], [19, 288], [22, 244], [24, 232]];
  const index = Math.max(0, stops.findIndex(stop => stop[0] > hour) - 1);
  const [start, hue] = stops[index], [end, nextHue] = stops[index + 1];
  const delta = ((nextHue - hue + 540) % 360) - 180;
  const base = hue + delta * (hour - start) / (end - start) + Math.sin(day / 366 * TAU) * 12 + Math.sin(day * 1.7) * 4;
  return [-22, 0, 23, 48].map((offset, index) =>
    `hsl(${(base + offset + 360) % 360} ${light ? 62 : 70}% ${light ? 37 + index * 3 : 69 + index * 4}%)`);
}

type Star = { homeX: number; homeY: number; x: number; y: number; vx: number; vy: number; size: number; shape: number; phase: number; color: number; emphasized: boolean };

export function StarWordmark() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const mask = document.createElement('canvas');
    const maskContext = mask.getContext('2d', { willReadFrequently: true });
    if (!maskContext) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0, height = 0, frame = 0, previous = 0, intersecting = true;
    let stars: Star[] = [], palette: string[] = [];
    let emphasisColor = '#ffffff';
    let pointer: { x: number; y: number; down: boolean } | undefined;
    let seed = 7189;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };

    function updatePalette() {
      const rgb = getComputedStyle(canvas!).color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
      const light = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 128;
      palette = starPalette(new Date(), light);
      emphasisColor = light ? '#181818' : '#ffffff';
    }
    function draw(time: number, step: number) {
      if (!context) return;
      context.clearRect(0, 0, width, height);
      for (const star of stars) {
        if (step) {
          let forceX = (star.homeX - star.x) * .027, forceY = (star.homeY - star.y) * .027;
          if (pointer) {
            const dx = star.x - pointer.x, dy = star.y - pointer.y;
            const distance = Math.hypot(dx, dy), radius = Math.min(width * .28, pointer.down ? 115 : 85);
            if (distance < radius) {
              const falloff = 1 - distance / radius;
              const force = pointer.down ? -1.7 * falloff : 2.7 * falloff * falloff;
              forceX += dx / Math.max(distance, 1) * force;
              forceY += dy / Math.max(distance, 1) * force;
            }
          }
          star.vx = (star.vx + forceX * step) * Math.pow(.81, step);
          star.vy = (star.vy + forceY * step) * Math.pow(.81, step);
          star.x += star.vx * step; star.y += star.vy * step;
        }
        const shimmer = motion.matches ? .85 : .77 + .19 * Math.sin(time * .0011 + star.phase);
        context.globalAlpha = star.emphasized ? .96 : shimmer;
        context.fillStyle = star.emphasized ? emphasisColor : palette[star.color];
        context.beginPath();
        const x = star.x, y = star.y, r = star.size;
        if (star.shape === 0) { // Four-point stars.
          context.moveTo(x, y - r * 1.7); context.lineTo(x + r * .3, y - r * .3);
          context.lineTo(x + r * 1.7, y); context.lineTo(x + r * .3, y + r * .3);
          context.lineTo(x, y + r * 1.7); context.lineTo(x - r * .3, y + r * .3);
          context.lineTo(x - r * 1.7, y); context.lineTo(x - r * .3, y - r * .3);
          context.closePath();
        } else if (star.shape === 1) {
          context.moveTo(x, y - r); context.lineTo(x + r, y); context.lineTo(x, y + r);
          context.lineTo(x - r, y); context.closePath();
        } else context.arc(x, y, r * .7, 0, TAU);
        context.fill();
      }
      context.globalAlpha = 1;
    }
    function stop() { cancelAnimationFrame(frame); frame = 0; previous = 0; }
    function tick(time: number) {
      frame = requestAnimationFrame(tick);
      if (time - previous < 32) return; // Decorative canvas, capped at 30 fps.
      const step = previous ? Math.min(2, (time - previous) / 16.67) : 1;
      previous = time;
      draw(time, step);
    }
    function syncMotion() {
      stop();
      updatePalette();
      if (motion.matches) {
        pointer = undefined;
        for (const star of stars) { star.x = star.homeX; star.y = star.homeY; star.vx = 0; star.vy = 0; }
        if (!document.hidden && intersecting) draw(0, 0);
      } else if (!document.hidden && intersecting && width > 0) frame = requestAnimationFrame(tick);
    }
    function resize() {
      if (!canvas || !maskContext || !context) return;
      const rect = canvas.getBoundingClientRect();
      width = Math.round(rect.width); height = Math.round(rect.height);
      if (!width || !height) { stop(); return; }
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      mask.width = width; mask.height = height;
      const fontSize = Math.min(90, width * .19);
      maskContext.font = `750 ${fontSize}px system-ui, sans-serif`;
      maskContext.fontKerning = 'none';
      maskContext.textAlign = 'center'; maskContext.textBaseline = 'middle'; maskContext.fillStyle = '#fff';
      maskContext.fillText('cardbush', width / 2, height / 2 - 2);
      const textLeft = (width - maskContext.measureText('cardbush').width) / 2;
      const emphasisLeft = textLeft + maskContext.measureText('car').width;
      const emphasisRight = textLeft + maskContext.measureText('cardb').width;
      const pixels = maskContext.getImageData(0, 0, width, height).data;
      stars = []; seed = 7189;
      const spacing = Math.max(2.7, width / 126);
      for (let y = 6; y < height - 6; y += spacing) for (let x = 6; x < width - 6; x += spacing) {
        if (pixels[(Math.floor(y) * width + Math.floor(x)) * 4 + 3] < 140) continue;
        const homeX = x + (random() - .5) * .9, homeY = y + (random() - .5) * .9;
        stars.push({ homeX, homeY, x: homeX, y: homeY, vx: 0, vy: 0,
          size: .75 + random() * .65, shape: Math.floor(random() * 5), phase: random() * TAU, color: Math.floor(random() * 4),
          emphasized: x >= emphasisLeft && x < emphasisRight });
      }
      // A few tiny stars around the lettering keep its edges airy.
      for (let index = 0; index < 32; index++) {
        const x = 12 + random() * (width - 24), y = 10 + random() * (height - 20);
        stars.push({ homeX: x, homeY: y, x, y, vx: 0, vy: 0, size: .4 + random() * .65,
          shape: index % 3, phase: random() * TAU, color: index % 4, emphasized: false });
      }
      updatePalette(); draw(0, 0); syncMotion();
    }
    function move(event: PointerEvent) {
      if (motion.matches || event.pointerType === 'touch') return;
      const rect = canvas!.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top, down: pointer?.down ?? false };
    }
    function down(event: PointerEvent) {
      if (motion.matches || event.pointerType === 'touch' || event.button !== 0) return;
      move(event);
      if (pointer) { pointer.down = true; canvas!.setPointerCapture(event.pointerId); }
    }
    function up() { if (pointer) pointer.down = false; }
    function leave() { pointer = undefined; }
    function refreshColors() { updatePalette(); if (motion.matches && !document.hidden && intersecting) draw(0, 0); }
    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(entries => { intersecting = entries[0]?.isIntersecting ?? false; syncMotion(); });
    const themeObserver = new MutationObserver(refreshColors);
    // Theme classes live on the app, with startup/native theme data on html.
    for (const element of [document.documentElement, canvas.closest('.app')]) {
      if (element) themeObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'data-start-theme'] });
    }
    resizeObserver.observe(canvas); intersectionObserver.observe(canvas);
    motion.addEventListener('change', syncMotion); document.addEventListener('visibilitychange', syncMotion);
    canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('lostpointercapture', leave);
    const clock = window.setInterval(refreshColors, 60000);
    resize();
    return () => {
      stop(); clearInterval(clock); resizeObserver.disconnect(); intersectionObserver.disconnect(); themeObserver.disconnect();
      motion.removeEventListener('change', syncMotion); document.removeEventListener('visibilitychange', syncMotion);
      canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('lostpointercapture', leave);
    };
  }, []);
  return <canvas ref={canvasRef} className="welcome-star-wordmark" role="img" aria-label="cardbush">cardbush</canvas>;
}
