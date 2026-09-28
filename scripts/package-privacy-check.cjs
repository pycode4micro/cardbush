module.exports = async context => {
  const { auditPackagePrivacy } = await import('./audit-package-privacy.mjs');
  await auditPackagePrivacy(context.appOutDir);
  const { verifyPackagedDependencies } = await import('./verify-packaged-dependencies.mjs');
  const path = require('node:path');
  const resources = context.packager.platform.nodeName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  verifyPackagedDependencies(path.join(resources, 'app.asar'));
};
