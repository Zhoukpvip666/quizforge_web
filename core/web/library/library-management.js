export function bindLibraryManagement({request,getContext,beforeChange,onChanged}){
  const $=selector=>document.querySelector(selector),dialog=$('#library-manage-dialog'),form=$('#library-manage-form');
  let operation=null,busy=false;
  const close=()=>{if(!busy)dialog.close();};
  $('#library-manage-close').addEventListener('click',close);$('#library-manage-cancel').addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  const error=message=>{$('#library-manage-error').textContent=message;$('#library-manage-error').hidden=!message;};
  function open(target,row,action='update'){
    const {kind,catalog}=getContext();if(!catalog.canManage)return;
    operation={kind,target,action,path:row?.path||''};
    const type=target==='group'?'分组':kind==='bank'?'题库':'拓展',removing=action==='delete',creatingGroup=target==='group'&&action==='create';
    $('#library-manage-title').textContent=`${removing?'删除':action==='create'?'新建':'编辑'}${type}`;
    $('#library-manage-name').value=target==='group'?(row?.name||''):(row?.title||row?.name||'');
    $('#library-manage-fields').hidden=removing;$('#library-manage-confirm').textContent=removing?'移入回收目录':'保存';
    $('#library-manage-confirm').classList.toggle('danger-button',removing);
    const hint=removing?(kind==='extension'&&target==='group'?'删除此逻辑分组，拓展文件、作答与历史保留。':`${row?.title||row?.name||row?.path}：${target==='group'?'此分组及其全部内容（包括未显示的文件）':'此'+type}将移入 .trash/library 回收目录，作答与历史数据保留。`):target==='group'?'分组只支持一层，可修改名称；改名不会重置作答与历史。':kind==='extension'?'只修改列表显示名称和逻辑分组，拓展实际目录保持原样。':'移动或改名不会重置作答与历史。';
    $('#library-manage-hint').textContent=hint;
    const select=$('#library-manage-group');select.closest('label').hidden=target==='group';$('#library-manage-cancel').hidden=creatingGroup;select.replaceChildren(new Option('未分组（根目录）',''));
    for(const path of catalog.groups?.[kind==='bank'?'banks':'extensions']||[]){
      if(target==='group'||path.includes('/')||path.includes('\\'))continue;
      select.append(new Option(path,path));
    }
    select.value=target==='group'?'':row?.group||'';error('');dialog.showModal();
    (removing?$('#library-manage-cancel'):$('#library-manage-name')).focus();
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!operation)return;const value={...operation};
    if(value.action!=='delete'){value.name=$('#library-manage-name').value.trim();value.group=value.target==='group'?'':$('#library-manage-group').value;if(!value.name){error('请输入名称');return;}}
    busy=true;error('');for(const button of form.querySelectorAll('button,input,select'))button.disabled=true;
    try{await beforeChange(value);const result=await request('/api/library/manage',{method:'POST',body:JSON.stringify(value),timeoutMs:60000});await onChanged(result,value);dialog.close();}
    catch(failure){error(failure.message);}
    finally{busy=false;for(const button of form.querySelectorAll('button,input,select'))button.disabled=false;}
  });
  return {open};
}
