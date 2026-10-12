import { ApiError, bad, routeId } from '../platform/errors.js';
import { fingerprint } from '../platform/json.js';
import { targetId } from '../ai/ai-protocol.js';

export class CollectionRoutes {
  constructor(library, states, ai, writes, automaticAi) { Object.assign(this, { library, states, ai, writes, automaticAi }); }
  async route(context, method, parts) {
    const { library, states, ai, writes } = this; states.recover(); const kind = parts[2], id = routeId(parts[3]);
    if (!['bank', 'extension', 'development', 'development-bank', 'exam'].includes(kind)) throw bad('Invalid collection kind');
    if (parts[4] === 'history') try { (await library.collection(kind, id)).features.requireHistory(); } catch (error) { if (error.code !== 'COLLECTION_NOT_FOUND') throw error; }
    if (parts.length === 4 && method === 'GET') return states.overview(await library.collection(kind, id));
    if (parts.length === 5) {
      if (parts[4] === 'summary' && method === 'GET') return states.summary(await library.collection(kind, id));
      if (parts[4] === 'history' && method === 'GET') return states.history(kind, id);
      if (parts[4] === 'restart' && method === 'POST') { const request = await writes.read(context); return states.restart(await library.collection(kind, id), request); }
      if (parts[4] === 'finish' && method === 'POST') {
        const request = await writes.read(context), collection = await library.collection(kind, id);
        for (const question of collection.questions) for (const taskId of await states.currentAiTaskIds(collection, question)) if (['queued', 'running', 'succeeded'].includes((await ai.get(collection, question, taskId)).status)) throw new ApiError(409, 'AI_GRADING_PENDING', 'AI 正在评分，请等待评分完成后再完成练习。');
        return states.finish(collection, request);
      }
    }
    if (parts.length === 6 && parts[4] === 'history') { if (method === 'GET') return states.history(kind, id, routeId(parts[5])); if (method === 'DELETE') { writes.validateOrigin(context); return states.deleteHistory(kind, id, routeId(parts[5])); } }
    if (parts.length >= 6 && parts[4] === 'questions') {
      const qid = routeId(parts[5]);
      if (parts.length === 6 && method === 'GET') { const collection = await library.readCollection(kind, id), question = collection.question(qid), response = await states.question(collection, question), task = await ai.current(collection, question); if (task !== null) response.aiTask = task; return response; }
      if (parts.length === 7) {
        if (parts[6] === 'stamp' && method === 'GET') { const collection = await library.readCollection(kind, id); return states.stamp(collection, collection.question(qid)); }
        if (parts[6] === 'editor' && method === 'GET') { const collection = await library.collection(kind, id); return states.editor(library, collection, collection.question(qid)); }
        if (parts[6] === 'edit' && method === 'POST') { const request = await writes.read(context), collection = await library.collection(kind, id); return states.edit(library, collection, collection.question(qid), request); }
        if (parts[6] === 'actions' && method === 'POST') {
          const request = await writes.read(context), collection = await library.writeCollection(kind, id), question = collection.question(qid), submit = request.action === 'submit', revision = submit ? (await states.stamp(collection, question)).revision : -1, response = await states.act(collection, question, request);
          if (submit && request.revision === revision && response.state.revision === revision + 1 && response.capabilities.canAiGrade && this.automaticAi()) try { await ai.startAutomatic(collection, question, { requestId: 'auto-submit-' + fingerprint(request, 'quizforge-auto-submit-v1'), contentVersion: response.stamp.contentVersion }); } catch { /* Submission remains durable if scheduling fails. */ }
          return response;
        }
      }
      if (parts.length >= 8 && parts[6] === 'ai') {
        const collection = await library.collection(kind, id), question = collection.question(qid);
        if (parts.length === 8 && parts[7] === 'current' && method === 'GET') { const parameters = context.url.searchParams.getAll('targetId'); if (parameters.length > 1) throw bad('Invalid AI targetId query'); return { task: await ai.current(collection, question, parameters.length ? targetId({ targetId: parameters[0] }) : null) }; }
        if (parts.length === 8 && parts[7] === 'grade' && method === 'POST') return ai.start(collection, question, await writes.read(context));
        if (parts.length >= 9 && parts[7] === 'tasks') {
          const task = routeId(parts[8]); if (parts.length === 9 && method === 'GET') return ai.get(collection, question, task);
          if (parts.length === 10 && method === 'POST') { if (parts[9] === 'retry') return ai.retry(collection, question, task, await writes.read(context)); if (parts[9] === 'confirm') return ai.confirm(collection, question, task, await writes.read(context)); }
        }
      }
    }
    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  }
}
