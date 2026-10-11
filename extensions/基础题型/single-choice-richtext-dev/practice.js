(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const content = QF.content;
  // UI-only fixtures for these examples. Remove before real functionality is implemented.
  const previewFixtures = /* PREVIEW_FIXTURES */ {"sample-text":{"correctOptionId":"choice-6","answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"6 是偶数。","marks":[{"type":"bold"}]}]},{"type":"paragraph","content":[{"type":"text","text":"偶数能被 2 整除。6 ÷ 2 = 3，其余三个数除以 2 都有余数。"}]}]}},"sample-image-math":{"correctOptionId":"length-5","answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"斜边长为 "},{"type":"inlineMath","attrs":{"latex":"5\\,\\mathrm{cm}"}},{"type":"text","text":"。"}]},{"type":"paragraph","content":[{"type":"text","text":"根据勾股定理："}]},{"type":"blockMath","attrs":{"latex":"c=\\sqrt{3^2+4^2}=\\sqrt{25}=5"}}]}},"sample-table-options":{"correctOptionId":"table-2","answerAndExplanation":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"第二张表正确。分别代入三个值："}]},{"type":"blockMath","attrs":{"latex":"(-1)^2=1,\\quad 0^2=0,\\quad 1^2=1"}},{"type":"paragraph","content":[{"type":"text","text":"因此对应的 y 值依次为 1、0、1。"}]}]}}};
  let context, selectedId = null, demoSubmitted = false, disposed = false, epoch = 0;
  const views = new Map();
  const resize = () => {if (!disposed) QF.ui.resize();};
  function showError(error) {if (disposed) return; $('error').textContent = error.message || String(error); $('error').hidden = false; resize();}
  function destroyViews() {views.forEach(view => view.destroy()); views.clear();}
  function renderDoc(key, host, doc) {
    const view = content.render(host, doc);
    views.set(key, view);
    const token = epoch;
    view.ready.then(() => {if (token === epoch) resize();}).catch(error => {if (token === epoch) showError(error);});
  }
  function locked() {return context.mode === 'history' || context.status === 'submitted' || demoSubmitted || !context.capabilities.canSave;}
  function answerData() {return context.status === 'submitted' ? context.question.data : demoSubmitted ? previewFixtures[context.question.id] : null;}
  function updateChoices() {
    const correctId = answerData()?.correctOptionId;
    for (const row of $('options').querySelectorAll('.choice')) {
      const id = row.dataset.id;
      row.classList.toggle('is-selected', id === selectedId && !correctId);
      row.classList.toggle('is-correct', Boolean(correctId) && id === correctId);
      row.classList.toggle('is-incorrect', Boolean(correctId) && id === selectedId && id !== correctId);
      const radio = row.querySelector('input');
      radio.checked = id === selectedId;
      radio.disabled = locked();
      radio.setAttribute('aria-label', `选项 ${row.dataset.letter}${id === correctId ? '，正确答案' : correctId && id === selectedId ? '，回答错误' : ''}`);
    }
    $('submit').hidden = context.capabilities.canSubmit !== true || locked();
    $('submit').disabled = !selectedId;
    $('retry').hidden = !demoSubmitted;
  }
  function choose(event) {
    if (!event.target.matches('input[type=radio]') || locked()) return;
    selectedId = event.target.value;
    updateChoices();
  }
  function submitPreview() {
    if (!selectedId || locked() || context.capabilities.canSubmit !== true) return;
    const fixture = previewFixtures[context.question.id];
    if (!fixture) {showError(new Error('此题没有界面演示数据，真实提交尚未实现。')); return;}
    demoSubmitted = true;
    updateChoices();
    $('result').hidden = false;
    renderDoc('assessment', $('answer-and-explanation'), fixture.answerAndExplanation);
    resize();
  }
  function retryPreview() {
    if (!demoSubmitted) return;
    demoSubmitted = false;
    selectedId = null;
    views.get('assessment')?.destroy();
    views.delete('assessment');
    $('answer-and-explanation').replaceChildren();
    $('result').hidden = true;
    updateChoices();
    resize();
  }
  $('options').addEventListener('change', choose);
  $('submit').addEventListener('click', submitPreview);
  $('retry').addEventListener('click', retryPreview);
  QF.page.register({
    async onLoad(next) {
      epoch++;
      destroyViews();
      context = next;
      demoSubmitted = false;
      selectedId = next.answer?.selectedOptionId ?? null;
      if (!next.question.data.options.some(option => option.id === selectedId)) selectedId = null;
      $('error').hidden = true;
      $('max-score').textContent = `${next.question.data.maxScore} 分`;
      renderDoc('stem', $('stem'), next.question.data.stem);
      $('options').replaceChildren();
      next.question.data.options.forEach((option, index) => {
        const row = document.createElement('label'); row.className = 'choice'; row.dataset.id = option.id;
        const letter = String.fromCharCode(65 + index); row.dataset.letter = letter;
        const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'selected-option'; radio.value = option.id;
        const marker = document.createElement('span'); marker.className = 'choice-letter'; marker.textContent = letter;
        const host = document.createElement('div'); host.className = 'choice-content';
        row.append(radio, marker, host); $('options').append(row);
        renderDoc(option.id, host, option.content);
      });
      const submitted = next.status === 'submitted';
      $('result').hidden = !submitted;
      if (submitted && next.question.data.answerAndExplanation) renderDoc('assessment', $('answer-and-explanation'), next.question.data.answerAndExplanation);
      else $('answer-and-explanation').replaceChildren();
      updateChoices();
      await Promise.all([...views.values()].map(view => view.ready));
      resize();
    },
    onDispose() {
      disposed = true; epoch++;
      destroyViews();
      $('options').removeEventListener('change', choose);
      $('submit').removeEventListener('click', submitPreview);
      $('retry').removeEventListener('click', retryPreview);
    }
  }).catch(showError);
})();
