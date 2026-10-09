import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(['.next/**', '.cache/**', 'node_modules/**', 'out/**', 'build/**', 'coverage/**', 'next-env.d.ts']),
]);
