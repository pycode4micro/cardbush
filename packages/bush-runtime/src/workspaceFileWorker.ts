/** Serialized into the Linux child; keep all dependencies inside this function. */
export async function workspaceFileWorkerMain() {
  const { open } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { createInterface } = await import('node:readline');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let writable = false;
  const metadata = async () => {
    const info = await file!.stat({ bigint: true });
    if (!info.isFile()) throw Object.assign(Error('File identity changed.'), { code: 'workspace_authorization_changed' });
    return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map(key => [key, String(info[key as keyof typeof info])]));
  };
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      try {
        if (line.length > 128 * 1024) throw Error('File protocol budget exceeded.');
        const input = JSON.parse(line);
        let result: unknown;
        if (input.op === 'open' && !file) {
          writable = input.write === true;
          file = await open(input.path, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const info = await metadata();
          if (`${info.dev}:${info.ino}` !== input.identity || writable && info.nlink !== '1')
            throw Object.assign(Error('File identity changed.'), { code: 'workspace_authorization_changed' });
          result = info;
        } else if (input.op === 'stat' && file) result = await metadata();
        else if (input.op === 'read' && file) {
          if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 65536 || !Number.isSafeInteger(input.offset) || input.offset < 0) throw Error('Invalid read budget.');
          const bytes = Buffer.alloc(input.count);
          const read = await file.read(bytes, 0, bytes.length, input.offset);
          result = bytes.subarray(0, read.bytesRead).toString('base64');
        } else if (input.op === 'truncate' && file && writable) {
          if (input.sha256) {
            const hash = createHash('sha256');
            for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
            if (hash.digest('hex') !== input.sha256) throw Object.assign(Error('The file changed before writing.'), { code: 'workspace_revision_conflict' });
          }
          await file.truncate(0);
        } else if (input.op === 'write' && file && writable) {
          const bytes = Buffer.from(input.data, 'base64');
          if (bytes.length > 65536 || !Number.isSafeInteger(input.offset) || input.offset < 0) throw Error('Invalid write budget.');
          let offset = 0;
          while (offset < bytes.length) offset += (await file.write(bytes, offset, bytes.length - offset, input.offset + offset)).bytesWritten;
        } else if (input.op === 'chmod' && file && writable) {
          if (!Number.isSafeInteger(input.mode) || input.mode < 0 || input.mode > 0o777) throw Error('Invalid file mode.');
          await file.chmod(input.mode);
        } else if (input.op === 'close') { await file?.close(); file = undefined; process.stdout.write('{"ok":true}\n'); break; }
        else throw Error('Invalid file protocol operation.');
        process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
      } catch (error) {
        const failure = error as NodeJS.ErrnoException;
        process.stdout.write(JSON.stringify({ ok: false, code: failure.code ?? 'sandbox_file_io_failed', message: failure.message }) + '\n');
        process.exitCode = 1; break;
      }
    }
  } finally { await file?.close(); }
}
