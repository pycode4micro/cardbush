// Use the same application launcher as the sidebar, then the component library's public button.
module.exports = async function openHomeEditor(read, visible, click) {
  await read("window.dispatchEvent(new CustomEvent('cardbush-open-application',{detail:{id:'builtin:components'}}))");
  const entry = '.components-app [data-home-action=edit]';
  await visible(entry);
  await click(entry);
  await visible('.home-board[data-editing=true]');
};
