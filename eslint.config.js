// ESLint flat config for the package source, tests and build config.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '.changeset/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Allow intentionally unused parameters and destructured values when prefixed with _.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // The library must stay runtime-neutral: no Node built-ins, no Bun globals.
    // src/node.ts (the ./node subpath) is the one place Node APIs are allowed.
    files: ['src/**/*.ts'],
    ignores: ['src/node.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'path',
                'os',
                'child_process',
                'bun',
                'bun:*',
              ],
              message:
                'src/ must stay runtime-neutral (Node, Bun and browsers).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'No Bun.* globals in src/.' },
        {
          name: 'process',
          message: 'No process in src/; take options instead.',
        },
        { name: 'Buffer', message: 'Use Uint8Array in src/.' },
      ],
    },
  }
);
