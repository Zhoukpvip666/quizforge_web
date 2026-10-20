import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { stageWindowsApp, digest } from './stage-windows-app.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const options = { version: '0.1.0-preview.3', node: process.execPath, output: path.join(root, 'dist'), license: null, sourceCommit: null, launcher: path.join(root, 'QuizForge.exe') };
for (let i = 2; i < process.argv.length; i++) {
  const key = { '--version': 'version', '--node': 'node', '--output': 'output', '--node-license': 'license', '--source-commit': 'sourceCommit', '--launcher': 'launcher' }[process.argv[i]];
  if (!key || ++i >= process.argv.length) throw new Error('Unknown package option'); options[key] = process.argv[i];
}
const output = path.resolve(options.output); fs.mkdirSync(output, { recursive: true });
const packageFile = path.join(output, `QuizForge-${options.version}-win-x64.zip`);
if (fs.existsSync(packageFile)) throw new Error('Package already exists; use a new output directory or version');
fs.mkdirSync(path.join(root, '.temp'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, '.temp', 'preview-package-')), target = path.join(work, 'QuizForge');
const receipt = await stageWindowsApp({ root, target, ...options });
const zip = new yazl.ZipFile();
function add(directory, relative = 'QuizForge') {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), entry = relative + '/' + name;
    if (fs.statSync(file).isDirectory()) add(file, entry); else zip.addFile(file, entry);
  }
}
add(target); const writing = pipeline(zip.outputStream, fs.createWriteStream(packageFile, { flags: 'wx' })); zip.end(); await writing;
const result = { packageFile, bytes: fs.statSync(packageFile).size, sha256: digest(fs.readFileSync(packageFile)), stagingRoot: target, ...receipt };
fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
