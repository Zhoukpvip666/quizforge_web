import { QuizForgeServer } from './host/http/server.js';
import { upgradeShortAnswerBanks } from './host/practice/short-answer-upgrade.js';

const options = { root: '.', host: '127.0.0.1', port: 8080, token: null, node: process.execPath };
let upgrade = false, upgradeAutomatic = false, only = false, service;
try {
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--help') {
      console.log('node core/server/main.mjs [--root DIRECTORY] [--host ADDRESS] [--port 8080] [--token TOKEN] [--node EXECUTABLE] [--upgrade-short-answer | --upgrade-short-answer-auto] [--upgrade-only]');
      process.exit(0);
    }
    if (flag === '--upgrade-short-answer') { upgrade = true; continue; }
    if (flag === '--upgrade-short-answer-auto') { upgradeAutomatic = true; continue; }
    if (flag === '--upgrade-only') { only = true; continue; }
    if (!['--root', '--host', '--port', '--token', '--node'].includes(flag) || ++i >= process.argv.length) throw new Error('Unknown option or missing value: ' + flag);
    options[flag.slice(2)] = flag === '--port' ? Number(process.argv[i]) : process.argv[i];
  }
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('QuizForge requires Node.js 24');
  if (only && !upgrade && !upgradeAutomatic) throw new Error('--upgrade-only requires an upgrade option');
  service = await QuizForgeServer.create(options);
  const stop = async () => { await service.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (upgrade) console.log('Short-answer banks upgraded: ' + await upgradeShortAnswerBanks(service.library, service.states));
  if (upgradeAutomatic) console.log('Automatic-scoring short-answer banks upgraded: ' + await upgradeShortAnswerBanks(service.library, service.states, true));
  if (only) await service.close();
  else {
    await service.start();
    console.log('QuizForge Web listening on http://' + (options.host.includes(':') ? '[' + options.host + ']' : options.host) + ':' + service.port());
    console.log('Local administrator supplied extensions only; Node restrictions are not a full hostile-code sandbox.');
  }
} catch (error) {
  await service?.close();
  // Do not print provider payloads, credentials or command-line access tokens.
  console.error('QuizForge could not start: ' + (error.code ?? error.message)); process.exitCode = 1;
}
