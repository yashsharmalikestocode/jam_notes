/* JAM Notes — Supabase Cloud Version (instant save + dual live search) */

const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

let currentUser = null;
let allNotes = [];
let activeTopicFilter = null;
let debounceTimer = null;

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

function uuid(){ return 'note_' + crypto.randomUUID(); }
function parseComma(s){ return s ? s.split(',').map(x=>x.trim()).filter(Boolean) : []; }
function escapeHtml(s){ return (s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function escapeAttr(s){ return escapeHtml(s).replaceAll("'","&#39;"); }
function linkify(text){
  const url = /(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/gim;
  return (text||'').replace(url,(m)=>`<a class="inline" target="_blank" rel="noopener" href="${m.startsWith('http')?m:'https://'+m}">${m}</a>`);
}

/* Tabs */
(function(){
  const tabs=$$(".tab");
  tabs.forEach(btn=>{
    btn.addEventListener("click",()=>{
      tabs.forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const name=btn.dataset.tab;
      $("#add").style.display    = name==="add"?"":"none";
      $("#browse").style.display = name==="browse"?"":"none";
    });
  });
})();

/* ---------- AUTH ---------- */
function setAuthState(loggedIn){
  const box = $("#auth");
  box.classList.toggle("logged-in",  loggedIn);
  box.classList.toggle("logged-out", !loggedIn);
}
async function refreshSessionUI(){
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user ?? null;
  if(currentUser){
    $("#session-email").textContent = `Signed in as ${currentUser.email}`;
    setAuthState(true);
    await afterLoginBoot();
  }else{
    $("#session-email").textContent = "";
    setAuthState(false);
    allNotes=[]; renderResults('#results',[]); renderResults('#results-browse',[]); renderTopicList([]);
    teardownRealtime();
  }
}
$("#btn-signup").addEventListener("click", async ()=>{
  const email=$("#email").value.trim(), password=$("#password").value;
  if(!email || !password) return alert("Email & password required.");
  const { error } = await supabase.auth.signUp({ email, password });
  if(error) return alert(error.message);
  alert("Sign up successful. Confirm email if required, then log in.");
});
$("#btn-login").addEventListener("click", async ()=>{
  const email=$("#email").value.trim(), password=$("#password").value;
  if(!email || !password) return alert("Email & password required.");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if(error) return alert(error.message);
  currentUser = data.user ?? data.session?.user ?? null;
  if(currentUser){
    $("#session-email").textContent = `Signed in as ${currentUser.email}`;
    setAuthState(true);
    await afterLoginBoot();
  }else{
    await refreshSessionUI();
  }
});
$("#btn-logout").addEventListener("click", async ()=>{ await supabase.auth.signOut(); await refreshSessionUI(); });
supabase.auth.onAuthStateChange(()=>refreshSessionUI());

/* ---------- Boot & Realtime ---------- */
let notesSubscription=null;
async function afterLoginBoot(){
  await loadNotes();
  buildTopicChips(allNotes);
  renderTopicList(allNotes);
  setupRealtime();
}
function setupRealtime(){
  teardownRealtime();
  notesSubscription = supabase
    .channel("notes-realtime")
    .on("postgres_changes",
      { event:"*", schema:"public", table:"notes", filter:`user_id=eq.${currentUser.id}` },
      (payload)=>{
        if(payload.eventType==="INSERT") allNotes.unshift(payload.new);
        else if(payload.eventType==="UPDATE"){
          const i = allNotes.findIndex(n=>n.id===payload.new.id);
          if(i>-1) allNotes[i]=payload.new;
        } else if(payload.eventType==="DELETE"){
          allNotes = allNotes.filter(n=>n.id!==payload.old.id);
        }
        refreshLists();
      }
    ).subscribe();
}
function teardownRealtime(){ if(notesSubscription) supabase.removeChannel(notesSubscription); notesSubscription=null; }

/* ---------- CRUD ---------- */
async function loadNotes(){
  const { data, error } = await supabase.from("notes").select("*").order("updated_at",{ascending:false}).limit(1000);
  if(error){ console.error(error); return alert("Failed to load notes."); }
  allNotes = data || [];
  refreshLists();
}

async function saveNote(){
  if(!currentUser) return alert("Please log in first.");

  const payload = {
    id: uuid(),
    user_id: currentUser.id,
    title: $("#title").value.trim(),
    question_id: $("#qid").value.trim(),
    topics: parseComma($("#topics").value),
    refs: $("#refs").value.trim(),
    body: $("#body").value
  };

  // Request the row back so we can inject it immediately
  const { data, error } = await supabase.from("notes").upsert(payload, { onConflict:"id" }).select().single();
  if(error){ console.error(error); $("#saveStatus").textContent="Save failed."; return; }

  // 🔥 Instant UI update (no waiting for realtime)
  allNotes.unshift(data);
  refreshLists();

  $("#saveStatus").textContent="Saved ✔"; await sleep(900); $("#saveStatus").textContent="";
  resetForm();
}

async function deleteNote(id){
  if(!confirm("Delete this note?")) return;
  const { error } = await supabase.from("notes").delete().eq("id", id);
  if(error){ console.error(error); alert("Delete failed."); }
}

function editNote(n){
  $("#title").value  = n.title || "";
  $("#qid").value    = n.question_id || "";
  $("#topics").value = (n.topics || []).join(", ");
  $("#refs").value   = n.refs || "";
  $("#body").value   = n.body || "";
  $$(".tab").forEach(b=>b.classList.remove("active"));
  $("[data-tab='add']").classList.add("active");
  $("#add").style.display = "";
  $("#browse").style.display = "none";
}
function resetForm(){ $("#title").value = $("#qid").value = $("#topics").value = $("#refs").value = $("#body").value = ""; $("#saveStatus").textContent=""; }

/* ---------- Search (Add tab + Browse tab) ---------- */
const debounce = (fn,ms)=>{ clearTimeout(debounceTimer); debounceTimer=setTimeout(fn,ms); };

$("#q").addEventListener("input", ()=>debounce(()=>runSearch('#q', '#results'),150));
$("#q-browse").addEventListener("input", ()=>debounce(()=>runSearch('#q-browse', '#results-browse'),150));

document.addEventListener("keydown",(e)=>{ if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="enter") saveNote(); });
$("#saveBtn").addEventListener("click", saveNote);
$("#resetBtn").addEventListener("click", resetForm);

function parseSearch(q){
  const out = { topic:null, qid:null, title:null, plain:null };
  if(!q) return out; const parts=q.toLowerCase().trim().split(/\s+/g); const rest=[];
  for(const p of parts){
    if(p.startsWith("topic:")) out.topic=p.slice(6);
    else if(p.startsWith("qid:")) out.qid=p.slice(4);
    else if(p.startsWith("title:")) out.title=p.slice(6);
    else rest.push(p);
  }
  out.plain = rest.join(" ").trim() || null; return out;
}
function filterNotes(notes, query, topicFilter){
  if(!notes.length) return [];
  const p=parseSearch(query); let res=notes;
  if(topicFilter) res=res.filter(n=>(n.topics||[]).some(t=>t.toLowerCase()===topicFilter.toLowerCase()));
  if(p.topic) res=res.filter(n=>(n.topics||[]).some(t=>t.toLowerCase().includes(p.topic)));
  if(p.qid) res=res.filter(n=>(n.question_id||"").toLowerCase().includes(p.qid));
  if(p.title) res=res.filter(n=>(n.title||"").toLowerCase().includes(p.title));
  if(p.plain){ const s=p.plain;
    res=res.filter(n=>(n.title||"").toLowerCase().includes(s) ||
                      (n.body||"").toLowerCase().includes(s) ||
                      (n.refs||"").toLowerCase().includes(s) ||
                      (n.question_id||"").toLowerCase().includes(s) ||
                      (n.topics||[]).some(t=>t.toLowerCase().includes(s)));
  }
  return res.slice(0,100);
}

function runSearch(inputSel, targetSel){
  const q = $(inputSel).value.trim();
  const list = filterNotes(allNotes, q, activeTopicFilter);
  renderResults(targetSel, list);
}

/* ---------- Rendering ---------- */
function renderResults(targetSel, list){
  const container = $(targetSel);
  if(!container) return;
  if(!list.length){
    container.innerHTML = `<div class="empty">No matches. Try <b>topic:Algebra</b> or <b>qid:2023</b>.</div>`;
    return;
  }
  container.innerHTML = list.map(n=>{
    const topics=(n.topics||[]).map(t=>`<span>${escapeHtml(t)}</span>`).join(" ");
    return `<div class="result">
      <h3>${escapeHtml(n.title||"Untitled")}</h3>
      <div class="meta">
        <span>QID: ${escapeHtml(n.question_id||"")}</span>
        <span>${topics}</span>
        <span>${new Date(n.updated_at).toLocaleString()}</span>
      </div>
      <div class="spacer"></div>
      <div class="text">${linkify(escapeHtml(n.body||""))}</div>
      <div class="spacer"></div>
      <div class="inline-actions">
        <button class="btn small secondary" onclick='editNote(${JSON.stringify(n).replace(/"/g,"&quot;")})'>Edit</button>
        <button class="btn small warn" onclick='deleteNote("${n.id}")'>Delete</button>
      </div>
    </div>`;
  }).join("");
}

/* Topic chips + grouped list (unchanged UI) */
function buildTopicChips(notes){
  const chips=$("#topicsCloud"); const set=new Set();
  notes.forEach(n=>(n.topics||[]).forEach(t=>set.add(t)));
  const arr=[...set].sort((a,b)=>a.localeCompare(b));
  chips.innerHTML = arr.map(t=>`<span class="chip ${t===activeTopicFilter?'active':''}" data-chip="${escapeAttr(t)}">${escapeHtml(t)}</span>`).join("") || `<span class="hint">No topics yet.</span>`;
  chips.querySelectorAll("[data-chip]").forEach(ch=>{
    ch.addEventListener("click", ()=>{
      activeTopicFilter = (activeTopicFilter===ch.dataset.chip) ? null : ch.dataset.chip;
      buildTopicChips(allNotes);
      runSearch('#q', '#results');
      runSearch('#q-browse', '#results-browse');
      renderTopicList(allNotes);
    });
  });
}

function renderTopicList(notes){
  const wrap=$("#topicList");
  if(!notes.length){ wrap.innerHTML = `<div class="empty">No notes yet.</div>`; return; }
  const map=new Map();
  notes.forEach(n=>{
    (n.topics&&n.topics.length ? n.topics : ["(untagged)"]).forEach(t=>{
      if(activeTopicFilter && t.toLowerCase()!==activeTopicFilter.toLowerCase()) return;
      if(!map.has(t)) map.set(t,[]);
      map.get(t).push(n);
    });
  });
  wrap.innerHTML = [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([topic,items])=>{
    const rows = items.map(n=>`
      <div class="result">
        <h3>${escapeHtml(n.title||"Untitled")}</h3>
        <div class="meta"><span>QID: ${escapeHtml(n.question_id||"")}</span><span>${new Date(n.updated_at).toLocaleString()}</span></div>
        <div class="text">${linkify(escapeHtml(n.body||""))}</div>
        <div class="inline-actions">
          <button class="btn small secondary" onclick='editNote(${JSON.stringify(n).replace(/"/g,"&quot;")})'>Edit</button>
          <button class="btn small warn" onclick='deleteNote("${n.id}")'>Delete</button>
        </div>
      </div>`).join("");
    return `<div class="topic-group"><div class="topic-title">${escapeHtml(topic)}</div><div class="spacer"></div>${rows}</div>`;
  }).join("");
}

/* Tools */
$("#exportBtn").addEventListener("click", ()=>{
  if(!currentUser) return alert("Log in first.");
  const data = JSON.stringify({ exported_at:new Date().toISOString(), notes: allNotes }, null, 2);
  const blob = new Blob([data], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download="jam-notes-export.json"; a.click();
  URL.revokeObjectURL(url);
});
$("#importBtn").addEventListener("click", ()=>$("#importFile").click());
$("#importFile").addEventListener("change", async (e)=>{
  if(!currentUser) return alert("Log in first.");
  const f=e.target.files?.[0]; if(!f) return;
  let parsed; try{ parsed=JSON.parse(await f.text()); }catch{ return alert("Invalid JSON."); }
  const incoming=parsed.notes||[]; if(!incoming.length) return alert("No notes found.");
  const map=new Map(allNotes.map(n=>[n.id,n])); const upserts=[];
  for(const n of incoming){
    if(!n.id) continue;
    const ex = map.get(n.id);
    if(!ex || new Date(n.updated_at) > new Date(ex.updated_at)){
      upserts.push({ id:n.id, user_id: currentUser.id, title:n.title||"", question_id:n.question_id||"", topics:n.topics||[], refs:n.refs||"", body:n.body||"" });
    }
  }
  if(!upserts.length) return alert("Nothing to import.");
  const { error } = await supabase.from("notes").upsert(upserts, { onConflict:"id" });
  if(error){ console.error(error); return alert("Import failed."); }
  alert("Import complete.");
});
$("#nukeBtn").addEventListener("click", async ()=>{
  if(!currentUser) return alert("Log in first.");
  if(!confirm("Delete ALL notes?")) return;
  const { error } = await supabase.from("notes").delete().eq("user_id", currentUser.id);
  if(error){ console.error(error); return alert("Delete failed."); }
  alert("All notes deleted.");
});

/* Helper: refresh both lists/searches */
function refreshLists(){
  buildTopicChips(allNotes);
  renderTopicList(allNotes);
  runSearch('#q', '#results');
  runSearch('#q-browse', '#results-browse');
}

/* Boot */
refreshSessionUI();
