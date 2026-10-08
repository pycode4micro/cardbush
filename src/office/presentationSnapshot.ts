import { waitForFileViewerImages, waitForFileViewerNextPaint, type FileRenderExportAdapter } from '@file-viewer/core';

// PNGs capture the real slide DOM, not a second decoder or embedded thumbnail.
export function presentationSnapshot(adapter: FileRenderExportAdapter) {
  let stage: HTMLDivElement | null = null;
  let slides: HTMLElement[] = [];
  return {
    async prepare() {
      if (!adapter.toHtml) throw Error('Presentation snapshot is unavailable.');
      await adapter.beforeSnapshot?.();
      const html = await adapter.toHtml({ mode: 'export', title: document.title });
      stage = document.createElement('div');
      stage.className = 'pptx-render-surface cardbush-presentation-export';
      stage.innerHTML = html;
      document.body.append(stage);
      slides = Array.from(stage.querySelectorAll<HTMLElement>('.slide'));
      if (!slides.length) throw Error('No rendered slides to export.');
      document.documentElement.classList.add('cardbush-exporting-presentation');
      for (const node of Array.from(stage.querySelectorAll<HTMLElement>('.flyfish-pptx-scale-box, .flyfish-pptx-content, .flyfish-pptx'))) {
        node.style.transform = 'none'; node.style.margin = '0'; node.style.padding = '0';
      }
      await document.fonts.ready;
      await waitForFileViewerImages(stage);
      return slides.map((slide, index) => ({ page: index + 1,
        width: parseFloat(getComputedStyle(slide).width), height: parseFloat(getComputedStyle(slide).height) }));
    },
    async show(page: number, width: number) {
      if (!stage || !slides[page - 1]) throw Error(`Slide ${page} does not exist.`);
      slides.forEach((slide, index) => {
        const slot = slide.closest<HTMLElement>('.flyfish-pptx-slide-slot');
        const visible = index === page - 1;
        if (slot) {
          slot.style.display = visible ? 'block' : 'none';
          slot.style.position = 'absolute'; slot.style.inset = '0'; slot.style.margin = '0';
        }
        slide.style.display = visible ? 'block' : 'none';
      });
      const slide = slides[page - 1], style = getComputedStyle(slide);
      const nativeWidth = parseFloat(style.width), nativeHeight = parseFloat(style.height);
      if (!(nativeWidth > 0 && nativeHeight > 0)) throw Error('Invalid slide dimensions.');
      const scale = width / nativeWidth, height = Math.round(nativeHeight * scale);
      stage.style.width = `${width}px`; stage.style.height = `${height}px`;
      slide.style.position = 'absolute'; slide.style.left = '0'; slide.style.top = '0';
      slide.style.margin = '0'; slide.style.transformOrigin = 'top left'; slide.style.transform = `scale(${scale})`;
      await waitForFileViewerNextPaint(window);
      await waitForFileViewerNextPaint(window);
      const bounds = slide.getBoundingClientRect();
      return { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height };
    },
  };
}
