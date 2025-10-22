// JAM Notes (revised two-panel version)
// Paste your Supabase and Gemini keys below

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const GEMINI_API_KEY = "AIzaSyBe5HbVdaMPFJ6aPvi2GoPMLAgchZ_jf_U";  // <--- add your key

let currentUser = null;
let allNotes = [];
let activeTopicFilter = null;
let debounceTimer = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function uuid(){return "note_"+crypto.randomUUID();}
function parseComma(s){return s? s.split(",").map(x=>x.trim()).filter(Boolean):[];}
function escapeHtml(s){return (s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
function linkify(t){
  return t.replace(/(https?:\/\/[^\s]+)/g, m => `<a class="inline" target="_blank" href="${m}">${m}</a>`);
}

// Tabs
$$(".tab").forEach(btn=>{
  btn.onclick=()=>{
    $$(".tab").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    $$(".tab-panel").forEach(p=>p.classList.remove("active"));
    $("#"+btn.dataset.tab).classList.add("active");
  };
});

// ---------- AUTH ----------
async function refreshUI(){
  const {data}=await supabase.auth.getSession();
  currentUser=data.session?.user??null;
  $("#auth-fields").classList.toggle("hidden",!!currentUser);
  $("#auth-session").classList.toggle("hidden",!currentUser);
  if(currentUser){
    $("#session-email").textContent=`Signed in as ${currentUser.email}`;
    loadNotes();
  } else {
    $("#session-email").textContent="";
    $("#notes-list").innerHTML="";
  }
}

$("#btn-signup").onclick=async()=>{
  const email=$("#email").value,password=$("#password").value;
  const {error}=await supabase.auth.signUp({email,password});
  if(error)alert(error.message);else alert("Check email to confirm, then login.");
};
$("#btn-login").onclick=async()=>{
  const {error}=await supabase.auth.signInWithPassword({email:$("#email").value,password:$("#password").value});
  if(error)alert(error.message);else refreshUI();
};
$("#btn-logout").onclick=async()=>{await supabase.auth.signOut();refreshUI();};
supabase.auth.onAuthStateChange(refreshUI);

// ---------- NOTES ----------
$("#btn-save-note").onclick=saveNote;
$("#btn-clear-form").onclick=()=>["title","topics","qids","refs","body"].forEach(id=>$("#note-"+id).value="");
document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter")saveNote();});

async function saveNote(){
  if(!currentUser)return alert("Login first");
  const payload={
    id:$("#note-id")?.value||uuid(),
    user_id:currentUser.id,
    title:$("#note-title").value.trim(),
    topics:parseComma($("#note-topics").value),
    question_id:$("#note-qids").value.trim(),
    refs:$("#note-refs").value.trim(),
    body:$("#note-body").value
  };
  const {error}=await supabase.from("notes").upsert(payload);
  if(error){console.error(error);$("#note-status").textContent="Save failed";}
  else{$("#note-status").textContent="Saved ✔";await sleep(1200);$("#note-status").textContent="";}
}

async function loadNotes(){
  const {data,error}=await supabase.from("notes").select("*").order("updated_at",{ascending:false}).limit(200);
  if(error){console.error(error);return;}
  allNotes=data;renderNotes(allNotes);buildChips(allNotes);
}

function renderNotes(list){
  const wrap=$("#notes-list");
  if(!list.length){wrap.innerHTML="<p class='muted'>No notes yet.</p>";return;}
  wrap.innerHTML=list.map(n=>{
    const t=(n.topics||[]).map(x=>`<span class='topic'>${x}</span>`).join(" ");
    return `<div class='note-card'>
      <h3>${escapeHtml(n.title||"Untitled")}</h3>
      <div class='meta'>QID: ${escapeHtml(n.question_id||"")}</div>
      <div class='topics'>${t}</div>
      <pre>${linkify(escapeHtml(n.body||""))}</pre>
      <div class='meta'>${new Date(n.updated_at).toLocaleString()}</div>
      <div class='btns'>
        <button onclick='edit("${n.id}")'>Edit</button>
        <button class='danger' onclick='del("${n.id}")'>Delete</button>
      </div>
    </div>`;
  }).join("");
}

function edit(id){
  const n=allNotes.find(x=>x.id===id);if(!n)return;
  $("#note-title").value=n.title||"";
  $("#note-topics").value=(n.topics||[]).join(", ");
  $("#note-qids").value=n.question_id||"";
  $("#note-refs").value=n.refs||"";
  $("#note-body").value=n.body||"";
}
async function del(id){
  if(!confirm("Delete note?"))return;
  await supabase.from("notes").delete().eq("id",id);
  loadNotes();
}

function buildChips(notes){
  const box=$("#topic-chips");
  const topics=[...new Set(notes.flatMap(n=>n.topics||[]))];
  box.innerHTML=topics.map(t=>`<span class='chip' data-t='${t}'>${t}</span>`).join("");
  box.querySelectorAll(".chip").forEach(c=>{
    c.onclick=()=>{activeTopicFilter=c.dataset.t===activeTopicFilter?null:c.dataset.t;runSearch();}
  });
}

$("#search-input").oninput=()=>{clearTimeout(debounceTimer);debounceTimer=setTimeout(runSearch,150);};
function runSearch(){
  let q=$("#search-input").value.toLowerCase(),res=allNotes;
  if(activeTopicFilter)res=res.filter(n=>n.topics?.includes(activeTopicFilter));
  if(q.includes("topic:")){const t=q.split("topic:")[1].trim();res=res.filter(n=>n.topics?.some(x=>x.toLowerCase().includes(t)));}
  else if(q.includes("qid:")){const id=q.split("qid:")[1].trim();res=res.filter(n=>(n.question_id||"").toLowerCase().includes(id));}
  else if(q.includes("title:")){const tt=q.split("title:")[1].trim();res=res.filter(n=>(n.title||"").toLowerCase().includes(tt));}
  else if(q){res=res.filter(n=>(n.title+n.body).toLowerCase().includes(q));}
  renderNotes(res.slice(0,100));
}

// ---------- CHAT ----------
$("#btn-send").onclick=sendMsg;
$("#btn-load-chat").onclick=loadChat;
$("#btn-clear-chat").onclick=clearChat;

async function askGemini(prompt){
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})
  });
  const d=await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text||"No
