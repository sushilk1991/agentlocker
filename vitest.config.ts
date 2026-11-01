import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
 resolve: {alias: {'@agentlocker/sdk': fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url))}},
 test: {
  include: ['tests/**/*.test.ts'],
  globalSetup: ['tests/build-web.ts'],
  testTimeout: 15000,
  hookTimeout: 30000,
  // Keep local workerd instances within the resources of a small dev machine.
  fileParallelism: false,
 },
});
