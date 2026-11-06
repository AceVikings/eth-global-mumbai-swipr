import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['frontend/src/**/*.test.{ts,tsx}', 'frontend/build/**/*.test.ts', 'backend/**/*.test.ts', 'scripts/**/*.test.js'] } });
