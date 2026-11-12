export const fixturePlugin = { id: 'fixture', name: 'Fixture bridge', version: '1', description: 'Test bridge plugin', tools: [
  { name: 'send_file', description: 'Send a requested file to this message source.', fileArguments: ['file'],
    inputSchema: { type: 'object', properties: { file: { type: 'string', minLength: 1 } }, required: ['file'], additionalProperties: false } },
] };

// Deterministic model behaviour; the real runtime still searches, loads, admits
// and invokes the independently registered plugin through its normal tools.
export function bridgeMessageSource(history) {
  const strings = [];
  const visit = value => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
  visit(history);
  let services, observedEnvironment = false;
  for (const text of strings) for (const line of text.split('\n')) {
    try {
      const fact = JSON.parse(line);
      if (fact.protocol !== 'bush.runtime_environment.v1') continue;
      if (fact.kind === 'snapshot') { services = undefined; observedEnvironment = true; }
      if (Object.hasOwn(fact.sections ?? {}, 'services')) { services = fact.sections.services; observedEnvironment = true; }
    } catch { /* Ordinary model input is not an environment fact. */ }
  }
  const source = observedEnvironment ? services?.bots?.find(entry => entry.sourceRef &&
    entry.context?.source?.sourceRef === entry.sourceRef)?.context.source
    : strings.filter(text => text.includes('Bot connection and message source supplied by the host')).flatMap(text => text.split('\n').map(line => {
      try { return JSON.parse(line).source; } catch { return undefined; }
    })).filter(Boolean).at(-1);
  return source;
}

export function bridgeModelStep(history, file, prefix = 'bridge') {
  const source = bridgeMessageSource(history);
  if (!source) return;
  const target = source.plugins?.flatMap(plugin => plugin.tools).find(name => name.endsWith('__send_file'));
  if (!target) throw Error('fixture_missing_bridge_plugin');
  const past = JSON.stringify(history);
  if (!past.includes(`${prefix}-search-call`)) return { id: `${prefix}-search-call`, name: 'search_plugins', arguments: { query: target } };
  if (!past.includes(`${prefix}-schema-call`)) return { id: `${prefix}-schema-call`, name: 'get_tool_schema', arguments: { name: target } };
  if (!past.includes(`${prefix}-file-call`)) return { id: `${prefix}-file-call`, name: 'call_tool', arguments: { name: target, arguments: { file, request_id: `${prefix}-file` } } };
}

// The parent searches for capabilities and delegates execution. The child loads and calls the bridge tool.
export function assistantBridgeStep(request, file, prefix = 'bridge') {
  if (request.tools.some(t => t.name === 'call_tool')) return bridgeModelStep(request.input,file,prefix);
  if (!bridgeMessageSource(request.input) || JSON.stringify(request.input).includes(prefix+'-delegate')) return;
  return {id:prefix+'-delegate',name:'subagent',arguments:{prompt:'Send the requested file through its source bridge: '+file}};
}
