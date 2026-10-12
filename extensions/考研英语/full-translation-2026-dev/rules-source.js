import {validateDocument} from '../../../core/shared/richtext/1.1.2/src/document.js';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v),half=v=>Number.isFinite(v)&&Number.isInteger(v*2),submitted=s=>s?.submitted||s?.status==='submitted';
const uniform=d=>half(d.pointsPerItem)&&d.pointsPerItem>0&&d.maxScore===d.pointsPerItem*d.parts.length&&d.maxScore<=100000&&new Set(d.parts.map(p=>p.id)).size===d.parts.length&&validateDocument(d.stem,{requireContent:true});
const validResponses=(a,d,check)=>object(a?.responses)&&Object.entries(a.responses).every(([id,v])=>{const p=d.parts.find(p=>p.id===id);return p&&typeof v==='string'&&check(v,p);});
const hasAnswer=a=>Object.values(a.responses).some(v=>v.trim());
import {prepareAiGrading} from './ai-document.js';
QF.defineType({prepareAiGrading,
validateQuestion(d){return validateDocument(d.stem,{requireContent:true})&&half(d.maxScore)&&d.maxScore>0&&d.maxScore<=100000&&['referenceAnswer','rubric'].every(k=>d[k]===null||validateDocument(d[k]));},
validateAnswer(a){return a?.formatVersion===1&&validateDocument(a.document);},
project(d,s){return {formatVersion:1,stem:d.stem,maxScore:d.maxScore,...(submitted(s)?{referenceAnswer:d.referenceAnswer,rubric:d.rubric}:{})};},
grade(d,a){if(!validateDocument(a.document,{requireContent:true}))throw new Error('请先填写译文。');return {gradingStatus:'pending',score:null,maxScore:d.maxScore,correct:null,feedback:null};},
review(d,a,r){if(!object(r)||!half(r.score)||r.score<0||r.score>d.maxScore||Object.keys(r).some(k=>!['score','feedback'].includes(k))||r.feedback!==undefined&&(typeof r.feedback!=='string'||r.feedback.length>20000))throw new Error('评分须在0至满分之间，以0.5为步长。');return {gradingStatus:'graded',score:r.score,maxScore:d.maxScore,correct:r.score===d.maxScore,feedback:r.feedback??null};},
getScore(d,s){return {score:submitted(s)?s.result?.score??null:0,maxScore:d.maxScore};}
});
