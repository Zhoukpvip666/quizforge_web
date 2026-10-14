const MAX_UPLOAD=64*1024*1024;

export function downloadPackage(blob,name){
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function bindLibraryTransfer({request,getContext,beforeChange,onImported,onMessage,download=downloadPackage}){
  const $=selector=>document.querySelector(selector),picker=$('#library-import-file'),dialog=$('#library-import-dialog'),form=$('#library-import-form');
  let file=null,busy=false,prepared=null;
  const choicesBox=document.createElement('div');choicesBox.id='library-import-choices';choicesBox.hidden=true;$('#library-import-error').before(choicesBox);
  function clearPrepared(){prepared=null;choicesBox.replaceChildren();choicesBox.hidden=true;}
  function showChoices(result){
    prepared=result;choicesBox.replaceChildren();choicesBox.hidden=false;
    const intro=document.createElement('p');intro.className='library-manage-hint';intro.textContent='以下题库版本不高于本地版本，请选择保留哪一份。';choicesBox.append(intro);
    for(const row of result.conflicts){
      const label=document.createElement('label'),caption=document.createElement('span'),select=document.createElement('select');select.dataset.bankId=row.id;
      caption.textContent=`${row.title} · 本地 ${row.existingVersion??'未标注'} / 导入 ${row.incomingVersion??'未标注'}`;
      for(const [value,text] of [['keep','保留现有题库'],['replace','使用导入题库']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
      label.append(caption,select);choicesBox.append(label);
    }
  }
  const error=message=>{$('#library-import-error').textContent=message;$('#library-import-error').hidden=!message;};
  const close=()=>{if(!busy){if(prepared)request('/api/library/import/cancel',{method:'POST',body:JSON.stringify({importId:prepared.importId})}).catch(()=>{});clearPrepared();dialog.close();file=null;picker.value='';}};
  for(const id of ['library-import-close','library-import-cancel'])$(`#${id}`).addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else close();});
  $('#library-import').addEventListener('click',()=>{if(getContext().catalog.canManage&&!busy){picker.value='';picker.click();}});
  picker.addEventListener('change',()=>{
    if(!getContext().catalog.canManage||busy)return;
    file=picker.files?.[0]||null;if(!file)return;
    if(prepared)request('/api/library/import/cancel',{method:'POST',body:JSON.stringify({importId:prepared.importId})}).catch(()=>{});
    clearPrepared();
    $('#library-import-name').textContent=file.name;
    error(file.size>MAX_UPLOAD?'题库包超过 64 MiB，请缩小题库分组':!file.name.toLowerCase().endsWith('.qbank')?'请选择 QuizForge .qbank 文件':'');
    $('#library-import-confirm').disabled=file.size>MAX_UPLOAD||!file.name.toLowerCase().endsWith('.qbank');dialog.showModal();
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!file||!getContext().catalog.canManage||file.size>MAX_UPLOAD||!file.name.toLowerCase().endsWith('.qbank'))return;
    const committing=!!prepared;
    busy=true;error('');for(const control of form.querySelectorAll('button,select'))control.disabled=true;$('#library-import-confirm').textContent='正在导入…';
    try{
      await beforeChange();
      const result=prepared?await request('/api/library/import/commit',{method:'POST',body:JSON.stringify({importId:prepared.importId,choices:Object.fromEntries([...choicesBox.querySelectorAll('select')].map(select=>[select.dataset.bankId,select.value]))}),timeoutMs:135000}):await request('/api/library/import',{method:'POST',body:file,headers:{'Content-Type':'application/vnd.quizforge.qbank'},timeoutMs:135000});
      if(result.needsConfirmation){showChoices(result);return;}
      await onImported(result);clearPrepared();dialog.close();file=null;picker.value='';
    }catch(failure){if(committing)clearPrepared();error(failure.message);}
    finally{busy=false;for(const control of form.querySelectorAll('button,select'))control.disabled=false;$('#library-import-confirm').textContent=prepared?'确认选择并导入':'导入';}
  });
  async function exportGroup(row){
    if(busy||getContext().kind!=='bank'||!getContext().catalog.canManage)return;
    busy=true;
    try{
      await beforeChange();onMessage('正在打包题库分组…');
      const blob=await request('/api/library/export',{method:'POST',body:JSON.stringify({group:row.path}),responseType:'blob',timeoutMs:135000});
      await download(blob,`${row.name||row.path}.qbank`);onMessage('题库分组已导出。');
    }catch(failure){onMessage(failure.message);}
    finally{busy=false;}
  }
  return {exportGroup};
}
