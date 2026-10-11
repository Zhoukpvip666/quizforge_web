/** Delivers metadata only; opening collections and preserving editor state belong to the app. */
export function createLibraryIndexClient({request,onIndex,onError=()=>{},isVisible=()=>true,setTimer=setTimeout,clearTimer=clearTimeout}){
  let generation=0,timer=null,lastIndex=null,stopped=false;
  const cancel=()=>{if(timer!==null)clearTimer(timer);timer=null;};
  const pending=()=>[...(lastIndex?.banks||[]),...(lastIndex?.extensions||[])].some(row=>['pending','checking'].includes(row.validationStatus));
  const schedule=()=>{cancel();if(!stopped&&isVisible()&&pending())timer=setTimer(async()=>{timer=null;const current=generation;try{await load(current);}catch{}},2000);};
  async function load(current){
    try{
      const value=await request('/api/library/index');
      if(stopped||current!==generation)return;
      lastIndex=value;onIndex(value);schedule();return value;
    }catch(error){
      if(stopped||current!==generation)return;
      cancel();onError(error);if(error.status!==401)schedule();
      throw error;
    }
  }
  return {
    refresh(){if(stopped)return Promise.resolve();cancel();return load(++generation);},
    visibilityChanged(){schedule();},
    stop(){stopped=true;generation++;cancel();},
  };
}
