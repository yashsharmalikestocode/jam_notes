/* ===========================
   JAM Notes — Supabase Cloud Version
   Matches new HTML & CSS (two-panel layout)
   Tabs: Add Note / Browse & Search
   =========================== */

// ---------- Supabase init ----------
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- State ----------
let currentUser = null;
let allNotes = [];
let activeTopicFilter = null;
let debounceTimer = null;

// ---------- Shortcuts ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uuid() {
  return "note_" + crypto.randomUUID();
}

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/gim;
  return (text || "").replace(urlRegex, (m) => {
    const href = m.startsWith("http") ? m : `https://${m}`;
    return `<a class="inline" target="_blank" rel="noopener" href="${href}">${m}</a>`;
  });
}

function parseComma(s) {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

// ---------- Tabs ----------
(function initTabs() {
  const tabs = $$(".tab");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const name = btn.dataset.tab;
      $("#add").style.display = name === "add" ? "" : "none";
      $("#browse").style.display = name === "browse" ? "" : "none";
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
    $("#session-email").textContent = "";
    allNotes = [];
    renderResults([]);
    teardownRealtime();
  }
}

$("#btn-signup").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  const password = $("#password").value;
  if (!email || !password) return alert("Email & password required.");
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return alert(error.message);
  alert("Sign up successful. Please check your email and then log in.");
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

supabase.auth.onAuthStateChange(() => refreshSessionUI());

// ---------- After login ----------
let notesSubscription = null;

async function afterLoginBoot() {
  await loadNotes();
  buildTopicChips(allNotes);
  renderTopicList(allNotes);
  setupRealtime();
}

// ---------- Realtime ----------
function setupRealtime() {
  teardownRealtime();
  notesSubscription = supabase
    .channel("notes-realtime")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "notes",
        filter: `user_id=eq.${currentUser.id}`,
      },
      (payload) => {
        if (payload.eventType === "INSERT") {
          allNotes.unshift(payload.new);
        } else if (payload.eventType === "UPDATE") {
          const i = allNotes.findIndex((n) => n.id === payload.new.id);
          if (i !== -1) allNotes[i] = payload.new;
        } else if (payload.eventType === "DELETE") {
          allNotes = allNotes.filter((n) => n.id !== payload.old.id);
        }
        buildTopicChips(allNotes);
        runSearch();
        renderTopicList(allNotes);
      }
    )
    .subscribe();
}

function teardownRealtime() {
  if (notesSubscription) supabase.removeChannel(notesSubscription);
  notesSubscription = null;
}

// ---------- CRUD ----------
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
  runSearch();
  renderTopicList(allNotes);
}

async function saveNote() {
  if (!currentUser) return alert("Please log in first.");
  const id = uuid();
  const title = $("#title").value.trim();
  const qids = $("#qid").value.trim();
  const topics = parseComma($("#topics").value);
  const refs = $("#refs").value.trim();
  const body = $("#body").value;

  const payload = {
    id,
    user_id: currentUser.id,
    title,
    question_id: qids,
    topics,
    refs,
    body,
  };

  const { error } = await supabase
    .from("notes")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    console.error(error);
    $("#saveStatus").textContent = "Save failed.";
  } else {
    $("#saveStatus").textContent = "Saved ✔";
    await sleep(1000);
    $("#saveStatus").textContent = "";
    resetForm();
  }
}

async function deleteNote(id) {
  if (!confirm("Delete this note?")) return;
  const { error } = await supabase.from("notes").delete().eq("id", id);
  if (error) {
    console.error(error);
    alert("Delete failed.");
  }
}

function editNote(n) {
  $("#title").value = n.title || "";
  $("#qid").value = n.question_id || "";
  $("#topics").value = (n.topics || []).join(", ");
  $("#refs").value = n.refs || "";
  $("#body").value = n.body || "";
  $(".tab.active").classList.remove("active");
  $("[data-tab='add']").classList.add("active");
  $("#add").style.display = "";
  $("#browse").style.display = "none";
}

function resetForm() {
  $("#title").value = "";
  $("#qid").value = "";
  $("#topics").value = "";
  $("#refs").value = "";
  $("#body").value = "";
  $("#saveStatus").textContent = "";
}

// ---------- Search ----------
$("#q").addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 200);
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "enter") saveNote();
});

$("#saveBtn").addEventListener("click", saveNote);
$("#resetBtn").addEventListener("click", resetForm);

function runSearch() {
  const query = $("#q").value.trim();
  const results = filterNotes(allNotes, query, activeTopicFilter);
  renderResults(results);
}

function parseSearch(q) {
  const out = { topic: null, qid: null, title: null, plain: null };
  if (!q) return out;
  const parts = q.toLowerCase().split(/\s+/g);
  let rest = [];
  for (const p of parts) {
    if (p.startsWith("topic:")) out.topic = p.slice(6);
    else if (p.startsWith("qid:")) out.qid = p.slice(4);
    else if (p.startsWith("title:")) out.title = p.slice(6);
    else rest.push(p);
  }
  out.plain = rest.join(" ").trim() || null;
  return out;
}

function filterNotes(notes, query, topicFilter) {
  if (!notes.length) return [];
  const p = parseSearch(query);
  let res = notes;
  if (topicFilter)
    res = res.filter((n) =>
      (n.topics || []).some((t) => t.toLowerCase() === topicFilter.toLowerCase())
    );
  if (p.topic)
    res = res.filter((n) =>
      (n.topics || []).some((t) => t.toLowerCase().includes(p.topic))
    );
  if (p.qid)
    res = res.filter((n) =>
      (n.question_id || "").toLowerCase().includes(p.qid)
    );
  if (p.title)
    res = res.filter((n) => (n.title || "").toLowerCase().includes(p.title));
  if (p.plain) {
    const s = p.plain;
    res = res.filter(
      (n) =>
        (n.title || "").toLowerCase().includes(s) ||
        (n.body || "").toLowerCase().includes(s) ||
        (n.refs || "").toLowerCase().includes(s) ||
        (n.question_id || "").toLowerCase().includes(s) ||
        (n.topics || []).some((t) => t.toLowerCase().includes(s))
    );
  }
  return res.slice(0, 100);
}

// ---------- Render ----------
function renderResults(list) {
  const container = $("#results");
  if (!list.length) {
    container.innerHTML = `<div class="empty">No matches. Try <b>topic:Algebra</b> or <b>qid:2023</b>.</div>`;
    return;
  }
  container.innerHTML = list
    .map((n) => {
      const topics = (n.topics || [])
        .map((t) => `<span>${escapeHtml(t)}</span>`)
        .join(" ");
      return `
        <div class="result">
          <h3>${escapeHtml(n.title || "Untitled")}</h3>
          <div class="meta">
            <span>QID: ${escapeHtml(n.question_id || "")}</span>
            <span>${topics}</span>
            <span>${new Date(n.updated_at).toLocaleString()}</span>
          </div>
          <div class="spacer"></div>
          <div class="text">${linkify(escapeHtml(n.body || ""))}</div>
          <div class="spacer"></div>
          <div class="inline-actions">
            <button class="btn small secondary" onclick="editNote(${JSON.stringify(
              n
            ).replace(/"/g, '&quot;')})">Edit</button>
            <button class="btn small warn" onclick="deleteNote('${n.id}')">Delete</button>
          </div>
        </div>
      `;
    })
    .join("");
}

// ---------- Browse ----------
function buildTopicChips(notes) {
  const box = $("#topicsCloud");
  const set = new Set();
  notes.forEach((n) => (n.topics || []).forEach((t) => set.add(t)));
  const arr = Array.from(set).sort((a, b) => a.localeCompare(b));
  box.innerHTML = arr
    .map(
      (t) =>
        `<span class="chip ${t === activeTopicFilter ? "active" : ""}" data-chip="${escapeAttr(
          t
        )}">${escapeHtml(t)}</span>`
    )
    .join("");
  box.querySelectorAll("[data-chip]").forEach((ch) => {
    ch.addEventListener("click", () => {
      activeTopicFilter =
        activeTopicFilter === ch.dataset.chip ? null : ch.dataset.chip;
      buildTopicChips(allNotes);
      runSearch();
      renderTopicList(allNotes);
    });
  });
}

function renderTopicList(notes) {
  const wrap = $("#topicList");
  if (!notes.length) {
    wrap.innerHTML = `<div class="empty">No notes yet.</div>`;
    return;
  }
  const map = new Map();
  notes.forEach((n) => {
    (n.topics && n.topics.length ? n.topics : ["(untagged)"]).forEach((t) => {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(n);
    });
  });

  const html = Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([topic, arr]) => {
      const rows = arr
        .map(
          (n) => `
        <div class="result">
          <h3>${escapeHtml(n.title || "Untitled")}</h3>
          <div class="meta"><span>QID: ${escapeHtml(
            n.question_id || ""
          )}</span><span>${new Date(n.updated_at).toLocaleString()}</span></div>
          <div class="text">${linkify(escapeHtml(n.body || ""))}</div>
          <div class="inline-actions">
            <button class="btn small secondary" onclick="editNote(${JSON.stringify(
              n
            ).replace(/"/g, '&quot;')})">Edit</button>
            <button class="btn small warn" onclick="deleteNote('${n.id}')">Delete</button>
          </div>
        </div>`
        )
        .join("");
      return `<div class="topic-group">
        <div class="topic-title">${escapeHtml(topic)}</div>
        <div class="spacer"></div>${rows}
      </div>`;
    })
    .join("");
  wrap.innerHTML = html;
}

// ---------- Export / Import / Delete All ----------
$("#exportBtn").addEventListener("click", () => {
  if (!currentUser) return alert("Log in first.");
  const data = JSON.stringify(
    { exported_at: new Date().toISOString(), notes: allNotes },
    null,
    2
  );
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "jam-notes-export.json";
  a.click();
  URL.revokeObjectURL(url);
});

$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  if (!currentUser) return alert("Log in first.");
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return alert("Invalid JSON file.");
  }
  const incoming = parsed.notes || [];
  if (!incoming.length) return alert("No notes found.");

  const map = new Map(allNotes.map((n) => [n.id, n]));
  const upserts = [];
  for (const n of incoming) {
    if (!n.id) continue;
    const ex = map.get(n.id);
    if (!ex || new Date(n.updated_at) > new Date(ex.updated_at)) {
      upserts.push({
        id: n.id,
        user_id: currentUser.id,
        title: n.title || "",
        question_id: n.question_id || "",
        topics: n.topics || [],
        refs: n.refs || "",
        body: n.body || "",
      });
    }
  }
  if (!upserts.length) return alert("Nothing to import.");
  const { error } = await supabase.from("notes").upsert(upserts);
  if (error) {
    console.error(error);
    return alert("Import failed.");
  }
  alert("Import complete.");
});

$("#nukeBtn").addEventListener("click", async () => {
  if (!currentUser) return alert("Log in first.");
  if (!confirm("Delete ALL notes?")) return;
  const { error } = await supabase
    .from("notes")
    .delete()
    .eq("user_id", currentUser.id);
  if (error) {
    console.error(error);
    alert("Delete failed.");
  } else alert("All notes deleted.");
});

// ---------- Boot ----------
refreshSessionUI();
