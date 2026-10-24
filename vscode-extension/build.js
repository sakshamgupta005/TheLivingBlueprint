const esbuild = require('esbuild');

const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: !isProduction,
  minify: isProduction,
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
    if (isProduction) {
      const mapFile = path.join(__dirname, 'out', 'extension.js.map');
      if (fs.existsSync(mapFile)) {
        fs.unlinkSync(mapFile);
      }
    }
    console.log(`[Living Blueprint] Compiled out/extension.js successfully (${isProduction ? 'production' : 'development'}).`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
