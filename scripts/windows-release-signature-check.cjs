module.exports = async context => {
  const { auditWindowsSignatures, collectWindowsBinaries } = await import('./verify-windows-signatures.mjs');
  if (context.appOutDir && context.electronPlatformName === 'win32') {
    await auditWindowsSignatures(await collectWindowsBinaries(context.appOutDir));
  } else if (context.file && /\.exe$/i.test(context.file)) {
    await auditWindowsSignatures([context.file]);
  }
};
