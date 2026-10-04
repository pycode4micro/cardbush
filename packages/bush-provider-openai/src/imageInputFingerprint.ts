import { createHash } from 'node:crypto';
import type { ProviderInputProjection } from '@cardbush/bush-protocol';

/** Inspect only actual input blocks, never JSON inside text or tool schemas. */
export function imageInputFingerprint(input: unknown): NonNullable<ProviderInputProjection['images']> {
  const digests: string[] = [];
  let remoteCount = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const block = value as Record<string, unknown>;
    if (block.type === 'input_image' || block.type === 'image_url' || block.type === 'image') {
      // Include detail/source options as well as bytes. Only hashes are retained.
      digests.push(createHash('sha256').update(JSON.stringify(block)).digest('hex'));
      const source = block.source as { type?: string; url?: string } | undefined;
      const image = block.image_url;
      const url = typeof image === 'string' ? image
        : image && typeof image === 'object' ? (image as { url?: string }).url : source?.url;
      // Remote image bytes cannot be verified locally; an unchanged URL does
      // not prove that the provider fetched identical pixels.
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) remoteCount++;
      return;
    }
    visit(block.content);
    visit(block.output);
  };
  visit(input);
  return { digests, remoteCount };
}
