module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
    ],
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
    },
    env: {
        node: true,
        es2022: true,
    },
    rules: {
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        '@typescript-eslint/no-explicit-any': 'off',
        // Production code mixes CommonJS-style require() with ES imports
        // (notably in entraAuth.ts and queryPanel.ts) and the test files
        // intentionally use require() to swap module implementations behind
        // esbuild's back. Disabling here keeps the lint config usable without
        // a sweeping refactor of unrelated code.
        '@typescript-eslint/no-var-requires': 'off',
    },
    ignorePatterns: ['out/', 'node_modules/'],
};