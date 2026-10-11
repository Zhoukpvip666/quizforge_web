import { ApiError, bad } from './errors.js';
import { cloneJson, integralField, jsonBytes } from './json.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validTargetId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/^[\s\uFEFF]|[\s\uFEFF]$|[\x00-\x1f\x7f-\x9f<>]/u.test(value);
export function targetId(value) {
  if (!value || !Object.hasOwn(value, 'targetId')) return null;
  if (!validTargetId(value.targetId)) throw bad('Invalid AI targetId'); return value.targetId;
}
export function validateInput(value) {
  const invalid = message => { throw new ApiError(422, 'INVALID_AI_INPUT', message); };
  if (!object(value) || !integralField(value, 'protocolVersion') || value.protocolVersion !== 1) invalid('题型拓展的 AI 评分协议无效。');
  if (Object.keys(value).some(field => !['protocolVersion', 'question', 'answer', 'referenceAnswer', 'rubric', 'maxScore', 'scoreStep'].includes(field))) invalid('AI 评分输入含未声明字段。');
  if (![value.maxScore, value.scoreStep].every(number => typeof number === 'number' && Number.isFinite(number) && number > 0)) invalid('AI 评分满分与精度必须是有限正数。');
  let chars = 0, images = 0;
  for (const field of Object.hasOwn(value, 'rubric') ? ['question', 'answer', 'referenceAnswer', 'rubric'] : ['question', 'answer', 'referenceAnswer']) {
    const blocks = value[field];
    if (!Array.isArray(blocks) || blocks.length > 2000 || ((field !== 'referenceAnswer' || !Object.hasOwn(value, 'rubric')) && !blocks.length)) invalid('AI 评分内容无效。');
    for (const block of blocks) {
      if (!object(block)) invalid('AI 评分内容块无效。');
      if (block.type === 'text') { if (typeof block.text !== 'string' || Object.keys(block).length !== 2 || (chars += block.text.length) > 400000) invalid('AI 评分文字无效或超出限制。'); }
      else if (block.type === 'image') {
        if (Object.keys(block).some(field => !['type', 'assetId', 'alt'].includes(field))) invalid('AI 图片不接受 URL 或路径。');
        if (typeof block.assetId !== 'string' || !/^[a-f0-9]{64}$/.test(block.assetId) || ++images > 40 || (Object.hasOwn(block, 'alt') && (typeof block.alt !== 'string' || block.alt.length > 500))) invalid('AI 图片引用无效。');
      } else invalid('AI 评分内容块类型无效。');
    }
  }
  if (jsonBytes(value).length > 1024 * 1024) throw new ApiError(413, 'AI_INPUT_TOO_LARGE', 'AI 评分输入超出大小限制。');
}
export function normalizeInput(value) {
  const result = cloneJson(value);
  if (!Object.hasOwn(result, 'rubric')) return result;
  if (!Array.isArray(result.referenceAnswer) || !Array.isArray(result.rubric) || !result.rubric.length) throw new ApiError(422, 'INVALID_AI_INPUT', 'AI 评分内容无效。');
  result.referenceAnswer = [...(result.referenceAnswer.length ? [{ type: 'text', text: '参考答案：' }, ...result.referenceAnswer] : []), { type: 'text', text: '评分依据：' }, ...result.rubric]; delete result.rubric; return result;
}
export function decorateReview(evaluated, previous, trusted = null) {
  const assessment = trusted ? trusted.assessment : previous?.aiAssessment;
  if (!object(assessment)) return evaluated;
  const result = cloneJson(evaluated); result.gradedAt = new Date().toISOString();
  let feedback = `最终得分：${result.score} / ${result.maxScore} 分`;
  if (trusted && typeof assessment.targetId === 'string') {
    const assessments = object(previous?.aiAssessments) ? cloneJson(previous.aiAssessments) : {};
    Object.defineProperty(assessments, assessment.targetId, { value: cloneJson(assessment), enumerable: true, configurable: true, writable: true });
    result.aiAssessments = assessments; delete result.aiAssessment; result.gradingSource = 'ai-assisted';
    if (typeof evaluated.feedback === 'string' && evaluated.feedback.trim()) feedback += '\n\n' + evaluated.feedback;
    feedback += `\n\n小题 ${assessment.targetId} AI 建议：${assessment.score} / ${assessment.maxScore} 分\n${assessment.feedback}`;
  } else {
    result.aiAssessment = cloneJson(assessment); const suggestedMax = typeof assessment.maxScore === 'number' ? assessment.maxScore : result.maxScore;
    const adjusted = result.score !== assessment.score || result.maxScore !== suggestedMax;
    result.gradingSource = trusted === null ? 'manual' : adjusted ? 'ai-assisted' : 'ai';
    if (trusted === null || adjusted) feedback += `\n${trusted === null ? '人工调整' : '拓展处理'}；AI 建议：${assessment.score} / ${suggestedMax} 分`;
    if (typeof assessment.feedback === 'string' && assessment.feedback.trim()) feedback += '\n\nAI 评分依据：\n' + assessment.feedback;
    if (trusted === null && typeof evaluated.feedback === 'string' && evaluated.feedback.trim()) feedback += '\n\n人工评语：\n' + evaluated.feedback;
  }
  if (feedback.length > 20000) throw bad('Combined grading feedback exceeds limit'); result.feedback = feedback; return result;
}
