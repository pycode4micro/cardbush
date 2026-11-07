import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';

export type PredicateObservation = { nowMs: number; kind: string; toolName?: string; status?: string };
export const predicateEngine = getQuickJS;
export type CollectorMatch = { key: string; evidence: string };

/** Sources enter the isolated VM as JSON data. match() can only describe a bounded observation. */
export function evaluatePredicate(engine: QuickJSWASMModule, code: string, observation?: PredicateObservation & { value?: unknown; previousKey?: string },
  onMatch?: (match: CollectorMatch) => void): boolean {
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  runtime.setMaxStackSize(128 * 1024);
  const deadline = performance.now() + 25;
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  const vm = runtime.newContext();
  try {
    if (onMatch) {
      const match = vm.newFunction('match', (key, evidence) => {
        if (!key || !evidence || vm.typeof(key) !== 'string' || vm.typeof(evidence) !== 'string') throw Error('match requires two strings.');
        const item = { key: vm.getString(key), evidence: vm.getString(evidence) };
        if (!item.key || item.key.length > 256 || item.evidence.length > 4000) throw Error('match key or evidence exceeds its limit.');
        onMatch(item);
        return vm.newNumber(1);
      });
      vm.setProp(vm.global, 'match', match); match.dispose();
      const remember = vm.newFunction('remember', key => {
        if (!key || vm.typeof(key) !== 'string') throw Error('remember requires a string key.');
        const value = vm.getString(key);
        if (!value || value.length > 256) throw Error('remember key exceeds its limit.');
        onMatch({ key: value, evidence: '' });
        return vm.newNumber(0);
      });
      vm.setProp(vm.global, 'remember', remember); remember.dispose();
    }
    const body = '(function(observation) { "use strict";\n' + code + '\n})';
    // Compile first on registration. Never evaluate user-supplied source in Node.
    const result = vm.evalCode(observation ? body + '(' + JSON.stringify(observation) + ')' : body,
      'event-predicate.js', { type: 'global', compileOnly: !observation });
    if (result.error) {
      result.error.dispose();
      throw Error(observation ? 'EVENT_TRIGGER_EXECUTION_FAILED' : 'EVENT_TRIGGER_INVALID_CODE');
    }
    try {
      if (!observation) return false;
      if (vm.typeof(result.value) !== 'number') throw Error('EVENT_TRIGGER_EXPECTED_ZERO_OR_ONE');
      const value = vm.getNumber(result.value);
      if (value !== 0 && value !== 1) throw Error('EVENT_TRIGGER_EXPECTED_ZERO_OR_ONE');
      return value === 1;
    } finally { result.value.dispose(); }
  } finally { vm.dispose(); runtime.dispose(); }
}
