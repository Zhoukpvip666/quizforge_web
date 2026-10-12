import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeDirectory, within } from '../platform/files.js';
const code = fileURLToPath(new URL('../../../', import.meta.url)), base = path.join(path.dirname(code), '.temp', 'node-migration');
function fixture(t) {
  safeDirectory(base, true); const root = fs.mkdtempSync(path.join(base, 'startup-'));
  for (const directory of ['core/web', 'extensions', 'question-banks']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'core/web/index.html'), '<!doctype html><title>Native CLI fixture</title>');
  t.after(() => { assert.ok(within(base, root) && root !== base); fs.rmSync(root, { recursive: true, force: true }); }); return root;
}
function child(root, options = []) {
  const env = { ...process.env, PATH: '' }; delete env.JAVA_HOME; delete env.JDK_HOME;
  const processChild = spawn(process.execPath, [path.join(code, 'server/main.mjs'), '--root', root, '--port', '0', ...options], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; processChild.stdout.on('data', value => output += value); processChild.stderr.on('data', value => output += value);
  const ended = new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('close', exitCode => resolve({ exitCode, output })); });
  return { processChild, ended, output: () => output };
}
test('native CLI starts with no Java or shell executable on PATH and recovers a stopped host lock', async t => {
  const root = fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const running = child(root); t.after(() => running.processChild.kill());
    const until = Date.now() + 10000; let port;
    while (Date.now() < until && !port) { port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(running.output())?.[1]; if (!port) await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.ok(port, running.output());
    assert.equal((await (await fetch('http://127.0.0.1:' + port + '/api/health')).json()).ok, true);
    assert.ok((await (await fetch('http://127.0.0.1:' + port + '/')).text()).includes('Native CLI fixture'));
    running.processChild.kill(); await running.ended;
  }
});
test('explicit native upgrade-only exits and releases the data lock without starting a website', async t => {
  const root = fixture(t), running = child(root, ['--upgrade-short-answer-auto', '--upgrade-only']); t.after(() => running.processChild.kill());
  const result = await running.ended; assert.equal(result.exitCode, 0, result.output); assert.ok(result.output.includes('banks upgraded: 0'));
  assert.equal(fs.existsSync(path.join(root, '.state/host.lock')), false); assert.equal(result.output.includes('listening on'), false);
});
