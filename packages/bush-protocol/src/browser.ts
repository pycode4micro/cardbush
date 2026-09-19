import { z } from 'zod';

export const DEFAULT_BROWSER_START_PAGE = 'https://www.google.com/';
export const BROWSER_CONFIGURATION_PROTOCOL = 'cardbush.browser_config.v1' as const;

export const browserStartPageSchema = z.string().trim().max(4096).transform(value => {
  if (!value) return DEFAULT_BROWSER_START_PAGE;
  if (value === 'about:blank') return value;
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
}).pipe(z.union([z.literal('about:blank'), z.url({ protocol: /^https?$/, normalize: true })]))
  .refine(value => !/^https?:\/\/[^/?#]*@/i.test(value), 'Do not include credentials in the start page.');

export const browserConfigurationSchema = z.object({
  protocol: z.literal(BROWSER_CONFIGURATION_PROTOCOL),
  revision: z.number().int().positive(),
  startPage: browserStartPageSchema.default(DEFAULT_BROWSER_START_PAGE),
});
export type BrowserConfiguration = z.infer<typeof browserConfigurationSchema>;
export const defaultBrowserConfiguration = (): BrowserConfiguration => ({
  protocol: BROWSER_CONFIGURATION_PROTOCOL, revision: 1, startPage: DEFAULT_BROWSER_START_PAGE,
});
