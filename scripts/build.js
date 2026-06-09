const esbuild = require('esbuild');

async function main() {
  await esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    minify: false,
  });

  console.log('Build succeeded');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
