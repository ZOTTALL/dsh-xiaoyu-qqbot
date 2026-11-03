import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
const code=fs.readFileSync(new URL('../assets/memory-fullscreen.js',import.meta.url),'utf8')
function setup({failure=false}={}){
  const listeners=new Map(),button=()=>({disabled:false,hidden:true,attributes:{},events:{},setAttribute(k,v){this.attributes[k]=v},addEventListener(k,v){this.events[k]=v},removeEventListener(k){delete this.events[k]},focus(){this.focused=true}})
  const document={fullscreenElement:null,addEventListener(k,fn){listeners.set(k,fn)},removeEventListener(k){listeners.delete(k)},async exitFullscreen(){this.fullscreenElement=null;listeners.get('fullscreenchange')?.()}}
  const stage={dataset:{},requests:0,async requestFullscreen(){this.requests++;if(failure)throw new Error('denied');document.fullscreenElement=this;listeners.get('fullscreenchange')?.()}}
  const enterButton=button(),exitButton=button(),errors=[],states=[]
  const c=vm.createContext({});vm.runInContext(code,c)
  const api=c.QQBotFullscreen.create({document,stage,enterButton,exitButton,onChange:x=>states.push(x),onError:e=>errors.push(e.message)})
  return {api,document,stage,enterButton,exitButton,errors,states,listeners}
}
test('fullscreen: explicit click enters only stage, exit returns focus and normal state',async()=>{
  const x=setup();assert.equal(x.stage.requests,0);assert.equal(x.exitButton.hidden,true)
  await x.enterButton.events.click();assert.equal(x.document.fullscreenElement,x.stage);assert.equal(x.exitButton.hidden,false);assert.equal(x.enterButton.attributes['aria-pressed'],'true');assert.equal(x.exitButton.focused,true)
  await x.exitButton.events.click();assert.equal(x.document.fullscreenElement,null);assert.equal(x.enterButton.focused,true);assert.equal(x.stage.dataset.fullscreen,'false')
})
test('fullscreen: external Escape-style exit synchronizes button and layout',async()=>{
  const x=setup();await x.api.enter();await x.document.exitFullscreen();assert.equal(x.exitButton.hidden,true);assert.equal(x.enterButton.attributes['aria-pressed'],'false');assert.equal(x.states.at(-1),false)
})
test('fullscreen: Escape key explicitly exits embedded browsers as well',async()=>{
  const x=setup();await x.api.enter();await x.listeners.get('keydown')({key:'Escape'});assert.equal(x.stage.dataset.fullscreen,'false');assert.equal(x.enterButton.focused,true)
})
test('fullscreen: rejected requests never leave a fake fullscreen state; rapid clicks do not duplicate',async()=>{
  const x=setup({failure:true});await Promise.all([x.api.enter(),x.api.enter()]);assert.equal(x.stage.requests,1);assert.equal(x.errors.length,1);assert.equal(x.stage.dataset.fullscreen,'false');assert.equal(x.enterButton.disabled,false)
})
test('fullscreen: destroy releases listeners and pending entry path',async()=>{
  const x=setup();x.api.destroy();assert.equal(x.listeners.size,0);assert.equal(Object.keys(x.enterButton.events).length,0);await x.api.enter();assert.equal(x.stage.requests,0)
  const html=fs.readFileSync(new URL('../assets/memory.html',import.meta.url),'utf8');assert.match(html,/id="fullscreen"/);assert.match(html,/id="exit-fullscreen" hidden/)
})
