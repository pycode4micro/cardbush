import path from 'node:path';

// Adapter for the pinned renderer's existing chart path. Keep its data parser,
// chart types and lifecycle; make failures visible and SVG snapshots synchronous.
export function pptxChartPlugin(root) {
  return { name: 'cardbush-pptx-charts', transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/@file-viewer/pptx/dist/chart.js')) return;
    const patches = [
      ['    const { billboard, d3Format } = await chartLibraryLoader();', '    try {\n    const { billboard, d3Format } = await chartLibraryLoader();'],
      ['            return;\n    }\n    if (chart.data)', '            throw new Error(`Unsupported PPTX chart type: ${payload.chartType}`);\n    }\n    if (chart.data)'],
      ['        return bb.generate(chart);\n    }\n};', '        return await renderPptxChart(chart, options => bb.generate(options), chartTarget);\n    }\n    } catch (error) { markPptxChartFailure(chartTarget, error); throw error; }\n};'],
      ["        chartTarget.dataset.fileViewerMissingCapability = 'pptx-charts';", "        markPptxChartFailure(chartTarget, new Error('PPTX chart renderer unavailable'));\n        chartTarget.dataset.fileViewerMissingCapability = 'pptx-charts';"],
    ];
    for (const [before, after] of patches) {
      if (code.split(before).length !== 2) throw Error('PPTX chart dependency changed; review the adapter before building.');
      code = code.replace(before, after);
    }
    const helper = path.resolve(root, 'src/office/pptxChartRendering.ts').replaceAll('\\', '/');
    return `import {renderPptxChart, markPptxChartFailure} from ${JSON.stringify(helper)};\n${code}`;
  } };
}
