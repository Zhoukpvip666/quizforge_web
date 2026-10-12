import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {sanitizeCaptureHtml,captureDraftRegion,copyCaptureImage} from '../../web/draft/whiteboard-capture.js';

test('copy exports the original PNG and explains browser or permission failures',async()=>{
 const blob=new Blob(['png'],{type:'image/png'}),writes=[],win={isSecureContext:true,ClipboardItem:class {constructor(data){this.data=data;}},navigator:{clipboard:{write:async items=>writes.push(items)}}};
 await copyCaptureImage(blob,win);assert.equal(writes[0][0].data['image/png'],blob);
 await assert.rejects(copyCaptureImage(blob,{isSecureContext:false}),/HTTPS/);
 await assert.rejects(copyCaptureImage(blob,{isSecureContext:true}),/不支持/);
 win.navigator.clipboard.write=async()=>{throw new Error('denied');};await assert.rejects(copyCaptureImage(blob,win),/剪贴板/);
});
test('capture display copies strip active content, event handlers and network CSS while preserving text styles',()=>{
 const dom=new JSDOM(),html=sanitizeCaptureHtml(dom.window.document,'<div style="color:rgb(10,20,30);background-image:url(https://example.test/track)"><script>alert(1)</script><iframe src="https://example.test"></iframe><img src="data:image/png;base64,AA==" onerror="x()"><a href="javascript:x()">link</a><input type="password" value="secret"><span>题干</span></div>');
 assert.doesNotMatch(html,/script|iframe|onerror|example.test|javascript:|secret/);assert.match(html,/rgb\(10, 20, 30\)/);assert.match(html,/题干/);
 assert.throws(()=>sanitizeCaptureHtml(dom.window.document,'<img src="https://example.test/track">'),/图片/);dom.window.close();
});
test('region composition crops ink at device pixels and excludes toolbar or page chrome',async()=>{
 const calls=[],context={scale(...v){calls.push(['scale',...v]);},fillRect(...v){calls.push(['paper',...v]);},drawImage(...v){calls.push(['ink',...v]);}};
 const output={getContext:()=>context,toBlob:callback=>callback({png:true})},doc={createElement:()=>output,defaultView:{}},viewport={ownerDocument:doc};
 const ink={},result=await captureDraftRegion({rect:{x:10,y:20,width:100,height:60},ink,draft:{paper:{color:'#fff8e7',pattern:'plain'}},camera:{x:0,y:0,zoom:1},scroll:{x:0,y:0},pixelRatio:3},{viewport});
 assert.deepEqual(result,{png:true});assert.equal(output.width,200);assert.equal(output.height,120);assert.deepEqual(calls.at(-1),['ink',ink,30,60,300,180,0,0,100,60]);
});
