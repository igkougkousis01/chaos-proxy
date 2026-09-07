import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The maintenance scripts in `scripts/` are plain Node ESM rather than
    // TypeScript, so nothing has told ESLint which globals a Node runtime
    // provides. `no-undef` is what catches a typo in a name there, so the
    // globals are declared rather than the rule switched off. Only the ones
    // these scripts actually use are listed; anything else is a mistake worth
    // hearing about.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        clearTimeout: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
  },
  prettier,
);
