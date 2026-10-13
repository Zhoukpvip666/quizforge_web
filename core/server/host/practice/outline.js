import { ApiError } from '../platform/errors.js';
import { cloneJson, jsonBytes } from '../platform/json.js';

function plain(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f-\x9f<>]/.test(value); }
const invalidItems = () => new ApiError(422, 'INVALID_OUTLINE_ITEMS', '小题目录必须为最多 100 项的有序数组，每项仅含唯一 id 和纯文本 label。');
export function readOutlineItems(values) {
  if (!Array.isArray(values) || values.length > 100) throw invalidItems();
  const seen = new Set();
  return values.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !plain(value.id, 128) || !plain(value.label, 80) || seen.has(value.id)) throw invalidItems();
    seen.add(value.id); return { id: value.id, label: value.label };
  });
}
export function readOutlineConfiguration(value, extension) {
  const invalid = () => new ApiError(422, 'INVALID_OUTLINE_ITEMS', '题目 outline 仅允许 {level:question,label:纯文本编号} 或 {level:parts,items:1 至 100 项有序小题目录}，不能同时列出大题和小题。');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) throw invalid();
  if (value.level === 'question') {
    if (!plain(value.label, 80)) throw invalid();
    return { level: 'question', label: value.label, items: [] };
  }
  if (value.level !== 'parts' || !Object.hasOwn(value, 'items')) throw invalid();
  const items = readOutlineItems(value.items);
  if (!items.length) throw invalid();
  if (!extension.outlineItemsDeclared) throw new ApiError(422, 'OUTLINE_CAPABILITY_REQUIRED', '题库显式小题目录需要所属拓展声明 API 1.1 outline-items 定位能力；题库与拓展均未修改。');
  return { level: 'parts', label: null, items };
}
export function attachOutline(row, question) {
  if (question.outline?.level === 'question') row.outlineLabel = question.outline.label;
  if (question.outlineItems.length) row.outlineItems = cloneJson(question.outlineItems);
  return row;
}
export function addOutlineBytes(current, additional) {
  if (additional < 0 || current > 8 * 1024 * 1024 - additional) throw new ApiError(422, 'INVALID_OUTLINE_ITEMS', '题库的小题目录超过 8 MiB 限制，请缩短目录标签或拆分题库；原题库未修改。');
  return current + additional;
}
export function validateOutlineStates(items, submitted) {
  const invalid = () => new ApiError(422, 'INVALID_OUTLINE_STATES', 'outlineStates 无效：需要唯一小题 id 与合法 status；作答时仅允许 unanswered/draft，提交后不能返回 draft。');
  if (!Array.isArray(items) || items.length > 100) throw invalid();
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 || !plain(item.id, 128) || seen.has(item.id) || !['unanswered', 'draft', 'correct', 'incorrect'].includes(item.status) || (!submitted && !['unanswered', 'draft'].includes(item.status)) || (submitted && item.status === 'draft')) throw invalid();
    seen.add(item.id);
  }
}
export function validateAnswerState(value, question = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['status', 'outlineStates'].includes(key)) || !['unanswered', 'draft'].includes(value.status) || !Array.isArray(value.outlineStates)) throw new ApiError(422, 'INVALID_ANSWER_STATE', '作答状态需要 unanswered/draft 和小题状态数组。');
  validateOutlineStates(value.outlineStates, false);
  if (question && value.outlineStates.some(item => !question.outlineItems.some(allowed => allowed.id === item.id))) throw new ApiError(422, 'INVALID_ANSWER_STATE', '作答状态 ID 不属于当前题目大纲。');
}
export function visibleOutlineStates(items, question, submitted) {
  validateOutlineStates(items, submitted);
  const ids = new Set(question.outlineItems.map(item => item.id));
  return cloneJson(items.filter(item => ids.has(item.id)));
}
export async function runRuleBatches(engine, questions, operation, field, inputs) {
  if (questions.length !== inputs.length) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid batch alignment');
  const groups = new Map(), result = Array(questions.length).fill(null);
  let outlineBytes = 1;
  for (let i = 0; i < questions.length; i++) {
    const extension = questions[i].extension;
    if (!extension) throw new ApiError(400, 'INVALID_REQUEST', 'Missing batch extension');
    const key = extension.id + '@' + extension.version + ':' + extension.fingerprint;
    if (!groups.has(key)) groups.set(key, { extension, indexes: [] });
    groups.get(key).indexes.push(i);
  }
  const ordered = [...groups].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, group]) => group);
  async function runGroup(group) {
    const maximum = operation === 'outlineBatch' || (operation === 'scoreBatch' && group.extension.outlineItemsDeclared) ? 24 : 512;
    let cursor = 0;
    while (cursor < group.indexes.length) {
      const batch = [], indexes = []; let bytes = 0;
      while (cursor < group.indexes.length && batch.length < maximum) {
        const index = group.indexes[cursor], size = jsonBytes(inputs[index]).length + 1;
        if (batch.length && bytes + size > 512 * 1024) break;
        batch.push(inputs[index]); indexes.push(index); bytes += size; cursor++;
      }
      const response = await engine.run(group.extension, { op: operation, questions: batch });
      if (field !== null) {
        const values = response?.[field];
        if (!Array.isArray(values) || values.length !== indexes.length) throw new ApiError(422, 'RULE_BATCH_INVALID', 'Extension returned an invalid batch result');
        if (operation === 'outlineBatch') for (const value of values) outlineBytes = addOutlineBytes(outlineBytes, jsonBytes(value).length + 1);
        for (let i = 0; i < indexes.length; i++) result[indexes[i]] = values[i];
      }
    }
  }
  // Independent validators/projections can overlap process startup. Keep each
  // extension's batches sequential and drain both workers before propagating a
  // failure, so a failed load never leaves rule work running in the background.
  const concurrency = ['validateBank', 'projectBatch'].includes(operation) ? 2 : 1;
  let cursor = 0, failed = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, ordered.length) }, async () => {
    while (!failed && cursor < ordered.length) {
      const group = ordered[cursor++];
      try { await runGroup(group); } catch (error) { failed = true; throw error; }
    }
  }));
  const failure = workers.find(worker => worker.status === 'rejected');
  if (failure) throw failure.reason;
  return result;
}
export async function outlineQuestions(engine, questions) {
  const enabled = questions.filter(question => !question.outline && question.extension.outlineItemsDeclared), byId = new Map();
  if (enabled.length) {
    const values = await runRuleBatches(engine, enabled, 'outlineBatch', 'outlineItems', enabled.map(question => question.data));
    for (let i = 0; i < enabled.length; i++) byId.set(enabled[i].id, readOutlineItems(values[i]));
  }
  const result = questions.map(question => byId.has(question.id) ? { ...question, outlineItems: byId.get(question.id) } : question);
  let bytes = 1;
  for (const question of result) bytes = addOutlineBytes(bytes, jsonBytes(attachOutline({}, question)).length + 1);
  return result;
}
