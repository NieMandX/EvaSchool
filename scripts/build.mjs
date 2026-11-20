import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const file = path => new URL(path, root);
const service = process.argv.includes('--service');
const outputDirectory = service ? 'dist-service' : 'dist';
const styleFiles = ['src/style.css'];
if (service) styleFiles.push('src/service-panel.css', 'src/service-performance.css');
const [template, styleSources, bundled] = await Promise.all([
  readFile(file('src/index.html'), 'utf8'),
  Promise.all(styleFiles.map(path => readFile(file(path), 'utf8'))),
  build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [service ? 'src/service-entry.js' : 'src/app.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    charset: 'utf8',
    target: ['safari15.4', 'chrome105', 'firefox110'],
    write: false,
    legalComments: 'none',
  }),
]);

let styles = styleSources.join('\n');
for (const subset of ['cyrillic', 'latin']) {
  const path = `src/assets/manrope-${subset}.woff2`;
  const font = await readFile(file(path));
  styles = styles.replace(`./assets/manrope-${subset}.woff2`, `data:font/woff2;base64,${font.toString('base64')}`);
}
const notices = await Promise.all(
  ['node_modules/d3-geo/LICENSE', 'node_modules/d3-array/LICENSE', 'node_modules/internmap/LICENSE',
    'node_modules/topojson-client/LICENSE', 'src/assets/World-Atlas-ISC.txt', 'src/assets/Manrope-OFL.txt', 'src/assets/World-Countries-ODbL.txt']
    .map(async path => `${path.replace(/^.*?\//, '')}\n${await readFile(file(path), 'utf8')}`),
);
const licenses = [
  'Map data: Natural Earth (public domain), via World Atlas 2.0.2 (ISC), simplified.',
  'Continental groupings are derived from world-countries 5.1.0, https://github.com/mledoze/countries, under ODbL 1.0.',
  ...notices,
].join('\n\n').replaceAll('--', '–');
const code = bundled.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const output = template
  .replace('<!-- styles -->', () => `<style>\n${styles}</style>`)
  .replace('<!-- scripts -->', () => `<script>\n${code}</script>\n<!--\n${licenses}\n-->`);

const outputPath = `${outputDirectory}/index.html`;
await mkdir(file(outputDirectory), { recursive: true });
await writeFile(file(outputPath), output);
console.log(`${outputPath} · ${Math.round(Buffer.byteLength(output) / 1024)} KiB`);
