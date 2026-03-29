(function(){
// Don't init twice
if(document.getElementById('vera-fab'))return;

// Load veteran-context.js if not already loaded
if(typeof buildVeteranContext==='undefined'){var s=document.createElement('script');s.src='js/veteran-context.js';document.head.appendChild(s);}

// Inject CSS
var style=document.createElement('style');
style.textContent=`
#vera-fab{position:fixed;right:20px;bottom:24px;z-index:1000;background:#0E8A63;color:#fff;border:none;border-radius:28px;padding:10px 20px 10px 16px;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:800;letter-spacing:.3px;display:flex;align-items:center;gap:7px;box-shadow:0 4px 16px rgba(14,138,99,0.35);transition:transform .15s,box-shadow .15s,opacity .3s;animation:veraPulse 1.5s ease 2}
#vera-fab:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(14,138,99,0.4)}
#vera-fab.hidden{opacity:0;pointer-events:none;transform:translateY(10px)}
#vera-fab .vera-icon{font-size:18px;line-height:1}
@keyframes veraPulse{0%,100%{box-shadow:0 4px 16px rgba(14,138,99,0.35)}50%{box-shadow:0 4px 24px rgba(14,138,99,0.55)}}
@media(max-width:600px){#vera-fab{padding:12px;border-radius:50%;width:52px;height:52px;justify-content:center}#vera-fab .vera-text{display:none}}

#vera-panel{position:fixed;right:20px;bottom:24px;z-index:1001;width:380px;height:520px;background:#F5F2EC;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.15),0 2px 8px rgba(0,0,0,0.08);display:flex;flex-direction:column;overflow:hidden;transform:translateY(110%);opacity:0;transition:transform .3s cubic-bezier(.4,0,.2,1),opacity .25s ease;pointer-events:none}
#vera-panel.open{transform:translateY(0);opacity:1;pointer-events:auto}
@media(max-width:600px){#vera-panel{right:0;bottom:0;width:100%;height:100%;border-radius:0}}

.vp-header{background:#0E8A63;padding:14px 16px 10px;flex-shrink:0}
.vp-header-top{display:flex;align-items:center;justify-content:space-between}
.vp-title{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:800;color:#fff;letter-spacing:.3px}
.vp-close{background:none;border:none;color:rgba(255,255,255,0.7);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;transition:color .15s}
.vp-close:hover{color:#fff}
.vp-sub{font-family:'DM Mono',monospace;font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:.05em;text-transform:uppercase;margin-top:2px}

.vp-messages{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.vp-msg{max-width:88%;animation:vpMsgIn .2s ease both}
.vp-msg.user{align-self:flex-end}
.vp-msg.assistant{align-self:flex-start}
.vp-msg-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:#B8B5AE;margin-bottom:3px}
.vp-msg.user .vp-msg-label{text-align:right;color:#0E8A63}
.vp-msg-bubble{padding:10px 14px;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:13px;line-height:1.6;word-wrap:break-word}
.vp-msg.user .vp-msg-bubble{background:#0E8A63;color:#fff;border-bottom-right-radius:3px}
.vp-msg.assistant .vp-msg-bubble{background:#fff;border:1px solid rgba(0,0,0,0.09);color:#4A4845;border-bottom-left-radius:3px;box-shadow:0 1px 2px rgba(0,0,0,0.04)}
.vp-msg.assistant .vp-msg-bubble p{margin:0 0 6px}
.vp-msg.assistant .vp-msg-bubble p:last-child{margin:0}
.vp-msg.assistant .vp-msg-bubble strong{color:#18191A;font-weight:500}
@keyframes vpMsgIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

.vp-typing{align-self:flex-start;display:none}
.vp-typing .vp-msg-bubble{display:flex;gap:4px;padding:12px 16px}
.vp-typing-dot{width:6px;height:6px;border-radius:50%;background:#B8B5AE;animation:vpDotPulse 1.2s ease-in-out infinite}
.vp-typing-dot:nth-child(2){animation-delay:.2s}
.vp-typing-dot:nth-child(3){animation-delay:.4s}
@keyframes vpDotPulse{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1)}}

.vp-starters{display:flex;flex-wrap:wrap;gap:6px;padding:8px 0;justify-content:center}
.vp-starter{font-family:'DM Sans',sans-serif;font-size:12px;color:#0E8A63;background:rgba(14,138,99,0.09);border:1px solid rgba(14,138,99,0.25);border-radius:16px;padding:7px 12px;cursor:pointer;transition:all .15s;line-height:1.3;text-align:left}
.vp-starter:hover{background:#0E8A63;color:#fff;border-color:#0E8A63}

.vp-input-bar{flex-shrink:0;padding:10px 12px;border-top:1px solid rgba(0,0,0,0.09);display:flex;gap:6px;align-items:flex-end;background:#fff}
.vp-input{flex:1;padding:10px 12px;font-family:'DM Sans',sans-serif;font-size:14px;color:#18191A;background:#F5F2EC;border:1.5px solid rgba(0,0,0,0.16);border-radius:12px;outline:none;resize:none;max-height:80px;min-height:38px;line-height:1.4}
.vp-input:focus{border-color:#0E8A63}
.vp-input::placeholder{color:#B8B5AE}
.vp-send{width:38px;height:38px;border-radius:12px;background:#0E8A63;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;flex-shrink:0}
.vp-send:hover{background:#10A376}
.vp-send:disabled{opacity:.4;cursor:not-allowed}
.vp-send svg{width:16px;height:16px}
`;
document.head.appendChild(style);

// Inject FAB
var fab=document.createElement('button');
fab.id='vera-fab';
fab.innerHTML='<span class="vera-icon">\u2726</span><span class="vera-text">ASK VERA</span>';
fab.onclick=function(){openVera();};
document.body.appendChild(fab);

// Inject Panel
var panel=document.createElement('div');
panel.id='vera-panel';
panel.innerHTML=`
<div class="vp-header">
  <div class="vp-header-top">
    <span class="vp-title">Ask VERA</span>
    <button class="vp-close" onclick="closeVera()">&times;</button>
  </div>
  <div class="vp-sub">Veterans Entitlement & Ratings Advisor</div>
</div>
<div class="vp-messages" id="vp-messages">
  <div class="vp-starters" id="vp-starters">
    <div class="vp-starter" onclick="veraSendStarter(this)">How does VA combined rating math work?</div>
    <div class="vp-starter" onclick="veraSendStarter(this)">What qualifies as presumptive?</div>
    <div class="vp-starter" onclick="veraSendStarter(this)">How do I appeal a denial?</div>
  </div>
  <div class="vp-msg assistant vp-typing" id="vp-typing">
    <div class="vp-msg-bubble"><div class="vp-typing-dot"></div><div class="vp-typing-dot"></div><div class="vp-typing-dot"></div></div>
  </div>
</div>
<div class="vp-input-bar">
  <textarea class="vp-input" id="vp-input" placeholder="Ask about your VA benefits..." rows="1" onkeydown="veraKey(event)"></textarea>
  <button class="vp-send" id="vp-send" onclick="veraSend()"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg></button>
</div>`;
document.body.appendChild(panel);

// Auto-resize
var vpInput=document.getElementById('vp-input');
vpInput.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,80)+'px';});

// State
var veraMessages=[];
var veraSending=false;
var veraIsPaid=false;

// Check plan for free message limit
function veraCheckPlan(){
  try{
    if(window.sb&&window.currentUser){
      window.sb.from('profiles').select('plan').eq('user_id',window.currentUser.id).single().then(function(r){
        var plan=(r.data&&r.data.plan)||'free';
        if(plan==='pro'||plan==='earned')veraIsPaid=true;
      });
    }
  }catch(e){}
}
setTimeout(veraCheckPlan,1500);

window.openVera=function(){
  document.getElementById('vera-panel').classList.add('open');
  document.getElementById('vera-fab').classList.add('hidden');
  setTimeout(function(){document.getElementById('vp-input').focus();},300);
};
window.closeVera=function(){
  document.getElementById('vera-panel').classList.remove('open');
  document.getElementById('vera-fab').classList.remove('hidden');
};

function veraAddMsg(role,content){
  var container=document.getElementById('vp-messages');
  var typing=document.getElementById('vp-typing');
  var div=document.createElement('div');
  div.className='vp-msg '+role;
  var label=role==='user'?'You':'VERA';
  div.innerHTML='<div class="vp-msg-label">'+label+'</div><div class="vp-msg-bubble">'+veraFmt(content,role)+'</div>';
  container.insertBefore(div,typing);
  container.scrollTop=container.scrollHeight;
}

function veraFmt(text,role){
  if(role==='user')return veraEsc(text);
  var h=veraEsc(text);
  h=h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  h=h.split('\n\n').map(function(p){return '<p>'+p+'</p>';}).join('');
  h=h.replace(/\n/g,'<br>');
  return h;
}
function veraEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

window.veraSendStarter=function(el){
  document.getElementById('vp-starters').style.display='none';
  document.getElementById('vp-input').value=el.textContent;
  veraSend();
};

window.veraKey=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();veraSend();}};

window.veraSend=async function(){
  var input=document.getElementById('vp-input');
  var text=input.value.trim();
  if(!text||veraSending)return;

  // Free message limit (10 messages for non-paid users)
  if(!veraIsPaid){
    var count=parseInt(localStorage.getItem('vera_free_count')||'0');
    if(count>=10){
      input.value='';
      veraAddMsg('user',text);
      var container=document.getElementById('vp-messages');
      var typing=document.getElementById('vp-typing');
      var limitDiv=document.createElement('div');
      limitDiv.className='vp-msg assistant';
      limitDiv.innerHTML='<div class="vp-msg-label">VERA</div><div class="vp-msg-bubble"><p>You\u2019ve used your 10 free questions. To keep getting answers \u2014 on your conditions, your rating, your next steps \u2014 unlock EARNED for $39/mo. No lawyers. No cuts. Just the intel you need.</p><a href="upgrade.html" style="display:inline-block;margin-top:10px;padding:10px 20px;background:#0E8A63;color:#fff;border-radius:10px;font-size:14px;font-weight:500;text-decoration:none;font-family:DM Sans,sans-serif">Unlock EARNED \u2192</a></div>';
      container.insertBefore(limitDiv,typing);
      container.scrollTop=container.scrollHeight;
      input.disabled=true;
      input.placeholder='Free messages used \u2014 unlock EARNED to continue';
      document.getElementById('vp-send').disabled=true;
      return;
    }
    localStorage.setItem('vera_free_count',String(count+1));
  }

  veraSending=true;
  input.value='';input.style.height='auto';
  document.getElementById('vp-send').disabled=true;
  document.getElementById('vp-starters').style.display='none';
  veraAddMsg('user',text);
  veraMessages.push({role:'user',content:text});
  document.getElementById('vp-typing').style.display='block';
  document.getElementById('vp-messages').scrollTop=document.getElementById('vp-messages').scrollHeight;

  try{
    var vc='';
    try{if(window.sb&&window.currentUser)vc=await buildVeteranContext(window.currentUser.id,window.sb);}catch(e){}
    var res=await fetch('/api/ask-vera',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:veraMessages,veteranContext:vc||undefined})
    });
    var data=await res.json();
    document.getElementById('vp-typing').style.display='none';
    if(!data.success)throw new Error(data.error||'VERA could not respond.');
    veraMessages.push({role:'assistant',content:data.reply});
    veraAddMsg('assistant',data.reply);
  }catch(err){
    document.getElementById('vp-typing').style.display='none';
    veraAddMsg('assistant','Sorry \u2014 '+(err.message||'something went wrong. Try again.'));
  }
  veraSending=false;
  document.getElementById('vp-send').disabled=false;
  input.focus();
};
})();
