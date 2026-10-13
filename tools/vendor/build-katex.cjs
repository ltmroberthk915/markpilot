'use strict';
// Reproduce the maintained renderer, CSS, fonts and provenance from pinned source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, "../..");
const BASE = path.join(ROOT, ".mp-verify/vendor-katex-source-map");
const PATCHED = path.join(BASE, 'patched');
const BUNDLE = path.join(ROOT, 'dsh-markpilot/renderer/vendor/katex');
const esbuild = require(path.join(ROOT, 'dsh-markpilot/node_modules/esbuild'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const within = (base, relative) => {
  const target = path.resolve(base, relative);
  if (!target.startsWith(path.resolve(base) + path.sep)) throw Error('Build target escape: ' + relative);
  return target;
};
const write = (relative, value) => {
  const target = within(BUNDLE, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, value);
};

async function main() {
  const compiler = JSON.parse(fs.readFileSync(path.join(ROOT,'dsh-markpilot/package-lock.json'),'utf8')).packages['node_modules/esbuild'];
  if (esbuild.version !== '0.28.2' || compiler.version !== esbuild.version ||
      compiler.integrity !== 'sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==') throw Error('Pinned compiler identity mismatch');
  require('./katex-source-map.cjs');
  const manifest = JSON.parse(fs.readFileSync(path.join(BASE, 'manifest.json'), 'utf8'));
  if (manifest.upstreamVersion !== '0.19.0' ||
      manifest.purpose !== 'katex-source-map-maintained') throw Error('Wrong source manifest');
  const inventoryText = fs.readFileSync(within(BASE, manifest.inventory.file));
  if (sha(inventoryText) !== manifest.inventory.sha256) throw Error('Inventory hash mismatch');
  const inventory = JSON.parse(inventoryText.toString('utf8'));
  const membership = [];
  function collect(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory,name), stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw Error('Linked cache input: ' + target);
      if (stat.isDirectory()) collect(target);
      else if (stat.isFile()) membership.push(path.relative(PATCHED,target).replaceAll('\\','/'));
      else throw Error('Unexpected cache input: ' + target);
    }
  }
  collect(PATCHED);
  if (JSON.stringify(membership.sort()) !== JSON.stringify(inventory.outputs.map(file=>file.file).sort())) {
    throw Error('Patched cache membership mismatch; remove unknown owned cache files before rebuilding');
  }
  for (const file of inventory.outputs) {
    if (sha(fs.readFileSync(within(PATCHED, file.file))) !== file.sha256) throw Error('Patched hash mismatch: ' + file.file);
  }
  if (sha(fs.readFileSync(path.join(BASE, 'entry.ts'))) !== manifest.entrySha256) throw Error('Entry hash mismatch');
  if (manifest.builderSha256 && sha(fs.readFileSync(__filename)) !== manifest.builderSha256) throw Error('Builder hash mismatch');

  // Match upstream's /*preval*/ imports: these two modules are pure data
  // generators, not the parser or renderer. Their exact bytes were verified above.
  const frozenUnicode = {
    name: 'freeze-pinned-unicode-data',
    setup(build) {
      build.onLoad({filter: /[\\/]src[\\/]unicode(?:Accents|Symbols)\.js$/}, args => {
        const inputPath = fs.realpathSync(args.path);
        if (!inputPath.startsWith(fs.realpathSync(PATCHED) + path.sep)) throw Error('Unexpected Unicode module');
        const data = require(inputPath);
        return {contents: 'export default ' + JSON.stringify(data) + ';\n', loader: 'js'};
      });
    },
  };
  const result = await esbuild.build({
    absWorkingDir: BASE,
    entryPoints: [within(BASE, manifest.build.entry)],
    outfile: path.join(BUNDLE, 'katex-sourcemap.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: manifest.build.target,
    define: manifest.build.define,
    minify: false,
    legalComments: 'inline',
    banner: {js: '/*! KaTeX 0.19.0, MIT; see LICENSE. Maintained sourceMap port. */'},
    plugins: [frozenUnicode],
    write: false,
    logLevel: 'warning',
  });
  for (const output of result.outputFiles) {
    const relative = path.relative(BUNDLE, output.path);
    write(relative, output.contents);
  }
  for (const file of inventory.outputs.filter(file => file.file.startsWith('dist/'))) {
    write(file.file.slice('dist/'.length), fs.readFileSync(within(PATCHED, file.file)));
  }
  write('provenance.json', fs.readFileSync(path.join(BASE,'manifest.json')));
  write('inventory.json', fs.readFileSync(path.join(BASE,'inventory.json')));
  write('patches.json', fs.readFileSync(path.join(BASE,'patches.json')));
  write('LICENSE', fs.readFileSync(path.join(BASE, 'LICENSE')));
  const js = fs.readFileSync(path.join(BUNDLE, 'katex-sourcemap.js'));
  const status = {
    schema: 1, built: true,
    upstreamVersion: manifest.upstreamVersion, esbuildVersion: esbuild.version,
    compiler: {version:compiler.version,resolved:compiler.resolved,integrity:compiler.integrity},
    manifestSha256: sha(fs.readFileSync(path.join(BASE, 'manifest.json'))),
    javascript: {file: 'katex-sourcemap.js', bytes: js.length, sha256: sha(js)},
    assets: inventory.outputs.filter(file => file.file.startsWith('dist/')).map(file =>
      ({...file, file: file.file.slice('dist/'.length)})),
  };
  write('build-status.json', JSON.stringify(status, null, 2) + '\n');
  process.stdout.write(JSON.stringify({...status, assets: status.assets.length}) + '\n');
}
main().catch(error => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
