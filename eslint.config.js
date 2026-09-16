import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: ['.github/workflows/release.yml', 'test/fixtures/**/dist'],
}, {
  files: ['playground/**', 'test/visual/**'],
  rules: {
    'antfu/no-import-dist': 'off',
    'antfu/no-top-level-await': 'off',
    'node/prefer-global/process': 'off',
    'no-console': 'off',
  },
})
