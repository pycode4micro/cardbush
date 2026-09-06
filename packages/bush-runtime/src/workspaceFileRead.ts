import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export interface FileLineRange {
  startLine: number;
  lineCount: number;
}

/** Read all bytes for the revision, retaining only the requested decoded lines. */
export async function readFileLineRange(
  path: string,
  encoding: BufferEncoding,
  range: FileLineRange,
  signal?: AbortSignal,
) {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const hash = createHash("sha256");
    const decoder = new StringDecoder(encoding);
    const selected: string[] = [];
    const lastLine = range.startLine + (range.lineCount - 1);
    let currentLine = 1;
    let hasTail = false;
    let pendingCR = false;
    let pendingCRSelected = false;
    const isSelected = () => currentLine >= range.startLine && currentLine <= lastLine;
    const consume = (text: string) => {
      if (!text) return;
      let offset = 0;
      if (pendingCR) {
        if (text[0] === "\n") {
          if (pendingCRSelected) selected.push("\n");
          offset = 1;
        }
        pendingCR = false;
      }
      const endings = /\r\n|\r|\n/g;
      endings.lastIndex = offset;
      for (let match; (match = endings.exec(text));) {
        const end = match.index + match[0].length;
        const include = isSelected();
        if (include) selected.push(text.slice(offset, end));
        currentLine += 1;
        hasTail = false;
        pendingCR = match[0] === "\r" && end === text.length;
        pendingCRSelected = include;
        offset = end;
      }
      if (offset < text.length) {
        if (isSelected()) selected.push(text.slice(offset));
        hasTail = true;
      }
    };
    const stream = handle.createReadStream({ autoClose: false, signal });
    for await (const chunk of stream) {
      hash.update(chunk);
      consume(decoder.write(chunk));
    }
    consume(decoder.end());
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw Object.assign(new Error("The file changed during the ranged read; read it again."), {
        code: "file_changed_during_read",
      });
    }
    const totalLines = currentLine - 1 + Number(hasTail);
    const endLine = totalLines >= range.startLine ? Math.min(lastLine, totalLines) : null;
    return {
      sha256: hash.digest("hex"),
      content: selected.join(""),
      start_line: range.startLine,
      end_line: endLine,
      total_lines: totalLines,
      next_start_line: endLine !== null && endLine < totalLines ? endLine + 1 : null,
    };
  } finally {
    await handle.close();
  }
}
