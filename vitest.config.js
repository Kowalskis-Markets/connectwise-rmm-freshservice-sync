import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      reporter: ['json', 'text'],
      include: ['server/**/*.js']
    }
  }
});
