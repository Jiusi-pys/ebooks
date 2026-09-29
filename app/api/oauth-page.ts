function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  );
}

export function authorizationPage(input: {
  id: string;
  csrf: string;
  nonce: string;
  clientName: string;
  redirect: string;
}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权读取书房</title>
<style nonce="${input.nonce}">body{font:16px/1.6 system-ui,sans-serif;background:#f4f1eb;color:#242424;margin:0;padding:32px 16px}main{max-width:520px;margin:6vh auto;padding:32px;background:white;border-radius:16px}h1{font-size:26px}label{display:block;margin:14px 0}input,button{box-sizing:border-box;font:inherit;padding:12px;border:1px solid #aaa;border-radius:8px;width:100%}button{cursor:pointer;margin:8px 0;background:#243e35;color:white}button[name=decision][value=deny]{background:white;color:#333}small{overflow-wrap:anywhere;color:#555}#error{color:#a22}[hidden]{display:none!important}</style></head>
<body><main><h1>授权读取书房</h1><p>应用 <strong>${escape(input.clientName)}</strong> 请求读取你的书籍目录、阅读进度、书摘、批注、复习卡和笔记。</p><p>权限：仅限读取服务端已同步的数据。</p><small>授权结果返回：${escape(input.redirect)}</small><p id="error" role="alert"></p>
<form id="login"><h2>登录书房</h2><label>用户名<input name="username" autocomplete="username" required maxlength="256"></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><button>登录</button></form>
<form id="consent" method="post" action="/oauth/authorize" hidden><p id="account"></p><input type="hidden" name="request_id" value="${input.id}"><input type="hidden" name="csrf" value="${input.csrf}"><button name="decision" value="allow">允许只读访问</button><button name="decision" value="deny">拒绝</button></form>
<script nonce="${input.nonce}">
const login=document.getElementById('login'),consent=document.getElementById('consent'),error=document.getElementById('error');
async function session(){const r=await fetch('/api/auth/session',{cache:'no-store'});if(!r.ok)throw Error('无法验证书房登录状态，请稍后重试');const s=await r.json();if(s.setupRequired)throw Error('请先在书房首页完成账户设置，再重新连接');login.hidden=!!s.authenticated;consent.hidden=!s.authenticated;if(s.authenticated)document.getElementById('account').textContent='当前账户：'+s.user.id;}
login.addEventListener('submit',async e=>{e.preventDefault();error.textContent='';const button=login.querySelector('button');button.disabled=true;try{const fields=new FormData(login);const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appId:fields.get('username'),appSecret:fields.get('password')})});const result=await r.json();login.querySelector('[name=password]').value='';if(!r.ok)throw Error(result.message||'登录失败');await session();}catch(e){error.textContent=e.message||'登录失败';}finally{button.disabled=false;}});
session().catch(e=>{error.textContent=e.message;});
</script></main></body></html>`;
}
