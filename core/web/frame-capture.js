// Read-only display snapshot from the opaque extension frame. Rendering stays in the host.
export function installFrameCapture({ session }) {
  window.addEventListener('message', event => {
    const value=event.data;
    if(event.source!==parent||value?.channel!=='quizforge-host'||value.session!==session||value.kind!=='capture-region'||typeof value.id!=='string')return;
    const send=data=>parent.postMessage({channel:'quizforge-extension',session,kind:'captured-region',id:value.id,...data},'*');
    try {
      const clone=document.createElement('div');clone.innerHTML=document.body.innerHTML;
      const originals=[document.body,...document.body.querySelectorAll('*')],copies=[clone,...clone.querySelectorAll('*')];
      for(let index=0;index<originals.length;index++) {
        const source=originals[index],target=copies[index];
        if(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','LINK','META'].includes(source.tagName)){target.remove();continue;}
        const style=getComputedStyle(source);target.style.cssText=Array.from(style).map(key=>`${key}:${style.getPropertyValue(key)};`).join('');
        for(const attribute of [...target.attributes])if(/^on/i.test(attribute.name))target.removeAttribute(attribute.name);
        if(source instanceof HTMLInputElement){target.setAttribute('value',source.type==='password'?'':source.value);if(source.checked)target.setAttribute('checked','');else target.removeAttribute('checked');}
        if(source instanceof HTMLTextAreaElement)target.textContent=source.value;
        if(source instanceof HTMLOptionElement){if(source.selected)target.setAttribute('selected','');else target.removeAttribute('selected');}
        if(source instanceof HTMLCanvasElement||source instanceof HTMLImageElement&&source.currentSrc.startsWith('blob:')){
          const canvas=source instanceof HTMLCanvasElement?source:Object.assign(document.createElement('canvas'),{width:source.naturalWidth,height:source.naturalHeight});
          if(source!==canvas)canvas.getContext('2d').drawImage(source,0,0);
          const image=document.createElement('img');image.src=canvas.toDataURL('image/png');image.style.cssText=target.style.cssText;target.replaceWith(image);
        }
      }
      const html=clone.outerHTML;
      if(html.length>8000000)throw new Error('题目页面过大，请简化内容后重试');
      send({ok:true,html,width:document.documentElement.clientWidth,height:document.body.scrollHeight});
    }catch(error){send({ok:false,error:error.message||'题目内容读取失败'});}
  });
}
