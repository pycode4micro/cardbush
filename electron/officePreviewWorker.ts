import { renderOfficePreview } from './officePreview';
import { checkOfficePreviewAdmission } from './officePreviewAdmission';

// Launched only in the existing protected process scope, never in Electron main.
async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('Missing Office preview path.');
  await checkOfficePreviewAdmission(filePath);
  process.stdout.write(await renderOfficePreview(filePath));
}
void main().catch(error => { process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
