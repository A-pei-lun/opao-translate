import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.resolve(root, '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.version !== packageInfo.version)
  throw new Error('Manifest and package versions must match');
const artifactName = 'O泡翻译-' + manifest.version;
const output = path.join(project, '05_构建产物', artifactName);
const allowedOutput = path.resolve(project, '05_构建产物', artifactName);
if (
  path.resolve(output) !== allowedOutput ||
  !allowedOutput.startsWith(path.resolve(project, '05_构建产物') + path.sep)
)
  throw new Error('Unexpected build output path');
try {
  if ((await fs.lstat(allowedOutput)).isSymbolicLink())
    throw new Error('Build output must not be a symbolic link');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await fs.rm(allowedOutput, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const common = {
  bundle: true,
  minify: false,
  sourcemap: true,
  target: 'chrome120',
  logLevel: 'warning',
  legalComments: 'linked',
};
await build({
  ...common,
  entryPoints: Object.fromEntries(
    ['background', 'runtime', 'settings', 'popup', 'workspace'].map((name) => [
      name,
      path.join(root, 'src', `${name}.js`),
    ]),
  ),
  outdir: output,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
});
await build({
  ...common,
  entryPoints: [path.join(root, 'src/content/main.js')],
  outfile: path.join(output, 'content.js'),
  format: 'iife',
});
await build({
  ...common,
  entryPoints: [path.join(root, 'src/content/subtitle-hook.js')],
  outfile: path.join(output, 'subtitle-hook.js'),
  format: 'iife',
});
await fs.copyFile(path.join(root, 'manifest.json'), path.join(output, 'manifest.json'));
await fs.cp(path.join(root, 'public'), output, { recursive: true });
const pdfRoot = path.join(root, 'node_modules/pdfjs-dist');
await fs.mkdir(path.join(output, 'vendor'), { recursive: true });
await fs.copyFile(
  path.join(pdfRoot, 'build/pdf.worker.mjs'),
  path.join(output, 'vendor/pdf.worker.mjs'),
);
for (const folder of ['cmaps', 'standard_fonts', 'wasm'])
  await fs.cp(path.join(pdfRoot, folder), path.join(output, 'vendor', folder), { recursive: true });

const ruleEntries = JSON.parse(
  await fs.readFile(path.join(root, 'public/site-rules.json'), 'utf8'),
);

const licenseNames = [
  'dompurify',
  'fflate',
  'pdf-lib',
  'pdfjs-dist',
  'pako',
  'tslib',
  '@pdf-lib/standard-fonts',
  '@pdf-lib/upng',
];
const notices = [];
for (const dependency of licenseNames) {
  const folder = path.join(root, 'node_modules', dependency);
  try {
    const files = (await fs.readdir(folder)).filter((name) =>
      /^(LICENSE|COPYING|NOTICE)/i.test(name),
    );
    for (const file of files)
      notices.push(
        `\n\n# ${dependency} / ${file}\n\n${await fs.readFile(path.join(folder, file), 'utf8')}`,
      );
  } catch {
    /* Some transitive packages may be hoisted differently. */
  }
}
await fs.writeFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
const entries = {};
const hashes = [];
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(location);
    else {
      const name = path.relative(output, location).replaceAll('\\', '/');
      const bytes = await fs.readFile(location);
      hashes.push({
        file: name,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
      entries[name] = new Uint8Array(bytes);
    }
  }
}
await collect(output);
await fs.writeFile(
  path.join(project, '05_构建产物', artifactName + '-文件清单.json'),
  JSON.stringify(hashes, null, 2),
);
entries['版本说明.txt'] = strToU8(
  'O泡翻译 ' +
    manifest.version +
    '\n在 Edge 的扩展管理页启用开发人员模式，加载此文件夹。首次打开设置添加翻译服务。\n',
);
const archive = path.join(project, '05_构建产物', artifactName + '.zip');
await fs.writeFile(archive, zipSync(entries, { level: 6 }));
console.log(
  JSON.stringify(
    {
      output,
      archive,
      files: hashes.length,
      siteRules: ruleEntries.length,
      sha256: crypto
        .createHash('sha256')
        .update(await fs.readFile(archive))
        .digest('hex'),
    },
    null,
    2,
  ),
);
