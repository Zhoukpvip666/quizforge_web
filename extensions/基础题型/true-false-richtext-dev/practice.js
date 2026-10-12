(function(){
  'use strict';
  const KIND=/* KIND */ 'true-false',fixtures=/* FIXTURES */ {"sample-true":{"formatVersion":1,"stem":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"一个整数若能被 2 整除，这个整数就是偶数。"}]}]},"correctAnswer":true,"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"正确。能被 2 整除是偶数的定义。"}]}]},"maxScore":2},"true-false-sample-true":{"formatVersion":1,"stem":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"一个整数若能被 2 整除，这个整数就是偶数。"}]}]},"correctAnswer":true,"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"正确。能被 2 整除是偶数的定义。"}]}]},"maxScore":2},"sample-false":{"formatVersion":1,"stem":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"对于所有实数 "},{"type":"inlineMath","attrs":{"latex":"x"}},{"type":"text","text":"，都有 "},{"type":"inlineMath","attrs":{"latex":"x^2=x"}},{"type":"text","text":"。"}]}]},"correctAnswer":false,"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"错误。取 "},{"type":"inlineMath","attrs":{"latex":"x=2"}},{"type":"text","text":"，则 "},{"type":"inlineMath","attrs":{"latex":"x^2=4\\ne2"}},{"type":"text","text":"。一个反例即可否定“对于所有实数”的陈述。"}]}]},"maxScore":2},"true-false-sample-false":{"formatVersion":1,"stem":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"对于所有实数 "},{"type":"inlineMath","attrs":{"latex":"x"}},{"type":"text","text":"，都有 "},{"type":"inlineMath","attrs":{"latex":"x^2=x"}},{"type":"text","text":"。"}]}]},"correctAnswer":false,"answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"错误。取 "},{"type":"inlineMath","attrs":{"latex":"x=2"}},{"type":"text","text":"，则 "},{"type":"inlineMath","attrs":{"latex":"x^2=4\\ne2"}},{"type":"text","text":"。一个反例即可否定“对于所有实数”的陈述。"}]}]},"maxScore":2}};
  const $=id=>document.getElementById(id),content=QF.content,views=new Map(),selected=new Set(),reported=new Map();
  let context,submitted=false,disposed=false,epoch=0,reportQueue=Promise.resolve();
  const options=data=>KIND==='true-false'?[{id:'true',content:word('正确')},{id:'false',content:word('错误')}]:data.options;
  const word=text=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
  const resize=()=>{if(!disposed)QF.ui.resize();};
  const locked=()=>submitted||context.mode==='history'||context.status==='submitted'||context.capabilities.canSave!==true;
  function showError(error){if(disposed)return;$('error').hidden=false;$('error').textContent=error.message||String(error);resize();}
  function render(key,host,doc){views.get(key)?.destroy();const view=content.render(host,doc);views.set(key,view);const token=epoch;view.ready.then(()=>{if(!disposed&&token===epoch)resize();}).catch(showError);}
  function reference(){return context.status==='submitted'?context.question.data:submitted?fixtures[context.question.id]:null;}
  function correctIds(data){if(!data)return[];return KIND==='multiple'?data.correctOptionIds:KIND==='true-false'?[String(data.correctAnswer)]:[data.correctOptionId];}
  function reportProgress(){
    if(disposed||locked())return;const status=selected.size?'draft':'unanswered';if(reported.get('parent')===status)return;reported.set('parent',status);const token=epoch;
    reportQueue=reportQueue.catch(()=>{}).then(async()=>{if(disposed||token!==epoch)return;const reply=await QF.page.reportAnswerState({status});if(!reply?.ok){reported.delete('parent');throw new Error(reply?.error?.message||'作答进度上报失败');}});reportQueue.catch(showError);
  }
  function update(){
    const correct=new Set(correctIds(reference()));
    for(const row of $('options').querySelectorAll('.choice')){const id=row.dataset.id,input=row.querySelector('input');input.checked=selected.has(id);input.disabled=locked();row.classList.toggle('is-selected',!correct.size&&selected.has(id));row.classList.toggle('is-correct',correct.has(id));row.classList.toggle('is-incorrect',correct.size>0&&selected.has(id)&&!correct.has(id));input.setAttribute('aria-label',KIND==='true-false'?(id==='true'?'正确':'错误'):`选项 ${row.dataset.letter}`);}
    $('submit').hidden=submitted||context.status==='submitted'||context.capabilities.canSubmit!==true;$('submit').disabled=selected.size===0;$('retry').hidden=!submitted||context.capabilities.canSubmit!==true;resize();
  }
  function choose(event){if(!event.target.matches('input')||locked())return;const id=event.target.value;if(KIND!=='multiple')selected.clear();if(event.target.checked)selected.add(id);else selected.delete(id);update();reportProgress();}
  async function submit(){if(locked()||!selected.size||context.capabilities.canSubmit!==true)return;await reportQueue;if(disposed)return;const fixture=fixtures[context.question.id];if(!fixture){showError(new Error('真实提交尚未实现，此题没有演示数据。'));return;}
    submitted=true;const expected=new Set(correctIds(fixture)),correct=expected.size===selected.size&&[...selected].every(id=>expected.has(id));$('result').hidden=false;$('demo-score').textContent=`${correct?context.question.data.maxScore:0} / ${context.question.data.maxScore} 分 · 演示`;
    render('assessment',$('answer-and-explanation'),fixture.answerAndExplanation);update();
  }
  function retry(){if(!submitted||context.capabilities.canSubmit!==true||context.mode==='history')return;submitted=false;selected.clear();views.get('assessment')?.destroy();views.delete('assessment');$('answer-and-explanation').replaceChildren();$('result').hidden=true;update();reportProgress();}
  const submitHandler=()=>submit().catch(showError);$('options').addEventListener('change',choose);$('submit').addEventListener('click',submitHandler);$('retry').addEventListener('click',retry);
  QF.page.register({
    async onLoad(next){await reportQueue;epoch++;views.forEach(view=>view.destroy());views.clear();reported.clear();context=next;submitted=false;selected.clear();
      const saved=KIND==='multiple'?next.answer?.selectedOptionIds:KIND==='true-false'?typeof next.answer?.value==='boolean'?[String(next.answer.value)]:[]:next.answer?.selectedOptionId?[next.answer.selectedOptionId]:[];
      const available=options(next.question.data);for(const id of saved||[])if(available.some(option=>option.id===id))selected.add(id);
      $('error').hidden=true;$('max-score').textContent=`${next.question.data.maxScore} 分`;render('stem',$('stem'),next.question.data.stem);$('options').replaceChildren();
      available.forEach((option,index)=>{const row=document.createElement('label');row.className='choice';row.dataset.id=option.id;row.dataset.letter=String.fromCharCode(65+index);const input=document.createElement('input');input.type=KIND==='multiple'?'checkbox':'radio';input.name='answer';input.value=option.id;const host=document.createElement('div');host.className='choice-content';row.append(input);if(KIND!=='true-false'){const letter=document.createElement('span');letter.className='choice-letter';letter.textContent=row.dataset.letter;row.append(letter);}row.append(host);$('options').append(row);render(option.id,host,option.content);});
      $('result').hidden=next.status!=='submitted';if(next.status==='submitted'&&next.question.data.answerAndExplanation){render('assessment',$('answer-and-explanation'),next.question.data.answerAndExplanation);$('demo-score').textContent=Number.isFinite(next.result?.score)?`${next.result.score} / ${next.question.data.maxScore} 分`:'';}else $('answer-and-explanation').replaceChildren();
      update();await Promise.all([...views.values()].map(view=>view.ready));resize();
    },
    async onFlush(){await reportQueue;},
    onDispose(){disposed=true;epoch++;views.forEach(view=>view.destroy());views.clear();$('options').removeEventListener('change',choose);$('submit').removeEventListener('click',submitHandler);$('retry').removeEventListener('click',retry);}
  }).catch(showError);
})();
