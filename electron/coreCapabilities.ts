/** These names belong to the product's consent and isolation boundary, not third-party packages. */
export function isCoreCapabilityId(id: string): boolean {
  return ['chrome', 'computer-use'].includes(id.trim().toLowerCase().replaceAll('_', '-'));
}
