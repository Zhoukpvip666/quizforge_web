import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stageWindowsApp, digest } from './stage-windows-app.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const options = { version: '0.1.0-preview.3', node: process.execPath, output: path.join(root, 'dist'), license: null, sourceCommit: null, launcher: path.join(root, 'QuizForge.exe'), compiler: process.env.ISCC_PATH, testId: null };
for (let i = 2; i < process.argv.length; i++) {
  const key = { '--version': 'version', '--node': 'node', '--output': 'output', '--node-license': 'license', '--source-commit': 'sourceCommit', '--launcher': 'launcher', '--compiler': 'compiler', '--test-id': 'testId' }[process.argv[i]];
  if (!key || ++i >= process.argv.length) throw new Error('Unknown installer option'); options[key] = process.argv[i];
}
if (!options.compiler || !fs.existsSync(options.compiler)) throw new Error('Specify Inno Setup 6.3+ ISCC.exe with --compiler or ISCC_PATH');
if (options.testId && !/^[a-z0-9-]{8,60}$/.test(options.testId)) throw new Error('Invalid isolated installer test id');
if (!/^[\w.-]{1,80}$/.test(options.version)) throw new Error('Invalid installer version');
const output = path.resolve(options.output); fs.mkdirSync(output, { recursive: true });
const packageFile = path.join(output, `QuizForge-${options.version}-win-x64-setup.exe`);
if (fs.existsSync(packageFile)) throw new Error('Installer already exists; use a new output directory or version');
fs.mkdirSync(path.join(root, '.temp'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, '.temp', 'installer-package-')), target = path.join(work, 'QuizForge');
const receipt = await stageWindowsApp({ root, target, ...options, installed: true, applicationId: options.testId ? 'QuizForge.InstallerTest.' + options.testId : 'QuizForge.Desktop' });
const definitions = [`/DPayloadRoot=${target}`, `/DOutputPath=${output}`, `/DAppVersion=${options.version}`];
if (options.testId) definitions.push(`/DAppId=QuizForge.InstallerTest.${options.testId}`, `/DAppName=QuizForge Test ${options.testId}`, `/DQBankExtension=.qbank-qftest-${options.testId}`, `/DHubScheme=quizforge-test-${options.testId}`);
execFileSync(options.compiler, [...definitions, path.join(root, 'core/desktop/installer/QuizForge.iss')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
const result = { packageFile, bytes: fs.statSync(packageFile).size, sha256: digest(fs.readFileSync(packageFile)), stagingRoot: target, testId: options.testId, ...receipt };
fs.writeFileSync(packageFile + '.sha256', result.sha256 + '  ' + path.basename(packageFile) + '\n');
fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
