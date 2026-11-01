import { defineConfig } from 'vitest/config';

export default defineConfig({
 test: {
  include: ['tests/**/*.test.ts'],
  testTimeout: 15000,
  hookTimeout: 30000,
  // Keep local workerd instances within the resources of a small dev machine.
  fileParallelism: false,
 },
});
