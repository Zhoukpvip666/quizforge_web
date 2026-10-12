(function () {
  'use strict';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const document = value => object(value) && value.type === 'doc' && Array.isArray(value.content) && value.content.length > 0;
  const total = data => data.parts.reduce((sum, part) => sum + part.maxScore, 0);
  function unavailable() {const error = new Error('简答题目前为界面原型，真实保存、判分与 AI 评分尚未实现。'); error.code = 'DEVELOPMENT_NOT_IMPLEMENTED'; throw error;}
  QF.defineType({
    validateQuestion(data) {
      return object(data) && data.formatVersion === 1 && (data.material === null || document(data.material))
        && Array.isArray(data.parts) && data.parts.length >= 1 && data.parts.length <= 100
        && data.parts.every(part => object(part) && /^[A-Za-z0-9_-]{1,64}$/.test(part.id) && document(part.stem) && document(part.answerAndExplanation)
          && Number.isFinite(part.maxScore) && part.maxScore > 0 && part.maxScore <= 100000 && Number.isInteger(part.maxScore * 2))
        && new Set(data.parts.map(part => part.id)).size === data.parts.length && total(data) <= 100000;
    },
    project(data, state) {
      return {formatVersion: data.formatVersion, material: data.material, parts: data.parts.map(part => ({id: part.id, stem: part.stem, maxScore: part.maxScore,
        ...(state?.submitted ? {answerAndExplanation: part.answerAndExplanation} : {})}))};
    },
    getScore(data, state) {
      const maxScore = total(data);
      if (!state?.submitted && state?.status !== 'submitted') {
        return {score:0,maxScore};
      }
      if (!state.result) return unavailable();
      if (state.result.gradingStatus === 'pending') return {score:null,maxScore,gradingStatus:'pending',outlineStates:data.parts.map(part => ({id:part.id,status:'incorrect'}))};
      if (!Number.isFinite(state.result.score)) return unavailable();
      return {score:state.result.score,maxScore,gradingStatus:'graded',outlineStates:data.parts.map(part => ({id:part.id,status:state.result.parts?.[part.id]?.score === part.maxScore ? 'correct' : 'incorrect'}))};
    },
    getOutlineItems(data) {return data.parts.length === 1 ? [] : data.parts.map((part,index) => ({id:part.id,label:`（${index + 1}）`}));},
    validateAnswer: unavailable,
    grade: unavailable,
    review: unavailable
  });
})();
