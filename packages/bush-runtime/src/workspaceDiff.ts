export function createDisplayDiff(before: string, after: string): {
  text: string;
  additions: number;
  deletions: number;
} {
  const beforeLines = normalizedTextLines(before);
  const afterLines = normalizedTextLines(after);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldChangeEnd = beforeLines.length - suffix;
  const newChangeEnd = afterLines.length - suffix;
  const additions = newChangeEnd - prefix;
  const deletions = oldChangeEnd - prefix;
  if (additions === 0 && deletions === 0) {
    return { text: "", additions: 0, deletions: 0 };
  }
  const context = 3;
  const oldHunkStart = Math.max(0, prefix - context);
  const newHunkStart = Math.max(0, prefix - context);
  const oldHunkEnd = Math.min(beforeLines.length, oldChangeEnd + context);
  const newHunkEnd = Math.min(afterLines.length, newChangeEnd + context);
  const oldCount = oldHunkEnd - oldHunkStart;
  const newCount = newHunkEnd - newHunkStart;
  const oldStart = oldCount === 0 ? oldHunkStart : oldHunkStart + 1;
  const newStart = newCount === 0 ? newHunkStart : newHunkStart + 1;
  const lines = [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...beforeLines.slice(oldHunkStart, prefix).map((line) => ` ${line}`),
    ...beforeLines.slice(prefix, oldChangeEnd).map((line) => `-${line}`),
    ...afterLines.slice(prefix, newChangeEnd).map((line) => `+${line}`),
    ...afterLines.slice(newChangeEnd, newHunkEnd).map((line) => ` ${line}`),
  ];
  return { text: lines.join("\n"), additions, deletions };
}

function normalizedTextLines(value: string): string[] {
  if (!value) return [];
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
