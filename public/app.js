const $ = id => document.getElementById(id);
const show = (id, visible) => { $(id).hidden = !visible; };
const stamp = value => value ? new Date(value).toLocaleString() : 'None';
const age = value => Math.max(0, Math.floor((Date.now() - value) / 60000)) + ' min';
const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = visibleText(String(text)); if (className) e.className = className; return e; };
// Render controls and bidi markers as visible escapes. All values enter text nodes.
const visibleText = text => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0'));
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object' ? '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}' : JSON.stringify(value);
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), b => b.toString(16).padStart(2,'0')).join('');
const unbase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
function base64(bytes) { let text=''; for(let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(text); }
let ownerToken = '', requests = new AbortController(), generation = 0, view = 'activity', timer, lastInput = Date.now(), lastRefresh = 0, eventCursor = 0, pendingVersion = '', refreshing = false;
let setupDefaults, setupKey, auditParams = new URLSearchParams({include_routine:'false'}), auditCursor, approvalOffset = 0;
const selected = new Map();
function message(text) { $('notice').textContent = text; }
function button(text, action, className) { const b = node('button',text,className); b.type = 'button'; b.addEventListener('click', () => run(action)); return b; }
async function run(action) { try { await action(); } catch(e) { if(e.name !== 'AbortError') message(e.message || 'The request failed. Try again.'); } }
async function api(path, {method='GET', body, key, raw=false} = {}) {
 const current = generation;
 const headers = {authorization:'Bearer ' + ownerToken};
 if(body !== undefined) headers['content-type']='application/json';
 if(method !== 'GET') headers['idempotency-key'] = key || crypto.randomUUID();
 const response = await fetch('/api/v1/owner/' + path, {method, headers, body:body === undefined ? undefined : JSON.stringify(body), cache:'no-store', redirect:'error', signal:requests.signal});
 if(current !== generation) throw new DOMException('Signed out','AbortError');
 if(!response.ok) {
  const data = await response.json();
  if(response.status===401) logout();
  throw new Error((data.error?.message || 'Request failed') + (data.request_id ? ' · Request ' + data.request_id : ''));
 }
 const data=raw ? response : await response.json();
 if(current !== generation)throw new DOMException('Signed out','AbortError');
 return data;
}
function logout() {
 ownerToken=''; activity=[]; setupDefaults=undefined; clearTimeout(expiryTimer); generation++; requests.abort(); requests=new AbortController(); clearTimeout(timer);
 selected.clear(); eventCursor=0; pendingVersion=''; lastRefresh=0; refreshing=false;setupKey=undefined;
 for(const id of ['activity-events','agent-list','grant-editor','approval-list','review-list','audit-events','decision-result','issued-token','connection-help']) $(id).replaceChildren();
 for(const id of ['workspace','setup','logout','token-once','batch','grant-editor']) show(id,false);
 $('owner-token').value=''; $('setup-confirm').checked=false; $('audit-filter').reset(); $('agent-form').reset();
 for(const id of ['storage','warnings','setup-origin','setup-defaults','refresh-time'])$(id).replaceChildren();
 $('pending-count').textContent='0 pending approvals';show('stale',false); $('decision-reason').value='';
 auditParams=new URLSearchParams({include_routine:'false'});auditCursor=undefined;approvalOffset=0;
 show('signin',true); message(''); $('owner-token').focus();
}
$('logout').addEventListener('click',logout);
$('signin-form').addEventListener('submit', event => { event.preventDefault(); run(async()=>{
 ownerToken=$('owner-token').value; $('owner-token').value='';
 try {
  const session=await api('session'); message(''); show('signin',false); show('logout',true);
  if(!session.setup_complete) {
   setupDefaults=session; setupKey=crypto.randomUUID(); $('setup-origin').textContent='Your URL: '+session.public_origin;
   $('setup-expiry').value=String(session.approval_ttl/60000);
   $('setup-defaults').textContent=`File quota: ${session.quota_bytes.toLocaleString()} bytes. File history: ${session.retention_ms/86400000} days. Audit history is kept indefinitely.`;
   show('setup',true);
  } else await enterWorkspace();
 } catch(e) { logout(); throw e; }
 }); });
$('setup-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
 await api('setup',{method:'POST',key:setupKey,body:{approval_ttl:Number($('setup-expiry').value)*60000,quota_bytes:setupDefaults.quota_bytes,retention_ms:setupDefaults.retention_ms}});
 show('setup',false);await enterWorkspace();message('Setup complete. Create an agent, add narrow grants and a task token, then review them before enabling it.');
});});
async function enterWorkspace() { show('workspace',true); await switchView('activity'); await refreshOverview(); }
async function switchView(name) {
 view=name; for(const e of document.querySelectorAll('.view')) e.hidden=e.id!==name;
 for(const e of document.querySelectorAll('nav button')) { if(e.dataset.view===name)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current'); }
 $('view-title').textContent={activity:'Activity',agents:'Agents & grants',approvals:'Approvals',audit:'Audit log'}[name];
 if(name==='agents')await loadAgents();if(name==='approvals')await loadApprovals();if(name==='audit')await loadAudit(false);
}
for(const e of document.querySelectorAll('nav button'))e.addEventListener('click',()=>run(()=>switchView(e.dataset.view)));
function eventTable(events) {
 if(!events.length)return node('p','No matching events.');
 const wrap=node('div',undefined,'table-wrap'),table=node('table'),head=node('tr');
 for(const title of ['Time / actor','Action / target','Decision / result','Trace'])head.append(node('th',title));
 const thead=node('thead');thead.append(head);table.append(thead);const body=node('tbody');
 for(const e of events) {
  const row=node('tr');
  for(const text of [`${stamp(e.timestamp)}\n${e.actor_name} (${e.actor_kind})`,`${e.operation}\n${e.target}`,`${e.decision} · ${e.result}\n${e.reason_code}`,`Request: ${e.request_id}\n${e.action_id?'Action: '+e.action_id:''}\n${e.token_id?'Token: '+e.token_id:''}`])row.append(node('td',text));
  body.append(row);
 }
 table.append(body);wrap.append(table);return wrap;
}
let activity=[];
async function refreshOverview() {
 clearTimeout(timer); if(!ownerToken||$('workspace').hidden||document.hidden||refreshing)return;
 refreshing=true; const current=generation;
 try {
  const data=await api('overview?cursor='+eventCursor+'&pending_version='+encodeURIComponent(pendingVersion));
  eventCursor=data.event_cursor;lastRefresh=Date.now();
  $('refresh-time').textContent='Last refreshed '+new Date(lastRefresh).toLocaleTimeString();show('stale',false);
  $('pending-count').textContent=`${data.pending_count} pending approval${data.pending_count===1?'':'s'}${data.oldest_pending_at?' · oldest '+age(data.oldest_pending_at):''}`;
  $('storage').textContent=`Files: ${data.storage.bytes.toLocaleString()} / ${data.storage.quota_bytes.toLocaleString()} bytes. Audit history through event #${data.audit_storage.last_event_id.toLocaleString()}, about ${data.audit_storage.estimated_bytes.toLocaleString()} bytes (estimate). History is kept.`;
  $('warnings').textContent=data.warnings.join(' ');
  const seen=new Set(activity.map(e=>e.id));activity=[...data.events.filter(e=>!seen.has(e.id)),...activity].sort((a,b)=>b.id-a.id).slice(0,100);
  $('activity-events').replaceChildren(eventTable(activity.filter(e=>!['action.get','owner.overview','owner.session','files.usage','agents.list','grants.read','approvals.list','approval.review','audit.list'].includes(e.operation))));
  if(view==='approvals'&&pendingVersion!==data.pending_version)await loadApprovals();
  pendingVersion=data.pending_version;
 } catch(e) { if(e.name!=='AbortError') { show('stale',!lastRefresh||Date.now()-lastRefresh>=30000);message(e.message); } }
 finally { if(current===generation) { refreshing=false;schedule(); } }
}
function schedule() { clearTimeout(timer); if(ownerToken&&!$('workspace').hidden&&!document.hidden)timer=setTimeout(refreshOverview,Date.now()-lastInput>60000?15000:5000); }
for(const name of ['pointerdown','keydown'])document.addEventListener(name,()=>{const wasIdle=Date.now()-lastInput>60000;lastInput=Date.now();if(wasIdle)schedule();},{passive:true});
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden)run(refreshOverview);});
$('refresh').addEventListener('click',()=>run(refreshOverview));
function tokenPanel(token) {
 $('issued-token').textContent=token;show('token-once',true);
 $('connection-help').textContent=`Connect this agent with its own token. Replace AGENT_TOKEN below with the token above.\n\nHTTP: ${location.origin}/api/v1/\nAuthorization: Bearer AGENT_TOKEN\n\nMCP: ${location.origin}/mcp (Streamable HTTP)\nAuthorization: Bearer AGENT_TOKEN\n\nCLI / SDK: use this deployment URL and AGENT_TOKEN. See the project connection guide. Remove direct copies of protected provider keys from agent configs.`;
 $('token-once').scrollIntoView({block:'center'});
}
$('copy-token').addEventListener('click',()=>run(async()=>{await navigator.clipboard.writeText($('issued-token').textContent);message('Token copied. Keep it private.');}));
$('hide-token').addEventListener('click',()=>{$('issued-token').replaceChildren();$('connection-help').replaceChildren();show('token-once',false);});
$('agent-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
 await api('agents',{method:'POST',body:{name:$('agent-name').value,description:$('agent-description').value}});$('agent-form').reset();await loadAgents();
});});
async function changeStatus(agent,status) { await api('agents/'+agent.id,{method:'PATCH',body:{status}});await loadAgents();await refreshOverview(); }
async function loadAgents() {
 const {agents}=await api('agents');const list=$('agent-list');list.replaceChildren();
 if(!agents.length)list.append(node('p','No agents yet.'));
 for(const a of agents) {
  const card=node('article',undefined,'card');card.append(node('h3',a.name),node('p',`${a.status} · ${a.description||'No description'}`),node('small','Agent ID: '+a.id));
  const actions=node('div',undefined,'actions');
  actions.append(button('Review grants',()=>editGrants(a)),button('View activity',async()=>{auditParams=new URLSearchParams({agent_id:a.id,include_routine:'true'});$('audit-filter').reset();$('audit-filter').elements.namedItem('agent_id').value=a.id;await switchView('audit');}));
  if(a.status!=='revoked') {
   actions.append(button(a.status==='enabled'?'Disable agent':'Review and enable',async()=>{
    if(a.status==='enabled')return changeStatus(a,'disabled');
    await editGrants(a);message('Review the effective grants and task tokens below before enabling this agent.');
    $('grant-editor').append(button('Enable '+a.name,()=>changeStatus(a,'enabled'),'primary'));
   }),button('Revoke agent',async()=>{if(confirm('Revoke '+visibleText(a.name)+' and all its tokens? Unexecuted requests will be invalidated. Dispatched sends cannot be recalled.'))await changeStatus(a,'revoked');},'danger'));
   const form=node('form',undefined,'inline');const label=node('label','Task token label'),input=node('input');input.required=true;input.maxLength=100;label.append(input);
   const ttlLabel=node('label','Lifetime in hours (max 720)'),ttl=node('input');ttl.type='number';ttl.min='0.016667';ttl.max='720';ttl.step='any';ttl.value='24';ttl.required=true;ttlLabel.append(ttl);
   const submit=node('button','Issue token');form.append(label,ttlLabel,submit);
   form.addEventListener('submit',event=>{event.preventDefault();run(async()=>{const t=await api(`agents/${a.id}/tokens`,{method:'POST',body:{label:input.value,lifetime_ms:Math.round(Number(ttl.value)*3600000)}});tokenPanel(t.token);await loadAgents();});});card.append(form);
  }
  card.append(actions);
  const tokens=node('div');tokens.append(node('h4','Task tokens'));
  for(const t of a.tokens) {
   const row=node('p',`${t.label} · ${t.prefix}… · ${t.revoked_at?'revoked':t.expires_at<=Date.now()?'expired':'expires '+stamp(t.expires_at)} `);
   row.append(node('small','Token ID: '+t.id));
   if(!t.revoked_at&&a.status!=='revoked')row.append(button('Revoke '+t.label,async()=>{await api(`agents/${a.id}/tokens/${t.id}`,{method:'DELETE'});await loadAgents();await refreshOverview();}));
   tokens.append(row);
  }
  if(!a.tokens.length)tokens.append(node('p','No tokens.'));card.append(tokens);list.append(card);
 }
}
async function editGrants(agent) {
 const [data,secretData]=await Promise.all([api(`agents/${agent.id}/grants`),api('secrets')]);
 const editor=$('grant-editor');editor.replaceChildren();show('grant-editor',true);
 editor.append(node('h3','Grants for '+agent.name),node('p','Access is the union of all unexpired grants. A narrow grant does not override a broad one. Read, write, and delete are separate permissions. Delete and replacement still need approval.'));
 const effective=node('details'),summary=node('summary','Effective grants now');effective.append(summary,node('pre',JSON.stringify(data.effective,null,2)));editor.append(effective);
 const form=node('form'),rows=node('div'),secretRows=node('div');const folderControls=[],secretControls=[];
 const expiryControl=value=>{const label=node('label','Expires (optional)','expiry'),input=node('input');input.type='datetime-local';
  if(value){const d=new Date(value);input.value=new Date(value-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}label.append(input);return {label,input};};
 function folderRow(g={prefix:'',read:false,write:false,delete:false}) {
  const row=node('div',undefined,'grant-row'),prefixLabel=node('label','Folder prefix'),prefix=node('input');prefix.required=true;prefix.value=g.prefix;prefix.placeholder='/projects/example/';prefixLabel.append(prefix);row.append(prefixLabel);
  const controls={row,prefix,removed:false};
  for(const permission of ['read','write','delete']) {const label=node('label',permission,'check'),input=node('input');input.type='checkbox';input.checked=!!g[permission];label.prepend(input);row.append(label);controls[permission]=input;}
  const expires=expiryControl(g.expires_at);controls.expiry=expires.input;row.append(expires.label,button('Remove folder',()=>{controls.removed=true;row.remove();}));
  const warning=node('p','Root access covers every file in this locker.','warning');warning.hidden=prefix.value!=='/';prefix.addEventListener('input',()=>{warning.hidden=prefix.value!=='/';});row.append(warning);rows.append(row);folderControls.push(controls);
 }
 data.folders.forEach(folderRow);form.append(rows,button('Add folder',()=>folderRow()));
 form.append(node('h4','Named secrets'),node('p','Use through proxy: the Worker reads the key for this agent. The agent never receives the saved value. Every outbound request needs approval.'));
 for(const s of secretData.secrets) {
  const existing=data.secrets.find(g=>g.secret_id===s.id),row=node('div',undefined,'grant-row'),label=node('label',s.name+(s.enabled?'':' (disabled)')+' · '+s.hosts.join(', '),'check'),input=node('input');input.type='checkbox';input.checked=!!existing;label.prepend(input);
  const expires=expiryControl(existing?.expires_at);row.append(label,expires.label);secretRows.append(row);secretControls.push({id:s.id,input,expiry:expires.input});
 }
 if(!secretData.secrets.length)secretRows.append(node('p','No saved secrets yet.'));
 form.append(secretRows);const save=node('button','Save reviewed grants','primary');save.disabled=agent.status==='revoked';form.append(save);
 form.addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  const expiry=input=>input.value?new Date(input.value).getTime():null;
  const folders=folderControls.filter(g=>!g.removed).map(g=>({prefix:g.prefix.value,read:g.read.checked,write:g.write.checked,delete:g.delete.checked,expires_at:expiry(g.expiry)}));
  const secrets=secretControls.filter(g=>g.input.checked).map(g=>({secret_id:g.id,read:true,expires_at:expiry(g.expiry)}));
  if(folders.some(g=>g.prefix==='/')&&!confirm('Grant access to the root folder? These permissions cover the whole locker.'))return;
  await api(`agents/${agent.id}/grants`,{method:'PUT',body:{expected_version:data.version,folders,secrets}});await loadAgents();await editGrants(agent);message('Grants saved. Outstanding requests checked against older policy are invalidated.');await refreshOverview();
 });});editor.append(form);editor.scrollIntoView({block:'start'});
}
let expiryTimer;
function selectionState() {
 clearTimeout(expiryTimer);show('batch',selected.size>0);
 const valid=[...selected.values()].every(r=>r.loaded&&r.data?.status==='pending'&&r.data.expires_at>Date.now());
 $('batch-count').textContent=`${selected.size} explicitly selected request${selected.size===1?'':'s'}. Each complete request and digest is shown above. Loading does not mean you have read it.`;
 $('approve-selected').disabled=!selected.size||!valid;
 $('approve-selected').textContent='Approve '+selected.size+' selected';$('deny-selected').textContent='Deny '+selected.size+' selected';
 $('deny-selected').disabled=![...selected.values()].some(r=>r.data?.status==='pending'&&r.data.expires_at>Date.now());
 let next=Infinity;
 for(const r of selected.values()) {
  const active=r.data?.status==='pending'&&r.data.expires_at>Date.now();
  if(r.approve)r.approve.disabled=!r.loaded||!active;if(r.deny)r.deny.disabled=!active;
  if(r.state)r.state.textContent=r.data ? (r.data.expires_at<=Date.now()&&r.data.status==='pending'?'expired':r.data.status) : 'Loading review';
  if(active)next=Math.min(next,r.data.expires_at);
 }
 if(next!==Infinity)expiryTimer=setTimeout(selectionState,Math.min(2147483647,Math.max(1,next-Date.now()+1)));
}
function clearSelection() {selected.clear();$('review-list').replaceChildren();$('decision-result').replaceChildren();$('decision-reason').value='';for(const e of $('approval-list').querySelectorAll('input[type=checkbox]'))e.checked=false;selectionState();}
$('clear-selection').addEventListener('click',clearSelection);
$('approval-filter').addEventListener('submit',event=>{event.preventDefault();approvalOffset=0;run(loadApprovals);});
$('approval-next').addEventListener('click',()=>{approvalOffset+=50;run(loadApprovals);});
$('approval-prev').addEventListener('click',()=>{approvalOffset=Math.max(0,approvalOffset-50);run(loadApprovals);});
async function loadApprovals() {
 const {approvals}=await api(`approvals?state=${$('approval-state').value}&limit=50&offset=${approvalOffset}`);
 const list=$('approval-list');list.replaceChildren();show('approval-prev',approvalOffset>0);show('approval-next',approvals.length===50);
 if(!approvals.length)list.append(node('p','No requests in this view.'));
 const groups=new Map();
 for(const a of approvals) {
  const groupKey=a.agent_name+' · '+a.operation;if(!groups.has(groupKey))groups.set(groupKey,[]);groups.get(groupKey).push(a);
 }
 for(const [name,items] of groups) {
  const section=node('section',undefined,'card');section.append(node('h3',name+' · '+items.length+' request'+(items.length===1?'':'s')));
  for(const a of items) {
   const label=node('label',undefined,'check'),check=node('input');check.type='checkbox';check.checked=selected.has(a.approval_id);
   const expired=a.expires_at<=Date.now();label.append(check,node('span',`${a.agent_name} · ${a.token_label} · ${a.operation} · ${a.target}\n${expired&&a.status==='pending'?'expired':a.status} · age ${age(a.created_at)} · expires ${stamp(a.expires_at)}`));
   check.addEventListener('change',()=>run(async()=>{
    if(!check.checked){selected.get(a.approval_id)?.element.remove();selected.delete(a.approval_id);selectionState();return;}
    if(selected.size>=20){check.checked=false;message('Select at most 20 requests per batch.');return;}
    const review={loaded:false,element:node('article',undefined,'card')};selected.set(a.approval_id,review);$('review-list').append(review.element);selectionState();
    await loadReview(a.approval_id,review);
   }));section.append(label);
  }
  list.append(section);
 }
 // Only refresh already-loaded detail states when queue state changed. Never
 // replace full review content while it is being read.
 for(const [id,r] of selected)if(r.data) {
  const status=await api('actions/'+r.data.id);if(!selected.has(id))continue;r.data.status=status.status;
 }
 selectionState();
}
function appendBytes(container,data) {
 const size=48*1024;
 container.append(node('p',`${data.length.toLocaleString()} bytes · complete base64 (lossless)`));
 const parts=(label,length,render)=>{
  if(length<=size){container.append(node('pre',render(0,length)));return;}
  const count=Math.ceil(length/size),group=node('details');group.append(node('summary',`${label}: all ${count} sections, including the final bytes`));
  // Each section remains available. Closed sections avoid laying out millions
  // of characters at once. Only presentation is deferred; all bytes are verified.
  for(let start=0,index=1;start<length;start+=size,index++) {
   const end=Math.min(start+size,length),part=node('details');
   part.append(node('summary',`Section ${index} of ${count} · ${label==='Base64'?'bytes':'text positions'} ${start+1}–${end} of ${length}`));
   let rendered=false;part.addEventListener('toggle',()=>{if(part.open&&!rendered){rendered=true;part.append(node('pre',render(start,end)));}});group.append(part);
  }
  container.append(group);
 };
 parts('Base64',data.length,(start,end)=>base64(data.subarray(start,end)));
 try {
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(data);
  container.append(node('p','Complete UTF-8 text. Control and direction markers appear as escaped codes.'));
  // A boundary may split a surrogate pair. Move that code point wholly into the
  // following section so the displayed Unicode remains unchanged.
  parts('UTF-8 text',decoded.length,(start,end)=>{
   if(start&&/[\uDC00-\uDFFF]/.test(decoded[start]))start--;
   if(end<decoded.length&&/[\uDC00-\uDFFF]/.test(decoded[end]))end--;
   return decoded.slice(start,end);
  });
 } catch {container.append(node('p','Binary content. Use the base64 above or download the bytes.'));}
}

async function loadReview(id,r) {
 const current=generation;
 try {
  const data=await api('approvals/'+id);if(!selected.has(id))return;r.data=data;
  r.element.replaceChildren(node('h3',data.agent.name+' · '+data.operation),node('p','Task: '+data.token.label+' · created '+stamp(data.created_at)+' · expires '+stamp(data.expires_at)));
  r.state=node('strong',data.status);r.element.append(r.state);
  const reason=data.operation==='proxy.request'?'Every outbound request needs approval.':data.operation==='file.delete'?'Every deletion needs approval.':data.operation==='file.write'&&data.input.expected_revision?'Replacing an existing revision needs approval.':'An owner rule requires review.';
  r.element.append(node('p',reason),node('p','Secret read grants mean use through the proxy. Stored keys stay hidden.'),node('p','Digest: '+data.digest),node('h4','Effective scope at review'),node('pre',JSON.stringify(data.scope,null,2)));
  if(data.scope?.folders.some(g=>g.prefix==='/'&&(!g.expires_at||g.expires_at>Date.now())))r.element.append(node('p','Broad access: this agent has a root folder grant.','warning'));
  const {input}=data;
  if(input.request) {
   const request=input.request,url=new URL(request.url);
   r.element.append(node('h4',request.method+' '+url.hostname),node('p','Full path and query: '+url.pathname+url.search));
   r.element.append(node('p',`Credential placeholder: ${input.injection_header}: ${input.scheme==='bearer'?'Bearer ':''}[secret ${input.secret}, value version ${input.value_version}]. Only the stored key bytes are hidden.`));
   const others=[...selected.values()].filter(other=>other!==r&&other.data?.input.secret===input.secret&&other.data.input.request);
   if(others.some(other=>new URL(other.data.input.request.url).hostname!==url.hostname))r.element.append(node('p','Changed destination: selected requests using this secret have different hosts.','warning'));
  }
  r.element.append(node('h4','Complete action input'),node('pre',JSON.stringify(input,null,2)));
  const computed=await hash(new TextEncoder().encode(canonical({input,...data.digest_context})));
  if(computed!==data.digest)throw new Error('Action digest does not match. Approval is blocked.');
  const body=node('div');r.element.append(body);
  let content;
  if(input.request) {
   content=unbase64(input.request.body_base64);
   if(await hash(content)!==input.request.body_hash)throw new Error('Body hash does not match. Approval is blocked.');appendBytes(body,content);
  } else if(input.revision||input.expected_revision) {
   body.append(node('p','Loading the complete file. Approval is disabled until the bytes are verified.'));
   const response=await api('approvals/'+id+'/content',{raw:true});content=new Uint8Array(await response.arrayBuffer());
   if(current!==generation||!selected.has(id))return;
   const expectedHash=input.revision?input.hash:input.previous_hash,expectedLength=input.revision?input.length:input.previous_length;
   if(content.length!==expectedLength||await hash(content)!==expectedHash)throw new Error('File bytes do not match the reviewed revision. Approval is blocked.');body.replaceChildren();appendBytes(body,content);
  }
  if(current!==generation||!selected.has(id))return;
  if(content)r.element.append(button('Download complete content',async()=>downloadBlob(new Blob([content]),'approval-content.bin')));
  r.loaded=true;r.element.append(node('p','Complete review data loaded and verified. Check the full request before deciding.'));
  r.approve=button('Approve this request',()=>decide('approve',[id]),'primary');r.deny=button('Deny this request',()=>decide('deny',[id]));
  const actions=node('div',undefined,'actions');actions.append(r.approve,r.deny,button('Revoke this agent',async()=>{if(confirm('Revoke this agent and invalidate its unexecuted requests? Dispatched sends cannot be recalled.')){await api('agents/'+data.digest_context.agent_id,{method:'PATCH',body:{status:'revoked'}});await refreshOverview();}}));r.element.append(actions);
 } catch(e) {if(e.name!=='AbortError') { r.loaded=false;r.element.append(node('p',e.message,'warning'));message(e.message);}}
 selectionState();
}
async function decide(decision,ids=[...selected.keys()]) {
 const members=ids.map(id=>({id,digest:selected.get(id)?.data?.digest}));
 if(decision==='approve'&&ids.some(id=>{const r=selected.get(id);return !r?.loaded||r.data.status!=='pending'||r.data.expires_at<=Date.now();}))throw new Error('Every selected request must be loaded, verified, and pending.');
 if(members.some(m=>!m.digest))throw new Error('Load every selected request before deciding.');
 if(!confirm(`${decision==='approve'?'Approve':'Deny'} exactly ${members.length} selected request${members.length===1?'':'s'}? This decision applies only to the digests shown.`))return;
 const result=await api('approvals/batch-decision',{method:'POST',body:{members,decision,reason:$('decision-reason').value}});
 for(const item of result.results){const r=selected.get(item.approval_id);if(r?.data&&item.status)r.data.status=item.status;}
 $('decision-result').textContent=visibleText(JSON.stringify(result,null,2));selectionState();await loadApprovals();await refreshOverview();
}
$('approve-selected').addEventListener('click',()=>run(()=>decide('approve')));$('deny-selected').addEventListener('click',()=>run(()=>decide('deny')));
$('audit-filter').addEventListener('submit',event=>{event.preventDefault();auditParams=new URLSearchParams();
 for(const [key,value] of new FormData($('audit-filter')))if(value&&key!=='include_routine')auditParams.set(key,['from','to'].includes(key)?String(new Date(String(value)).getTime()):String(value));
 auditParams.set('include_routine',$('audit-filter').elements.namedItem('include_routine').checked?'true':'false');run(()=>loadAudit(false));
});
async function loadAudit(older) {
 const params=new URLSearchParams(auditParams);if(older&&auditCursor)params.set('cursor',auditCursor);
 const data=await api('audit?'+params);auditCursor=data.next_cursor;
 if(!older)$('audit-events').replaceChildren();$('audit-events').append(eventTable(data.events));show('audit-next',!!auditCursor);
}
$('audit-next').addEventListener('click',()=>run(()=>loadAudit(true)));
function downloadBlob(blob,name) { const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
for(const format of ['jsonl','csv'])$('export-'+format).addEventListener('click',()=>run(async()=>{
 const params=new URLSearchParams(auditParams);params.set('format',format);const response=await api('audit/export?'+params,{raw:true});const current=generation,blob=await response.blob();if(current===generation)downloadBlob(blob,'agent-locker-audit.'+format);
}));
