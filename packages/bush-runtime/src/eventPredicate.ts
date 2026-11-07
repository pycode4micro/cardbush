import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';

export type PredicateObservation = { nowMs: number; kind: string; toolName?: string; status?: string };
export const predicateEngine = getQuickJS;

/** No host functions are installed. Only primitive observation fields cross into the guest. */
export function evaluatePredicate(engine: QuickJSWASMModule, code: string, observation?: PredicateObservation): boolean {
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  runtime.setMaxStackSize(128 * 1024);
  const deadline = performance.now() + 25;
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  const vm = runtime.newContext();
  try {
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
