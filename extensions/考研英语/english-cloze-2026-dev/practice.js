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
(function(){"use strict";
const $ = id => document.getElementById(id);
const node = (tag, cls, text) => {const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const targets = new Map();const store=createPersistence(()=>({responses:{...answer}}),message);
let context, data, answer={}, demoSubmitted=false, dispose=false;
const listeners=[];
function listen(target,event,fn){target.addEventListener(event,fn);listeners.push(()=>target.removeEventListener(event,fn));}
const resize=()=>{if(!dispose)QF.ui.resize();};
function message(text){$('notice').textContent=text;resize();}
function paragraphs(target,text){target.replaceChildren();String(text||'').split(/\n\n+/).forEach(t=>target.append(node('p','',t)));}
function partSection(part,stem){const section=node('section','part');section.id='part-'+part.id;section.tabIndex=-1;targets.set(part.id,section);const h=node('h3','part-title');h.append(node('span','part-number',part.number+'.'));if(stem)h.append(node('span','part-question',stem));section.append(h);return section;}
function outline(id){const target=targets.get(id);if(!target)return false;target.scrollIntoView({block:'center',behavior:'auto'});target.focus({preventScroll:true});return true;}
function readOnly(){return context?.mode==='history'||context?.status==='submitted';}
function clearListeners(){closePicker();listeners.splice(0).forEach(fn=>fn());}
let stemView=null,analysisView=null,picker=null,activeGap=null;
function closePicker(focus=false){const gap=activeGap;picker?.remove();picker=null;activeGap=null;if(gap){gap.setAttribute('aria-expanded','false');if(focus)gap.focus({preventScroll:true});}}
function syncGaps(){for(const gap of $('passage').querySelectorAll('.gap')){const part=data.parts.find(p=>p.id===gap.dataset.part);if(!part)continue;const option=part.options.find(o=>o.id===answer[part.id]);gap.textContent=part.number+(option?'. '+option.text:'');gap.setAttribute('aria-label','第'+part.number+'题'+(option?'，已选'+option.text:'，选择答案'));gap.classList.toggle('answered',!!option);gap.classList.toggle('correct',demoSubmitted&&answer[part.id]===part.correctOptionId);gap.classList.toggle('incorrect',demoSubmitted&&answer[part.id]!==part.correctOptionId);}}
function choose(part,option){if(readOnly()||store.busy||!context.capabilities?.canSave)return;answer[part.id]=option.id;for(const radio of targets.get(part.id).querySelectorAll('input[type=radio]'))radio.checked=radio.value===option.id;syncGaps();store.changed(part.id);updateButton();closePicker(true);resize();}
function openPicker(gap){if(readOnly()||store.busy||!context.capabilities?.canSave)return;if(activeGap===gap){closePicker(true);return;}closePicker();const part=data.parts.find(p=>p.id===gap.dataset.part);if(!part)return;activeGap=gap;gap.setAttribute('aria-expanded','true');picker=node('div','gap-picker');picker.id='cloze-gap-picker';picker.setAttribute('role','group');picker.setAttribute('aria-label','第'+part.number+'题选项');for(const [i,option] of part.options.entries()){const button=node('button','gap-choice',String.fromCharCode(65+i)+'. '+option.text);button.type='button';button.setAttribute('aria-pressed',String(answer[part.id]===option.id));button.onclick=()=>choose(part,option);picker.append(button);}document.body.append(picker);const rect=gap.getBoundingClientRect(),box=picker.getBoundingClientRect();picker.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-box.width-8))+'px';picker.style.top=(rect.bottom+box.height+8<=window.innerHeight?rect.bottom+6:Math.max(8,rect.top-box.height-6))+'px';picker.querySelector('button').focus({preventScroll:true});}
function bindGaps(){for(const gap of $('passage').querySelectorAll('.gap')){gap.setAttribute('aria-expanded','false');gap.setAttribute('aria-controls','cloze-gap-picker');listen(gap,'click',()=>openPicker(gap));}listen(document,'pointerdown',e=>{if(picker&&!picker.contains(e.target)&&e.target!==activeGap)closePicker();});listen(document,'keydown',e=>{if(picker&&e.key==='Escape'){e.preventDefault();closePicker(true);}});listen(window,'resize',()=>closePicker());listen(document,'scroll',()=>closePicker());syncGaps();}

async function renderPassage(){stemView?.destroy();stemView=QF.content.render($('passage'),data.stem);await stemView.ready;if(dispose)return;const walker=document.createTreeWalker($('passage'),NodeFilter.SHOW_TEXT);const texts=[];while(walker.nextNode())if(/\[\[\d+\]\]/.test(walker.currentNode.textContent))texts.push(walker.currentNode);for(const textNode of texts){const text=textNode.textContent,frag=document.createDocumentFragment();let start=0;for(const match of text.matchAll(/\[\[(\d+)\]\]/g)){frag.append(document.createTextNode(text.slice(start,match.index)));const part=data.parts.find(x=>x.number===match[1]);const gap=node('button','gap',match[1]);gap.type='button';gap.dataset.part=part?.id||'';gap.setAttribute('aria-label','定位第'+match[1]+'题');frag.append(gap);start=match.index+match[0].length;}frag.append(document.createTextNode(text.slice(start)));textNode.replaceWith(frag);}bindGaps();resize();}
function buildOptions(section,part){const options=node('fieldset','options');options.setAttribute('aria-label','第'+part.number+'题选项');for(const [index,option] of part.options.entries()){const row=node('label','option');const radio=node('input');radio.type='radio';radio.name='answer-'+part.id;radio.value=option.id;radio.checked=answer[part.id]===option.id;radio.disabled=readOnly();radio.setAttribute('aria-label',part.number+'. '+String.fromCharCode(65+index)+'. '+option.text);row.append(radio,node('span','option-letter',String.fromCharCode(65+index)),node('span','option-text',option.text));if(demoSubmitted){const correct=(part.correctOptionId);if(option.id===correct)row.classList.add('correct');else if(radio.checked)row.classList.add('incorrect');}listen(radio,'change',()=>{if(store.busy)return;choose(part,option);});options.append(row);}section.append(options);}
function updateButton(){$('submit-button').disabled=store.busy||!context.capabilities?.canSubmit||!data.parts.some(p=>answer[p.id]);}
function renderParts(){clearListeners();targets.clear();$('parts').replaceChildren();for(const part of data.parts){const section=partSection(part,part.stem);buildOptions(section,part); $('parts').append(section);}

  $('result-panel').hidden=!demoSubmitted;$('submit-button').hidden=demoSubmitted||context.mode==='history'||!context?.capabilities?.canSubmit;$('retry-button').hidden=!demoSubmitted||context.mode==='history'||context?.mode==='exam';if(demoSubmitted){$('result-score').textContent=context.result.score+' / '+context.result.maxScore+' 分';renderResults();}updateButton();resize();}
function renderResults(){analysisView?.destroy();const panel=$('result-details');panel.replaceChildren();const doc=typeof data.explanation==='string'?{type:'doc',content:data.explanation?[{type:'paragraph',content:[{type:'text',text:data.explanation}]}]:[{type:'paragraph'}]}:data.explanation;analysisView=QF.content.render(panel,doc);analysisView.ready.then(resize);}
const submitHandler=()=>store.submit(),retryHandler=()=>store.retry();$('submit-button').addEventListener('click',submitHandler);$('retry-button').addEventListener('click',retryHandler);
QF.page.register({async onLoad(next){const rebuild=store.enter(next);context=next;data=next.question.data;if(!rebuild){updateButton();return;}answer={...(next.answer?.responses||{})};demoSubmitted=next.status==='submitted';$('score-hint').textContent=data.maxScore+' 分';renderParts();await renderPassage();message(next.mode==='history'?'':demoSubmitted?'':'');},onOutlineNavigate:outline,onFlush:()=>store.flush(),onDispose(){dispose=true;store.dispose();stemView?.destroy();analysisView?.destroy();clearListeners();targets.clear();$('submit-button').removeEventListener('click',submitHandler);$('retry-button').removeEventListener('click',retryHandler);}}).catch(e=>message(e.message));

})();
