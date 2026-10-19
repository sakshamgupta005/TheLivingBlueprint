const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  target: 'node18',
  logLevel: 'info',
};

async function run() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[Living Blueprint] Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('[Living Blueprint] Compiled out/extension.js successfully.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
