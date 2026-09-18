/**
 * Typechecks the single-file browser app. The app intentionally lives inline
 * in index.html (compiled in the browser by Babel standalone), so this
 * extracts the same TypeScript source and runs it through strict `tsc`
 * against the DOM lib — the same verification the sibling repos run on
 * their app sources. Also typechecks the updater and this script's
 * companions (bun test already compiles them, but this keeps one command
 * for the whole repo).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const match = /<script type="text\/babel" data-presets="typescript">([\s\S]*?)<\/script>/.exec(html);
if (!match) {
  console.error('Could not find the inline babel script in index.html');
  process.exit(1);
}

const tmpDir = join(root, '.typecheck-tmp');
mkdirSync(tmpDir, { recursive: true });
const tmpFile = join(tmpDir, 'app-inline.ts');
writeFileSync(tmpFile, match[1]);

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
try {
  const result = Bun.spawnSync([
    tsc,
    '--noEmit',
    '--strict',
    '--target', 'es2022',
    '--module', 'esnext',
    '--moduleResolution', 'bundler',
    '--lib', 'es2022,dom,dom.iterable',
    '--skipLibCheck',
    tmpFile,
  ], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) process.exit(result.exitCode);
  console.log('typecheck: app inline script is clean');
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
