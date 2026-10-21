import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { answerAreaModel } from '../../../shared/answer-area/1.4.0/model.js';
import { ApiError } from '../platform/errors.js';

const model=answerAreaModel();
const require=createRequire(import.meta.url);
let canvasLibrary;
// Retrying a shared-ink answer must also clear its source strokes. Ordinary
// notes keep their original coordinates and remain available in the draft.
export function draftWithoutAnswerInk(draft,answer){
  if(!draft)return draft;
  const ids=new Set();
  function visit(value){
    if(!value||typeof value!=='object')return;
    if(value.type==='qf-answer-area'){
      if(value.inkSource==='draft')for(const stroke of value.strokes||[])ids.add(stroke.id);
      return;
    }
    for(const child of Object.values(value))visit(child);
  }
  visit(answer);
  return ids.size?{...draft,strokes:draft.strokes.filter(stroke=>!ids.has(stroke.id))}:draft;
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(name,data){
  const type=Buffer.from(name),length=Buffer.alloc(4);length.writeUInt32BE(data.length);
  let crc=0xffffffff;for(const byte of Buffer.concat([type,data]))crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const checksum=Buffer.alloc(4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,type,data,checksum]);
}
// Render the entire logical rectangle, including offscreen ink. No browser image,
// URL or screenshot supplied by an extension is trusted as the submitted answer.
export function renderAnswerArea(value,{budget={remaining:8000000},resources,decodedImages=new Map()}={}) {
  const doc=model.normalize(value,{snapshot:false}),{width,height}=doc;
  if(doc.text?.trim()||doc.inkSource==='draft'||doc.images?.length){
    // Load the native text rasterizer only for mixed answers. Pure text never
    // requires an image; old ink-only answers retain the original renderer.
    try{canvasLibrary??=require('@napi-rs/canvas');}catch(cause){throw new ApiError(503,'ANSWER_AREA_RENDER_UNAVAILABLE','答案图片组件不可用，请修复运行依赖后重试；已保存答案保留。',{cause});}
    const scale=doc.inkSource==='draft'||doc.images?.length?2:1;
    const canvas=canvasLibrary.createCanvas(width*scale,height*scale),context=canvas.getContext('2d');context.scale(scale,scale);
    const layout=model.textLayout(context,doc);
    if(layout.height>height)throw new ApiError(422,'ANSWER_AREA_TEXT_OVERFLOW','文字超出答题区高度，请返回检查答案后重试；原答案仍保留。');
    // Keep the same bounded ink-work validation as the pure rasterizer.
    if(doc.inkSource==='draft'){
      const work=doc.strokes.reduce((count,stroke)=>count+stroke.points.length,0);budget.remaining-=work*16;if(budget.remaining<0)throw new ApiError(413,'ANSWER_AREA_RENDER_LIMIT','答案笔迹绘制超过限制，已保存答案保留。');
      context.beginPath();context.rect(0,0,width,height);context.clip();
    }else renderAnswerArea({...doc,text:'',images:[]},{budget});
    const images=new Map();
    for(const item of doc.images||[]){
      const image=decodedImages.get(item.attrs.assetId);if(!image)throw new ApiError(422,'ANSWER_IMAGE_UNAVAILABLE','答案图片尚未完成解码，原答案仍保留');
      images.set(item.attrs.assetId,image);
    }
    model.paint(context,doc,{images});
    return canvas.toBuffer('image/png');
  }
  const pixels=Buffer.alloc(width*height*3,255);
  const disk=(x,y,radius,color)=>{
    const left=Math.max(0,Math.floor(x-radius)),right=Math.min(width-1,Math.ceil(x+radius));
    const top=Math.max(0,Math.floor(y-radius)),bottom=Math.min(height-1,Math.ceil(y+radius));
    for(let py=top;py<=bottom;py++)for(let px=left;px<=right;px++){
      if(--budget.remaining<0)throw new ApiError(413,'ANSWER_AREA_RENDER_LIMIT','手写答题区笔迹过于密集，请缩减后重试；已保存笔迹保留。');
      const coverage=Math.max(0,Math.min(1,radius+.5-Math.hypot(px+.5-x,py+.5-y)));
      if(coverage){const at=(py*width+px)*3;for(let c=0;c<3;c++)pixels[at+c]=Math.round(pixels[at+c]*(1-coverage)+color[c]*coverage);}
    }
  };
  for(const stroke of doc.strokes){
    const color=[1,3,5].map(index=>Number.parseInt(stroke.color.slice(index,index+2),16));
    const radius=p=>stroke.width*(.35+.65*p.pressure)/2;
    disk(stroke.points[0].x,stroke.points[0].y,radius(stroke.points[0]),color);
    for(let i=1;i<stroke.points.length;i++){
      const from=stroke.points[i-1],to=stroke.points[i],steps=Math.ceil(Math.hypot(to.x-from.x,to.y-from.y)/Math.max(.5,Math.min(radius(from),radius(to))*.5));
      for(let j=1;j<=steps;j++){const t=j/steps;disk(from.x+(to.x-from.x)*t,from.y+(to.y-from.y)*t,radius(from)+(radius(to)-radius(from))*t,color);}
    }
  }
  const rows=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)pixels.copy(rows,y*(width*3+1)+1,y*width*3,(y+1)*width*3);
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows,{level:3})),chunk('IEND',Buffer.alloc(0))]);
}
export function prepareAnswerAreas(answer,resources,{submit=false,targetIds=null,decodedImages=new Map()}={}) {
  let areas=0,points=0,pixels=0,nodes=0,height=0;const ids=new Set(),budget={remaining:8000000};
  function walk(value,depth=0){
    if(depth>64||++nodes>100000)throw new ApiError(413,'ANSWER_AREA_LIMIT','手写答案结构超出限制。');
    if(!value||typeof value!=='object')return value;
    if(!Array.isArray(value)&&value.type==='qf-answer-area'){
      let doc;try{doc=model.normalize(value,{snapshot:false});}catch(error){throw new ApiError(422,'INVALID_ANSWER_AREA',error.message);}
      if(doc.targetId!==undefined&&targetIds!==null&&!targetIds.includes(doc.targetId))throw new ApiError(422,'ANSWER_AREA_TARGET_UNKNOWN','手写答题区目标不属于当前题目的大纲小题。');
      if(++areas>model.limits.areas||ids.has(doc.id)||(points+=doc.strokes.reduce((sum,stroke)=>sum+stroke.points.length,0))>40000||(pixels+=doc.width*doc.height)>8000000||(height+=doc.height)>model.limits.totalHeight)throw new ApiError(413,'ANSWER_AREA_LIMIT','手写答题区数量、总尺寸或笔迹超出限制。');
      ids.add(doc.id);
      for(const item of doc.images||[])resources.read(item.attrs.assetId);
      if(submit&&(doc.strokes.length||doc.images?.length)){
        const resource=resources.store('image/png',renderAnswerArea(doc,{budget,resources,decodedImages}));
        doc.snapshot={type:'image',attrs:{assetId:resource.id}};
      }
      return doc;
    }
    if(Array.isArray(value))return value.map(child=>walk(child,depth+1));
    return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,walk(child,depth+1)]));
  }
  return walk(answer);
}


// Decode resources before entering the synchronous rasterizer. Image.src can
// expose dimensions before the native decoder has finished the pixel buffer.
export async function prepareAnswerAreasWithImages(answer,resources,options={}){
  if(!options.submit)return prepareAnswerAreas(answer,resources,options);
  const normalized=prepareAnswerAreas(answer,resources,{...options,submit:false}),ids=new Set();
  function collect(value){if(!value||typeof value!=='object')return;if(value.type==='qf-answer-area'){for(const item of value.images||[])ids.add(item.attrs.assetId);return;}for(const child of Object.values(value))collect(child);}
  collect(normalized);const decodedImages=new Map();let pixels=0;
  if(ids.size){
    try{canvasLibrary??=require('@napi-rs/canvas');}catch(cause){throw new ApiError(503,'ANSWER_AREA_RENDER_UNAVAILABLE','答案图片组件不可用，原答案仍保留',{cause});}
    for(const id of ids){
      let image;try{image=await canvasLibrary.loadImage(resources.read(id).bytes);}catch(cause){throw new ApiError(422,'ANSWER_IMAGE_INVALID','答案图片无法解码，原答案仍保留',{cause});}
      if(!(image.width>0&&image.height>0)||(pixels+=image.width*image.height)>16000000)throw new ApiError(413,'ANSWER_IMAGE_LIMIT','答案图片总分辨率过大，请缩小图片后重试；原答案仍保留');decodedImages.set(id,image);
    }
  }
  return prepareAnswerAreas(normalized,resources,{...options,decodedImages});
}
