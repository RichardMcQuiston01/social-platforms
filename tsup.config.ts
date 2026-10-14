import { defineConfig } from 'tsup';

// One entry per public subpath. Add new modules here and in package.json
// "exports" and "typesVersions" together.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    meta: 'src/meta/index.ts',
    threads: 'src/threads/index.ts',
    pinterest: 'src/pinterest/index.ts',
    s3: 'src/s3.ts',
    node: 'src/node.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  platform: 'neutral',
  tsconfig: 'tsconfig.node.json',
});
