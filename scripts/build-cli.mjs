import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ entryPoints: [root + 'packages/cli/src/index.ts'], outfile: root + 'packages/cli/dist/index.js',
 bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external' });
await chmod(root + 'packages/cli/dist/index.js', 0o755);
