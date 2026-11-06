import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.{ts,tsx}', 'build/**/*.test.ts', 'server/**/*.test.ts', 'scripts/**/*.test.js'] } });
