namespace Ltsc.Server;

/// <summary>
/// Single-page admin console (design §12 BFF/SPA). Vanilla JS, no build step —
/// served inline so there is no static-asset pipeline to ship. Talks only to the
/// existing role-gated APIs; the bearer token is held client-side and the UI
/// gates actions by the role returned from /api/whoami.
/// </summary>
public static class ConsoleHtml
{
    public const string Page = """
<!doctype html><html><head><meta charset="utf-8"><title>LTSC Fleet Console</title>
<style>
:root{--b:#d0d7de;--bg:#f6f8fa;--ok:#1a7f37;--warn:#9a6700;--err:#cf222e;--accent:#0969da}
*{box-sizing:border-box}body{font-family:system-ui,Segoe UI,sans-serif;margin:0;color:#1f2328}
header{display:flex;gap:.75rem;align-items:center;padding:.6rem 1rem;background:#24292f;color:#fff}
header h1{font-size:1rem;margin:0;font-weight:600}header input{padding:.35rem .5rem;border-radius:6px;border:1px solid #444;min-width:200px}
.badge{padding:.15rem .5rem;border-radius:999px;font-size:.75rem;background:#444}
.badge.Admin{background:#8250df}.badge.Operator{background:#0969da}.badge.Viewer{background:#1a7f37}.badge.None{background:#cf222e}
main{display:grid;grid-template-columns:340px 1fr;gap:1rem;padding:1rem;align-items:start}
.card{border:1px solid var(--b);border-radius:8px;background:#fff}
.card h2{font-size:.85rem;margin:0;padding:.5rem .75rem;border-bottom:1px solid var(--b);background:var(--bg)}
.card .body{padding:.5rem .75rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}td,th{padding:.35rem .5rem;text-align:left;border-bottom:1px solid #eee}
th{color:#656d76;font-weight:600}
.row{cursor:pointer}.row:hover{background:#f6f8fa}.row.sel{background:#ddf4ff}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%}.dot.on{background:var(--ok)}.dot.off{background:#999}
.pill{font-size:.7rem;padding:.1rem .4rem;border-radius:999px}.pill.ok{background:#dafbe1;color:var(--ok)}.pill.drift{background:#fff8c5;color:var(--warn)}
.tabs{display:flex;gap:.25rem;border-bottom:1px solid var(--b);padding:.4rem .75rem 0}
.tab{padding:.35rem .7rem;cursor:pointer;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;font-size:.85rem}
.tab.active{background:#fff;border-color:var(--b);font-weight:600}
button{padding:.35rem .7rem;border:1px solid var(--b);border-radius:6px;background:#fff;cursor:pointer;font-size:.82rem}
button:hover{background:var(--bg)}button:disabled{opacity:.4;cursor:not-allowed}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.actions{display:flex;flex-wrap:wrap;gap:.4rem;padding:.5rem .75rem}
textarea{width:100%;min-height:240px;font-family:ui-monospace,Consolas,monospace;font-size:.8rem;border:1px solid var(--b);border-radius:6px;padding:.5rem}
pre{margin:0;font-size:.8rem;white-space:pre-wrap;word-break:break-word}
.muted{color:#656d76}.kv{display:grid;grid-template-columns:140px 1fr;gap:.2rem .5rem;font-size:.85rem}
#toast{position:fixed;bottom:1rem;right:1rem;background:#24292f;color:#fff;padding:.6rem .9rem;border-radius:8px;opacity:0;transition:.2s}
#toast.show{opacity:1}
</style></head><body>
<header>
  <h1>LTSC Fleet</h1>
  <input id="tok" placeholder="API token" value="admin-token">
  <button onclick="connect()">Connect</button>
  <span id="role" class="badge None">None</span>
  <span class="muted" style="margin-left:auto;font-size:.78rem">tokens: viewer- / operator- / admin-token</span>
</header>
<main>
  <section class="card">
    <h2>Devices (<span id="count">0</span>)</h2>
    <div class="body" style="padding:0"><table id="fleet"><thead><tr><th></th><th>Device</th><th>Model</th><th>Policy</th></tr></thead><tbody></tbody></table></div>
  </section>
  <section class="card">
    <div class="tabs">
      <div class="tab active" data-t="overview" onclick="tab(this)">Overview</div>
      <div class="tab" data-t="inventory" onclick="tab(this)">Inventory</div>
      <div class="tab" data-t="commands" onclick="tab(this)">Commands</div>
      <div class="tab" data-t="shadow" onclick="tab(this)">Shadow</div>
      <div class="tab" data-t="policy" onclick="tab(this)">Policy</div>
      <div class="tab" data-t="audit" onclick="tab(this)">Audit</div>
    </div>
    <div id="actions" class="actions"></div>
    <div class="body"><div id="panel"><p class="muted">Select a device.</p></div></div>
  </section>
</main>
<div id="toast"></div>
<script>
let TOK="", ROLE="None", sel=null, cur="overview", fleet=[];
const $=id=>document.getElementById(id);
const rank={None:0,Viewer:1,Operator:2,Admin:3};
function hdr(){return {'Authorization':'Bearer '+TOK};}
function can(r){return rank[ROLE]>=rank[r];}
function toast(m){const t=$('toast');t.textContent=m;t.className='show';setTimeout(()=>t.className='',2500);}
async function api(path,opts){const r=await fetch(path,{...(opts||{}),headers:{...hdr(),...((opts||{}).headers||{})}});return r;}

async function connect(){
  TOK=$('tok').value.trim();
  const r=await fetch('/api/whoami',{headers:hdr()});const w=await r.json();
  ROLE=w.role;$('role').textContent=ROLE+(w.actor?(' ('+w.actor+')'):'');$('role').className='badge '+ROLE;
  if(ROLE==='None'){toast('invalid token');return;}
  loadFleet();
}
async function loadFleet(){
  const r=await api('/api/devices');if(!r.ok)return;fleet=await r.json();
  $('count').textContent=fleet.length;
  const tb=$('fleet').querySelector('tbody');tb.innerHTML='';
  for(const d of fleet){const tr=document.createElement('tr');tr.className='row'+(d.deviceId===sel?' sel':'');
    tr.onclick=()=>{sel=d.deviceId;render();loadFleet();};
    tr.innerHTML=`<td><span class="dot ${d.online?'on':'off'}"></span></td><td>${d.deviceId}</td><td>${d.model||''}</td>`+
      `<td><span class="pill ${d.inPolicy?'ok':'drift'}">${d.inPolicy?'in policy':'drift'}</span></td>`;
    tb.appendChild(tr);}
}
function tab(el){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');cur=el.dataset.t;render();}
function dev(){return fleet.find(d=>d.deviceId===sel);}

function renderActions(){
  const a=$('actions');a.innerHTML='';if(!sel)return;
  const add=(label,act,role,extra)=>{const b=document.createElement('button');b.textContent=label;b.disabled=!can(role);
    b.onclick=()=>cmd(act,extra);if(role==='Admin'||act==='reboot')b.className='';a.appendChild(b);};
  add('Collect inventory','collect','Operator');
  add('Reboot','reboot','Operator');add('Shutdown','shutdown','Operator');
  add('Restart services','restart_services','Operator',{services:'spooler'});
  add('Collect logs','collect_logs','Operator');
  add('Update: scan','update_scan','Operator');add('Update: install','update_install','Operator');
  add('Capture image','capture','Operator');add('Trigger BMR','trigger_bmr','Operator');
  add('Shadow','shadow','Operator');
}
async function cmd(act,extra){
  let q=`/api/devices/${sel}/command?action=${act}`;if(extra&&extra.services)q+=`&services=${extra.services}`;
  const r=await api(q,{method:'POST'});toast(`${act}: ${r.status} ${r.ok?'sent':await r.text()}`);
  setTimeout(()=>render(),1500);
}

async function render(){
  renderActions();const p=$('panel');if(!sel){p.innerHTML='<p class="muted">Select a device.</p>';return;}
  if(cur==='overview'){const d=dev()||{};p.innerHTML=`<div class="kv">
    <div>Device</div><div>${d.deviceId}</div><div>Group</div><div>${d.groupId}</div>
    <div>Model</div><div>${d.model||''}</div><div>OS</div><div>${d.os||''}</div>
    <div>Online</div><div>${d.online?'yes':'no'}</div>
    <div>Policy</div><div>${d.policyVersion} vs ${d.expectedPolicy} <span class="pill ${d.inPolicy?'ok':'drift'}">${d.inPolicy?'in policy':'drift'}</span></div>
    <div>Reboot pending</div><div>${d.rebootPending?'yes':'no'}</div><div>Last seen</div><div>${d.lastSeen}</div></div>`;}
  else if(cur==='inventory'){const r=await api(`/api/devices/${sel}/inventory`);
    p.innerHTML=r.ok?`<pre>${JSON.stringify(await r.json(),null,2)}</pre>`:'<p class="muted">no inventory yet</p>';}
  else if(cur==='commands'){const r=await api(`/api/devices/${sel}/commands`);const cs=r.ok?await r.json():[];
    p.innerHTML='<table><thead><tr><th>Command</th><th>Status</th><th>Exit</th><th>Detail</th></tr></thead><tbody>'+
      cs.map(c=>`<tr><td>${c.commandId}</td><td>${c.status}</td><td>${c.exitCode}</td><td>${(c.stdoutTail||'').slice(0,80)}</td></tr>`).join('')+'</tbody></table>';}
  else if(cur==='shadow'){const r=await api(`/api/devices/${sel}/shadow`);
    p.innerHTML=r.ok?`<pre>${JSON.stringify(await r.json(),null,2)}</pre>`:'<p class="muted">no shadow session</p>';}
  else if(cur==='policy'){const g=(dev()||{}).groupId||'group-default';const r=await api(`/api/groups/${g}/policy`);const txt=r.ok?await r.text():'{}';
    p.innerHTML=`<p class="muted">Group <b>${g}</b> policy (Admin can edit + save)</p>
      <textarea id="pol">${txt}</textarea><div style="margin-top:.5rem"><button class="primary" ${can('Admin')?'':'disabled'} onclick="savePolicy('${g}')">Save & push</button></div>`;}
  else if(cur==='audit'){if(!can('Admin')){p.innerHTML='<p class="muted">Admin only.</p>';return;}
    const r=await api('/api/audit');const rows=r.ok?await r.json():[];
    p.innerHTML='<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>'+
      rows.map(a=>`<tr><td>${a.ts.slice(0,19)}</td><td>${a.actor}</td><td>${a.action}</td><td>${a.target}</td><td>${a.detail}</td></tr>`).join('')+'</tbody></table>';}
}
async function savePolicy(g){
  const r=await api(`/api/groups/${g}/policy`,{method:'POST',body:$('pol').value});
  toast(`policy: ${r.status} ${await r.text()}`);loadFleet();
}
setInterval(()=>{if(ROLE!=='None'){loadFleet();if(['inventory','commands','shadow'].includes(cur))render();}},5000);
connect();
</script></body></html>
""";
}
