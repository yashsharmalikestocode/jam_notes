/***** CONFIG: paste your Supabase project values *****/
const SUPABASE_URL = 'https://phwcblejkxiqsrwwmaha.supabase.co';   // <-- your project URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBod2NibGVqa3hpcXNyd3dtYWhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA5MDkzNzUsImV4cCI6MjA3NjQ4NTM3NX0.l0BB35NCvpyd3t37EYYQ_Ic2_Orh5OV-mon1cVefAc0'; // <-- your anon key

/***** Local DB (browser backup & offline) *****/
const DB_KEY = 'jamnotes_v1';
let db = [];
const loadLocal = () => { try { db = JSON.parse(localStorage.getItem(DB_KEY)||'[]'); } catch { db = []; } };
const saveLocal = () => localStorage.setItem(DB_KEY, JSON.stringify(db));
const uid = () => 'N'+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4);

// State for edit mode (prevents duplicates)
let editingId = null;

/***** Supabase init *****/
let supa = null, currentUser = null, rtChannel = null;

async function supaInit(){
  supa = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession:true } });
  if(!supa){ console.warn('Supabase not available'); return; }
  const { data: { session } } = await supa.auth.getSession();
  currentUser = session?.user || null;
  updateAuthUI();
  if(currentUser){ await pullFromCloud(); startRealtime(); }
  supa.auth.onAuthStateChange(async (_event, session)=>{
    currentUser = session?.user || null;
    updateAuthUI();
    if(currentUser){ await pullFromCloud(); startRealtime(); }
    else stopRealtime();
    renderSearch(); renderTopicsView();
  });
}

function updateAuthUI(){
  const status = document.getElementById('authStatus');
  const email  = document.getElementById('authEmail');
  const send   = document.getElementById('sendLinkBtn');
  const outBtn = document.getElementById('signOutBtn');
  if(currentUser){
    status.textContent = `Signed in as ${currentUser.email || currentUser.id}`;
    email.style.display='none'; send.style.display='none'; outBtn.style.display='inline-block';
  } else {
    status.textContent = 'Not signed in';
    email.style.display='inline-block'; send.style.display='inline-block'; outBtn.style.display='none';
  }
}

async function signInWithMagicLink(){
  const email = document.getElementById('authEmail').value.trim();
  if(!email){ alert('Enter an email.'); return; }
  const { error } = await supa.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
  if(error) alert(error.message); else alert('Check your email for the login link.');
}
async function signOut(){ await supa.auth.signOut(); }

/***** Cloud helpers *****/

// Normalize a record into our local shape
function normalize(rowOrNote){
  // Accept either DB row or local note
  const r = rowOrNote || {};
  // questions: local array; DB keeps question_id as comma string
  const questionsArr = Array.isArray(r.questions)
    ? r.questions.map(String)
    : (typeof r.question_id === 'string'
        ? r.question_id.split(',').map(s=>s.trim()).filter(Boolean)
        : (typeof r.questionId === 'string'
            ? r.questionId.split(',').map(s=>s.trim()).filter(Boolean)
            : []));
  return {
    id: r.id || uid(),
    title: r.title || '',
    // keep a legacy string for compatibility, but use questions[] internally
    questionId: questionsArr.join(', '),
    questions: questionsArr,
    topics: (r.topics || []).map(String),
    refs: r.refs || '',
    body: r.body || '',
    createdAt: r.created_at ? new Date(r.created_at).getTime() : (r.createdAt || Date.now()),
    updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : (r.updatedAt || Date.now())
  };
}

// Pull everything from cloud, merge with local (newer updatedAt wins)
async function pullFromCloud(){
  if(!supa || !currentUser) return;
  const { data, error } = await supa.from('notes').select('*').order('updated_at', { ascending:false });
  if(error){ console.warn('pull error', error); return; }
  const map = new Map(db.map(n=>[n.id,n]));
  for(const r of data){
    const n = normalize(r);
    if(map.has(n.id)){
      const cur = map.get(n.id);
      map.set(n.id, (n.updatedAt > cur.updatedAt) ? n : cur);
    } else {
      map.set(n.id, n);
    }
  }
  db = [...map.values()].sort((a,b)=> b.updatedAt-a.updatedAt);
  saveLocal();
  renderSearch(); renderTopicsView();
}
window.pullFromCloud = pullFromCloud; // allow manual triggering from console if needed

// Upsert a single note to cloud
async function pushOne(note){
  if(!supa || !currentUser) return;
  const payload = {
    id: note.id,
    user_id: currentUser.id,
    title: note.title,
    // store as comma-separated in DB for compatibility
    question_id: (note.questions && note.questions.length) ? note.questions.join(', ') : (note.questionId || ''),
    topics: note.topics,
    refs: note.refs,
    body: note.body,
    created_at: new Date(note.createdAt).toISOString(),
    updated_at: new Date(note.updatedAt).toISOString()
  };
  const { error } = await supa.from('notes').upsert(payload);
  if(error) console.warn('upsert error', error);
}

// Delete in cloud
async function deleteCloud(id){
  if(!supa || !currentUser) return;
  const { error } = await supa.from('notes').delete().eq('id', id);
  if(error) console.warn('delete error', error);
}

// Realtime: keep devices in sync
function startRealtime(){
  if(!supa || !currentUser) return;
  stopRealtime();
  rtChannel = supa
    .channel('notes-changes')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'notes', filter: `user_id=eq.${currentUser.id}` },
      (payload) => {
        const row = payload.new || payload.old;
        if(!row) return;
        if(payload.eventType === 'DELETE'){
          db = db.filter(n => n.id !== row.id);
        } else {
          const n = normalize(row);
          const i = db.findIndex(x => x.id === n.id);
          if(i === -1) db.unshift(n); else db[i] = n;
        }
        db.sort((a,b)=> b.updatedAt - a.updatedAt);
        saveLocal();
        renderSearch(); renderTopicsView();
      }
    )
    .subscribe();
}
function stopRealtime(){
  if(rtChannel && supa){ supa.removeChannel(rtChannel); }
  rtChannel = null;
}

/***** DOM refs *****/
const els = {
  tabs:[...document.querySelectorAll('.tab')],
  panels:{ add: document.getElementById('add'), browse: document.getElementById('browse') },
  title: document.getElementById('title'), qid: document.getElementById('qid'),
  topics: document.getElementById('topics'), refs: document.getElementById('refs'), body: document.getElementById('body'),
  saveBtn: document.getElementById('saveBtn'), resetBtn: document.getElementById('resetBtn'),
  q: document.getElementById('q'), results: document.getElementById('results'),
  topicsCloud: document.getElementById('topicsCloud'), topicList: document.getElementById('topicList'),
  exportBtn: document.getElementById('exportBtn'), importBtn: document.getElementById('importBtn'), importFile: document.getElementById('importFile'),
  nukeBtn: document.getElementById('nukeBtn'),
  sendLinkBtn: document.getElementById('sendLinkBtn'), signOutBtn: document.getElementById('signOutBtn'),
  tpl: document.getElementById('resultTpl')
};

/***** Tabs *****/
els.tabs.forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));
function switchTab(name){
  els.tabs.forEach(t=>{
    const active = t.dataset.tab===name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  Object.entries(els.panels).forEach(([k,sec])=>sec.style.display = (k===name)?'grid':'none');
  if(name==='add') els.title.focus(); else renderTopicsView();
}

/***** Save / Reset *****/
function clearForm(){
  els.title.value=''; els.qid.value=''; els.topics.value=''; els.refs.value=''; els.body.value='';
  editingId = null;
  els.saveBtn.textContent = 'Save Note';
}
els.resetBtn.addEventListener('click', clearForm);
document.addEventListener('keydown',(e)=>{ if(e.ctrlKey && e.key==='Enter'){ e.preventDefault(); saveNote(); }});
els.saveBtn.addEventListener('click', ()=>saveNote()); // single handler only (prevents duplicates)

function parseCSV(input){
  return input.split(',').map(s=>s.trim()).filter(Boolean);
}

function saveNote(){
  const title = els.title.value.trim();
  const questions = parseCSV(els.qid.value); // multiple question IDs supported
  const topics = parseCSV(els.topics.value);
  const refs = els.refs.value.trim();
  const body = els.body.value.trim();
  if(!title && !body){ alert('Please add a title or some note text.'); return; }
  const now = Date.now();

  if(editingId){
    const idx = db.findIndex(n=>n.id===editingId);
    if(idx>-1){
      db[idx] = { ...db[idx],
        title, questions, questionId: questions.join(', '),
        topics, refs, body, updatedAt: now
      };
      pushOne(db[idx]);
    }
  } else {
    const note = {
      id: uid(), title,
      questions, questionId: questions.join(', '),
      topics, refs, body, createdAt: now, updatedAt: now
    };
    db.unshift(note);
    pushOne(note);
  }

  saveLocal();
  clearForm();
  renderSearch();
  renderTopicsView();
}

/***** Search *****/
els.q.addEventListener('input', debounce(renderSearch, 120));
function debounce(fn,ms=150){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
function tokenizeQuery(q){
  const t={ text:[], topic:[], qid:[], title:[] };
  q.split(/\s+/).forEach(p=>{
    if(p.startsWith('topic:')) t.topic.push(p.slice(6).toLowerCase());
    else if(p.startsWith('qid:')) t.qid.push(p.slice(4).toLowerCase());
    else if(p.startsWith('title:')) t.title.push(p.slice(6).toLowerCase());
    else if(p) t.text.push(p.toLowerCase());
  }); return t;
}
function matches(n,t){
  const questionsStr = (n.questions && n.questions.length) ? n.questions.join(' ') : (n.questionId || '');
  const hay=(n.title+' '+questionsStr+' '+n.refs+' '+n.body+' '+(n.topics||[]).join(' ')).toLowerCase();
  if(t.text.length && !t.text.every(x=>hay.includes(x))) return false;
  if(t.title.length && !t.title.every(x=>n.title.toLowerCase().includes(x))) return false;
  if(t.qid.length){
    const inQuestions = (n.questions || (n.questionId ? n.questionId.split(',').map(s=>s.trim()) : []))
      .map(s=>s.toLowerCase());
    if(!t.qid.every(q=> inQuestions.some(s=>s.includes(q)))) return false;
  }
  if(t.topic.length && !t.topic.every(x=> (n.topics||[]).map(s=>s.toLowerCase()).some(k=>k.includes(x)))) return false;
  return true;
}
function renderSearch(){
  const q = els.q.value.trim();
  const t = tokenizeQuery(q);
  const results = (!q? db.slice(0,20) : db.filter(n=>matches(n,t))).slice(0,100);
  els.results.innerHTML='';
  if(!results.length){ els.results.innerHTML='<div class="empty">No matches. Try <b>topic:Calculus</b> or <b>qid:2023</b>.</div>'; return; }
  results.forEach(n=>els.results.appendChild(renderCard(n)));
}
function renderCard(n){
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = n.id;
  node.querySelector('h3').textContent = n.title || '(untitled)';
  const meta = node.querySelector('.meta'); meta.innerHTML='';
  const add=(k,v)=>{ const s=document.createElement('span'); s.textContent=`${k}: ${v}`; meta.appendChild(s); };
  // Per your request: DO NOT show questions in the meta.
  if(n.topics?.length) add('Topics', n.topics.join(', '));
  if(n.refs) add('Refs', n.refs);
  const ts=document.createElement('div'); ts.className='hint'; ts.style.fontSize='11px'; ts.textContent='Saved '+new Date(n.updatedAt).toLocaleString(); meta.appendChild(ts);
  node.querySelector('.text').innerHTML = linkify(escapeHtml(n.body || ''));
  node.querySelector('.edit').addEventListener('click',()=>startEdit(n.id));
  node.querySelector('.del').addEventListener('click',()=>{ if(confirm('Delete this note?')){ deleteNote(n.id); }});
  return node;
}
function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function linkify(s){ return s.replace(/(https?:\/\/[^\s)]+)(?![^<]*>)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>'); }

function startEdit(id){
  const n = db.find(x=>x.id===id); if(!n) return;
  switchTab('add');
  editingId = n.id;
  els.title.value=n.title;
  els.qid.value=(n.questions && n.questions.length) ? n.questions.join(', ') : (n.questionId || '');
  els.topics.value=(n.topics||[]).join(', ');
  els.refs.value=n.refs;
  els.body.value=n.body;
  els.saveBtn.textContent='Update Note';
}

function deleteNote(id){
  db = db.filter(n=>n.id!==id);
  saveLocal();
  deleteCloud(id);
  renderSearch(); renderTopicsView();
}

/***** Topics view *****/
function allTopics(){
  const m=new Map();
  db.forEach(n=>(n.topics||[]).forEach(t=>{ const k=t.trim(); if(!k) return; m.set(k,(m.get(k)||0)+1); }));
  return [...m.entries()].sort((a,b)=> b[1]-a[1] || a[0].localeCompare(b[0]));
}
function renderTopicsView(selected=null){
  const topics=allTopics();
  const cloud = els.topicsCloud; cloud.innerHTML='';
  const chip=(label,count,active=false)=>{ const d=document.createElement('div'); d.className='chip btn'; d.tabIndex=0; d.textContent=count?`${label} (${count})`:label; if(active) d.style.outline='2px solid var(--accent)'; d.onclick=()=>renderTopicsView(label==='All Topics'?null:label); d.onkeydown=(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); d.click(); } }; return d; };
  cloud.appendChild(chip('All Topics', db.length, selected==null));
  topics.forEach(([t,c])=> cloud.appendChild(chip(t,c, selected===t)));

  const list = els.topicList; list.innerHTML='';
  const groups=new Map();
  db.forEach(n=>{
    const listT = (selected? (n.topics||[]).includes(selected) : (n.topics?.length? n.topics : ['(untagged)']))
      ? (n.topics?.length? n.topics : ['(untagged)']) : [];
    listT.forEach(t=>{
      if(selected && t!==selected) return;
      if(!groups.has(t)) groups.set(t, []);
      groups.get(t).push(n);
    });
  });
  [...groups.keys()].sort((a,b)=>a.localeCompare(b)).forEach(topic=>{
    const box=document.createElement('div'); box.className='topic-group';
    const ttl=document.createElement('div'); ttl.className='topic-title'; ttl.textContent=topic; box.appendChild(ttl);
    (groups.get(topic)||[]).sort((a,b)=> b.updatedAt-a.updatedAt).forEach(n=> box.appendChild(renderCard(n)) );
    list.appendChild(box);
  });
  if(groups.size===0){ list.innerHTML='<div class="empty">No notes yet. Add some from the <b>Add Note</b> tab.</div>'; }
}

/***** Export/Import/Local wipe *****/
els.exportBtn.onclick = ()=>{
  const blob = new Blob([JSON.stringify({version:2, exportedAt:Date.now(), notes:db}, null, 2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`jam-notes-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href);
};
els.importBtn.onclick = ()=> els.importFile.click();
els.importFile.onchange = async (e)=>{
  const file=e.target.files?.[0]; if(!file) return; const text=await file.text();
  try{
    const json=JSON.parse(text); const incoming=json.notes||json||[];
    const map=new Map(db.map(n=>[n.id,n]));
    incoming.forEach(n=>{
      const clean=normalize(n);
      if(map.has(clean.id)){
        const cur=map.get(clean.id);
        map.set(clean.id, (clean.updatedAt>cur.updatedAt)?clean:cur);
      } else map.set(clean.id, clean);
    });
    db=[...map.values()].sort((a,b)=>b.updatedAt-a.updatedAt);
    saveLocal(); renderSearch(); renderTopicsView(); alert('Import complete');
  }catch(err){ alert('Import failed: '+err.message); }
  e.target.value='';
};
els.nukeBtn.onclick = ()=>{
  if(prompt('Type DELETE to clear local browser copy:')==='DELETE'){
    db=[]; saveLocal(); renderSearch(); renderTopicsView();
  }
};

/***** Auth buttons *****/
els.sendLinkBtn.onclick = signInWithMagicLink;
els.signOutBtn.onclick = signOut;

/***** Init *****/
loadLocal();
renderSearch();
renderTopicsView();
supaInit();
