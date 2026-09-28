// SSH uses its supported JavaScript/Node crypto implementation in desktop builds.
// These two optional accelerators are excluded from the package; rebuilding them
// would require a C++ toolchain even though SSH does not require either binding.
module.exports = async function beforePack(context) {
  const { rebuild } = await import('@electron/rebuild');
  const { Arch } = require('electron-builder');
  const { info, platform, config } = context.packager;
  await rebuild({
    buildPath: info.appDir,
    projectRootPath: await info.getWorkspaceRoot(),
    electronVersion: info.framework.version,
    platform: platform.nodeName,
    arch: Arch[context.arch],
    buildFromSource: config.buildDependenciesFromSource === true,
    mode: 'sequential',
    disablePreGypCopy: true,
    ignoreModules: ['cpu-features', 'ssh2'],
  });
  // Keep electron-builder's dependency collector enabled: beforeBuild returning
  // false in builder 26 would also omit production node_modules from the ASAR.
};
