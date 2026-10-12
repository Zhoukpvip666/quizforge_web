// Public API 1.3 adapter. Reports run immediately, independently of disk saves.
function createAnswerStateQueue({read,hasAnswer,writable,notice,onSaved=()=>{}}){
  let epoch=0,version=0,saved=0,latest=null,flight=null,timer=null,disposed=false;
  const targets=new Map();
  const check=reply=>{
    if(!reply?.ok)throw Object.assign(new Error(reply?.error?.message||'答案保存失败。'),{code:reply?.error?.code});
    return reply.data;
  };
  function report(snapshot,targetId){
    const value={status:hasAnswer(snapshot,targetId)?'draft':'unanswered'};
    if(targetId!==undefined)value.targetId=targetId;
    // Capture errors as values; debounce must never leave an unhandled rejection.
    try{return Promise.resolve(QF.page.reportAnswerState(value)).then(reply=>{
      const stateId=check(reply)?.stateId;
      if(typeof stateId!=='string'||!/^\d{1,16}$/.test(stateId))throw new Error('作答状态上报未返回有效编号。');
      return {stateId};
    },error=>({error})).catch(error=>({error}));}
    catch(error){return Promise.resolve({error});}
  }
  function changed(targetId){
    if(disposed||!writable())return;
    const item={version:++version,snapshot:structuredClone(read()),targetId,failed:false};
    item.report=report(item.snapshot,targetId); // Never wait for flight here.
    latest=item;targets.set(targetId,item);notice('');
    clearTimeout(timer);timer=setTimeout(()=>save().catch(()=>{}),180);
  }
  function refresh(){
    const snapshot=structuredClone(read()),item={version:version,snapshot,failed:false};
    // Only targets actually changed locally; no bulk initialization.
    for(const [id,previous] of targets){
      if(previous.version<=saved)continue;
      item.targetId=id;item.report=report(snapshot,id);targets.set(id,{...item});
    }
    latest=item;
  }
  function save(){
    clearTimeout(timer);timer=null;
    if(flight)return flight;
    if(disposed||version<=saved)return Promise.resolve();
    if(!writable())return Promise.reject(new Error('当前答案不能保存。'));
    const generation=epoch;
    const task=(async()=>{
      while(!disposed&&epoch===generation&&version>saved){
        if(latest.failed)refresh();
        const item=latest;
        try{
          const reports=await Promise.all([...targets.values()].filter(t=>t.version>saved&&t.version<=item.version).map(t=>t.report));
          if(disposed||epoch!==generation)return;
          if(item!==latest)continue;
          const failed=reports.find(r=>r.error);if(failed)throw failed.error;
          const reported=await item.report;if(reported.error)throw reported.error;
          const reply=await QF.save({purpose:'draft',data:{answer:item.snapshot},answerStateId:reported.stateId});
          if(disposed||epoch!==generation)return;
          if(!reply?.ok&&reply?.error?.code==='INVALID_ANSWER_STATE'){
            // An expired old ID must never be paired with a newer answer.
            // Re-report the current snapshot, and retry once through a fresh pair.
            if(item.refreshed)throw Object.assign(new Error(reply.error.message),{code:reply.error.code});
            refresh();latest.refreshed=true;continue;
          }
          check(reply);saved=Math.max(saved,item.version);onSaved(saved);
          for(const [id,t] of targets)if(t.version<=saved)targets.delete(id);
          if(item===latest)notice('');
        }catch(error){
          if(epoch===generation&&!disposed){latest.failed=true;notice(error.message+' 当前输入仍保留，请重试。',true);}
          throw error;
        }
      }
    })();
    flight=task;
    task.then(()=>{if(flight===task)flight=null;},()=>{if(flight===task)flight=null;});
    return task;
  }
  return {changed,save,async flush(){clearTimeout(timer);timer=null;await save();if(version>saved)await save();},
    reset(){epoch++;version=0;saved=0;latest=null;flight=null;targets.clear();clearTimeout(timer);timer=null;},
    dispose(){disposed=true;epoch++;clearTimeout(timer);timer=null;targets.clear();}};
}

// Local adapter over the public QF API. It owns no storage or grading.
function createPersistence(read,notice){
 let context=null,disposed=false,busy=false;
 const caps=()=>context?.capabilities||{},locked=()=>context?.status==='submitted'||context?.mode==='history';
 const ok=reply=>{if(!reply?.ok)throw new Error(reply?.error?.message||'操作失败。');return reply;};
 function controls(){const submit=document.getElementById('submit-button'),retry=document.getElementById('retry-button');submit.hidden=locked()||!caps().canSubmit;submit.disabled=busy||!caps().canSubmit||!Object.values(read().responses).some(v=>v.trim());retry.hidden=context?.status!=='submitted'||context?.mode==='history'||context?.mode==='exam';retry.disabled=busy||!caps().canRetry;}
 const drafts=createAnswerStateQueue({read,hasAnswer:(snapshot,id)=>!!snapshot.responses[id]?.trim(),writable:()=>!disposed&&!locked()&&caps().canSave===true,notice});
 function save(){return drafts.save();}
 return {get busy(){return busy;},get context(){return context;},enter(next){const same=context?.question.id===next.question.id,previous=context?.status;context=next;const preserve=same&&!locked()&&previous!=='submitted';if(!same||previous==='submitted'&&!locked()){drafts.reset();}controls();return !preserve;},changed(targetId){if(locked()||busy)return;drafts.changed(targetId);},async flush(){await drafts.flush();},async submit(){if(busy||locked()||!caps().canSubmit)return;busy=true;controls();try{await this.flush();ok(await QF.save({purpose:'submit',data:{answer:structuredClone(read())}}));notice('');}catch(e){notice(e.message+' 当前答案仍保留。');}finally{busy=false;controls();}},async retry(){if(busy||!caps().canRetry)return;busy=true;controls();try{await this.flush();ok(await QF.requestAction({action:'retry'}));}catch(e){notice(e.message);}finally{busy=false;controls();}},dispose(){disposed=true;drafts.dispose();}};
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
  listen(choice,'click',()=>{const partId=activePart;if(store.busy)return;answer[partId]=id;activePart=null;store.changed(partId);build(partId);});panel.append(choice);
 }
 const clear=node('button','letter-choice clear-choice','×');clear.type='button';clear.setAttribute('aria-label','清空当前选择');listen(clear,'click',()=>{const partId=activePart;if(store.busy)return;delete answer[partId];activePart=null;store.changed(partId);build(partId);});panel.append(clear);
 listen(panel,'keydown',e=>{if(e.key==='Escape'){const partId=activePart;activePart=null;build(partId);}});chain.append(panel);
}
if(focusPart)chain.querySelector('[data-part-id="'+focusPart+'"]')?.focus({preventScroll:true});
$('submit-button').hidden=submitted||!context?.capabilities?.canSubmit;$('submit-button').disabled=store.busy||!context.capabilities?.canSubmit||!data.parts.some(p=>answer[p.id]);$('retry-button').hidden=!submitted||context.mode==='history'||context?.mode==='exam';$('result-panel').hidden=!submitted;if(submitted){$('result-score').textContent=context.result.score+' / '+context.result.maxScore+' 分';const details=$('result-details');details.replaceChildren();const keys=node('div','order-answer-key');for(const part of data.parts){const slot=data.slots.find(s=>s.id===part.slotId);keys.append(node('span','',part.number+'. '+slot.correctParagraphId));}details.append(keys);analysisView?.destroy();const doc=typeof data.explanation==='string'?{type:'doc',content:data.explanation?[{type:'paragraph',content:[{type:'text',text:data.explanation}]}]:[{type:'paragraph'}]}:data.explanation;analysisView=QF.content.render(details.appendChild(node('div','analysis-content')),doc);analysisView.ready.then(resize);}$('notice').textContent=context.mode==='history'?'':submitted?'':'';resize();}
async function load(next){const rebuild=store.enter(next);context=next;data=next.question.data;if(!rebuild)return;answer={...(next.answer?.responses||{})};submitted=next.status==='submitted';activePart=null;$('score-hint').textContent=data.maxScore+' 分';view?.destroy();view=QF.content.render($('passage'),data.stem);await view.ready;if(!disposed)build();}
function submit(){activePart=null;return store.submit();}function retry(){activePart=null;return store.retry();}
$('submit-button').addEventListener('click',submit);$('retry-button').addEventListener('click',retry);
QF.page.register({onLoad:load,onOutlineNavigate(id){const el=targets.get(id);if(!el)return false;el.scrollIntoView({block:'center'});el.focus({preventScroll:true});return true;},onFlush:()=>store.flush(),onDispose(){disposed=true;store.dispose();view?.destroy();analysisView?.destroy();listeners.splice(0).forEach(fn=>fn());targets.clear();$('submit-button').removeEventListener('click',submit);$('retry-button').removeEventListener('click',retry);}}).catch(e=>{$('notice').textContent=e.message;});
})();
