// Local adapter over the public QF API. It owns no storage or grading.
function createPersistence(read,notice){
 let context=null,version=0,saved=0,timer=null,chain=Promise.resolve(),disposed=false,busy=false;
 const caps=()=>context?.capabilities||{},locked=()=>context?.status==='submitted'||context?.mode==='history';
 const ok=reply=>{if(!reply?.ok)throw new Error(reply?.error?.message||'操作失败。');return reply;};
 function controls(){const submit=document.getElementById('submit-button'),retry=document.getElementById('retry-button');submit.hidden=locked()||!caps().canSubmit;submit.disabled=busy||!caps().canSubmit||!Object.values(read().responses).some(v=>v.trim());retry.hidden=context?.status!=='submitted'||context?.mode==='history'||context?.mode==='exam';retry.disabled=busy||!caps().canRetry;}
 function save(){clearTimeout(timer);timer=null;if(disposed||locked()||version<=saved)return chain;if(!caps().canSave)return Promise.reject(new Error('当前答案不能保存。'));const current=version,answer=structuredClone(read());const next=chain.catch(()=>{}).then(async()=>{ok(await QF.save({purpose:'draft',data:{answer}}));saved=Math.max(saved,current);if(!disposed&&current===version)notice('');});chain=next;next.catch(e=>{if(!disposed)notice(e.message+' 当前输入仍保留，切题前会重试。');});return next;}
 return {get busy(){return busy;},get context(){return context;},enter(next){const same=context?.question.id===next.question.id,previous=context?.status;context=next;const preserve=same&&!locked()&&previous!=='submitted';if(!same||previous==='submitted'&&!locked()){version=0;saved=0;chain=Promise.resolve();clearTimeout(timer);}controls();return !preserve;},changed(){if(locked()||busy)return;version++;notice('');clearTimeout(timer);timer=setTimeout(()=>save().catch(()=>{}),180);},async flush(){clearTimeout(timer);timer=null;await save();await chain;},async submit(){if(busy||locked()||!caps().canSubmit)return;busy=true;controls();try{await this.flush();ok(await QF.save({purpose:'submit',data:{answer:structuredClone(read())}}));notice('');}catch(e){notice(e.message+' 当前答案仍保留。');}finally{busy=false;controls();}},async retry(){if(busy||!caps().canRetry)return;busy=true;controls();try{await this.flush();ok(await QF.requestAction({action:'retry'}));}catch(e){notice(e.message);}finally{busy=false;controls();}},dispose(){disposed=true;clearTimeout(timer);timer=null;}};
}
(function(){'use strict';
const $=id=>document.getElementById(id),node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
let context,data,answer={},submitted=false,disposed=false,view=null,analysisView=null,activePart=null;const listeners=[],targets=new Map();
const resize=()=>{if(!disposed)QF.ui.resize();},listen=(el,event,fn)=>{el.addEventListener(event,fn);listeners.push(()=>el.removeEventListener(event,fn));};
const store=createPersistence(()=>({responses:{...answer}}),text=>{$('notice').textContent=text;resize();});
function build(focusPart){
listeners.splice(0).forEach(fn=>fn());targets.clear();const chain=$('sequence');chain.replaceChildren();
for(const slot of data.slots){
 const part=data.parts.find(p=>p.slotId===slot.id),cell=node('div','order-cell'+(slot.locked?' fixed':''));cell.tabIndex=-1;if(part)targets.set(part.id,cell);
 cell.append(node('small','slot-number',part?part.number:''));
 if(slot.locked){const value=node('span','slot-value',slot.correctParagraphId);value.setAttribute('aria-label','固定段落'+slot.correctParagraphId);cell.append(value);}
 else{
  const button=node('button','slot-value slot-trigger',answer[part.id]||'—');button.type='button';button.dataset.partId=part.id;button.disabled=submitted||context.mode==='history';button.setAttribute('aria-label','第'+part.number+'题选项');button.setAttribute('aria-expanded',String(activePart===part.id));button.setAttribute('aria-controls','letter-picker');
  listen(button,'click',()=>{activePart=activePart===part.id?null:part.id;build(part.id);});cell.append(button);
  if(activePart===part.id)cell.classList.add('active');if(answer[part.id])cell.classList.add('filled');
 }
 if(submitted&&part)cell.classList.add(answer[part.id]===(slot.correctParagraphId)?'correct':'incorrect');chain.append(cell);
}
if(activePart&&!submitted){
 const panel=node('div','letter-picker');panel.id='letter-picker';panel.setAttribute('role','group');panel.setAttribute('aria-label','候选选项');
 for(const id of data.paragraphIds){
  if(data.slots.some(s=>s.locked&&s.correctParagraphId===id))continue;
  const choice=node('button','letter-choice'+(answer[activePart]===id?' selected':''),id);choice.type='button';choice.setAttribute('aria-label','选择选项'+id);choice.setAttribute('aria-pressed',String(answer[activePart]===id));choice.disabled=Object.entries(answer).some(([key,v])=>key!==activePart&&v===id);
  listen(choice,'click',()=>{const partId=activePart;if(store.busy)return;answer[partId]=id;activePart=null;store.changed();build(partId);});panel.append(choice);
 }
 const clear=node('button','letter-choice clear-choice','×');clear.type='button';clear.setAttribute('aria-label','清空当前选择');listen(clear,'click',()=>{const partId=activePart;if(store.busy)return;delete answer[partId];activePart=null;store.changed();build(partId);});panel.append(clear);
 listen(panel,'keydown',e=>{if(e.key==='Escape'){const partId=activePart;activePart=null;build(partId);}});chain.append(panel);
}
if(focusPart)chain.querySelector('[data-part-id="'+focusPart+'"]')?.focus({preventScroll:true});
$('submit-button').hidden=submitted||!context?.capabilities?.canSubmit;$('submit-button').disabled=store.busy||!context.capabilities?.canSubmit||!data.parts.some(p=>answer[p.id]);$('retry-button').hidden=!submitted||context.mode==='history'||context?.mode==='exam';$('result-panel').hidden=!submitted;if(submitted){$('result-score').textContent=context.result.score+' / '+context.result.maxScore+' 分';const details=$('result-details');details.replaceChildren();const keys=node('div','order-answer-key');for(const part of data.parts){const slot=data.slots.find(s=>s.id===part.slotId);keys.append(node('span','',part.number+'. '+slot.correctParagraphId));}details.append(keys);analysisView?.destroy();const doc=typeof data.explanation==='string'?{type:'doc',content:data.explanation?[{type:'paragraph',content:[{type:'text',text:data.explanation}]}]:[{type:'paragraph'}]}:data.explanation;analysisView=QF.content.render(details.appendChild(node('div','analysis-content')),doc);analysisView.ready.then(resize);}$('notice').textContent=context.mode==='history'?'':submitted?'':'';resize();}
async function load(next){const rebuild=store.enter(next);context=next;data=next.question.data;if(!rebuild)return;answer={...(next.answer?.responses||{})};submitted=next.status==='submitted';activePart=null;$('score-hint').textContent=data.maxScore+' 分';view?.destroy();view=QF.content.render($('passage'),data.stem);await view.ready;if(!disposed)build();}
function submit(){activePart=null;return store.submit();}function retry(){activePart=null;return store.retry();}
$('submit-button').addEventListener('click',submit);$('retry-button').addEventListener('click',retry);
QF.page.register({onLoad:load,onOutlineNavigate(id){const el=targets.get(id);if(!el)return false;el.scrollIntoView({block:'center'});el.focus({preventScroll:true});return true;},onFlush:()=>store.flush(),onDispose(){disposed=true;store.dispose();view?.destroy();analysisView?.destroy();listeners.splice(0).forEach(fn=>fn());targets.clear();$('submit-button').removeEventListener('click',submit);$('retry-button').removeEventListener('click',retry);}}).catch(e=>{$('notice').textContent=e.message;});
})();
