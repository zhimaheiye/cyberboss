const path = require('path');

// Compile locally on normal desktop startup, without a separate dev server.
async function compileFrontend() {
  const result = await require('esbuild').build({
    absWorkingDir: path.resolve(__dirname, '../..'),
    entryPoints: ['web/src/App.jsx'], bundle: true, write: false,
    outfile: 'app.js', format: 'esm', platform: 'browser', target: ['chrome120', 'edge120', 'firefox121'],
    jsx: 'automatic', minify: true, legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  return result.outputFiles.find(file => file.path.endsWith('.js')).contents;
}
module.exports = { compileFrontend };
