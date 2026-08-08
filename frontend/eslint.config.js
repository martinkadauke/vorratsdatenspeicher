// ⚠️ This config exists for ONE rule: react-hooks/rules-of-hooks.
//
// The desktop app shipped a black window twice, both times from Onboarding.tsx, both times from a
// mistake TypeScript cannot see:
//   * a `const` read by a `.filter()` callback that ran before the declaration (React unmounts)
//   * a `useRef` placed BELOW `if (!show) return null` — fine while the wizard is open, fatal the
//     moment it closes, because that render suddenly has one hook fewer (React #300)
// `npm run build` was green for both. This rule catches the second class at lint time, in one
// second, instead of costing an evening of guessing at GPU caches.
//
// Deliberately narrow: no style rules, no opinions about the existing code. Everything here is a
// correctness rule that has already cost real time.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Exhaustive-deps stays a warning: the codebase has deliberate omissions, and turning it
      // into an error today would bury the rule above in noise.
      'react-hooks/exhaustive-deps': 'warn',
      // Everything else off — this is a safety net, not a style police.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': 'off',
      // `cond && doThing()` is used deliberately throughout; not a correctness issue.
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-undef': 'off',
    },
  },
);
