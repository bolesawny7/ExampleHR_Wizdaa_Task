// ESLint uses @babel/eslint-parser so legacy decorators + class fields
// parse via our existing babel.config.json.
//
// Note: `no-unused-vars` cannot see usage through Nest's parameter
// decorators (`@Inject(Foo) bar`) because the ESLint scope analyzer does
// not walk decorator expressions.  We therefore:
//   - skip arg checks (`args: 'none'`) — decorator-bound params look unused
//   - ignore PascalCase imports/vars — NestJS decorator targets are
//     capitalised by convention; a truly unused class import is rare and
//     caught by the editor.
//   - ignore underscore-prefixed names — standard convention for "on
//     purpose unused".
module.exports = {
  root: true,
  env: { node: true, es2022: true, jest: true },
  parser: '@babel/eslint-parser',
  parserOptions: {
    sourceType: 'module',
    requireConfigFile: true,
    babelOptions: { configFile: './babel.config.json' },
  },
  extends: ['eslint:recommended', 'prettier'],
  rules: {
    'no-unused-vars': [
      'error',
      {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^(_|[A-Z])',
      },
    ],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      files: ['test/**/*.js'],
      rules: { 'no-console': 'off' },
    },
  ],
  ignorePatterns: ['node_modules/', 'dist/', 'coverage/'],
};
