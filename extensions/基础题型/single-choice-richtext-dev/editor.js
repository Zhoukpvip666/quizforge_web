(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const content = QF.content;
  const copy = value => JSON.parse(JSON.stringify(value));
  const empty = () => copy(content.EMPTY_DOCUMENT);
  const views = new Map(), hosts = new Map();
  let draft, baseline = '', active = null, editor = null, switching = Promise.resolve(), disposed = false, editable = false;
  const resize = () => {if (!disposed) QF.ui.resize();};
  function showError(error) {if (disposed) return; $('error').hidden = false; $('error').textContent = error.message || String(error); resize();}
  function getDoc(key) {return key === 'stem' ? draft.stem : key === 'assessment' ? draft.answerAndExplanation : draft.options.find(option => option.id === key)?.content;}
  function setDoc(key, doc) {if (key === 'stem') draft.stem = copy(doc); else if (key === 'assessment') draft.answerAndExplanation = copy(doc); else {const option = draft.options.find(value => value.id === key); if (option) option.content = copy(doc);}}
  function capture() {if (editor && active) setDoc(active, editor.getDocument()); return {...copy(draft), maxScoreText: $('edit-max-score').value};}
  function updateScore() {
    const input = $('edit-max-score');
    const value = Number(input.value);
    const valid = input.value.trim() !== '' && Number.isFinite(value) && value > 0 && value <= 100000;
    input.setCustomValidity(valid ? '' : '满分须大于 0，最多 100000');
    input.setAttribute('aria-invalid', String(!valid));
    input.style.width = `${Math.max(1.5, Math.min(11, input.value.length + .5))}ch`;
  }
  function preview(key) {
    const host = hosts.get(key); if (!host) return;
    views.get(key)?.destroy(); views.delete(key);
    host.classList.remove('is-editing'); host.setAttribute('role', 'button'); host.tabIndex = editable ? 0 : -1;
    if (content.isEmpty(getDoc(key))) {host.replaceChildren(); const hint = document.createElement('div'); hint.className = 'empty-field'; hint.textContent = '点击填写'; host.append(hint);}
    else {const view = content.render(host, getDoc(key)); views.set(key, view); view.ready.then(resize).catch(showError);}
    resize();
  }
  async function closeEditor() {
    if (!editor) return;
    await editor.flush();
    capture();
    const previous = active;
    editor.destroy(); editor = null; active = null;
    preview(previous);
  }
  async function activate(key) {
    if (!editable || disposed || key === active || !hosts.has(key)) return;
    await closeEditor();
    if (disposed || !hosts.has(key)) return;
    const host = hosts.get(key);
    views.get(key)?.destroy(); views.delete(key);
    host.classList.add('is-editing'); host.removeAttribute('role'); host.tabIndex = -1;
    active = key;
    const candidate = content.createEditor(host, {
      doc: getDoc(key) || empty(), placeholder: '',
      resources: {get: id => QF.resources.get(id), put() {const error = new Error('界面原型暂不保存上传图片。'); error.code = 'DEVELOPMENT_NOT_IMPLEMENTED'; return Promise.reject(error);}},
      onChange(doc) {if (!disposed && active === key) {setDoc(key, doc); resize();}}
    });
    editor = candidate;
    await candidate.ready;
    if (disposed || editor !== candidate) {candidate.destroy(); return;}
    candidate.focus(); resize();
  }
  function schedule(operation) {switching = switching.catch(() => {}).then(operation); switching.catch(showError);}
  function updateCorrect() {
    $('option-editors').querySelectorAll('.choice').forEach(row => {
      const correct = row.dataset.id === draft.correctOptionId;
      row.classList.toggle('is-correct', correct);
      row.querySelector('input[type=radio]').checked = correct;
    });
  }
  function buildOptions() {
    for (const [key, view] of views) if (key !== 'stem' && key !== 'assessment') {view.destroy(); views.delete(key);}
    for (const key of hosts.keys()) if (key !== 'stem' && key !== 'assessment') hosts.delete(key);
    $('option-editors').replaceChildren();
    draft.options.forEach((option, index) => {
      const letter = String.fromCharCode(65 + index);
      const row = document.createElement('div'); row.className = 'choice'; row.dataset.id = option.id;
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'correct-option'; radio.value = option.id; radio.disabled = !editable; radio.setAttribute('aria-label', `将选项 ${letter} 设为正确答案`);
      const marker = document.createElement('span'); marker.className = 'choice-letter'; marker.textContent = letter;
      const host = document.createElement('div'); host.className = 'editable-field'; host.dataset.field = option.id; host.setAttribute('aria-label', `编辑选项 ${letter}`);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-option'; remove.textContent = '×'; remove.dataset.remove = option.id; remove.setAttribute('aria-label', `删除选项 ${letter}`); remove.disabled = !editable || draft.options.length <= 2;
      row.append(radio, marker, host, remove); $('option-editors').append(row);
      hosts.set(option.id, host); preview(option.id);
    });
    $('add-option').disabled = !editable || draft.options.length >= 26;
    updateCorrect(); resize();
  }
  function chooseCorrect(event) {if (editable && event.target.matches('input[type=radio]')) {draft.correctOptionId = event.target.value; updateCorrect();}}
  function requestEdit(event) {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    const host = event.target.closest('.editable-field');
    if (!host || host.classList.contains('is-editing')) return;
    if (event.type === 'keydown') event.preventDefault();
    schedule(() => activate(host.dataset.field));
  }
  function addOption() {
    if (!editable || draft.options.length >= 26) return;
    schedule(async () => {
      await closeEditor();
      if (disposed || draft.options.length >= 26) return;
      let number = 1; while (draft.options.some(option => option.id === `choice${number}`)) number++;
      const id = `choice${number}`; draft.options.push({id, content: empty()});
      buildOptions(); await activate(id);
    });
  }
  function removeOption(event) {
    const button = event.target.closest('button[data-remove]');
    if (!editable || !button || draft.options.length <= 2) return;
    const id = button.dataset.remove;
    schedule(async () => {await closeEditor(); if (disposed || draft.options.length <= 2 || !draft.options.some(option => option.id === id)) return; draft.options = draft.options.filter(option => option.id !== id); if (draft.correctOptionId === id) draft.correctOptionId = null; buildOptions();});
  }
  const root = document.querySelector('.authoring');
  root.addEventListener('click', requestEdit); root.addEventListener('keydown', requestEdit);
  $('option-editors').addEventListener('change', chooseCorrect);
  $('option-editors').addEventListener('click', removeOption);
  $('add-option').addEventListener('click', addOption);
  $('edit-max-score').addEventListener('input', updateScore);
  function unavailable(message) {const error = new Error(message); error.code = 'DEVELOPMENT_NOT_IMPLEMENTED'; throw error;}
  QF.editor.register({
    async onLoad(context) {
      await switching;
      editor?.destroy(); editor = null; active = null;
      views.forEach(view => view.destroy()); views.clear(); hosts.clear();
      draft = copy(context.question.data);
      editable = context.capabilities?.canEdit === true;
      $('edit-max-score').value = String(draft.maxScore);
      $('edit-max-score').disabled = !editable;
      updateScore(); baseline = JSON.stringify(capture());
      hosts.set('stem', $('edit-stem')); hosts.set('assessment', $('edit-assessment'));
      $('edit-stem').dataset.field = 'stem'; $('edit-assessment').dataset.field = 'assessment';
      $('error').hidden = true;
      preview('stem'); buildOptions(); preview('assessment');
      await Promise.all([...views.values()].map(view => view.ready)); resize();
    },
    hasChanges() {return Boolean(draft) && JSON.stringify(capture()) !== baseline;},
    async getDocument() {await switching; await editor?.flush(); unavailable('单选题编辑原型尚未接入题目保存。');},
    async exportDraft() {unavailable('单选题编辑原型尚未接入草稿持久化。');},
    async onFlush() {await switching; await editor?.flush();},
    onDispose() {
      disposed = true; editor?.destroy(); editor = null;
      views.forEach(view => view.destroy()); views.clear(); hosts.clear();
      root.removeEventListener('click', requestEdit); root.removeEventListener('keydown', requestEdit);
      $('option-editors').removeEventListener('change', chooseCorrect); $('option-editors').removeEventListener('click', removeOption); $('add-option').removeEventListener('click', addOption);
      $('edit-max-score').removeEventListener('input', updateScore);
    }
  }).catch(showError);
})();
