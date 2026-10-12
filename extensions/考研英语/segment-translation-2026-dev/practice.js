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
const $=id=>document.getElementById(id),node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;},targets=new Map(),listeners=[];
let context,data,answer={},scores={},stemView=null,assessmentView=null,disposed=false,reviewVersion=0,savedReview=0,reviewTimer=null,reviewFlight=null,reviewChain=Promise.resolve();
const aiTasks=new Map(),aiTimers=new Map(),aiBusy=new Set(),dirtyScores=new Map();let epoch=0;
const resize=()=>{if(!disposed)QF.ui.resize();},message=text=>{$('notice').textContent=text;resize();},listen=(el,e,fn)=>{el.addEventListener(e,fn);listeners.push(()=>el.removeEventListener(e,fn));};
const store=createPersistence(()=>({responses:{...answer}}),message),locked=()=>context?.status==='submitted'||context?.mode==='history',canReview=()=>context?.mode!=='history'&&context?.status==='submitted'&&context.capabilities?.canReview;
let translationDialog=null,dialogInput=null,dialogPart=null,dialogTrigger=null;
function closeTranslation(focus=false){const trigger=dialogTrigger;translationDialog?.remove();translationDialog=null;dialogInput=null;dialogPart=null;dialogTrigger=null;if(focus&&trigger?.isConnected)trigger.focus({preventScroll:true});}
function setTranslation(part,value){if(locked()||store.busy||!context.capabilities?.canSave)return;answer[part.id]=value;const input=targets.get(part.id)?.querySelector('textarea');if(input&&input.value!==value)input.value=value;if(dialogPart===part.id&&dialogInput&&dialogInput.value!==value)dialogInput.value=value;store.changed(part.id);$('submit-button').disabled=!context.capabilities?.canSubmit||!Object.values(answer).some(v=>v.trim());}
function positionTranslation(){
 if(!translationDialog||!dialogTrigger?.isConnected)return;
 const rect=dialogTrigger.getBoundingClientRect(),gap=8,margin=8;
 const width=document.documentElement.clientWidth||window.innerWidth;
 const height=translationDialog.getBoundingClientRect().height;
 const pageHeight=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight,window.innerHeight);
 const below=rect.bottom+window.scrollY+gap,above=rect.top+window.scrollY-gap-height;
 const top=below+height<=pageHeight-margin||above<margin?below:above;
 translationDialog.style.left=Math.max(margin,Math.min(rect.left+window.scrollX,width-translationDialog.getBoundingClientRect().width-margin))+'px';
 translationDialog.style.top=top+'px';
}
function openTranslation(part,trigger){
 if(locked()||store.busy||!context.capabilities?.canSave)return;
 closeTranslation();dialogPart=part.id;dialogTrigger=trigger;
 translationDialog=node('section','translation-dialog');
 translationDialog.setAttribute('role','dialog');
 translationDialog.setAttribute('aria-label','译文编辑');
 dialogInput=node('textarea','answer-area');dialogInput.value=answer[part.id]||'';dialogInput.rows=4;
 dialogInput.setAttribute('aria-label','第'+part.number+'题译文编辑');
 dialogInput.oninput=()=>setTranslation(part,dialogInput.value);
 translationDialog.append(dialogInput);
 translationDialog.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();closeTranslation(true);flush().catch(e=>message(e.message));}};
 document.body.append(translationDialog);positionTranslation();dialogInput.focus({preventScroll:true});
}
function bindTranslationSegments(){listen(window,'resize',positionTranslation);listen(document,'pointerdown',e=>{if(translationDialog&&!translationDialog.contains(e.target)&&!dialogTrigger?.contains(e.target)){closeTranslation();flush().catch(e=>message(e.message));}});for(const line of $('passage').querySelectorAll('u')){const fragment=line.textContent.trim();const part=data.parts.find(p=>fragment&&(p.segment===fragment||p.segment.includes(fragment)));if(!part)continue;line.classList.add('translation-trigger');line.tabIndex=0;line.setAttribute('role','button');line.setAttribute('aria-label','编辑第'+part.number+'题译文');line.setAttribute('aria-disabled',String(locked()||!context.capabilities?.canSave));listen(line,'click',()=>openTranslation(part,line));listen(line,'keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openTranslation(part,line);}});}}
function outline(id){const el=targets.get(id);if(!el)return false;el.scrollIntoView({block:'center'});el.focus({preventScroll:true});return true;}
function resultScore(){$('result-score').textContent=context.result?.gradingStatus==='pending'?'待评分 / '+data.maxScore+' 分':(context.result?.score??0)+' / '+data.maxScore+' 分 · '+Object.keys(context.result?.partScores||context.result?.feedback?.scores||{}).length+'/'+data.parts.length+' 句已评分';}
function saveReview(){clearTimeout(reviewTimer);reviewTimer=null;if(reviewFlight)return reviewFlight;if(!dirtyScores.size)return reviewChain;if(!canReview())return Promise.reject(new Error('当前评分不能保存。'));const next=(async()=>{while(!disposed&&dirtyScores.size){const [id,value]=dirtyScores.entries().next().value;const reply=await QF.save({purpose:'review',data:{review:{targetId:id,score:value}}});if(!reply?.ok)throw new Error(reply?.error?.message||'评分保存失败。');if(dirtyScores.get(id)===value)dirtyScores.delete(id);scores[id]=value;$('review-retry').hidden=true;message('');}savedReview=reviewVersion;refreshResults();})();reviewFlight=next;reviewChain=next;next.catch(e=>{if(!disposed){$('review-retry').hidden=!canReview();message(e.message+' 当前分数仍保留，请点击重试保存。');}}).finally(()=>{if(reviewFlight===next)reviewFlight=null;});return next;}
function refreshResults(){resultScore();for(const part of data.parts){const section=targets.get(part.id);if(!section)continue;const output=section.querySelector('output'),slider=section.querySelector('input[type=range]');if(output)output.textContent=scores[part.id]===undefined?'未评分':scores[part.id]+' / '+data.pointsPerItem+' 分';if(slider){slider.value=scores[part.id]??0;slider.disabled=!canReview()||aiBusy.has(part.id);}const button=section.querySelector('.ai-part button'),note=section.querySelector('.ai-part .notice'),feedback=section.querySelector('.ai-feedback'),task=aiTasks.get(part.id);if(button){button.disabled=context.mode==='history'||!context.capabilities?.canAiGrade||!answer[part.id]?.trim()||aiBusy.has(part.id)||['queued','running'].includes(task?.status);button.textContent=task?.checkFailed?'检查评分进度':task?.status==='failed'?'重试AI评分':scores[part.id]!==undefined?'重新AI评分':'AI评分';}if(note)note.textContent=task?.error?.message||({queued:'等待评分…',running:'正在评分…',confirmed:'评分已保存',superseded:'评分已失效，请重新评分'}[task?.status]||'');if(feedback)feedback.textContent=context.result?.partFeedback?.[part.id]||context.result?.aiAssessments?.[part.id]?.feedback||'';}resize();}
async function aiAction(id,action='current'){if(disposed||context.mode==='history'||!context.capabilities?.canAiGrade)return;const generation=epoch;aiBusy.add(id);refreshResults();try{if(action!=='current'&&action!=='poll')await flush();if(disposed||generation!==epoch)return;const task=aiTasks.get(id);const reply=action==='current'?await QF.ai.getTask({targetId:id}):action==='poll'?await QF.ai.getTask({taskId:task.taskId}):action==='retry'?await QF.ai.retry({taskId:task.taskId}):await QF.ai.grade({targetId:id,force:!!task||scores[id]!==undefined});if(disposed||generation!==epoch)return;if(!reply?.ok)throw new Error(reply?.error?.message||'AI评分操作失败。');const value=action==='current'?reply.data.task:reply.data;if(value&&value.targetId!==id)throw new Error('AI评分目标不匹配。');if(value)aiTasks.set(id,value);else aiTasks.delete(id);clearTimeout(aiTimers.get(id));aiTimers.delete(id);if(['queued','running','succeeded'].includes(value?.status))aiTimers.set(id,setTimeout(()=>{aiTimers.delete(id);aiAction(id,'poll');},1500));}catch(e){if(!disposed&&generation===epoch){aiTasks.set(id,{...aiTasks.get(id),status:'failed',checkFailed:action==='poll',error:{message:e.message}});}}finally{if(!disposed&&generation===epoch){aiBusy.delete(id);refreshResults();}}}
async function flush(){clearTimeout(reviewTimer);await store.flush();await saveReview();await reviewChain;}
function build(){closeTranslation();listeners.splice(0).forEach(fn=>fn());targets.clear();$('parts').replaceChildren();for(const part of data.parts){const section=node('section','part');section.tabIndex=-1;targets.set(part.id,section);section.append(node('h3','part-title',part.number+'.'),node('p','seg-heading',part.segment));const input=node('textarea','answer-area');input.rows=4;input.value=answer[part.id]||'';input.placeholder='填写中文译文';input.setAttribute('aria-label','第'+part.number+'题译文');input.disabled=locked();listen(input,'input',()=>{if(store.busy)return;setTranslation(part,input.value);});section.append(input);
if(context.status==='submitted'){const panel=node('div','part-result'),row=node('div','score-row'),slider=node('input'),output=node('output');slider.type='range';slider.min=0;slider.max=data.pointsPerItem;slider.step=.5;slider.value=scores[part.id]??0;slider.setAttribute('aria-label','第'+part.number+'题评分');slider.disabled=!canReview();output.dataset.part=part.id;output.textContent=scores[part.id]===undefined?'未评分':scores[part.id]+' / '+data.pointsPerItem+' 分';listen(slider,'input',()=>{scores[part.id]=Number(slider.value);dirtyScores.set(part.id,scores[part.id]);reviewVersion++;output.textContent=slider.value+' 分 · 待保存';clearTimeout(reviewTimer);reviewTimer=setTimeout(()=>saveReview().catch(()=>{}),180);});row.append(node('label','','人工评分'),slider,output);panel.append(row);const ai=node('div','ai-part'),button=node('button','secondary','AI评分');button.type='button';button.disabled=!context.capabilities?.canAiGrade||context.mode==='history';button.setAttribute('aria-label','第'+part.number+'题AI评分');listen(button,'click',()=>aiAction(part.id,aiTasks.get(part.id)?.checkFailed?'poll':aiTasks.get(part.id)?.status==='failed'&&aiTasks.get(part.id)?.taskId?'retry':'grade'));ai.append(button,node('p','notice',''),node('p','ai-feedback',''));panel.append(ai);section.append(panel);}$('parts').append(section);}
$('result-panel').hidden=context.status!=='submitted';$('submit-button').hidden=locked()||!context?.capabilities?.canSubmit;$('submit-button').disabled=!context.capabilities?.canSubmit||!Object.values(answer).some(v=>v.trim());$('retry-button').hidden=context.status!=='submitted'||context.mode==='history'||context?.mode==='exam';$('retry-button').disabled=!context.capabilities?.canRetry;$('review-retry').hidden=true;bindTranslationSegments();refreshResults();resize();}
async function load(next){const old=context,rebuild=store.enter(next);context=next;data=next.question.data;if(!rebuild)return;const same=old?.question.id===next.question.id;if(same&&old.mode===next.mode&&old.status==='submitted'&&next.status==='submitted'){scores={...(next.result?.partScores||next.result?.feedback?.scores||{}),...Object.fromEntries(dirtyScores)};refreshResults();return;}answer={...(next.answer?.responses||{})};epoch++;for(const timer of aiTimers.values())clearTimeout(timer);aiTimers.clear();aiTasks.clear();aiBusy.clear();dirtyScores.clear();scores={...(next.result?.partScores||next.result?.feedback?.scores||{})};reviewVersion=savedReview=0;reviewChain=Promise.resolve();stemView?.destroy();assessmentView?.destroy();stemView=QF.content.render($('passage'),data.stem);await stemView.ready;if(disposed)return;build();if(next.status==='submitted'){assessmentView=QF.content.render($('assessment'),data.assessment);await assessmentView.ready;}if(next.status==='submitted'&&next.mode!=='history'&&next.capabilities?.canAiGrade)for(const part of data.parts)aiAction(part.id);message(next.mode==='history'?'':next.status==='submitted'?'':'');resize();}
const submit=()=>store.submit(),retry=async()=>{await flush();return store.retry();},retryReview=()=>saveReview().catch(()=>{});$('submit-button').addEventListener('click',submit);$('retry-button').addEventListener('click',retry);$('review-retry').addEventListener('click',retryReview);
QF.page.register({onLoad:load,onOutlineNavigate:outline,onFlush:flush,onDispose(){closeTranslation();disposed=true;epoch++;for(const timer of aiTimers.values())clearTimeout(timer);aiTimers.clear();aiTasks.clear();store.dispose();clearTimeout(reviewTimer);stemView?.destroy();assessmentView?.destroy();listeners.splice(0).forEach(fn=>fn());targets.clear();$('submit-button').removeEventListener('click',submit);$('retry-button').removeEventListener('click',retry);$('review-retry').removeEventListener('click',retryReview);}}).catch(e=>message(e.message));
})();
