/**
 * Pre-compiles JSX in public/index.html at Docker build time.
 * Removes babel-standalone CDN and replaces <script type="text/babel">
 * with plain compiled JS so the browser doesn't do any transformation.
 */
const fs   = require('fs');
const path = require('path');
const babel = require('@babel/core');

const htmlPath = path.join(__dirname, 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const BABEL_TAG = '<script type="text/babel">';
const start = html.indexOf(BABEL_TAG);
const end   = html.lastIndexOf('</script>');

if (start === -1) {
  console.log('No <script type="text/babel"> found — nothing to do.');
  process.exit(0);
}

const jsxCode = html.slice(start + BABEL_TAG.length, end);

const result = babel.transformSync(jsxCode, {
  presets: [['@babel/preset-react', { runtime: 'classic' }]],
  configFile: false,
  babelrc:    false,
});

// Replace text/babel block with compiled JS
let out = html.slice(0, start) + '<script>' + result.code + html.slice(end);

// Remove babel-standalone CDN script tag (not needed anymore)
out = out.replace(/<script src="[^"]*babel[^"]*"><\/script>\n?/g, '');

fs.writeFileSync(htmlPath, out);
console.log('✅ JSX precompiled — babel-standalone removed from HTML');
