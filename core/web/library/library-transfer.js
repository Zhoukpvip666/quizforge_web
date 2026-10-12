const MAX_UPLOAD=64*1024*1024;

export function downloadPackage(blob,name){
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function bindLibraryTransfer({request,getContext,beforeChange,onImported,onMessage,download=downloadPackage}){
  const $=selector=>document.querySelector(selector),picker=$('#library-import-file'),dialog=$('#library-import-dialog'),form=$('#library-import-form');
  let file=null,busy=false;
  const error=message=>{$('#library-import-error').textContent=message;$('#library-import-error').hidden=!message;};
  const close=()=>{if(!busy){dialog.close();file=null;picker.value='';}};
  for(const id of ['library-import-close','library-import-cancel'])$(`#${id}`).addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else{file=null;picker.value='';}});
  $('#library-import').addEventListener('click',()=>{if(getContext().catalog.canManage&&!busy){picker.value='';picker.click();}});
  picker.addEventListener('change',()=>{
    if(!getContext().catalog.canManage||busy)return;
    file=picker.files?.[0]||null;if(!file)return;
    $('#library-import-name').textContent=file.name;
    error(file.size>MAX_UPLOAD?'题库包超过 64 MiB，请缩小题库分组':!file.name.toLowerCase().endsWith('.qbank')?'请选择 QuizForge .qbank 文件':'');
    $('#library-import-confirm').disabled=file.size>MAX_UPLOAD||!file.name.toLowerCase().endsWith('.qbank');dialog.showModal();
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!file||!getContext().catalog.canManage||file.size>MAX_UPLOAD||!file.name.toLowerCase().endsWith('.qbank'))return;
    busy=true;error('');for(const button of form.querySelectorAll('button'))button.disabled=true;$('#library-import-confirm').textContent='正在导入…';
    try{
      await beforeChange();
      const result=await request('/api/library/import',{method:'POST',body:file,headers:{'Content-Type':'application/vnd.quizforge.qbank'},timeoutMs:135000});
      await onImported(result);dialog.close();file=null;picker.value='';
    }catch(failure){error(failure.message);}
    finally{busy=false;for(const button of form.querySelectorAll('button'))button.disabled=false;$('#library-import-confirm').textContent='导入';}
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
