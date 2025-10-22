/* ===========================
   JAM Notes — Core Logic
   Tech: Vanilla JS + Supabase + Gemini
   =========================== */

// ---------- Supabase init ----------
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Simple State ----------
let currentUser = null;
let allNotes = [];   // in-memory cache for UI only (no localStorage)
let activeTopicFilter = null;
let debounceTimer = null;

// ---------- Utilities ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function uuid() {
  // lightweight ID for notes primary key (text)
  return 'note_' + crypto.randomUUID();
}

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/gim;
  return text.replace(urlRegex, (m) => {
    const href = m.startsWith('http') ? m : `https://${m}`;
    return `<a class="inline" target="_blank" rel="noopener" href="${href}">${m}</a>`;
  });
}

function parseComma(s) {
  if (!s) return [];
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

// ---------- Tabs ----------
(function initTabs(){
  const tabs = $$(".tab");
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const name = btn.dataset.tab;
      $$(".tab-panel").forEach(p => p.classList.remove("active"));
      $("#" + name).classList.add("active");
    });
  });
})();

// ---------- Auth ----------
async function refreshSessionUI() {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  currentUser = session?.user ?? null;

  $("#auth-fields").classList.toggle("hidden", !!currentUser);
  $("#auth-session").classList.toggle("hidden", !currentUser);

  if (currentUser) {
    $("#session-email").textContent = `Signed in as ${currentUser.email}`;
    await afterLoginBoot();
  } else {
    $("#session-email").textContent = "Signed in as —";
    allNotes = [];
    renderNotesList([]);
    teardownRealtime();
  }
}

$("#btn-signup").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  const password = $("#password").value;
  if (!email || !password) return alert("Email & password required.");
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return alert(error.message);
  alert("Sign up successful. Please check your email for confirmation if required, then log in.");
});

$("#btn-login").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return alert(error.message);
  await refreshSessionUI();
});

$("#btn-logout").addEventListener("click", async () => {
  await supabase.auth.signOut();
  await refreshSessionUI();
});

supabase.auth.onAuthStateChange((_event, _session) => {
  // Keep UI synced if Supabase updates the session
  refreshSessionUI();
});

// ---------- Post-login boot ----------
let notesSubscription = null;
let chatSubscription = null;

async function afterLoginBoot() {
  await loadNotes();
  buildTopicChips(allNotes);
  setupRealtime(); // subscribe after user_id is known
}

// ---------- Realtime ----------
function setupRealtime() {
  teardownRealtime();
  // notes changes for this user
  notesSubscription = supabase
    .channel("notes-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "notes", filter: `user_id=eq.${currentUser.id}` },
      (payload) => {
        // mutate in-memory & re-render
        if (payload.eventType === "INSERT") {
          allNotes.unshift(payload.new);
        } else if (payload.eventType === "UPDATE") {
          const idx = allNotes.findIndex(n => n.id === payload.new.id);
          if (idx !== -1) allNotes[idx] = payload.new;
        } else if (payload.eventType === "DELETE") {
          allNotes = allNotes.filter(n => n.id !== payload.old.id);
        }
        buildTopicChips(allNotes);
        runSearch();
      }
    )
    .subscribe();

  // chat_history realtime (append in chat window if topic matches)
  chatSubscription = supabase
    .channel("chat-changes")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_history", filter: `user_id=eq.${currentUser.id}` },
      (payload) => {
        const topic = $("#chat-topic").value.trim();
        if (topic && payload.new.topic === topic) {
          appendChatMessage("user", payload.new.question, payload.new.created_at); // show user question
          appendChatMessage("ai", payload.new.response, payload.new.created_at);
        }
      }
    )
    .subscribe();
}

function teardownRealtime() {
  if (notesSubscription) supabase.removeChannel(notesSubscription);
  if (chatSubscription) supabase.removeChannel(chatSubscription);
  notesSubscription = chatSubscription = null;
}

// ---------- Notes CRUD ----------
async function loadNotes() {
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error) {
    console.error(error);
    return alert("Failed to load notes.");
  }
  allNotes = data || [];
  renderNotesList(allNotes.slice(0,100));
}

$("#btn-save-note").addEventListener("click", saveNote);
$("#btn-clear-form").addEventListener("click", clearForm);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "enter") {
    saveNote();
  }
});

async function saveNote() {
  if (!currentUser) return alert("Please log in first.");

  const id = $("#note-id").value || uuid();
  const title = $("#note-title").value.trim();
  const qids = $("#note-qids").value.trim();
  const topics = parseComma($("#note-topics").value);
  const refs = $("#note-refs").value.trim();
  const body = $("#note-body").value;

  const payload = {
    id,
    user_id: currentUser.id,
    title,
    question_id: qids,
    topics,
    refs,
    body
  };

  const { data, error } = await supabase
    .from("notes")
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();

  if (error) {
    console.error(error);
    $("#note-status").textContent = "Save failed.";
    return;
  }

  $("#note-id").value = data.id; // keep ID for additional edits
  $("#note-status").textContent = "Saved.";
  await sleep(1200);
  $("#note-status").textContent = "";
}

function clearForm() {
  $("#note-id").value = "";
  $("#note-title").value = "";
  $("#note-qids").value = "";
  $("#note-topics").value = "";
  $("#note-refs").value = "";
  $("#note-body").value = "";
  $("#note-status").textContent = "";
}

function editNote(n) {
  $("#note-id").value = n.id;
  $("#note-title").value = n.title || "";
  $("#note-qids").value = n.question_id || "";
  $("#note-topics").value = (n.topics || []).join(", ");
  $("#note-refs").value = n.refs || "";
  $("#note-body").value = n.body || "";

  // switch to Add Note tab
  $$(".tab").forEach(b => b.classList.remove("active"));
  $("[data-tab='add-note']").classList.add("active");
  $$(".tab-panel").forEach(p => p.classList.remove("active"));
  $("#add-note").classList.add("active");
}

async function deleteNote(id) {
  if (!confirm("Delete this note?")) return;
  const { error } = await supabase.from("notes").delete().eq("id", id);
  if (error) {
    console.error(error);
    return alert("Delete failed.");
  }
}

// ---------- Notes UI & Search ----------
function renderNotesList(list) {
  const wrap = $("#notes-list");
  if (!list || list.length === 0) {
    wrap.innerHTML = `<div class="muted">No notes yet. Try adding one!</div>`;
    return;
  }
  const html = list.slice(0,100).map(n => {
    const topics = (n.topics || []).map(t => `<span class="note-topic">${t}</span>`).join(" ");
    const body = linkify(escapeHtml(n.body || ""));
    const updated = new Date(n.updated_at).toLocaleString();
    return `
      <div class="note-card">
        <div>
          <h3 class="note-title">${escapeHtml(n.title || "Untitled")}</h3>
          <div class="note-meta">QIDs: ${escapeHtml(n.question_id || "")}</div>
          <div class="note-topics">${topics}</div>
          <div class="note-meta">Refs: ${escapeHtml(n.refs || "")}</div>
          <div class="note-meta">Updated: ${updated}</div>
        </div>
        <div class="note-body">${body}</div>
        <div class="note-actions">
          <button class="btn" data-edit="${n.id}">Edit</button>
          <button class="btn danger" data-del="${n.id}">Delete</button>
        </div>
      </div>
    `;
  }).join("");
  wrap.innerHTML = html;

  // bind actions
  wrap.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const n = allNotes.find(x => x.id === btn.dataset.edit);
      if (n) editNote(n);
    });
  });
  wrap.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => deleteNote(btn.dataset.del));
  });
}

function buildTopicChips(notes) {
  const chips = $("#topic-chips");
  const set = new Set();
  notes.forEach(n => (n.topics || []).forEach(t => set.add(t)));
  const arr = Array.from(set).sort((a,b)=>a.localeCompare(b));
  chips.innerHTML = arr.map(t => `<span class="chip ${t===activeTopicFilter?'active':''}" data-chip="${escapeAttr(t)}">${escapeHtml(t)}</span>`).join("");
  chips.querySelectorAll("[data-chip]").forEach(ch => {
    ch.addEventListener("click", () => {
      activeTopicFilter = (activeTopicFilter === ch.dataset.chip) ? null : ch.dataset.chip;
      chips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      if (activeTopicFilter) ch.classList.add("active");
      runSearch(); // re-filter
    });
  });
}

$("#search-input").addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 160);
});

function runSearch() {
  const q = $("#search-input").value.trim();
  let list = filterNotes(allNotes, q, activeTopicFilter);
  renderNotesList(list);
}

function filterNotes(notes, query, topicFilter) {
  if (!notes || notes.length === 0) return [];
  const parsed = parseSearch(query);
  let res = notes;

  if (topicFilter) {
    res = res.filter(n => (n.topics || []).some(t => t.toLowerCase() === topicFilter.toLowerCase()));
  }
  if (parsed.topic) {
    res = res.filter(n => (n.topics || []).some(t => t.toLowerCase().includes(parsed.topic)));
  }
  if (parsed.qid) {
    res = res.filter(n => (n.question_id || "").toLowerCase().includes(parsed.qid));
  }
  if (parsed.title) {
    res = res.filter(n => (n.title || "").toLowerCase().includes(parsed.title));
  }
  if (parsed.plain) {
    const p = parsed.plain;
    res = res.filter(n =>
      (n.title || "").toLowerCase().includes(p) ||
      (n.body || "").toLowerCase().includes(p) ||
      (n.refs || "").toLowerCase().includes(p) ||
      (n.question_id || "").toLowerCase().includes(p) ||
      (n.topics || []).some(t => t.toLowerCase().includes(p))
    );
  }
  // Limit for perf
  return res.slice(0, 100);
}

function parseSearch(q) {
  const out = { topic:null, qid:null, title:null, plain:null };
  if (!q) return out;
  const lower = q.toLowerCase();
  const parts = lower.split(/\s+/g);

  let leftover = [];
  for (const p of parts) {
    if (p.startsWith("topic:")) out.topic = p.slice(6);
    else if (p.startsWith("qid:")) out.qid = p.slice(4);
    else if (p.startsWith("title:")) out.title = p.slice(6);
    else leftover.push(p);
  }
  out.plain = leftover.join(" ").trim() || null;
  return out;
}

// ---------- Export / Import / Reset ----------
$("#btn-export").addEventListener("click", () => {
  if (!currentUser) return alert("Log in first.");
  const data = JSON.stringify({ exported_at: new Date().toISOString(), notes: allNotes }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "jam-notes-export.json"; a.click();
  URL.revokeObjectURL(url);
});

$("#import-input").addEventListener("change", async (e) => {
  if (!currentUser) return alert("Log in first.");
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { return alert("Invalid JSON."); }
  const incoming = parsed.notes || [];
  if (incoming.length === 0) return alert("No notes found in file.");

  // Merge: newer timestamps win
  const existingMap = new Map(allNotes.map(n => [n.id, n]));
  const upserts = [];
  for (const n of incoming) {
    if (!n.id) continue;
    const existing = existingMap.get(n.id);
    if (!existing || new Date(n.updated_at) > new Date(existing.updated_at)) {
      // ensure ownership + trigger updated_at on server
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
  if (upserts.length === 0) return alert("Nothing to import (everything up to date).");

  const { error } = await supabase.from("notes").upsert(upserts, { onConflict: "id" });
  if (error) {
    console.error(error);
    return alert("Import failed.");
  }
  alert("Import complete.");
});

$("#btn-delete-all").addEventListener("click", async () => {
  if (!currentUser) return alert("Log in first.");
  if (!confirm("This will delete ALL your notes and chat. Continue?")) return;

  const { error: e1 } = await supabase.from("notes").delete().eq("user_id", currentUser.id);
  const { error: e2 } = await supabase.from("chat_history").delete().eq("user_id", currentUser.id);
  if (e1 || e2) {
    console.error(e1 || e2);
    return alert("Failed to delete all.");
  }
  alert("All data deleted.");
});

// ---------- AI Chat ----------
async function askGemini(apiKey, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: userPrompt }] }] })
  });
  const data = await res.json();
  // Handle possible safety blocks / errors
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.promptFeedback?.blockReason || "No response.";
}

function appendChatMessage(who, text, ts=null) {
  const box = $("#chat-window");
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  div.innerHTML = `
    <div class="bubble">${linkify(escapeHtml(text || ""))}</div>
    <div class="tiny">${ts ? new Date(ts).toLocaleString() : new Date().toLocaleString()}</div>
  `;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function loadChatTopic() {
  if (!currentUser) return alert("Log in first.");
  const topic = $("#chat-topic").value.trim();
  if (!topic) return alert("Enter a topic.");
  $("#chat-window").innerHTML = "";
  const { data, error } = await supabase
    .from("chat_history")
    .select("*")
    .eq("topic", topic)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) {
    console.error(error);
    return alert("Failed to load chat.");
  }
  (data || []).forEach(row => {
    appendChatMessage("user", row.question, row.created_at);
    appendChatMessage("ai", row.response, row.created_at);
  });
}

async function clearChatTopic() {
  if (!currentUser) return alert("Log in first.");
  const topic = $("#chat-topic").value.trim();
  if (!topic) return alert("Enter a topic.");
  if (!confirm(`Delete chat history for topic "${topic}"?`)) return;
  const { error } = await supabase.from("chat_history").delete().eq("topic", topic).eq("user_id", currentUser.id);
  if (error) { console.error(error); return alert("Failed to clear chat."); }
  $("#chat-window").innerHTML = "";
}

$("#btn-load-chat").addEventListener("click", loadChatTopic);
$("#btn-clear-chat").addEventListener("click", clearChatTopic);

$("#btn-send").addEventListener("click", async () => {
  if (!currentUser) return alert("Log in first.");
  const topic = $("#chat-topic").value.trim();
  const apiKey = $("#gemini-key").value.trim();
  const msg = $("#chat-message").value.trim();

  if (!topic) return alert("Enter a topic.");
  if (!apiKey) return alert("Paste your Gemini API key.");
  if (!msg) return;

  $("#chat-message").value = "";
  appendChatMessage("user", msg);
  $("#typing").classList.remove("hidden");

  let replyText = "";
  try {
    replyText = await askGemini(apiKey,
`You are JAM Notes' IIT-JAM tutor. Be concise, rigorous, and show steps.
Question/topic: ${topic}
User: ${msg}`);
  } catch (e) {
    console.error(e);
    replyText = "Error contacting Gemini.";
  } finally {
    $("#typing").classList.add("hidden");
  }
  appendChatMessage("ai", replyText);

  // Store question/response pair
  const { error } = await supabase.from("chat_history").insert({
    user_id: currentUser.id,
    topic,
    question: msg,
    response: replyText
  });
  if (error) console.error(error);
});

// ---------- HTML escapers ----------
function escapeHtml(s) {
  return (s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");
}
function escapeAttr(s){ return escapeHtml(s).replaceAll("'","&#39;"); }

// ---------- Notes list click link handling ----------
// (Links already open in new tab via linkify target="_blank")

// ---------- Boot ----------
refreshSessionUI();
