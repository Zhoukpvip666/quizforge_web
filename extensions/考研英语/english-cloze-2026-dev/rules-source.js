import { validateDocument } from '../../../core/shared/richtext/1.1.2/src/document.js';
const object = v => v && typeof v === 'object' && !Array.isArray(v), half = v => Number.isFinite(v) && Number.isInteger(v * 2), submitted = s => s?.submitted || s?.status === 'submitted';
const uniform = d => (typeof d.explanation === 'string' || validateDocument(d.explanation)) && half(d.pointsPerItem) && d.pointsPerItem > 0 && d.maxScore === d.pointsPerItem * d.parts.length && d.maxScore <= 100000 && new Set(d.parts.map(p => p.id)).size === d.parts.length && validateDocument(d.stem, { requireContent: true });
const validResponses = (a, d, check) => object(a?.responses) && Object.entries(a.responses).every(([id, v]) => { const p = d.parts.find(p => p.id === id); return p && typeof v === 'string' && check(v, p); });
const hasAnswer = a => Object.values(a.responses).some(v => v.trim());
QF.defineType({
    project(data, state) { const projected = {};["stem", "pointsPerItem", "maxScore"].forEach(key => projected[key] = data[key]); projected.parts = data.parts.map(part => { const value = {};["id", "number", "options"].forEach(key => value[key] = part[key]); if (state?.submitted) ["correctOptionId"].forEach(key => value[key] = part[key]); return value; }); if (state?.submitted) projected.explanation = data.explanation; return projected; },
    validateQuestion(d) { return uniform(d) && d.parts.every(p => new Set(p.options.map(o => o.id)).size === p.options.length && p.options.some(o => o.id === p.correctOptionId)); },
    validateAnswer(a, d) { return validResponses(a, d, (v, p) => v === '' || p.options.some(o => o.id === v)); },
    grade(d, a) { if (!hasAnswer(a)) throw new Error('请先作答。'); const score = d.parts.reduce((s, p) => s + (a.responses[p.id] === p.correctOptionId ? d.pointsPerItem : 0), 0); return { gradingStatus: 'graded', score, maxScore: d.maxScore, correct: score === d.maxScore, feedback: null }; },
    getScore(d,s){const value={score:submitted(s)?s.result?.score??null:0,maxScore:d.maxScore};if(submitted(s)&&s.answer?.responses)value.outlineStates=d.parts.map(p=>({id:p.id,status:!s.answer.responses[p.id]?.trim()?'unanswered':s.answer.responses[p.id]===p.correctOptionId?'correct':'incorrect'}));return value;}
});
