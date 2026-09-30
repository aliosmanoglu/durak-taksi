// Kök yapılandırmayla aynı kurallar (@eslint/js + typescript-eslint) + React Native için react-hooks.
// Kök `eslint.config.js` bu klasörü yok sayar; bu paket kendi `lint` script'iyle denetlenir.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '.expo/**', 'dist/**', 'android/**', 'ios/**', 'expo-env.d.ts', '*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
