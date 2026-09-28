import { extractFile, listPackage, uncache } from '@electron/asar';

// A structurally valid MSIX can still contain an unusable ASAR when a builder
// hook accidentally disables dependency collection. Check the installed tree.
export function verifyPackagedDependencies(archive) {
  uncache(archive);
  const files = new Set(listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')));
  const manifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  const missing = Object.keys(manifest.dependencies ?? {})
    .filter(name => !files.has(`node_modules/${name}/package.json`));
  // sharp is a required transitive native dependency used by Computer Use.
  if (!files.has('node_modules/sharp/package.json')) missing.push('sharp');
  if (missing.length) throw Error('Packaged application is missing production dependencies: ' + missing.join(', '));
  return { verified: Object.keys(manifest.dependencies ?? {}).length };
}
