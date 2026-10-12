(function () {
  'use strict';
  const $ = id => document.getElementById(id), content = QF.content;
  const copy = value => JSON.parse(JSON.stringify(value));
  const previewFixtures = /* PREVIEW_FIXTURES */ {"sample-text":{"parts":{"cache":{"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"参考答案","marks":[{"type":"bold"}]}]},{"type":"paragraph","content":[{"type":"text","text":"缓存将经常使用的数据暂存起来，减少重复计算或读取，从而加快响应速度。使用时需要考虑缓存内容与原始数据的一致性，避免读取过期数据。"}]},{"type":"paragraph","content":[{"type":"text","text":"评分参考：说明缓存的基本作用 3 分；指出一个合理的注意事项并作说明 2 分。"}]}]},"demoScore":4,"demoFeedback":"示例分数展示：说明了缓存的作用，但还可补充数据一致性的具体例子。"}}},"sample-image-math":{"parts":{"area":{"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"三角形面积等于底乘高的一半："}]},{"type":"blockMath","attrs":{"latex":"S=\\frac{1}{2}\\times3\\times4=6\\,\\mathrm{cm}^2"}},{"type":"paragraph","content":[{"type":"text","text":"评分参考：公式与过程正确 3 分；结果及单位正确 2 分。"}]}]},"demoScore":5,"demoFeedback":"示例分数展示：计算过程、结果与单位完整。"}}},"sample-material":{"parts":{"average":{"answerAndExplanation":{"type":"doc","content":[{"type":"blockMath","attrs":{"latex":"\\frac{20+30+25}{3}=25\\text{（本）}"}},{"type":"paragraph","content":[{"type":"text","text":"平均每天借出 25 本书。评分参考：计算式正确 2 分；结果正确 2 分。"}]}]},"demoScore":4,"demoFeedback":"示例分数展示：计算式与结果完整。"},"reasoning":{"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"这份记录不足以证明阅读活动一定有效。周二借阅量最多只是现象，借阅数量还可能受课程安排、图书上新等因素影响。可以补充活动前后或有、无活动时的借阅记录，并尽量保持其他条件一致。"}]},{"type":"paragraph","content":[{"type":"text","text":"评分参考：指出证据不足 2 分；说明其他可能因素 2 分；提出合理的补充证据或比较办法 2 分。"}]}]},"demoScore":4,"demoFeedback":"示例分数展示：指出证据不足并解释可能因素，还可补充如何比较。"}}},"short-sample-text":{"parts":{"cache":{"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"参考答案","marks":[{"type":"bold"}]}]},{"type":"paragraph","content":[{"type":"text","text":"缓存将经常使用的数据暂存起来，减少重复计算或读取，从而加快响应速度。使用时需要考虑缓存内容与原始数据的一致性，避免读取过期数据。"}]},{"type":"paragraph","content":[{"type":"text","text":"评分参考：说明缓存的基本作用 3 分；指出一个合理的注意事项并作说明 2 分。"}]}]},"demoScore":4,"demoFeedback":"示例分数展示：说明了缓存的作用，但还可补充数据一致性的具体例子。"}}},"short-sample-image-math":{"parts":{"area":{"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"三角形面积等于底乘高的一半："}]},{"type":"blockMath","attrs":{"latex":"S=\\frac{1}{2}\\times3\\times4=6\\,\\mathrm{cm}^2"}},{"type":"paragraph","content":[{"type":"text","text":"评分参考：公式与过程正确 3 分；结果及单位正确 2 分。"}]}]},"demoScore":5,"demoFeedback":"示例分数展示：计算过程、结果与单位完整。"}}},"short-sample-material":{"parts":{"average":{"answerAndExplanation":{"type":"doc","content":[{"type":"blockMath","attrs":{"latex":"\\frac{20+30+25}{3}=25\\text{（本）}"}},{"type":"paragraph","content":[{"type":"text","text":"平均每天借出 25 本书。评分参考：计算式正确 2 分；结果正确 2 分。"}]}]},"demoScore":4,"demoFeedback":"示例分数展示：计算式与结果完整。"},"reasoning":{"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"这份记录不足以证明阅读活动一定有效。周二借阅量最多只是现象，借阅数量还可能受课程安排、图书上新等因素影响。可以补充活动前后或有、无活动时的借阅记录，并尽量保持其他条件一致。"}]},{"type":"paragraph","content":[{"type":"text","text":"评分参考：指出证据不足 2 分；说明其他可能因素 2 分；提出合理的补充证据或比较办法 2 分。"}]}]},"demoScore":4,"demoFeedback":"示例分数展示：指出证据不足并解释可能因素，还可补充如何比较。"}}}};
  const views = new Map(), targets = new Map(), answers = new Map(), results = new Map(), timers = new Map();
  let context, active = null, editor = null, submitted = false, disposed = false, epoch = 0, switching = Promise.resolve();
  let reportQueue=Promise.resolve();const reported=new Map();
  function reportProgress(id){
    if(disposed||locked())return;
    const status=content.isEmpty(answers.get(id))?'unanswered':'draft';
    if(reported.get(id)===status)return;reported.set(id,status);
    const targetId=context.question.data.parts.length>1?id:undefined,token=epoch;
    reportQueue=reportQueue.catch(()=>{}).then(async()=>{if(disposed||token!==epoch)return;const reply=await QF.page.reportAnswerState({status,...(targetId?{targetId}:{})});if(!reply?.ok){reported.delete(id);throw new Error(reply?.error?.message||'作答进度上报失败');}});reportQueue.catch(showError);
  }
  const resize = () => {if (!disposed) QF.ui.resize();};
  function showError(error) {if (disposed) return; $('error').hidden = false; $('error').textContent = error.message || String(error); resize();}
  function renderDoc(key, host, doc) {
    views.get(key)?.destroy();
    const view = content.render(host, doc); views.set(key,view); const token = epoch;
    view.ready.then(() => {if (token === epoch) resize();}).catch(error => {if (token === epoch) showError(error);});
    return view;
  }
  function clearTimers() {timers.forEach(clearTimeout); timers.clear();}
  function locked() {return submitted || context.mode === 'history' || context.capabilities.canSave !== true;}
  function updateSubmit() {$('submit').disabled = ![...answers.values()].some(doc => !content.isEmpty(doc));}
  function previewAnswer(id) {
    const host = targets.get(id)?.answer; if (!host) return;
    views.get('answer-' + id)?.destroy(); views.delete('answer-' + id);
    host.classList.remove('is-editing'); host.classList.toggle('readonly',locked());
    host.tabIndex = locked() ? -1 : 0;
    host.setAttribute('role',locked() ? 'region' : 'button');
    const doc = answers.get(id);
    if (!doc || content.isEmpty(doc)) {host.replaceChildren(); const hint = document.createElement('span'); hint.className='answer-placeholder'; hint.textContent=locked()?'未作答':'点击作答'; host.append(hint);}
    else renderDoc('answer-' + id, host, doc);
    resize();
  }
  async function closeEditor() {
    if (!editor) return;
    await editor.flush();
    answers.set(active,editor.getDocument());
    const previous=active; editor.destroy(); editor=null; active=null;
    previewAnswer(previous); updateSubmit();
  }
  async function activate(id) {
    if (disposed || locked() || active===id || !targets.has(id)) return;
    await closeEditor(); if (disposed || locked()) return;
    const host=targets.get(id).answer;
    views.get('answer-' + id)?.destroy(); views.delete('answer-' + id);
    host.classList.add('is-editing'); host.removeAttribute('role'); host.tabIndex=-1;
    active=id;
    const candidate=content.createEditor(host,{doc:answers.get(id)||copy(content.EMPTY_DOCUMENT),placeholder:'',
      resources:{get:assetId=>QF.resources.get(assetId),put(){return Promise.reject(Object.assign(new Error('界面原型暂不保存上传图片。'),{code:'DEVELOPMENT_NOT_IMPLEMENTED'}));}},
      onChange(doc){if(!disposed&&active===id){answers.set(id,copy(doc));updateSubmit();reportProgress(id);resize();}}});
    editor=candidate; await candidate.ready;
    if(disposed||editor!==candidate){candidate.destroy();return;} candidate.focus();resize();
  }
  function schedule(operation){switching=switching.catch(()=>{}).then(operation);switching.catch(showError);}
  function requestEdit(event){
    if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;
    const host=event.target.closest('.answer-field');
    if(!host||host.classList.contains('is-editing')||locked())return;
    if(event.type==='keydown')event.preventDefault();
    schedule(()=>activate(host.dataset.id));
  }
  function updateGrade(id){
    const target=targets.get(id),part=context.question.data.parts.find(value=>value.id===id),result=results.get(id);
    if(!target||!part)return;
    target.value.textContent=result?.pending?'评分中（演示）':Number.isFinite(result?.score)?`${result.score} / ${part.maxScore} 分${result.demo?' · 演示':''}`:'待评分';
    target.slider.value=String(result?.score??0);
    target.feedback.hidden=!result?.feedback;target.feedback.textContent=result?.feedback||'';
    target.ai.disabled=Boolean(result?.pending);
    resize();
  }
  function aiPreview(id){
    if(!submitted||context.status==='submitted'||context.mode==='history'||content.isEmpty(answers.get(id)))return;
    const fixture=previewFixtures[context.question.id]?.parts[id];if(!fixture)return;
    clearTimeout(timers.get(id));
    results.set(id,{...results.get(id),pending:true,demo:true});updateGrade(id);
    const token=epoch;
    timers.set(id,setTimeout(()=>{
      timers.delete(id);if(disposed||token!==epoch||!submitted)return;
      results.set(id,{score:fixture.demoScore,feedback:'AI 评价演示：'+fixture.demoFeedback,pending:false,demo:true});updateGrade(id);
    },700));
  }
  function gradeManually(event){
    if(!event.target.matches('input[type=range]')||context.status==='submitted'||context.mode==='history')return;
    const id=event.target.dataset.id;clearTimeout(timers.get(id));timers.delete(id);
    const previous=results.get(id);results.set(id,{score:Number(event.target.value),feedback:previous?.feedback||'',pending:false,demo:true});updateGrade(id);
  }
  function showResult(part,fixture,demo){
    const target=targets.get(part.id);target.result.hidden=false;
    if(fixture?.answerAndExplanation)renderDoc('assessment-'+part.id,target.assessment,fixture.answerAndExplanation);
    target.slider.max=String(part.maxScore);
    target.slider.disabled=!demo;
    target.ai.hidden=!demo||content.isEmpty(answers.get(part.id));
    updateGrade(part.id);
  }
  async function submitPreview(){
    if(submitted||context.capabilities.canSubmit!==true)return;
    await switching;await closeEditor();await reportQueue;if(disposed||submitted)return;
    if(![...answers.values()].some(doc=>!content.isEmpty(doc)))return;
    const fixture=previewFixtures[context.question.id];if(!fixture){showError(new Error('此题没有演示数据，真实提交尚未实现。'));return;}
    submitted=true;$('submit').hidden=true;$('retry').hidden=false;
    for(const part of context.question.data.parts){previewAnswer(part.id);showResult(part,fixture.parts[part.id],true);}
    // Demonstrates automatic per-part grading only; no AI request or persistent result.
    for(const part of context.question.data.parts)aiPreview(part.id);
    resize();
  }
  function retryPreview(){
    if(context.status==='submitted'||context.mode==='history')return;
    clearTimers();epoch++;submitted=false;answers.clear();results.clear();for(const part of context.question.data.parts)reportProgress(part.id);
    for(const part of context.question.data.parts){views.get('assessment-'+part.id)?.destroy();views.delete('assessment-'+part.id);const target=targets.get(part.id);target.assessment.replaceChildren();target.result.hidden=true;previewAnswer(part.id);}
    $('submit').hidden=context.capabilities.canSubmit!==true;$('retry').hidden=true;updateSubmit();resize();
  }
  function clickActions(event){const button=event.target.closest('button[data-ai]');if(button)aiPreview(button.dataset.ai);}
  $('parts').addEventListener('click',requestEdit);$('parts').addEventListener('keydown',requestEdit);
  $('parts').addEventListener('input',gradeManually);$('parts').addEventListener('click',clickActions);
  const submitHandler=()=>submitPreview().catch(showError);
  $('submit').addEventListener('click',submitHandler);$('retry').addEventListener('click',retryPreview);
  QF.page.register({
    async onLoad(next){
      await switching;await closeEditor();await reportQueue;epoch++;clearTimers();reported.clear();
      views.forEach(view=>view.destroy());views.clear();targets.clear();answers.clear();results.clear();
      context=next;submitted=next.status==='submitted';$('error').hidden=true;
      const data=next.question.data,multiple=data.parts.length>1;
      $('total-score').textContent=`${data.parts.reduce((sum,part)=>sum+part.maxScore,0)} 分`;
      $('material').hidden=!data.material||content.isEmpty(data.material);
      if(!$('material').hidden)renderDoc('material',$('material'),data.material);else $('material').replaceChildren();
      $('parts').replaceChildren();
      data.parts.forEach((part,index)=>{
        const section=document.createElement('section');section.className='part';section.dataset.id=part.id;
        if(multiple){const heading=document.createElement('div');heading.className='part-header';const number=document.createElement('span');number.className='part-number';number.textContent=`（${index+1}）`;const score=document.createElement('span');score.className='question-score';score.textContent=`${part.maxScore} 分`;heading.append(number,score);section.append(heading);}
        const stem=document.createElement('div');stem.className='stem';
        const answer=document.createElement('div');answer.className='answer-field';answer.dataset.id=part.id;answer.setAttribute('aria-label',multiple?`第${index+1}问作答`:'作答');
        const result=document.createElement('section');result.className='result';result.hidden=true;
        const caption=document.createElement('div');caption.className='section-label';caption.textContent='答案与解析';
        const assessment=document.createElement('div');
        const grading=document.createElement('div');grading.className='grading';
        const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max=String(part.maxScore);slider.step='.5';slider.value='0';slider.className='grade-slider';slider.dataset.id=part.id;slider.setAttribute('aria-label',multiple?`第${index+1}问人工评分`:'人工评分');
        const value=document.createElement('span');value.className='grade-value';value.setAttribute('aria-live','polite');
        const ai=document.createElement('button');ai.type='button';ai.className='ai-button';ai.dataset.ai=part.id;ai.textContent='AI 评分';ai.setAttribute('aria-label',multiple?`第${index+1}问 AI 评分演示`:'AI 评分演示');
        const feedback=document.createElement('p');feedback.className='ai-feedback';feedback.hidden=true;
        grading.append(slider,value,ai);result.append(caption,assessment,grading,feedback);section.append(stem,answer,result);$('parts').append(section);
        targets.set(part.id,{section,answer,result,assessment,slider,value,ai,feedback});
        renderDoc('stem-'+part.id,stem,part.stem);
        const saved=next.answer?.responses?.[part.id];if(saved)answers.set(part.id,copy(saved));
        previewAnswer(part.id);
        if(submitted){results.set(part.id,next.result?.parts?.[part.id]||{});showResult(part,part,false);}
      });
      $('submit').hidden=submitted||next.capabilities.canSubmit!==true;$('retry').hidden=true;updateSubmit();
      await Promise.all([...views.values()].map(view=>view.ready));resize();
    },
    async onFlush(){await switching;await editor?.flush();await reportQueue;},
    async onOutlineNavigate(id){const target=targets.get(id);if(!target)return false;await switching;await Promise.all([...views.values()].map(view=>view.ready));target.section.scrollIntoView({block:'center',behavior:'auto'});target.answer.focus({preventScroll:true});return true;},
    onDispose(){disposed=true;epoch++;clearTimers();editor?.destroy();editor=null;views.forEach(view=>view.destroy());views.clear();targets.clear();
      $('parts').removeEventListener('click',requestEdit);$('parts').removeEventListener('keydown',requestEdit);$('parts').removeEventListener('input',gradeManually);$('parts').removeEventListener('click',clickActions);$('submit').removeEventListener('click',submitHandler);$('retry').removeEventListener('click',retryPreview);}
  }).catch(showError);
})();
