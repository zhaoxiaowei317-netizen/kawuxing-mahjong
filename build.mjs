import {build} from 'esbuild';
import {mkdir,copyFile,writeFile,readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {tileArtwork} from './src/tile-art-hd.js';

await mkdir('dist/assets',{recursive:true});
await mkdir('dist/assets/voice',{recursive:true});

await build({
  absWorkingDir: process.cwd(),
  entryPoints: [resolve('src/app.js')],
  tsconfigRaw: {},
  bundle: true,
  format: 'iife',
  charset: 'utf8',
  outfile: resolve('dist/app.js'),
  minify: true,
  plugins: [{
    name: 'node-files',
    setup(b) {
      b.onResolve({filter: /.*/}, args => ({path: createRequire(args.importer || resolve('build.mjs')).resolve(args.path), namespace: 'node-files'}));
      b.onLoad({filter: /.*/, namespace: 'node-files'}, async args => ({contents: await readFile(args.path, 'utf8'), loader: args.path.endsWith('.json') ? 'json' : 'js'}));
    }
  }]
});

for(const f of ['index.html','style.css','game.css','visual-refresh.css']) {
  await copyFile('src/' + f, 'dist/' + f);
}
await writeFile('dist/game.css', (await readFile('src/game.css', 'utf8')) + '\n' + (await readFile('src/table-experience.css', 'utf8')));
await copyFile('node_modules/@kobalab/majiang-core/LICENSE', 'dist/MAJIANG-LICENSE.txt');

for(const t of [...['p','s'].flatMap(s => Array.from({length:9}, (_,i) => s + (i+1))), 'z5', 'z6', 'z7']) {
  await writeFile(`dist/assets/${t}.svg`, tileArtwork(t));
}
for(const f of await readdir('src/assets/voice')) {
  await copyFile(`src/assets/voice/${f}`, `dist/assets/voice/${f}`);
}
for(let i = 0; i < 4; i++) {
  await copyFile(`src/assets/avatars/avatar-${i}.png`, `dist/assets/avatar-${i}.png`);
}

await build({
  absWorkingDir: process.cwd(),
  entryPoints: [resolve('src/online.js')],
  bundle: true,
  format: 'iife',
  charset: 'utf8',
  outfile: resolve('dist/online.js'),
  minify: true,
  tsconfigRaw: {},
  plugins: [{
    name: 'online-node-files',
    setup(b) {
      b.onResolve({filter: /.*/}, args => ({path: createRequire(args.importer || resolve('build.mjs')).resolve(args.path), namespace: 'online-files'}));
      b.onLoad({filter: /.*/, namespace: 'online-files'}, async args => ({contents: await readFile(args.path, 'utf8'), loader: args.path.endsWith('.json') ? 'json' : 'js'}));
    }
  }]
});
await copyFile('src/online.html', 'dist/online.html');

// Copy updated bundles and assets to game/
await copyFile('dist/app.js', 'game/app.js');
await copyFile('dist/online.js', 'game/online.js');

console.log('Successfully built dist and synced to game/');
