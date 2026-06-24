import esbuild from 'esbuild';

const server = {
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server.js',
  platform: 'node',
  format: 'esm',
  target: 'node18',
  bundle: true,
  external: ['ws'],
  // Some transitive deps may use require(); shim it for ESM output.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
};

const app = {
  entryPoints: ['public/app.ts'],
  outfile: 'public/app.js',
  platform: 'browser',
  format: 'esm',
  bundle: true,
  logLevel: 'info',
};

await esbuild.build(server);
await esbuild.build(app);
console.log('roon-web: build complete');
