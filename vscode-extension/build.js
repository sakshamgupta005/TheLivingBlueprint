const esbuild = require('esbuild');

const path = require('path');
const fs = require('fs');

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

function verifyWebviewAssets() {
  const requiredFiles = [
    'media/webview/index.html',
    'media/webview/styles.css',
    'media/webview/main.js',
  ];
  for (const rel of requiredFiles) {
    const full = path.join(__dirname, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing required webview asset: ${rel}`);
    }
  }
}

async function run() {
  verifyWebviewAssets();

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
