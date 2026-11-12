// These wire-protocol fixtures replay catalogs bound before search_plugins.
export function legacySearchCatalog(registry) {
  return registry.definitions().map(tool => tool.name === 'search_plugins' ? registry.resolve('mcp_search').definition : tool);
}
