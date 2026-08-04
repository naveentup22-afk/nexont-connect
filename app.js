/* ===================================================================
   Nexont Connect — app.js
   Auth (persistent), Workspaces, Tasks + Comments, Chat + @mentions,
   Dashboard, in-app Notifications, Theme toggle, Share Target intake.
=================================================================== */

// ---------- State ----------
let currentUser = null;       // Firebase auth user
let currentUserDoc = null;    // Firestore users/{uid}
let currentWorkspaceId = null;
let currentWorkspaceRole = "member";
let membersCache = {};        // uid -> {name,email}
let activeChannelId = "general";
let unsubscribers = [];       // active Firestore listeners to detach on workspace switch

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const nowTs = () => firebase.firestore.FieldValue.serverTimestamp();

function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("");
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function isOverdue(task) {
  if (!task.deadline || task.status === "Done") return false;
  const d = task.deadline.toDate ? task.deadline.toDate() : new Date(task.deadline);
  return d.getTime() < Date.now();
}

function statusClass(status) {
  return {
    "To Do": "status-todo",
    "In Progress": "status-progress",
    "Pending Handover": "status-handover",
    "At Risk": "status-risk",
    "Done": "status-done"
  }[status] || "status-todo";
}

function clearListeners() {
  unsubscribers.forEach(u => u());
  unsubscribers = [];
}

function injectMark() {
  const tpl = $("nexont-mark-svg").content.cloneNode(true);
  document.querySelectorAll(".nexont-mark").forEach(el => el.appendChild(tpl.cloneNode(true)));
}
injectMark();

// ---------- Theme ----------
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("nexont_theme", theme);
  $("themeLightBtn").classList.toggle("active", theme === "light");
  $("themeDarkBtn").classList.toggle("active", theme === "dark");
}
(function initTheme() {
  const saved = localStorage.getItem("nexont_theme") ||
    (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(saved);
})();
$("themeLightBtn").addEventListener("click", () => applyTheme("light"));
$("themeDarkBtn").addEventListener("click", () => applyTheme("dark"));

// ---------- Auth persistence (stay logged in) ----------
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

$("toggleAuthMode").addEventListener("click", () => {
  const showingLogin = !$("loginForm").classList.contains("hidden");
  $("loginForm").classList.toggle("hidden", showingLogin);
  $("signupForm").classList.toggle("hidden", !showingLogin);
  $("authSubtitle").textContent = showingLogin ? "Create your account" : "Sign in to your workspace";
  $("toggleText").textContent = showingLogin ? "Already have an account?" : "New here?";
  $("toggleAuthMode").textContent = showingLogin ? "Sign in" : "Create an account";
});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    await auth.signInWithEmailAndPassword($("loginEmail").value.trim(), $("loginPassword").value);
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

$("forgotPasswordBtn").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  $("loginError").textContent = "";
  if (!email) {
    $("loginError").textContent = "Enter your email above first, then tap 'Forgot password?'";
    return;
  }
  try {
    await auth.sendPasswordResetEmail(email);
    $("loginError").style.color = "var(--brand, #2B3FF3)";
    $("loginError").textContent = "Password reset email sent — check your inbox.";
  } catch (err) {
    $("loginError").style.color = "";
    $("loginError").textContent = err.message;
  }
});

$("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("signupError").textContent = "";
  try {
    const name = $("signupName").value.trim();
    const cred = await auth.createUserWithEmailAndPassword($("signupEmail").value.trim(), $("signupPassword").value);
    await db.collection("users").doc(cred.user.uid).set({
      name, email: cred.user.email, createdAt: nowTs()
    });
  } catch (err) {
    $("signupError").textContent = err.message;
  }
});

$("logoutBtn").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (user) => {
  clearListeners();
  if (!user) {
    currentUser = null;
    $("authScreen").style.display = "flex";
    $("appShell").classList.remove("active");
    return;
  }
  currentUser = user;
  const userSnap = await db.collection("users").doc(user.uid).get();
  currentUserDoc = userSnap.exists ? userSnap.data() : { name: user.email, email: user.email };
  if (!userSnap.exists) {
    await db.collection("users").doc(user.uid).set({ name: currentUserDoc.name, email: user.email, createdAt: nowTs() });
  }

  $("authScreen").style.display = "none";
  $("appShell").classList.add("active");
  $("userName").textContent = currentUserDoc.name;
  $("userAvatar").textContent = initials(currentUserDoc.name);
  $("settingsUserName").textContent = currentUserDoc.name;
  $("settingsUserEmail").textContent = user.email;

  await loadWorkspaces();
  handleShareTargetIntake();
});

// ---------- Workspaces ----------
async function loadWorkspaces() {
  const snap = await db.collection("workspaces")
    .where(`memberUids`, "array-contains", currentUser.uid)
    .get();

  const select = $("workspaceSelect");
  select.innerHTML = "";

  if (snap.empty) {
    // First-time user: offer to create a workspace inline
    const opt = document.createElement("option");
    opt.textContent = "No workspace yet — create one";
    select.appendChild(opt);
    const name = prompt("Name your first workspace (e.g. 'Taxi Operations'):", "My Team");
    if (name) {
      const ref = await db.collection("workspaces").add({
        name, createdBy: currentUser.uid, createdAt: nowTs(),
        memberUids: [currentUser.uid],
        members: { [currentUser.uid]: { role: "admin", name: currentUserDoc.name, email: currentUser.email } }
      });
      await db.collection("workspaces").doc(ref.id).collection("channels").doc("general").set({
        name: "general", createdAt: nowTs()
      });
      currentWorkspaceId = ref.id;
    }
  } else {
    snap.forEach(doc => {
      const opt = document.createElement("option");
      opt.value = doc.id;
      opt.textContent = doc.data().name;
      select.appendChild(opt);
    });
    currentWorkspaceId = select.options[0].value;
  }

  select.addEventListener("change", () => {
    currentWorkspaceId = select.value;
    enterWorkspace();
  });

  if (currentWorkspaceId) enterWorkspace();
}

async function enterWorkspace() {
  clearListeners();
  const wsSnap = await db.collection("workspaces").doc(currentWorkspaceId).get();
  const ws = wsSnap.data();
  membersCache = ws.members || {};
  currentWorkspaceRole = (membersCache[currentUser.uid] || {}).role || "member";
  $("navMembers").classList.toggle("hidden", currentWorkspaceRole !== "admin");
  $("userRole").textContent = currentWorkspaceRole === "admin" ? "Admin" : "Member";

  populateAssigneeDropdown();
  renderMembersView();
  listenTasks();
  listenChannels();
  listenNotifications();
  listenSchedules();
}

// ---------- Navigation ----------
document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
  btn.addEventListener("click", () => { switchView(btn.dataset.view); closeSidebar(); });
});
function openSidebar() {
  $("sidebar").classList.add("open");
  $("sidebarBackdrop").classList.remove("hidden");
  $("sidebarBackdrop").classList.add("open");
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebarBackdrop").classList.remove("open");
  $("sidebarBackdrop").classList.add("hidden");
}
$("menuToggleBtn").addEventListener("click", openSidebar);
$("sidebarBackdrop").addEventListener("click", closeSidebar);
function switchView(view) {
  document.querySelectorAll(".nav-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $(`view-${view}`).classList.remove("hidden");
  const titles = { today: "Today's Tasks", tasks: "All Tasks", chat: "Chat", schedules: "Schedules", dashboard: "Dashboard", members: "Manage Members", settings: "Settings" };
  $("viewTitle").textContent = titles[view];
  $("fabAddTask").classList.toggle("hidden", !["today", "tasks"].includes(view));
  if (view === "dashboard") renderDashboard();
}

// ---------- Tasks ----------
let allTasks = [];
let statusFilter = "all";

function tasksCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("tasks");
}

function listenTasks() {
  const unsub = tasksCol().orderBy("deadline", "asc").onSnapshot(snap => {
    allTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTodayTasks();
    renderAllTasks();
    if (!$("view-dashboard").classList.contains("hidden")) renderDashboard();
  });
  unsubscribers.push(unsub);
}

function renderTaskCard(task) {
  const div = document.createElement("div");
  div.className = `task-card shift-${task.shift}` + (isOverdue(task) ? " overdue" : "");
  const assignee = membersCache[task.assignedTo]?.name || "Unassigned";
  div.innerHTML = `
    <div class="task-top">
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="status-pill ${statusClass(task.status)}">${task.status}</div>
    </div>
    <div class="task-meta">
      <span>👤 ${escapeHtml(assignee)}</span>
      <span>🕐 ${fmtDate(task.deadline)}</span>
      <span>Shift ${task.shift}</span>
      ${isOverdue(task) ? '<span style="color:var(--danger);font-weight:700;">Overdue</span>' : ""}
    </div>`;
  div.addEventListener("click", () => openTaskModal(task));
  return div;
}

function renderTodayTasks() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const list = allTasks.filter(t => {
    if (!t.deadline) return false;
    const d = t.deadline.toDate ? t.deadline.toDate() : new Date(t.deadline);
    return (d >= today && d < tomorrow) || (isOverdue(t)) || t.status === "Pending Handover";
  });
  const container = $("todayTaskList");
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = emptyState("Nothing due today. 🎉");
    return;
  }
  list.forEach(t => container.appendChild(renderTaskCard(t)));
}

function renderAllTasks() {
  const container = $("allTaskList");
  container.innerHTML = "";
  const list = statusFilter === "all" ? allTasks : allTasks.filter(t => t.status === statusFilter);
  if (!list.length) {
    container.innerHTML = emptyState("No tasks in this view.");
    return;
  }
  list.forEach(t => container.appendChild(renderTaskCard(t)));
}

function emptyState(msg) {
  return `<div class="empty-state"><p>${msg}</p></div>`;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

document.querySelectorAll("#statusFilterRow .chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#statusFilterRow .chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    statusFilter = chip.dataset.status;
    renderAllTasks();
  });
});

function populateAssigneeDropdown() {
  const sel = $("taskAssigneeInput");
  sel.innerHTML = "";
  Object.entries(membersCache).forEach(([uid, m]) => {
    const opt = document.createElement("option");
    opt.value = uid;
    opt.textContent = m.name;
    sel.appendChild(opt);
  });
}

// ---------- Task modal (create / edit / comments) ----------
let editingTaskId = null;

function openTaskModal(task) {
  editingTaskId = task ? task.id : null;
  $("taskModalTitle").textContent = task ? "Edit Task" : "New Task";
  $("taskModalError").textContent = "";
  $("taskTitleInput").value = task?.title || "";
  $("taskDescInput").value = task?.description || "";
  $("taskShiftInput").value = task?.shift || "A";
  $("taskAssigneeInput").value = task?.assignedTo || currentUser.uid;
  $("taskStatusInput").value = task?.status || "To Do";
  $("taskDeadlineInput").value = task?.deadline
    ? new Date(task.deadline.toDate ? task.deadline.toDate() : task.deadline).toISOString().slice(0, 16)
    : "";
  $("commentsSection").classList.toggle("hidden", !task);
  $("deleteTaskBtn").classList.toggle("hidden", !task);
  if (task) loadComments(task.id);
  $("taskModal").classList.remove("hidden");
}
$("closeTaskModal").addEventListener("click", () => $("taskModal").classList.add("hidden"));
$("cancelTaskBtn").addEventListener("click", () => $("taskModal").classList.add("hidden"));
$("fabAddTask").addEventListener("click", () => openTaskModal(null));

$("saveTaskBtn").addEventListener("click", async () => {
  const title = $("taskTitleInput").value.trim();
  if (!title) { $("taskModalError").textContent = "Title is required."; return; }
  const assignedTo = $("taskAssigneeInput").value;
  const deadlineVal = $("taskDeadlineInput").value;
  const data = {
    title,
    description: $("taskDescInput").value.trim(),
    shift: $("taskShiftInput").value,
    assignedTo,
    assignedToName: membersCache[assignedTo]?.name || "",
    status: $("taskStatusInput").value,
    deadline: deadlineVal ? firebase.firestore.Timestamp.fromDate(new Date(deadlineVal)) : null,
    updatedAt: nowTs()
  };

  try {
    if (editingTaskId) {
      await tasksCol().doc(editingTaskId).update(data);
    } else {
      data.createdAt = nowTs();
      data.createdBy = currentUser.uid;
      const ref = await tasksCol().add(data);
      if (assignedTo !== currentUser.uid) {
        await pushNotification(assignedTo, "assigned", `${currentUserDoc.name} assigned you a task: "${title}"`, ref.id);
      }
    }
    $("taskModal").classList.add("hidden");
  } catch (err) {
    $("taskModalError").textContent = err.message;
  }
});

$("deleteTaskBtn").addEventListener("click", async () => {
  if (!editingTaskId) return;
  if (!confirm("Delete this task?")) return;
  await tasksCol().doc(editingTaskId).delete();
  $("taskModal").classList.add("hidden");
});

function loadComments(taskId) {
  const list = $("commentList");
  list.innerHTML = "";
  const unsub = tasksCol().doc(taskId).collection("comments").orderBy("createdAt", "asc")
    .onSnapshot(snap => {
      list.innerHTML = "";
      snap.forEach(d => {
        const c = d.data();
        const item = document.createElement("div");
        item.className = "comment-item";
        item.innerHTML = `<div class="comment-head"><span class="comment-author">${escapeHtml(c.authorName)}</span><span class="comment-time">${fmtDate(c.createdAt)}</span></div><div class="comment-text">${escapeHtml(c.text)}</div>`;
        list.appendChild(item);
      });
      list.scrollTop = list.scrollHeight;
    });
  unsubscribers.push(unsub);
}

$("addCommentBtn").addEventListener("click", async () => {
  const text = $("newCommentInput").value.trim();
  if (!text || !editingTaskId) return;
  await tasksCol().doc(editingTaskId).collection("comments").add({
    text, authorUid: currentUser.uid, authorName: currentUserDoc.name, createdAt: nowTs()
  });
  const task = allTasks.find(t => t.id === editingTaskId);
  if (task && task.assignedTo !== currentUser.uid) {
    await pushNotification(task.assignedTo, "comment", `${currentUserDoc.name} commented on "${task.title}"`, editingTaskId);
  }
  $("newCommentInput").value = "";
});

// ---------- Schedules (pinned) ----------
function schedulesCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("schedules");
}

let allSchedules = [];
function listenSchedules() {
  const unsub = schedulesCol().orderBy("date", "asc").onSnapshot(snap => {
    allSchedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSchedulesList();
    renderPinnedBanner();
  });
  unsubscribers.push(unsub);
}

function fmtScheduleDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function renderSchedulesList() {
  const container = $("schedulesListContainer");
  if (!container) return;
  container.innerHTML = "";
  if (!allSchedules.length) {
    container.innerHTML = emptyState("No pinned schedules yet.");
    return;
  }
  allSchedules.forEach(s => {
    const canRemove = s.pinnedBy === currentUser.uid || currentWorkspaceRole === "admin";
    const row = document.createElement("div");
    row.className = "pinned-item";
    row.innerHTML = `
      <div style="flex:1;">
        <div class="pin-title">${escapeHtml(s.projectName)} — ${escapeHtml(s.submittalType)}</div>
        <div class="pin-meta">${fmtScheduleDate(s.date)} · pinned by ${escapeHtml(s.pinnedByName || "")}</div>
      </div>
      ${canRemove ? `<button data-id="${s.id}">Unpin</button>` : ""}`;
    if (canRemove) {
      row.querySelector("button").addEventListener("click", () => schedulesCol().doc(s.id).delete());
    }
    container.appendChild(row);
  });
}

function renderPinnedBanner() {
  const banner = $("pinnedBanner");
  if (!banner) return;
  if (!allSchedules.length) { banner.classList.add("hidden"); banner.innerHTML = ""; return; }
  banner.classList.remove("hidden");
  banner.innerHTML = "";
  allSchedules.slice(0, 3).forEach(s => {
    const row = document.createElement("div");
    row.className = "pinned-item";
    row.innerHTML = `
      <div style="flex:1;">
        <div class="pin-title">📌 ${escapeHtml(s.projectName)} — ${escapeHtml(s.submittalType)}</div>
        <div class="pin-meta">${fmtScheduleDate(s.date)}</div>
      </div>`;
    banner.appendChild(row);
  });
}

$("addScheduleBtn").addEventListener("click", async () => {
  $("scheduleError").textContent = "";
  const projectName = $("scheduleProjectInput").value.trim();
  const submittalType = $("scheduleTypeInput").value.trim();
  const date = $("scheduleDateInput").value;
  if (!projectName || !submittalType || !date) {
    $("scheduleError").textContent = "Project name, submittal type, and date are all required.";
    return;
  }
  await schedulesCol().add({
    projectName, submittalType, date,
    pinnedBy: currentUser.uid, pinnedByName: currentUserDoc.name, createdAt: nowTs()
  });
  $("scheduleProjectInput").value = "";
  $("scheduleTypeInput").value = "";
  $("scheduleDateInput").value = "";
});

// ---------- Chat ----------
function listenChannels() {
  const unsub = db.collection("workspaces").doc(currentWorkspaceId).collection("channels")
    .onSnapshot(snap => {
      const list = $("channelList");
      list.querySelectorAll(".channel-item").forEach(el => el.remove());
      snap.forEach(doc => {
        const item = document.createElement("div");
        item.className = "channel-item" + (doc.id === activeChannelId ? " active" : "");
        item.textContent = "# " + doc.data().name;
        item.addEventListener("click", () => {
          activeChannelId = doc.id;
          list.querySelectorAll(".channel-item").forEach(el => el.classList.remove("active"));
          item.classList.add("active");
          listenMessages();
        });
        list.appendChild(item);
      });
      listenMessages();
    });
  unsubscribers.push(unsub);
}

function msgCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("channels").doc(activeChannelId).collection("messages");
}

function listenMessages() {
  const unsub = msgCol().orderBy("createdAt", "asc").limitToLast(100).onSnapshot(snap => {
    const container = $("chatMessages");
    container.innerHTML = "";
    snap.forEach(d => {
      const m = d.data();
      const div = document.createElement("div");
      div.className = "msg";
      const rendered = escapeHtml(m.text).replace(/@([A-Za-z0-9 ]+?)(?=[\s.,!?]|$)/g, '<span class="mention-tag">@$1</span>');
      div.innerHTML = `
        <div class="avatar">${initials(m.authorName)}</div>
        <div class="msg-body">
          <div class="msg-head"><span class="msg-author">${escapeHtml(m.authorName)}</span><span class="msg-time">${fmtDate(m.createdAt)}</span></div>
          <div class="msg-text">${rendered}</div>
        </div>`;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  });
  unsubscribers.push(unsub);
}

let mentionQuery = null;
$("chatInput").addEventListener("input", (e) => {
  const val = e.target.value;
  const caret = e.target.selectionStart;
  const upToCaret = val.slice(0, caret);
  const match = upToCaret.match(/@([A-Za-z0-9 ]*)$/);
  if (match) {
    mentionQuery = match[1].toLowerCase();
    showMentionDropdown(mentionQuery);
  } else {
    $("mentionDropdown").classList.add("hidden");
    mentionQuery = null;
  }
});

function showMentionDropdown(query) {
  const matches = Object.entries(membersCache).filter(([uid, m]) => m.name.toLowerCase().includes(query));
  const dd = $("mentionDropdown");
  if (!matches.length) { dd.classList.add("hidden"); return; }
  dd.innerHTML = "";
  matches.forEach(([uid, m]) => {
    const item = document.createElement("div");
    item.className = "mention-dropdown-item";
    item.innerHTML = `<div class="avatar" style="width:22px;height:22px;font-size:10px;">${initials(m.name)}</div>${escapeHtml(m.name)}`;
    item.addEventListener("click", () => insertMention(m.name));
    dd.appendChild(item);
  });
  dd.classList.remove("hidden");
}

function insertMention(name) {
  const input = $("chatInput");
  const caret = input.selectionStart;
  const val = input.value;
  const upToCaret = val.slice(0, caret);
  const newUpTo = upToCaret.replace(/@([A-Za-z0-9 ]*)$/, `@${name} `);
  input.value = newUpTo + val.slice(caret);
  $("mentionDropdown").classList.add("hidden");
  input.focus();
}

$("chatInput").addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    await sendMessage();
  }
});

async function sendMessage() {
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  $("mentionDropdown").classList.add("hidden");

  await msgCol().add({
    text, authorUid: currentUser.uid, authorName: currentUserDoc.name, createdAt: nowTs()
  });

  // Detect @mentions and notify
  Object.entries(membersCache).forEach(([uid, m]) => {
    if (uid === currentUser.uid) return;
    const re = new RegExp(`@${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s.,!?]|$)`, "i");
    if (re.test(text)) {
      pushNotification(uid, "mention", `${currentUserDoc.name} mentioned you: "${text.slice(0, 80)}"`, null);
    }
  });
}

// ---------- Dashboard ----------
function renderDashboard() {
  const total = allTasks.length;
  const overdue = allTasks.filter(isOverdue).length;
  const pending = allTasks.filter(t => t.status === "Pending Handover").length;
  const done = allTasks.filter(t => t.status === "Done").length;

  $("statGrid").innerHTML = `
    <div class="stat-card"><div class="num">${total}</div><div class="label">Total Tasks</div></div>
    <div class="stat-card danger"><div class="num">${overdue}</div><div class="label">Overdue</div></div>
    <div class="stat-card warning"><div class="num">${pending}</div><div class="label">Pending Handover</div></div>
    <div class="stat-card success"><div class="num">${done}</div><div class="label">Completed</div></div>
  `;

  const counts = {};
  Object.keys(membersCache).forEach(uid => counts[uid] = 0);
  allTasks.forEach(t => { if (t.status !== "Done" && t.assignedTo) counts[t.assignedTo] = (counts[t.assignedTo] || 0) + 1; });
  const max = Math.max(1, ...Object.values(counts));

  const container = $("memberBreakdown");
  container.innerHTML = "";
  Object.entries(counts).forEach(([uid, count]) => {
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <div class="avatar">${initials(membersCache[uid]?.name)}</div>
      <div style="width:110px;font-size:13px;font-weight:600;">${escapeHtml(membersCache[uid]?.name || "Unknown")}</div>
      <div class="member-bar-track"><div class="member-bar-fill" style="width:${(count / max) * 100}%"></div></div>
      <div class="member-count">${count}</div>`;
    container.appendChild(row);
  });
}

// ---------- Members management (admin) ----------
function renderMembersView() {
  const container = $("membersListContainer");
  container.innerHTML = "";
  Object.entries(membersCache).forEach(([uid, m]) => {
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <div class="avatar">${initials(m.name)}</div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;">${escapeHtml(m.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${escapeHtml(m.email)} · ${m.role}</div>
      </div>`;
    container.appendChild(row);
  });
}

$("addMemberBtn").addEventListener("click", async () => {
  $("addMemberError").textContent = "";
  const email = $("addMemberEmail").value.trim();
  if (!email) return;
  const userSnap = await db.collection("users").where("email", "==", email).limit(1).get();
  if (userSnap.empty) {
    $("addMemberError").textContent = "No Nexont Connect account found with that email yet — ask them to sign up first.";
    return;
  }
  const uDoc = userSnap.docs[0];
  const wsRef = db.collection("workspaces").doc(currentWorkspaceId);
  await wsRef.update({
    memberUids: firebase.firestore.FieldValue.arrayUnion(uDoc.id),
    [`members.${uDoc.id}`]: { role: "member", name: uDoc.data().name, email: uDoc.data().email }
  });
  $("addMemberEmail").value = "";
  await enterWorkspace();
});

// ---------- Notifications (in-app, Spark-plan friendly) ----------
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

async function pushNotification(toUid, type, text, taskId) {
  await db.collection("workspaces").doc(currentWorkspaceId).collection("notifications").add({
    toUid, type, text, taskId: taskId || null, read: false, createdAt: nowTs()
  });
}

function listenNotifications() {
  const unsub = db.collection("workspaces").doc(currentWorkspaceId).collection("notifications")
    .where("toUid", "==", currentUser.uid)
    .orderBy("createdAt", "desc")
    .limit(30)
    .onSnapshot(snap => {
      let unread = 0;
      const list = $("notifList");
      list.innerHTML = "";
      snap.docChanges().forEach(change => {
        if (change.type === "added" && !change.doc.metadata.hasPendingWrites) {
          const n = change.doc.data();
          const age = n.createdAt ? Date.now() - n.createdAt.toDate().getTime() : 999999;
          if (age < 10000 && $("notifToggle").checked && Notification.permission === "granted") {
            new Notification("Nexont Connect", { body: n.text });
          }
        }
      });
      snap.forEach(d => {
        const n = d.data();
        if (!n.read) unread++;
        const item = document.createElement("div");
        item.className = "comment-item";
        item.style.cursor = "pointer";
        item.innerHTML = `<div class="comment-text">${escapeHtml(n.text)}</div><div class="comment-time" style="margin-top:4px;">${fmtDate(n.createdAt)}</div>`;
        item.addEventListener("click", () => {
          db.collection("workspaces").doc(currentWorkspaceId).collection("notifications").doc(d.id).update({ read: true });
        });
        list.appendChild(item);
      });
      $("notifDot").classList.toggle("hidden", unread === 0);
      $("chatBadge").classList.toggle("hidden", true); // reserved for future unread-chat count
    });
  unsubscribers.push(unsub);
}

$("notifBtn").addEventListener("click", () => $("notifModal").classList.remove("hidden"));
$("closeNotifModal").addEventListener("click", () => $("notifModal").classList.add("hidden"));

// ---------- Share Target intake (Outlook -> Task or Chat) ----------
let pendingShare = null;
function handleShareTargetIntake() {
  const params = new URLSearchParams(window.location.search);
  const sharedTitle = params.get("shared_title");
  const sharedText = params.get("shared_text");
  if (sharedTitle || sharedText) {
    pendingShare = { title: sharedTitle || "", text: sharedText || "" };
    setTimeout(() => $("shareChoiceModal").classList.remove("hidden"), 400);
    window.history.replaceState({}, "", "index.html");
  }
}

$("closeShareChoiceModal").addEventListener("click", () => {
  $("shareChoiceModal").classList.add("hidden");
  pendingShare = null;
});

$("shareAsTaskBtn").addEventListener("click", () => {
  if (!pendingShare) return;
  $("shareChoiceModal").classList.add("hidden");
  switchView("tasks");
  openTaskModal(null);
  $("taskTitleInput").value = pendingShare.title;
  $("taskDescInput").value = pendingShare.text;
  pendingShare = null;
});

$("shareToChatBtn").addEventListener("click", async () => {
  if (!pendingShare) return;
  $("shareChoiceModal").classList.add("hidden");
  const combined = [pendingShare.title, pendingShare.text].filter(Boolean).join("\n");
  switchView("chat");
  await msgCol().add({
    text: combined, authorUid: currentUser.uid, authorName: currentUserDoc.name, createdAt: nowTs()
  });
  pendingShare = null;
});

// ---------- Register service worker ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
