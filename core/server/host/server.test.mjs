import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { QuizForgeServer } from './server.js';
import { readJson, safeDirectory, within } from './files.js';
import { jsonBytes } from './json.js';
import { MIME as archiveMime } from './library-archive.js';
const codeRoot = fileURLToPath(new URL('../../', import.meta.url)), base = path.join(path.dirname(codeRoot), '.temp', 'node-migration');
async function fixture(t, options = {}) {
  safeDirectory(base, true); const root = fs.mkdtempSync(path.join(base, 'http-')); fs.mkdirSync(path.join(root, 'extensions')); fs.mkdirSync(path.join(root, 'question-banks'));
  const extension = path.join(root, 'extensions', 'choice'); fs.cpSync(path.join(codeRoot, 'test/fixtures/legacy-extensions/single-choice-1.0.0'), extension, { recursive: true });
  const raw = readJson(path.join(extension, readJson(path.join(extension, 'manifest.json')).examples)); raw.id = 'bank1'; raw.features = { history: options.history ?? true };
  fs.writeFileSync(path.join(root, 'question-banks', 'bank.json'), jsonBytes(raw));
  const service = await QuizForgeServer.create({ root, codeRoot, port: 0, token: options.token ?? null }); service.engine.validationEnvironment = async () => 'http-fixture'; await service.start();
  t.after(async () => { await service.close(); assert.ok(within(base, root) && root !== base); fs.rmSync(root, { recursive: true, force: true }); });
  const api = async (uri, { method = 'GET', body, headers = {}, port = service.port() } = {}) => {
    const response = await fetch('http://127.0.0.1:' + port + uri, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, data: response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  return { root, service, api, raw };
}
const rawGet = (port, uri, headers = {}) => new Promise((resolve, reject) => { const request = http.get({ host: '127.0.0.1', port, path: uri, headers }, response => { const bytes = []; response.on('data', chunk => bytes.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, data: Buffer.concat(bytes).toString() })); }); request.on('error', reject); });
test('native HTTP serves existing pages and isolates administrator routes', async t => {
  const { api, service } = await fixture(t);
  assert.equal((await api('/api/health')).data.ok, true);
  const page = await api('/'); assert.equal(page.status, 200); assert.ok(page.data.includes(Buffer.from('QuizForge'))); assert.ok(page.headers.get('content-security-policy'));
  assert.equal((await rawGet(service.port(), '/api/health', { Host: 'evil.example:' + service.port() })).status, 403);
  assert.equal((await rawGet(service.port(), '/api/settings/ai', { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
  assert.equal((await rawGet(service.port(), '/%2e%2e/package.json')).status, 404);
  assert.equal((await api('/api/settings/development', { method: 'PUT', body: { enabled: true }, headers: { Origin: 'https://evil.example' } })).data.error.code, 'ORIGIN_REJECTED');
  const index = await api('/api/library/index'); assert.equal(index.status, 200); assert.equal(index.data.canManage, true); assert.equal(index.data.banks[0].id, 'bank1');
  const catalog = await api('/api/catalog'); assert.equal(catalog.status, 200); assert.equal(catalog.data.banks[0].validationStatus, 'ready');
  const credential = await api('/api/settings/ai/credential'); assert.equal(credential.status, 200);
  assert.equal((await api('/api/settings/ai')).data.apiKey, undefined);
  assert.equal((await api('/api/extensions/quizforge.single-choice/1.0.0/page?typeId=x')).status, 400);
});
test('native HTTP preserves revision, submitted answers, frozen history and restart', async t => {
  const { api, raw } = await fixture(t), qid = raw.questions[0].id, prefix = '/api/collections/bank/bank1', q = prefix + '/questions/' + qid;
  const original = await api(q); assert.equal(original.status, 200);
  const answer = { selectedOptionId: raw.questions[0].data.correctOptionId };
  const draft = await api(q + '/actions', { method: 'POST', body: { action: 'draft', requestId: 'native-draft1', revision: 0, data: { answer } } }); assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const submitted = await api(q + '/actions', { method: 'POST', body: { action: 'submit', requestId: 'native-submit1', revision: 1, data: { answer } } }); assert.equal(submitted.status, 200); assert.equal(submitted.data.state.status, 'submitted');
  const summary = await api(prefix + '/summary'); assert.equal(summary.status, 200);
  const finished = await api(prefix + '/finish', { method: 'POST', body: { requestId: 'native-finish1', roundId: summary.data.roundId, summaryVersion: summary.data.summaryVersion } }); assert.equal(finished.status, 200);
  const history = await api(prefix + '/history'); assert.equal(history.status, 200); assert.equal(history.data.records.length, 1);
  const frozen = await api(prefix + '/history/' + history.data.records[0].id); assert.equal(frozen.status, 200); assert.ok(frozen.data.page);
  const restarted = await api(prefix + '/restart', { method: 'POST', body: { requestId: 'native-restart1', roundId: finished.data.roundId, summaryVersion: finished.data.summaryVersion } }); assert.equal(restarted.status, 200); assert.equal((await api(q)).data.state.status, 'unanswered');
});
test('history-disabled HTTP practice requires and isolates the browser page session', async t => {
  const { api, raw, root } = await fixture(t, { history: false }), uri = '/api/collections/bank/bank1/questions/' + raw.questions[0].id;
  assert.equal((await api(uri)).data.error.code, 'PRACTICE_SESSION_REQUIRED');
  const first = { 'X-QuizForge-Practice-Session': randomUUID() }, second = { 'X-QuizForge-Practice-Session': randomUUID() };
  assert.equal((await api(uri, { headers: first })).status, 200);
  const drafted = await api(uri + '/actions', { method: 'POST', headers: first, body: { action: 'draft', requestId: 'temporary-draft1', revision: 0, data: { answer: { selectedOptionId: raw.questions[0].data.correctOptionId } } } }); assert.equal(drafted.status, 200);
  assert.equal((await api(uri, { headers: second })).data.state.status, 'unanswered');
  assert.equal(fs.readdirSync(path.join(root, '.state')).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 0);
});
test('native host enforces one writer per data directory and retains local access tokens', async t => {
  const { service, root, api } = await fixture(t, { token: 'native-token-123456789' });
  assert.equal((await api('/api/health')).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { password: 'native-token-123456789' } })).status, 200);
  assert.equal((await api('/api/health', { headers: { 'X-QuizForge-Token': 'native-token-123456789' } })).status, 200);
  await assert.rejects(QuizForgeServer.create({ root, codeRoot, port: 0 }), /already open/);
  assert.equal(fs.existsSync(path.join(root, '.state', 'host.lock')), true);
});
test('shared network password protects remote listener and blocks remote settings', async t => {
  const { api, service } = await fixture(t);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const settings = await api('/api/settings/network', { method: 'PUT', body: { enabled: true, publicEnabled: false, port, password: 'shared-password' } }); assert.equal(settings.status, 200); assert.equal(settings.data.enabled, true);
  assert.equal((await api('/api/health', { port })).status, 401);
  const login = await api('/api/auth/login', { port, method: 'POST', body: { password: 'shared-password' } }); assert.equal(login.status, 200); const headers = { 'X-QuizForge-Token': login.data.token };
  assert.equal((await api('/api/health', { port, headers })).status, 200);
  assert.equal((await api('/api/settings/ai/credential', { port, headers })).status, 403);
  assert.equal((await api('/api/settings/network', { port, headers })).status, 403);
  await api('/api/settings/network', { method: 'PUT', body: { enabled: false, publicEnabled: false, port } });
  assert.equal(service.networkServer, null);
});

test('HTTP group export and import transport the native qbank stream and installed versions', async t => {
  const { api, root, raw } = await fixture(t); fs.renameSync(path.join(root, 'question-banks', 'bank.json'), path.join(root, 'question-banks', 'bank1.json'));
  assert.equal((await api('/api/library/manage', { method: 'POST', body: { kind: 'bank', action: 'create', target: 'group', name: 'HTTP Group' } })).status, 200);
  const moved = await api('/api/library/manage', { method: 'POST', body: { kind: 'bank', action: 'update', target: 'item', path: 'bank1.json', name: raw.title, group: 'HTTP Group' } }); assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const archive = await api('/api/library/export', { method: 'POST', body: { group: 'HTTP Group' } }); assert.equal(archive.status, 200); assert.equal(archive.headers.get('content-type'), archiveMime); assert.ok(archive.headers.get('content-disposition').includes('.qbank'));
  const other = await fixture(t); fs.unlinkSync(path.join(other.root, 'question-banks', 'bank.json')); fs.rmSync(path.join(other.root, 'extensions', 'choice'), { recursive: true }); other.service.library.invalidate();
  const response = await fetch('http://127.0.0.1:' + other.service.port() + '/api/library/import', { method: 'POST', headers: { 'Content-Type': archiveMime }, body: archive.data });
  const imported = await response.json(); assert.equal(response.status, 200, JSON.stringify(imported)); assert.equal(imported.importedBanks, 1); assert.equal(imported.importedExtensions, 1);
  assert.equal((await other.api('/api/collections/bank/bank1')).status, 200);
});

test('HTTP exams keep saved draft choices until hand-in and join ordinary history', async t => {
  const { api, raw } = await fixture(t), prefix = '/api/collections/bank/bank1';
  const started = await api(prefix + '/exams', { method: 'POST', body: { requestId: 'http-exam-start', durationMinutes: null } }); assert.equal(started.status, 200, JSON.stringify(started.data));
  const exam = '/api/collections/exam/' + started.data.id, qid = raw.questions[0].id;
  const saved = await api(exam + '/questions/' + qid + '/actions', { method: 'POST', body: { requestId: 'http-exam-draft', revision: 0, action: 'draft', data: { answer: { selectedOptionId: raw.questions[0].data.correctOptionId } } } }); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await api(exam)).data.states[qid].status, 'draft');
  const rejected = await api(exam + '/questions/' + qid + '/actions', { method: 'POST', body: { requestId: 'http-exam-early-submit', revision: 1, action: 'submit', data: { answer: { selectedOptionId: raw.questions[0].data.correctOptionId } } } }); assert.equal(rejected.data.error.code, 'EXAM_ACTION_DISABLED');
  const finished = await api(exam + '/exam', { method: 'POST', body: {} }); assert.equal(finished.status, 200, JSON.stringify(finished.data)); assert.equal(finished.data.status, 'completed'); assert.equal(finished.data.summary.score, 1);
  const history = (await api(prefix + '/history')).data.records.find(row => row.mode === 'exam'); assert.ok(history);
  assert.equal((await api(prefix + '/history/' + history.id)).data.questions[0].payload.state.result.correct, true);
});
