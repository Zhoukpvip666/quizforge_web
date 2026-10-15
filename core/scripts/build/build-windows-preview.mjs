import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { copyRuntimeDependencies } from './runtime-dependencies.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const options = { version: '0.1.0-preview.2', node: process.execPath, output: path.join(root, 'dist'), license: null, sourceCommit: null };
for (let i = 2; i < process.argv.length; i++) {
  const key = { '--version': 'version', '--node': 'node', '--output': 'output', '--node-license': 'license', '--source-commit': 'sourceCommit' }[process.argv[i]];
  if (!key || ++i >= process.argv.length) throw new Error('Unknown package option'); options[key] = process.argv[i];
}
if (process.platform !== 'win32' || process.arch !== 'x64' || !/^[\w.-]{1,80}$/.test(options.version)) throw new Error('This build produces a Windows x64 preview');
if (options.sourceCommit !== null && !/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw new Error('Invalid source commit');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const launcher = path.join(root, 'QuizForge.exe');
if (!fs.existsSync(launcher)) throw new Error('Build QuizForge.exe with core/scripts/build/build-windows-launcher.ps1 first');
const source = path.join(root, 'core/desktop/windows');
if (fs.readdirSync(source).filter(name => name.endsWith('.cs')).some(name => fs.statSync(path.join(source, name)).mtimeMs > fs.statSync(launcher).mtimeMs)) throw new Error('Launcher source changed; rebuild QuizForge.exe first');
const nodeVersion = execFileSync(options.node, ['--version'], { windowsHide: true, encoding: 'utf8' }).trim();
if (!/^v24\./.test(nodeVersion)) throw new Error('Node.js 24 is required');
const output = path.resolve(options.output); fs.mkdirSync(output, { recursive: true });
const packageFile = path.join(output, `QuizForge-${options.version}-win-x64.zip`);
if (fs.existsSync(packageFile)) throw new Error('Package already exists; use a new output directory or version');
fs.mkdirSync(path.join(root, '.temp'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, '.temp', 'preview-package-')), target = path.join(work, 'QuizForge');
fs.mkdirSync(target);
const productFilter = file => {
  const name = path.basename(file);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Links are not packaged: ' + file);
  return !['.temp', '.state', '.development', '.trash', '.git', 'node_modules'].includes(name) && !/\.test\.(mjs|cjs|js)$/.test(name);
};
const copy = (relative, filter = productFilter) => fs.cpSync(path.join(root, relative), path.join(target, relative), { recursive: true, filter });
copy('QuizForge.exe');
for (const directory of ['core/server', 'core/web', 'core/shared', 'core/docs', 'skills']) copy(directory);
for (const file of ['core/package.json', 'core/package-lock.json', 'FEATURES.md']) copy(file);
const basics = ['single-choice-richtext', 'multiple-choice-richtext', 'true-false-richtext', 'short-answer-richtext'];
for (const name of basics) copy('extensions/' + name);
copy('extensions/README.md');
copy('question-banks/基础题型/.group.json'); copy('question-banks/基础题型/基础题型展示');
fs.mkdirSync(path.join(target, 'runtime')); fs.copyFileSync(options.node, path.join(target, 'runtime/node.exe'));
const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`;
let license;
if (options.license) license = fs.readFileSync(options.license);
else {
  const response = await fetch(licenseUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Node license download failed: ' + response.status);
  license = Buffer.from(await response.arrayBuffer());
}
if (!license.toString('utf8').includes('Node.js') || license.length > 1024 * 1024) throw new Error('Node license is invalid');
fs.writeFileSync(path.join(target, 'runtime/LICENSE'), license);

// Copy only the installed backend dependency closure, including every license.
// UI dependencies are already compiled into core/shared and web/assets.
const modules = copyRuntimeDependencies(root, target);

fs.writeFileSync(path.join(target, 'README.md'), `# QuizForge ${options.version}\n\nWindows 10/11 64 位预览版。解压整个文件夹后双击 QuizForge.exe。内置 Node.js ${nodeVersion}，无需安装 Node.js 或 Java。托盘使用 Windows 的 .NET Framework 4.8。\n\n首次启动服务就绪后自动打开网页。左键点击托盘打开网页；右键查看运行情况或退出 QuizForge。退出时等待已收到的保存请求完成，再关闭服务。关闭浏览器页面后服务继续运行，手机连接设置见应用设置。退出前请确认页面输入已保存。\n\n请保留整个目录结构，放在可写目录中；不要只复制 EXE。只附带基础题型展示库及四种基础拓展，其他题库可通过应用内“获取题库”下载。源码及开发文档见 core/docs；Windows 托盘启动器源码位于项目仓库的 core/desktop/windows。\n\n预览版已知问题：窄屏首次草稿异常、同内容服务重启后的旧页面保存重试、旧拓展待评分大纲状态、汇总页改名显示和旧格式导出同身份拓展并存场景，尚待当前版本复测/修复。\n`);
const receipt = { version: options.version, sourceCommit: options.sourceCommit, platform: 'win-x64', nodeVersion, nodeLicenseSource: licenseUrl, launcherSha256: digest(fs.readFileSync(launcher)), extensions: basics,
  banks: ['基础题型/基础题型展示'], dependencies: modules, excluded: ['personal state/settings/history', 'root test/', 'non-basic banks/extensions', 'automatic tests', 'temporary/build files'] };
fs.writeFileSync(path.join(target, 'RELEASE.json'), JSON.stringify(receipt, null, 2));
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
