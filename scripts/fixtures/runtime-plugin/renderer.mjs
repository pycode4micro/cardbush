export const apiVersion = 1;
export default host => {
  let state = { title: 'Fixture', choices: [], selectedId: '' };
  const listeners = new Set();
  const publish = () => listeners.forEach(listener => listener());
  return {
    apiVersion,
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async load() {
      const receipt = await host.command('plugin.fixture.configuration', { action: 'read' });
      state = { ...state, choices: receipt.configuration.items, selectedId: receipt.configuration.items[0]?.id ?? '' };
      // Materialize configuration for persistence and recovery assertions.
      if (receipt.contentHash === '0') await host.command('plugin.fixture.configuration', {
        action: 'write', expectedHash: receipt.contentHash, configuration: receipt.configuration,
      });
      publish();
    },
    select(id) { state = { ...state, selectedId: id }; publish(); },
    async prepareTurn() {
      await host.command('plugin.fixture.apply_snapshot', { selectedId: state.selectedId, items: state.choices });
    },
    mount(container) {
      const editor = document.createElement('div');
      editor.className = 'fixture-editor';
      editor.style.cssText = 'padding:16px;max-width:100%;box-sizing:border-box';
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Draft');
      input.style.cssText = 'width:100%;box-sizing:border-box';
      editor.append(input);
      container.append(editor);
      return { update() {}, dispose() { editor.remove(); } };
    },
    dispose() { listeners.clear(); },
  };
};
