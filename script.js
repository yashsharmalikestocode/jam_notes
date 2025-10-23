/* JAM Notes — Supabase Cloud Version
   - Email/password auth with stateful UI (only one auth view visible)
   - Realtime sync + instant UI update on Save
   - Live search in both Add and Browse tabs
   - Topic chips, edit/delete, export/import/nuke
*/

const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

let currentUser = null;
let allNotes = [];
let activeTopicFilter = null;
let debounceTimer = null;

/* ---------- Helpers ---------- */
const $  = (s) => document.querySelector(s);
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

/* ---------- Custom Modal Helpers ---------- */
const modalOverlay = $("#modal-overlay");
const modalMessage = $("#modal-message");
const modalOk = $("#modal-ok");
const modalCancel = $("#modal-cancel");

function showAlert(message) {
  modalMessage.textContent = message;
  modalCancel.style.display = "none";
  modalOk.style.display = "inline-block";
  modalOk.onclick = () => { modalOverlay.style.display = "none"; };
  modalOverlay.style.display = "flex";
}

function showConfirm(message, onConfirm) {
  modalMessage.textContent = message;
  modalCancel.style.display = "inline-block";
  modalOk.style.display = "inline-block";
  
  modalOk.onclick = () => {
    modalOverlay.style.display = "none";
    onConfirm(); // Execute the callback
  };
  modalCancel.onclick = () => {
    modalOverlay.style.display = "none";
  };
  modalOverlay.style.display = "flex";
}


/* ---------- Tabs ---------- */
(function(){
  const tabs=$$(".tab");
  tabs.forEach(btn=>{
    btn.addEventListener("click",()=>{
      tabs.forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const name=btn.dataset.tab;
      $("#add").style.display    = name==="add"?"":"none";
      $("#browse").style.display = name==="browse"?"":"none";
    });
  });
})();

/* ---------- Auth ---------- */
function setAuthState(loggedIn){
  const box = $("#auth");
  box.classList.toggle("logged-in",  loggedIn);
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
    allNotes = [];
    renderResults('#results', []);
    renderResults('#results-browse', []);
    renderTopicList([]);
    teardownRealtime();
  }
}

$("#btn-signup").addEventListener("click", async ()=>{
  const email=$("#email").value.trim(), password=$("#password").value;
  if(!email || !password) return showAlert("Email & password required.");
  const { error } = await supabase.auth.signUp({ email, password });
  if(error) return showAlert(error.message);
  showAlert("Sign up successful. Please check your email for a confirmation link, then log in.");
});

/*
 * --- THIS IS THE FIX ---
 * The login button's only job is to try to sign in.
 * The `onAuthStateChange` listener below will automatically
 * detect the successful login and call `refreshSessionUI()`.
 */
$("#btn-login").addEventListener("click", async ()=>{
  const email=$("#email").value.trim(), password=$("#password").value;
  if(!email || !password) {
    showAlert("Email & password required.");
    return;
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if(error) {
    console.error("Login failed:", error.message);
    showAlert(error.message);
  }
  // On success, onAuthStateChange will fire automatically.
});

$("#btn-logout").addEventListener("click", async ()=>{
  await supabase.auth.signOut();
  // onAuthStateChange will fire automatically.
});

// This listener is the single source of truth for auth state changes.
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
  if (!currentUser) return; // Don't subscribe if logged out
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

function teardownRealtime(){
  if(notesSubscription) supabase.removeChannel(notesSubscription);
  notesSubscription=null;
}

/* ---------- CRUD ---------- */
async function loadNotes(){
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .order("updated_at",{ascending:false})
    .limit(1000);
  if(error){ console.error(error); return showAlert("Failed to load notes."); }
  allNotes = data || [];
  refreshLists();
}

async function saveNote(){
  if(!currentUser) return showAlert("Please log in first.");

  // Check if an item is being edited (by checking if the ID exists in the form, hidden or not)
  // We'll use the title and body to check if we are editing.
  // A better way would be to store the editing ID in a global var.
  // For now, we'll just check if the title exists in our notes.
  // A simpler way: let's add a hidden field.
  // Let's modify `editNote` to store the ID.
  // ...
  // Actually, the original code's `upsert` handles this!
  // But `uuid()` is called every time. This is a bug.
  // `saveNote` should check if we are editing an *existing* note.
  // Let's add a global var `currentEditingId`
  
  // No, let's just use the `upsert` logic. The original `uuid()`
  // was the problem. `editNote` should set a global var.

  // Let's try a simpler fix:
  // When `editNote` is called, store the ID.
  // When `resetForm` is called, clear it.

  let currentEditingId = $("#saveBtn").dataset.editingId || null;

  const payload = {
    id: currentEditingId || uuid(), // Use existing ID or create a new one
    user_id: currentUser.id,
    title: $("#title").value.trim(),
    question_id: $("#qid").value.trim(),
    topics: parseComma($("#topics").value),
    refs: $("#refs").value.trim(),
    body: $("#body").value,
    updated_at: new Date().toISOString() // Force update timestamp
  };

  // Return the new row so we can inject immediately
  const { data, error } = await supabase
    .from("notes")
    .upsert(payload, { onConflict:"id" }) // `upsert` is correct
    .select()
    .single();

  if(error){
    console.error(error);
    $("#saveStatus").textContent="Save failed.";
    return;
  }

  // Instant UI update (no waiting for realtime)
  if (currentEditingId) {
    // Find and update existing
    const i = allNotes.findIndex(n => n.id === currentEditingId);
    if (i > -1) allNotes[i] = data;
    else allNotes.unshift(data); // Fallback
  } else {
    allNotes.unshift(data); // Add as new
  }
  allNotes.sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at)); // Re-sort
  refreshLists();

  $("#saveStatus").textContent="Saved ✔";
  await sleep(900);
  $("#saveStatus").textContent="";
  resetForm();
}

async function deleteNote(id){
  showConfirm("Delete this note?", async () => {
    const { error } = await supabase.from("notes").delete().eq("id", id);
    if(error){ console.error(error); showAlert("Delete failed."); }
    // UI will update via realtime
  });
}

function editNote(n){
  $("#title").value  = n.title || "";
  $("#qid").value    = n.question_id || "";
  $("#topics").value = (n.topics || []).join(", ");
  $("#refs").value   = n.refs || "";
  $("#body").value   = n.body || "";
  $("#saveBtn").dataset.editingId = n.id; // Store the ID for saving
  $("#saveBtn").textContent = "Update Note";
  $("#resetBtn").textContent = "Cancel Edit";

  $$(".tab").forEach(b=>b.classList.remove("active"));
  $("[data-tab='add']").classList.add("active");
  $("#add").style.display = "";
  $("#browse").style.display = "none";
  $("#title").focus();
}

function resetForm(){
  $("#title").value = "";
  $("#qid").value = "";
  $("#topics").value = "";
  $("#refs").value = "";
  $("#body").value = "";
  $("#saveStatus").textContent = "";
  $("#saveBtn").dataset.editingId = ""; // Clear the editing ID
  $("#saveBtn").textContent = "Save Note";
  $("#resetBtn").textContent = "Clear";
}

/* ---------- Search (both tabs) ---------- */
const debounce = (fn,ms)=>{ clearTimeout(debounceTimer); debounceTimer=setTimeout(fn,ms); };

$("#q").addEventListener("input", ()=>debounce(()=>runSearch('#q', '#results'),150));
$("#q-browse").addEventListener("input", ()=>debounce(()=>runSearch('#q-browse', '#results-browse'),150));

document.addEventListener("keydown",(e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="enter") {
    e.preventDefault();
    saveNote();
  }
});
$("#saveBtn").addEventListener("click", saveNote);
$("#resetBtn").addEventListener("click", resetForm);

function parseSearch(q){
  const out = { topic:null, qid:null, title:null, plain:null };
  if(!q) return out;
  const parts=q.toLowerCase().trim().split(/\s+/g);
  const rest=[];
  for(const p of parts){
    if(p.startsWith("topic:")) out.topic=p.slice(6);
    else if(p.startsWith("qid:")) out.qid=p.slice(4);
    else if(p.startsWith("title:")) out.title=p.slice(6);
    else rest.push(p);
  }
  out.plain = rest.join(" ").trim() || null;
  return out;
}

function filterNotes(notes, query, topicFilter){
  if(!notes.length) return [];
  const p=parseSearch(query);
  let res=notes;

  if(topicFilter){
    res = res.filter(n => (n.topics||[]).some(t => t.toLowerCase()===topicFilter.toLowerCase()));
  }
  if(p.topic){
    res = res.filter(n => (n.topics||[]).some(t => t.toLowerCase().includes(p.topic)));
  }
  if(p.qid){
    res = res.filter(n => (n.question_id||"").toLowerCase().includes(p.qid));
  }
  if(p.title){
    res = res.filter(n => (n.title||"").toLowerCase().includes(p.title));
  }
  if(p.plain){
    const s = p.plain;
    res = res.filter(n =>
      (n.title||"").toLowerCase().includes(s) ||
      (n.body||"").toLowerCase().includes(s) ||
      (n.refs||"").toLowerCase().includes(s) ||
      (n.question_id||"").toLowerCase().includes(s) ||
      (n.topics||[]).some(t => t.toLowerCase().includes(s))
    );
  }
  return res.slice(0,100);
}

function runSearch(inputSel, targetSel){
  const q = $(inputSel).value.trim();
  // Don't run search if topic filter is active and we're in the 'add' tab search
  const topicFilterActive = !!activeTopicFilter;
  if (targetSel === '#results' && topicFilterActive) {
      $(targetSel).innerHTML = `<div class="empty">Topic filter active. Clear it in "Browse" tab to search all notes.</div>`;
      return;
  }
  const list = filterNotes(allNotes, q, targetSel === '#results' ? null : activeTopicFilter);
  renderResults(targetSel, list);
}

/* ---------- Rendering ---------- */
function renderResults(targetSel, list){
  const container = $(targetSel);
  if(!container) return;
  const q = $(targetSel === '#results' ? '#q' : '#q-browse').value.trim();

  if(!list.length && q){
    container.innerHTML = `<div class="empty">No matches for <b>${escapeHtml(q)}</b>.</div>`;
    return;
  }
  if (!list.length && !q) {
    container.innerHTML = (targetSel === '#results') 
      ? `<div class="empty">Search results will appear here.</div>`
      : `<div class="empty">Search results will appear here. Clear search to see all notes.</div>`;
    return;
  }

  container.innerHTML = list.map(n=>{
    const topics=(n.topics||[]).map(t=>`<span>${escapeHtml(t)}</span>`).join(" ");
    const noteJson = escapeAttr(JSON.stringify(n));
    return `<div class="result">
      <h3>${escapeHtml(n.title||"Untitled")}</h3>
      <div class="meta">
        <span>QID: ${escapeHtml(n.question_id||"n/a")}</span>
        <span class="meta-topics">${topics || '<span>(untagged)</span>'}</span>
      	<span>${new Date(n.updated_at).toLocaleString()}</span>
      </div>
      <div class="spacer"></div>
      <div class="text">${linkify(escapeHtml(n.body||""))}</div>
      <div class="spacer"></div>
      <div class="inline-actions">
        <button class="btn small secondary" onclick='editNote(${noteJson})'>Edit</button>
        <button class="btn small warn" onclick='deleteNote("${n.id}")'>Delete</button>
      </div>
    </div>`;
  }).join("");
}

/* Topic chips + grouped list */
function buildTopicChips(notes){
  const chips=$("#topicsCloud");
  const set=new Set();
  notes.forEach(n=>(n.topics||[]).forEach(t=>set.add(t)));
  const arr=[...set].sort((a,b)=>a.localeCompare(b));
  chips.innerHTML = arr.map(t=>`<span class="chip btn ${t===activeTopicFilter?'active':''}" data-chip="${escapeAttr(t)}">${escapeHtml(t)}</span>`).join("") || `<span class="hint">No topics yet.</span>`;
  
  // Add "Clear" button if a filter is active
  if (activeTopicFilter) {
    chips.innerHTML += ` <button class="btn small secondary" id="clear-topic-filter">Clear Filter</button>`;
    $("#clear-topic-filter").addEventListener("click", () => {
      activeTopicFilter = null;
      refreshLists();
    });
  }

  chips.querySelectorAll("[data-chip]").forEach(ch=>{
    ch.addEventListener("click", ()=>{
      activeTopicFilter = (activeTopicFilter===ch.dataset.chip) ? null : ch.dataset.chip;
      refreshLists();
    });
  });
}

function renderTopicList(notes){
  const wrap=$("#topicList");
  const q = $('#q-browse').value.trim();
  
  // Filter notes based on search *before* grouping
  const filteredNotes = filterNotes(notes, q, activeTopicFilter);

  if(!filteredNotes.length){ 
    if (q) {
      wrap.innerHTML = `<div class="empty">No notes match your search.</div>`;
    } else if (activeTopicFilter) {
      wrap.innerHTML = `<div class="empty">No notes found for topic: <b>${escapeHtml(activeTopicFilter)}</b>.</div>`;
    } else {
      wrap.innerHTML = `<div class="empty">No notes yet.</div>`;
    }
    return;
  }

  const map=new Map();
  filteredNotes.forEach(n=>{
    (n.topics&&n.topics.length ? n.topics : ["(untagged)"]).forEach(t=>{
      // If a topic filter is active, only show that group
      if(activeTopicFilter && t.toLowerCase()!==activeTopicFilter.toLowerCase()) return;
      if(!map.has(t)) map.set(t,[]);
      map.get(t).push(n);
    });
  });

  wrap.innerHTML = [...map.entries()]
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([topic,items])=>{
      const rows = items.map(n=>{
        const noteJson = escapeAttr(JSON.stringify(n));
        return `
        <div class="result">
          <h3>${escapeHtml(n.title||"Untitled")}</h3>
          <div class="meta"><span>QID: ${escapeHtml(n.question_id||"n/a")}</span><span>${new Date(n.updated_at).toLocaleString()}</span></div>
          <div class="text">${linkify(escapeHtml(n.body||""))}</div>
          <div class="inline-actions">
            <button class="btn small secondary" onclick='editNote(${noteJson})'>Edit</button>
            <button class="btn small warn" onclick='deleteNote("${n.id}")'>Delete</button>
          </div>
        </div>`
      }).join("");

      return `<div class="topic-group">
        <div class="topic-title">${escapeHtml(topic)}</div>
        <div class="spacer"></div>
        ${rows}
      </div>`;
    }).join("");
}

/* ---------- Tools ---------- */
$("#exportBtn").addEventListener("click", ()=>{
  if(!currentUser) return showAlert("Log in first.");
  const data = JSON.stringify({ exported_at:new Date().toISOString(), notes: allNotes }, null, 2);
  const blob = new Blob([data], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download="jam-notes-export.json"; a.click();
  URL.revokeObjectURL(url);
});

$("#importBtn").addEventListener("click", ()=>$("#importFile").click());
$("#importFile").addEventListener("change", async (e)=>{
  if(!currentUser) return showAlert("Log in first.");
  const f=e.target.files?.[0]; if(!f) return;
  let parsed; try{ parsed=JSON.parse(await f.text()); }catch{ return showAlert("Invalid JSON."); }
  const incoming=parsed.notes||[]; if(!incoming.length) return showAlert("No notes found.");
  const map=new Map(allNotes.map(n=>[n.id,n])); const upserts=[];
  for(const n of incoming){
    if(!n.id) continue;
    const ex = map.get(n.id);
    if(!ex || new Date(n.updated_at) > new Date(ex.updated_at)){
      upserts.push({ id:n.id, user_id: currentUser.id, title:n.title||"", question_id:n.question_id||"", topics:n.topics||[], refs:n.refs||"", body:n.body||"", updated_at: n.updated_at || new Date().toISOString() });
    }
  }
  if(!upserts.length) return showAlert("Nothing to import (all notes are same or older).");
  const { error } = await supabase.from("notes").upsert(upserts, { onConflict:"id" });
  if(error){ console.error(error); return showAlert("Import failed."); }
  showAlert(`Import complete. ${upserts.length} notes merged.`);
  e.target.value = null; // Reset file input
  await loadNotes(); // Manually refresh after import
});

$("#nukeBtn").addEventListener("click", async ()=>{
  if(!currentUser) return showAlert("Log in first.");
  showConfirm("This will delete ALL your notes permanently. Are you sure?", async () => {
    const { error } = await supabase.from("notes").delete().eq("user_id", currentUser.id);
    if(error){ console.error(error); return showAlert("Delete failed."); }
    showAlert("All notes deleted.");
    // UI will update via realtime
  });
});

/* ---------- Refresh both views ---------- */
function refreshLists(){
  buildTopicChips(allNotes);
  // Only re-render lists/searches that are relevant
  runSearch('#q', '#results'); // This search is in the 'Add' tab
  runSearch('#q-browse', '#results-browse'); // This is the search in the 'Browse' tab
  renderTopicList(allNotes); // This is the main list in the 'Browse' tab
}

/* ---------- Boot ---------- */
// Initial call to set UI state (logged out or logged in)
refreshSessionUI();
