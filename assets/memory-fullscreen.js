// Fullscreen is requested only from the user's click; no window/session changes.
(function(root){
  'use strict'
  function create({document,stage,enterButton,exitButton,onChange=()=>{},onError=()=>{}}){
    let busy=false,disposed=false,wasActive=false
    function sync(){
      if(disposed)return
      const active=document.fullscreenElement===stage
      enterButton.setAttribute('aria-pressed',String(active))
      exitButton.hidden=!active
      stage.dataset.fullscreen=String(active)
      onChange(active)
      if(active)exitButton.focus({preventScroll:true})
      else if(wasActive)enterButton.focus({preventScroll:true})
      wasActive=active
    }
    async function enter(){
      if(busy||disposed||document.fullscreenElement===stage)return
      busy=true;enterButton.disabled=true
      try{
        if(typeof stage.requestFullscreen!=='function')throw new Error('当前宿主未启用全屏显示')
        await stage.requestFullscreen({navigationUI:'hide'})
        sync()
      }catch(error){if(!disposed)onError(error)}
      finally{busy=false;if(!disposed)enterButton.disabled=false}
    }
    async function exit(){
      if(disposed||document.fullscreenElement!==stage)return
      try{await document.exitFullscreen();sync()}catch(error){if(!disposed)onError(error)}
    }
    async function keydown(event){if(event.key==='Escape'&&document.fullscreenElement===stage)await exit()}
    document.addEventListener('fullscreenchange',sync)
    document.addEventListener('keydown',keydown)
    enterButton.addEventListener('click',enter)
    exitButton.addEventListener('click',exit)
    sync()
    return {enter,exit,destroy(){disposed=true;document.removeEventListener('fullscreenchange',sync);document.removeEventListener('keydown',keydown);enterButton.removeEventListener('click',enter);exitButton.removeEventListener('click',exit)}}
  }
  root.QQBotFullscreen={create}
})(globalThis)
