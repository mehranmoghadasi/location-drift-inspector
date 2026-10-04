import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'examples/output/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'no-implicit-globals': 'error',
    },
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
];
