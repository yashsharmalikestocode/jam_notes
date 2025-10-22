/* JAM Notes — Supabase email+password auth + cloud notes
   Visuals follow your provided template exactly. No local storage. */

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ------------ State ------------ */
let currentUser = null;
let allNotes = [];              // in-memory only (no localStorage)
let currentEditingId = null;    // which note we are editing
let debounceHandle = null;
let activeChip = null;

/* ------------ Shortcuts ------------ */
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uid  = () => "note_" + crypto.randomUUID();

function esc(s){return (s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");}
function linkify(t){
  return (t||"").replace(/(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/g, m => {
    const href = m.startsWith("http") ? m : `https://${m}`;
    return `<a class="inline" href="${href}" target="_blank" rel="noopener">${m}</a>`;
  });
}
function parseCSV(s){return !s?[]:s.split(",").map(x=>x.trim()).filter(Boolean);}

/* ------------ Tabs ------------ */
(function initTabs(){
  $$(".tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      $$(".tab").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $$("#add, #browse").forEach(() => {});
      $("#add").style.display    = tab==="add"    ? "" : "none";
      $("#browse").style.display = tab==="browse" ? "" : "none";
    });
  });
})();

/* ------------ Auth UI ------------ */
async function refreshSessionUI(){
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user ?? null;

  $("#auth-fields").classList.toggle("hidden", !!currentUser);
  $("#auth-session").classList.toggle("hidden", !currentUser);

  if (currentUser){
    $("#session-email").textContent = `Signed in as ${currentUser.email}`;
    await bootAfterLogin();
  } else {
    $("#session-email").textContent = "";
    teardownRealtime();
    allNotes = [];
    renderSearchResults([]);
    renderTopicGroups([]);
  }
}

$("#btn-signup").addEventListener("click", async ()=>{
  const email = $("#email").value.trim();
  const password = $("#password").value;
  if(!email || !password) return alert("Email and password required.");
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return alert(error.message);
  alert("Sign up OK. Confirm email if required, then login.");
});

$("#btn-login").addEventListener("click", async ()=>{
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return alert(error.message);
  await refreshSessionUI();
});

$("#btn-logout").addEventListener("click", async ()=>{
  await supabase.auth.signOut();
  await refreshSessionUI();
});

supabase.auth.onAuthStateChange(()=>refreshSessionUI());

/* ------------ Realtime ------------ */
let notesChannel = null;

function setupRealtime(){
  teardownRealtime();
  notesChannel = supabase
    .channel("notes-rt")
    .on("postgres_changes",
      { event: "*", schema: "public", table: "notes", filter: `user_id=eq.${currentUser.id}` },
      payload => {
        if (payload.eventType === "INSERT"){
          allNotes.unshift(payload.new);
        } else if (payload.eventType === "UPDATE"){
          const i = allNotes.findIndex(n=>n.id===payload.new.id);
          if (i>-1) allNotes[i] = payload.new;
        } else if (payload.eventType === "DELETE"){
          allNotes = allNotes.filter(n=>n.id!==payload.old.id);
        }
        buildTopicChips(allNotes);
        runSearch();
        renderTopicGroups(allNotes);
      }
    )
    .subscribe();
}
function teardownRealtime(){
  if (notesChannel) supabase.removeChannel(notesChannel);
  notesChannel = null;
}

/* ------------ Boot after login ------------ */
async function bootAfterLogin(){
  await loadNotes();
  buildTopicChips(allNotes);
  renderTopicGroups(allNotes);
  setupRealtime();
}

/* ------------ CRUD ------------ */
async function loadNotes(){
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error){ console.error(error); return alert("Failed to load notes."); }
  allNotes = data || [];
  runSearch();
}

async function saveNote(){
  if (!currentUser) return alert("Please login first.");
  const payload = {
    id: currentEditingId || uid(),
    user_id: currentUser.id,
    title: $("#title").value.trim(),
    question_id: $("#qid").value.trim(),
    topics: parseCSV($("#topics").value),
    refs: $("#refs").value.trim(),
    body: $("#body").value
  };

  const { error } = await supabase.from("notes").upsert(payload, { onConflict: "id" });
  if (error){ console.error(error); $("#saveStatus").textContent = "Save failed."; return; }
  currentEditingId = payload.id;
  $("#saveStatus").textContent = "Saved ✔";
  await sleep(1200); $("#saveStatus").textContent = "";
}

async function deleteNote(id){
  if (!confirm("Delete this note?")) return;
  const { error } = await supabase.from("notes").delete().eq("id", id);
  if (error){ console.error(error); alert("Delete failed."); }
}

function startEdit(note){
  currentEditingId = note.id;
  $("#title").value  = note.title || "";
  $("#qid").value    = note.question_id || "";
  $("#topics").value = (note.topics || []).join(", ");
  $("#refs").value   = note.refs || "";
  $("#body").value   = note.body || "";
  // Switch to Add tab
  $$(".tab").forEach(t=>t.classList.remove("active"));
  $("[data-tab='add']").classList.add("active");
  $("#add").style.display=""; $("#browse").style.display="none";
}

function resetForm(){
  currentEditingId = null;
  $("#title").value = $("#qid").value = $("#topics").value = $("#refs").value = $("#body").value = "";
  $("#saveStatus").textContent = "";
}

/* ------------ Search ------------ */
$("#q").addEventListener("input", ()=>{
  clearTimeout(debounceHandle);
  debounceHandle = setTimeout(runSearch, 160);
});

document.addEventListener("keydown", (e)=>{
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="enter") saveNote();
});

$("#saveBtn").addEventListener("click", saveNote);
$("#resetBtn").addEventListener("click", resetForm);

function parseQuery(q){
  const out = { topic:null, qid:null, title:null, plain:null };
  if (!q) return out;
  const parts = q.toLowerCase().trim().split(/\s+/);
  const leftover = [];
  for (const p of parts){
    if (p.startsWith("topic:")) out.topic = p.slice(6);
    else if (p.startsWith("qid:")) out.qid = p.slice(4);
    else if (p.startsWith("title:")) out.title = p.slice(6);
    else leftover.push(p);
  }
  out.plain = leftover.join(" ").trim() || null;
  return out;
}

function runSearch(){
  const q = $("#q").value || "";
  const filters = parseQuery(q);
  let list = allNotes;

  if (activeChip){
    list = list.filter(n => (n.topics||[]).some(t=>t.toLowerCase()===activeChip.toLowerCase()));
  }
  if (filters.topic){
    const s = filters.topic;
    list = list.filter(n => (n.topics||[]).some(t=>t.toLowerCase().includes(s)));
  }
  if (filters.qid){
    const s = filters.qid;
    list = list.filter(n => (n.question_id||"").toLowerCase().includes(s));
  }
  if (filters.title){
    const s = filters.title;
    list = list.filter(n => (n.title||"").toLowerCase().includes(s));
  }
  if (filters.plain){
    const s = filters.plain;
    list = list.filter(n =>
      (n.title||"").toLowerCase().includes(s) ||
      (n.body||"").toLowerCase().includes(s) ||
      (n.refs||"").toLowerCase().includes(s) ||
      (n.question_id||"").toLowerCase().includes(s) ||
      (n.topics||[]).some(t=>t.toLowerCase().includes(s))
    );
  }
  renderSearchResults(list.slice(0,100));
}

/* ------------ Search results UI ------------ */
function renderSearchResults(list){
  const container = $("#results");
  const tpl = $("#resultTpl");
  if (!list.length){
    container.innerHTML = `<div class="empty">No matches. Try <b>topic:Algebra</b> or <b>qid:2023</b>.</div>`;
    return;
  }
  container.innerHTML = "";
  list.forEach(n=>{
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = n.id;
    node.querySelector("h3").textContent = n.title || "Untitled";
    node.querySelector(".meta").innerHTML =
      `<span>QID: ${esc(n.question_id||"—")}</span>
       <span>${(n.topics||[]).map(t=>esc(t)).join(", ")||"No topics"}</span>
       <span>${new Date(n.updated_at).toLocaleString()}</span>`;
    node.querySelector(".text").innerHTML = linkify(esc(n.body||""));
    node.querySelector(".edit").addEventListener("click", ()=>startEdit(n));
    node.querySelector(".del").addEventListener("click", ()=>deleteNote(n.id));
    container.appendChild(node);
  });
}

/* ------------ Browse by topic ------------ */
function buildTopicChips(notes){
  const box = $("#topicsCloud");
  const set = new Set();
  notes.forEach(n => (n.topics||[]).forEach(t => set.add(t)));
  const items = Array.from(set).sort((a,b)=>a.localeCompare(b));
  box.innerHTML = items.map(t=>`<span class="chip btn" data-topic="${esc(t)}">${esc(t)}</span>`).join("") ||
                  `<span class="hint">No topics yet.</span>`;
  box.querySelectorAll("[data-topic]").forEach(c=>{
    c.addEventListener("click", ()=>{
      activeChip = (activeChip===c.dataset.topic) ? null : c.dataset.topic;
      buildTopicChips(allNotes);
      if (activeChip) c.classList.add("chip-active");
      runSearch();
      renderTopicGroups(allNotes);
    });
  });
}

function renderTopicGroups(notes){
  const wrap = $("#topicList");
  const map = new Map();
  notes.forEach(n=>{
    (n.topics && n.topics.length ? n.topics : ["(untagged)"]).forEach(t=>{
      if (activeChip && t.toLowerCase()!==activeChip.toLowerCase()) return;
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(n);
    });
  });

  if (!map.size){
    wrap.innerHTML = `<div class="empty">Nothing here yet.</div>`;
    return;
  }

  const groups = Array.from(map.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  wrap.innerHTML = groups.map(([topic, items])=>{
    const rows = items.map(n=>`
      <div class="result">
        <h3>${esc(n.title||"Untitled")}</h3>
        <div class="meta">
          <span>QID: ${esc(n.question_id||"—")}</span>
          <span>${new Date(n.updated_at).toLocaleString()}</span>
        </div>
        <div class="spacer"></div>
        <div class="text">${linkify(esc(n.body||""))}</div>
        <div class="spacer"></div>
        <div class="inline-actions">
          <button class="btn small secondary" onclick='(${startEdit.toString()})(${JSON.stringify(n)})'>Edit</button>
          <button class="btn small warn" onclick='(${deleteNote.toString()})("${n.id}")'>Delete</button>
        </div>
      </div>
    `).join("");

    return `
      <div class="topic-group">
        <div class="topic-title">${esc(topic)}</div>
        <div class="spacer"></div>
        ${rows}
      </div>
    `;
  }).join("");
}

/* ------------ Tools: export / import / nuke ------------ */
$("#exportBtn").addEventListener("click", ()=>{
  if(!currentUser) return alert("Login first.");
  const data = JSON.stringify({ exported_at: new Date().toISOString(), notes: allNotes }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "jam-notes-export.json"; a.click();
  URL.revokeObjectURL(url);
});

$("#importBtn").addEventListener("click", ()=>$("#importFile").click());
$("#importFile").addEventListener("change", async (e)=>{
  if(!currentUser) return alert("Login first.");
  const f = e.target.files?.[0]; if(!f) return;
  let parsed;
  try { parsed = JSON.parse(await f.text()); } catch { return alert("Invalid JSON."); }
  const incoming = parsed.notes || [];
  if (!incoming.length) return alert("No notes in file.");

  const map = new Map(allNotes.map(n=>[n.id,n]));
  const upserts = [];
  for (const n of incoming){
    if (!n.id) continue;
    const ex = map.get(n.id);
    if (!ex || new Date(n.updated_at) < new Date(ex.updated_at)) {
      // keep cloud as source of truth; only add if new id or local is newer
      upserts.push({
        id: n.id,
        user_id: currentUser.id,
        title: n.title || "",
        question_id: n.question_id || "",
        topics: n.topics || [],
        refs: n.refs || "",
        body: n.body || ""
      });
    }
  }
  if (!upserts.length) return alert("Nothing to import.");
  const { error } = await supabase.from("notes").upsert(upserts, { onConflict: "id" });
  if (error){ console.error(error); return alert("Import failed."); }
  alert("Import complete.");
});

$("#nukeBtn").addEventListener("click", async ()=>{
  if(!currentUser) return alert("Login first.");
  if(!confirm("Delete ALL your notes?")) return;
  const { error } = await supabase.from("notes").delete().eq("user_id", currentUser.id);
  if (error){ console.error(error); return alert("Delete failed."); }
  alert("All notes deleted.");
});

/* ------------ Boot ------------ */
refreshSessionUI();
