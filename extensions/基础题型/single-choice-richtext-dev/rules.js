(function () {
  'use strict';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const document = value => object(value) && value.type === 'doc' && Array.isArray(value.content) && value.content.length > 0;
  function unavailable() {
    const error = new Error('单选题目前为界面原型，保存与判分尚未实现。');
    error.code = 'DEVELOPMENT_NOT_IMPLEMENTED';
    throw error;
  }
  QF.defineType({
    validateQuestion(data) {
      return object(data) && data.formatVersion === 1 && document(data.stem)
        && document(data.answerAndExplanation) && Array.isArray(data.options)
        && data.options.length >= 2 && data.options.length <= 26
        && data.options.every(option => object(option) && /^[A-Za-z0-9_-]{1,64}$/.test(option.id) && document(option.content))
        && new Set(data.options.map(option => option.id)).size === data.options.length
        && data.options.some(option => option.id === data.correctOptionId)
        && Number.isFinite(data.maxScore) && data.maxScore > 0 && data.maxScore <= 100000;
    },
    project(data, state) {
      const value = {formatVersion: data.formatVersion, stem: data.stem, options: data.options, maxScore: data.maxScore};
      if (state?.submitted) {
        value.correctOptionId = data.correctOptionId;
        value.answerAndExplanation = data.answerAndExplanation;
      }
      return value;
    },
    getScore(data, state) {
      if (!state?.submitted && state?.status !== 'submitted') return {score: 0, maxScore: data.maxScore};
      if (!Number.isFinite(state.result?.score)) return unavailable();
      return {score: state.result.score, maxScore: data.maxScore};
    },
    validateAnswer: unavailable,
    grade: unavailable,
    review: unavailable
  });
})();
