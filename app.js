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

// ---------- Account type (Team Lead / Engineer) ----------
function applyAccountTypeUI(accountType) {
  $("acctTeamLeadBtn").classList.toggle("active", accountType === "admin");
  $("acctEngineerBtn").classList.toggle("active", accountType === "member");
}

document.querySelectorAll("#accountTypeToggle button").forEach(btn => {
  btn.addEventListener("click", async () => {
    const newType = btn.dataset.accountChoice;
    if (newType === currentUserDoc.accountType) return;
    await db.collection("users").doc(currentUser.uid).update({ accountType: newType });
    currentUserDoc.accountType = newType;
    applyAccountTypeUI(newType);
  });
});

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

let signupAccountType = "admin";
document.querySelectorAll("#signupTypeToggle button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#signupTypeToggle button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    signupAccountType = btn.dataset.accountType;
  });
});

$("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("signupError").textContent = "";
  try {
    const name = $("signupName").value.trim();
    const cred = await auth.createUserWithEmailAndPassword($("signupEmail").value.trim(), $("signupPassword").value);
    await db.collection("users").doc(cred.user.uid).set({
      name, email: cred.user.email, accountType: signupAccountType, createdAt: nowTs()
    });
  } catch (err) {
    $("signupError").textContent = err.message;
  }
});

$("saveWorkspaceNameBtn").addEventListener("click", async () => {
  $("workspaceNameError").textContent = "";
  const name = $("workspaceNameInput").value.trim();
  if (!name) { $("workspaceNameError").textContent = "Workspace name can't be empty."; return; }
  try {
    await db.collection("workspaces").doc(currentWorkspaceId).update({ name });
    const opt = $("workspaceSelect").querySelector(`option[value="${currentWorkspaceId}"]`);
    if (opt) opt.textContent = name;
  } catch (err) {
    $("workspaceNameError").textContent = err.message;
  }
});

$("saveEmpDetailsBtn").addEventListener("click", async () => {
  $("empDetailsError").textContent = "";
  const empId = $("empIdInput").value.trim();
  const department = $("empDeptInput").value.trim();
  const location = $("empLocationInput").value.trim();
  try {
    await db.collection("users").doc(currentUser.uid).update({ empId, department, location });
    currentUserDoc.empId = empId; currentUserDoc.department = department; currentUserDoc.location = location;
  } catch (err) {
    $("empDetailsError").textContent = err.message;
  }
});

$("logoutBtn").addEventListener("click", () => auth.signOut());

$("exitWorkspaceBtn").addEventListener("click", async () => {
  if (!currentWorkspaceId) return;
  const wsName = $("workspaceSelect").selectedOptions[0]?.textContent || "this workspace";
  if (!confirm(`Leave "${wsName}"? You'll lose access to its tasks, chat, and schedules.`)) return;
  const wsRef = db.collection("workspaces").doc(currentWorkspaceId);
  await wsRef.update({
    memberUids: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
    [`members.${currentUser.uid}`]: firebase.firestore.FieldValue.delete()
  });
  currentWorkspaceId = null;
  await loadWorkspaces();
  switchView("today");
});

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
    await db.collection("users").doc(user.uid).set({ name: currentUserDoc.name, email: user.email, accountType: "admin", createdAt: nowTs() });
    currentUserDoc.accountType = "admin";
  }
  // Existing users created before this feature default to Team Lead so nobody
  // who could already create workspaces loses that ability.
  if (!currentUserDoc.accountType) currentUserDoc.accountType = "admin";

  $("authScreen").style.display = "none";
  $("noWorkspaceScreen").style.display = "none";
  $("appShell").classList.add("active");
  $("userName").textContent = currentUserDoc.name;
  $("userAvatar").textContent = initials(currentUserDoc.name);
  $("settingsUserName").textContent = currentUserDoc.name;
  $("settingsUserEmail").textContent = user.email;
  applyAccountTypeUI(currentUserDoc.accountType);
  $("empIdInput").value = currentUserDoc.empId || "";
  $("empDeptInput").value = currentUserDoc.department || "";
  $("empLocationInput").value = currentUserDoc.location || "";

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
    $("appShell").classList.remove("active");
    $("noWorkspaceScreen").style.display = "flex";
    if (currentUserDoc.accountType === "member") {
      $("noWsTeamLead").classList.add("hidden");
      $("noWsEngineer").classList.remove("hidden");
      $("noWsEngineerEmail").textContent = currentUser.email;
    } else {
      $("noWsTeamLead").classList.remove("hidden");
      $("noWsEngineer").classList.add("hidden");
    }
    currentWorkspaceId = null;
    return;
  }

  $("noWorkspaceScreen").style.display = "none";
  $("appShell").classList.add("active");
  snap.forEach(doc => {
    const opt = document.createElement("option");
    opt.value = doc.id;
    opt.textContent = doc.data().name;
    select.appendChild(opt);
  });
  currentWorkspaceId = select.options[0].value;

  select.addEventListener("change", () => {
    currentWorkspaceId = select.value;
    enterWorkspace();
  });

  if (currentWorkspaceId) enterWorkspace();
}

$("createWorkspaceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("createWorkspaceError").textContent = "";
  const name = $("newWorkspaceNameInput").value.trim();
  if (!name) return;
  try {
    const ref = await db.collection("workspaces").add({
      name, createdBy: currentUser.uid, createdAt: nowTs(),
      memberUids: [currentUser.uid],
      members: { [currentUser.uid]: { role: "admin", name: currentUserDoc.name, email: currentUser.email } }
    });
    await db.collection("workspaces").doc(ref.id).collection("channels").doc("general").set({
      name: "general", createdAt: nowTs()
    });
    await loadWorkspaces();
  } catch (err) {
    $("createWorkspaceError").textContent = err.message;
  }
});

async function enterWorkspace() {
  clearListeners();
  const wsSnap = await db.collection("workspaces").doc(currentWorkspaceId).get();
  const ws = wsSnap.data();
  membersCache = ws.members || {};
  currentWorkspaceRole = (membersCache[currentUser.uid] || {}).role || "member";
  $("navMembers").classList.toggle("hidden", currentWorkspaceRole !== "admin");
  $("userRole").textContent = currentWorkspaceRole === "admin" ? "Admin" : "Member";
  $("workspaceNameInput").value = ws.name || "";

  populateAssigneeDropdown();
  renderMembersView();
  listenTasks();
  readState = {};
  unreadCounts = {};
  watchedChannels = new Set();
  listenReadState();
  listenChannels();
  listenNotifications();
  listenSchedules();
  listenLeave();
  $("teamAllowancePanel").classList.toggle("hidden", currentWorkspaceRole !== "admin");
  listenAllowances();
  listenProjects();
  listenRfiEntries();
  listenNotes();
  listenFlags();
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
  const titles = { today: "Today's Tasks", tasks: "All Tasks", chat: "Chat", schedules: "Schedules", dashboard: "Dashboard", allowance: "Allowance", rfi: "RFI Log", notes: "Sticky Notes", flags: "Flags", members: "Manage Members", settings: "Settings" };
  $("viewTitle").textContent = titles[view];
  $("fabAddTask").classList.toggle("hidden", !["today", "tasks"].includes(view));
  if (view === "dashboard") renderDashboard();
  if (view === "chat") markChannelRead(activeChannelId);
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

// ---------- On Leave Today ----------
function leaveCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("leaveToday");
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let onLeaveList = [];
function listenLeave() {
  const unsub = leaveCol().where("date", "==", todayStr()).onSnapshot(snap => {
    onLeaveList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLeaveBanner();
    $("onLeaveToggle").checked = onLeaveList.some(l => l.id === currentUser.uid);
  });
  unsubscribers.push(unsub);
}

function renderLeaveBanner() {
  [$("leaveBanner"), $("leaveBannerChat")].forEach(banner => {
    if (!banner) return;
    if (!onLeaveList.length) { banner.classList.add("hidden"); banner.innerHTML = ""; return; }
    banner.classList.remove("hidden");
    banner.innerHTML = "";
    onLeaveList.forEach(l => {
      const row = document.createElement("div");
      row.className = "pinned-item";
      row.innerHTML = `<div class="pin-title">🌴 ${escapeHtml(l.name)} is on leave today</div>`;
      banner.appendChild(row);
    });
  });
}

$("onLeaveToggle").addEventListener("change", async (e) => {
  if (e.target.checked) {
    await leaveCol().doc(currentUser.uid).set({
      name: currentUserDoc.name, date: todayStr(), createdAt: nowTs()
    });
  } else {
    await leaveCol().doc(currentUser.uid).delete();
  }
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
    renderScheduleLogs();
    renderPinnedBanner();
  });
  unsubscribers.push(unsub);
}

function fmtScheduleDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function populateScheduleProjectDropdown() {
  const select = $("scheduleProjectInput");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">Select a project</option>` +
    allProjects.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
  if (current) select.value = current;
}

function renderSchedulesList() {
  const container = $("schedulesListContainer");
  if (!container) return;
  const pinned = allSchedules.filter(s => s.status !== "Completed");
  container.innerHTML = "";
  if (!pinned.length) {
    container.innerHTML = emptyState("No pinned schedules yet.");
    return;
  }
  pinned.forEach(s => {
    const canRemove = s.pinnedBy === currentUser.uid || currentWorkspaceRole === "admin";
    const row = document.createElement("div");
    row.className = "pinned-item";
    row.innerHTML = `
      <div style="flex:1;">
        <div class="pin-title">${escapeHtml(s.projectName)} — ${escapeHtml(s.submittalType)}</div>
        <div class="pin-meta">${fmtScheduleDate(s.date)} · pinned by ${escapeHtml(s.pinnedByName || "")}</div>
      </div>`;
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    // Only Team Lead can mark a schedule complete.
    if (currentWorkspaceRole === "admin") {
      const completeBtn = document.createElement("button");
      completeBtn.className = "btn-secondary";
      completeBtn.textContent = "Mark Complete";
      completeBtn.addEventListener("click", () => {
        schedulesCol().doc(s.id).update({
          status: "Completed", completedBy: currentUser.uid, completedByName: currentUserDoc.name, completedAt: todayStr()
        });
      });
      actions.appendChild(completeBtn);
    }
    if (canRemove) {
      const unpinBtn = document.createElement("button");
      unpinBtn.textContent = "Unpin";
      unpinBtn.addEventListener("click", () => schedulesCol().doc(s.id).delete());
      actions.appendChild(unpinBtn);
    }
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function renderScheduleLogs() {
  const container = $("scheduleLogsContainer");
  if (!container) return;
  const logs = allSchedules.filter(s => s.status === "Completed");
  container.innerHTML = "";
  if (!logs.length) { container.innerHTML = emptyState("No completed schedules yet."); return; }
  logs.forEach(s => {
    const row = document.createElement("div");
    row.className = "pinned-item";
    row.innerHTML = `
      <div style="flex:1;">
        <div class="pin-title">${escapeHtml(s.projectName)} — ${escapeHtml(s.submittalType)}</div>
        <div class="pin-meta">Due ${fmtScheduleDate(s.date)} · pinned by ${escapeHtml(s.pinnedByName || "")} · completed by ${escapeHtml(s.completedByName || "")} on ${fmtScheduleDate(s.completedAt)}</div>
      </div>`;
    if (currentWorkspaceRole === "admin") {
      const delBtn = document.createElement("button");
      delBtn.className = "danger-btn";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => schedulesCol().doc(s.id).delete());
      row.appendChild(delBtn);
    }
    container.appendChild(row);
  });
}

function renderPinnedBanner() {
  const pinned = allSchedules.filter(s => s.status !== "Completed");
  [$("pinnedBanner"), $("pinnedBannerChat")].forEach(banner => {
    if (!banner) return;
    if (!pinned.length) { banner.classList.add("hidden"); banner.innerHTML = ""; return; }
    banner.classList.remove("hidden");
    banner.innerHTML = "";
    pinned.slice(0, 3).forEach(s => {
      const row = document.createElement("div");
      row.className = "pinned-item";
      row.innerHTML = `
        <div style="flex:1;">
          <div class="pin-title">📌 ${escapeHtml(s.projectName)} — ${escapeHtml(s.submittalType)}</div>
          <div class="pin-meta">${fmtScheduleDate(s.date)}</div>
        </div>`;
      banner.appendChild(row);
    });
  });
}

$("addScheduleBtn").addEventListener("click", async () => {
  $("scheduleError").textContent = "";
  const projectName = $("scheduleProjectInput").value;
  const submittalType = $("scheduleTypeInput").value.trim();
  const date = $("scheduleDateInput").value;
  if (!projectName || !submittalType || !date) {
    $("scheduleError").textContent = "Project, submittal type, and date are all required.";
    return;
  }
  await schedulesCol().add({
    projectName, submittalType, date, status: "Pinned",
    pinnedBy: currentUser.uid, pinnedByName: currentUserDoc.name, createdAt: nowTs()
  });
  $("scheduleProjectInput").value = "";
  $("scheduleTypeInput").value = "";
  $("scheduleDateInput").value = "";
});

// ---------- Allowance ----------
let allowanceType = "cabfood";
let allAllowances = [];

function allowanceCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("allowances");
}

document.querySelectorAll("#allowanceTypeRow .chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#allowanceTypeRow .chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    allowanceType = chip.dataset.atype;
    $("cabfoodFields").classList.toggle("hidden", allowanceType !== "cabfood");
    $("weekendFields").classList.toggle("hidden", allowanceType !== "weekend");
    $("allowanceError").textContent = "";
  });
});

function listenAllowances() {
  // Admin (Team Lead) needs every member's entries for the Team Report.
  // Engineers only ever query their own — matches the security rules,
  // which don't allow them to read other members' allowance docs.
  const query = currentWorkspaceRole === "admin"
    ? allowanceCol().orderBy("date", "desc")
    : allowanceCol().where("uid", "==", currentUser.uid).orderBy("date", "desc");

  const unsub = query.onSnapshot(snap => {
    allAllowances = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMyAllowances();
    if (currentWorkspaceRole === "admin") renderTeamAllowances();
  });
  unsubscribers.push(unsub);
}

function fmtAllowanceDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function renderAllowanceEntry(a, canDelete) {
  const div = document.createElement("div");
  div.className = "allowance-entry";
  const isCabFood = a.type === "cabfood";
  const detail = isCabFood
    ? `${escapeHtml(a.project || "—")} · Login ${escapeHtml(a.loginTime || "—")} · Logout ${escapeHtml(a.logoutTime || "—")}`
    : `${escapeHtml(a.project || "—")} (${escapeHtml(a.projectId || "—")}) · ${escapeHtml(a.client || "—")} · ${escapeHtml(a.status || "—")} · ${escapeHtml(a.dayType || "—")}${a.description ? "<br>" + escapeHtml(a.description) : ""}${a.remarks ? "<br>Remarks: " + escapeHtml(a.remarks) : ""}`;
  div.innerHTML = `
    <div>
      <div style="font-weight:600;">${isCabFood ? "🚕 Cab/Food" : "🗓️ Weekend Working"} — ${fmtAllowanceDate(a.date)}</div>
      <div class="ae-meta">${detail}</div>
    </div>`;
  if (canDelete) {
    const btn = document.createElement("button");
    btn.className = "danger-btn";
    btn.textContent = "Delete";
    btn.addEventListener("click", () => allowanceCol().doc(a.id).delete());
    div.appendChild(btn);
  }
  return div;
}

function renderMyAllowances() {
  const container = $("myAllowanceList");
  if (!container) return;
  const mine = allAllowances.filter(a => a.uid === currentUser.uid);
  container.innerHTML = "";
  if (!mine.length) { container.innerHTML = emptyState("No entries yet."); return; }
  mine.forEach(a => container.appendChild(renderAllowanceEntry(a, true)));
}

function renderGroupedByMember(container, entries) {
  container.innerHTML = "";
  if (!entries.length) { container.innerHTML = emptyState("No entries yet."); return; }
  const byUid = {};
  entries.forEach(e => { (byUid[e.uid] = byUid[e.uid] || []).push(e); });
  Object.entries(byUid).forEach(([uid, list]) => {
    const group = document.createElement("div");
    group.className = "allowance-member-group";
    group.innerHTML = `<div class="allowance-member-group-title"><div class="avatar" style="width:24px;height:24px;font-size:11px;">${initials(membersCache[uid]?.name)}</div>${escapeHtml(membersCache[uid]?.name || "Unknown")}</div>`;
    list.forEach(a => group.appendChild(renderAllowanceEntry(a, false)));
    container.appendChild(group);
  });
}

function renderTeamAllowances() {
  const cabPanel = $("teamCabFoodList");
  const wkPanel = $("teamWeekendList");
  if (!cabPanel || !wkPanel) return;
  renderGroupedByMember(cabPanel, allAllowances.filter(a => a.type === "cabfood"));
  renderGroupedByMember(wkPanel, allAllowances.filter(a => a.type === "weekend"));
}

$("addAllowanceBtn").addEventListener("click", async () => {
  $("allowanceError").textContent = "";
  try {
    if (allowanceType === "cabfood") {
      const date = $("cfDateInput").value;
      const project = $("cfProjectInput").value.trim();
      const loginTime = $("cfLoginInput").value;
      const logoutTime = $("cfLogoutInput").value;
      if (!date || !loginTime || !logoutTime) {
        $("allowanceError").textContent = "Date, login time, and logout time are all required.";
        return;
      }
      await allowanceCol().add({
        type: "cabfood", date, project, loginTime, logoutTime,
        uid: currentUser.uid, userName: currentUserDoc.name, createdAt: nowTs()
      });
      $("cfDateInput").value = ""; $("cfProjectInput").value = ""; $("cfLoginInput").value = ""; $("cfLogoutInput").value = "";
    } else {
      const date = $("wkDateInput").value;
      const dayType = $("wkDayTypeInput").value;
      const projectId = $("wkProjectIdInput").value.trim();
      const client = $("wkClientInput").value.trim();
      const project = $("wkProjectInput").value.trim();
      const status = $("wkStatusInput").value;
      const description = $("wkDescInput").value.trim();
      const remarks = $("wkRemarksInput").value.trim();
      if (!date || !project) {
        $("allowanceError").textContent = "Date and project name are required.";
        return;
      }
      await allowanceCol().add({
        type: "weekend", date, dayType, projectId, client, project, status, description, remarks,
        uid: currentUser.uid, userName: currentUserDoc.name, createdAt: nowTs()
      });
      $("wkDateInput").value = ""; $("wkProjectIdInput").value = ""; $("wkClientInput").value = "";
      $("wkProjectInput").value = ""; $("wkDescInput").value = ""; $("wkRemarksInput").value = "";
      $("wkDayTypeInput").value = "Full day"; $("wkStatusInput").value = "Running Project/Upload";
    }
  } catch (err) {
    $("allowanceError").textContent = err.message;
  }
});

function to12Hour(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}.${String(m).padStart(2, "0")} ${period}`;
}

async function fetchEmployeeDetails(uids) {
  const unique = [...new Set(uids)];
  const snaps = await Promise.all(unique.map(uid => db.collection("users").doc(uid).get()));
  const map = {};
  snaps.forEach((snap, i) => { map[unique[i]] = snap.exists ? snap.data() : {}; });
  return map;
}

$("exportCabFoodBtn").addEventListener("click", async () => {
  const entries = allAllowances.filter(a => a.type === "cabfood");
  const empMap = await fetchEmployeeDetails(entries.map(e => e.uid));
  const rows = [["S.NO", "EMP.ID", "NAME", "Department", "Location", "Date", "Project Name", "In Time", "Out Time", "Extra Working Days"]];
  entries.forEach((e, i) => {
    const emp = empMap[e.uid] || {};
    rows.push([
      i + 1,
      emp.empId || "",
      membersCache[e.uid]?.name || e.userName || "Unknown",
      emp.department || "",
      emp.location || "",
      e.date || "",
      e.project || "",
      to12Hour(e.loginTime),
      to12Hour(e.logoutTime),
      ""
    ]);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Food and Cab Bill");
  XLSX.writeFile(wb, `food-and-cab-bill-${todayStr()}.xlsx`);
});

$("exportWeekendBtn").addEventListener("click", async () => {
  const entries = allAllowances.filter(a => a.type === "weekend");
  const empMap = await fetchEmployeeDetails(entries.map(e => e.uid));
  const byDate = {};
  entries.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  const wb = XLSX.utils.book_new();
  const dates = Object.keys(byDate).sort();
  const header = ["S.No", "EMP ID", "EMP NAME", "DEPARTMENT", "Project ID", "Client Name", "Project Name", "Project Status", "Work Planned", "Day Type", "Remarks"];
  if (!dates.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["No entries yet"]]), "Weekend Working");
  } else {
    dates.forEach(date => {
      const rows = [header];
      byDate[date].forEach((e, i) => {
        const emp = empMap[e.uid] || {};
        rows.push([
          i + 1, emp.empId || "", membersCache[e.uid]?.name || e.userName || "Unknown", emp.department || "",
          e.projectId || "", e.client || "", e.project || "", e.status || "",
          e.description || "", e.dayType || "", e.remarks || ""
        ]);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const sheetName = date.replace(/[\\/?*\[\]:]/g, "-").slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });
  }
  XLSX.writeFile(wb, `weekend-working-${todayStr()}.xlsx`);
});

// ---------- Projects & RFI Log ----------
let allProjects = [];
let allRfiEntries = [];
let rfiFilterProjectId = "";

function projectsCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("projects");
}
function rfiCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("rfiEntries");
}

function listenProjects() {
  const unsub = projectsCol().orderBy("name").onSnapshot(snap => {
    allProjects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProjectsList();
    populateProjectDropdowns();
    populateScheduleProjectDropdown();
    renderRfiDashboard();
  });
  unsubscribers.push(unsub);
}

function fmtProjectDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function renderProjectsList() {
  const container = $("projectsListContainer");
  if (!container) return;
  container.innerHTML = "";
  if (!allProjects.length) { container.innerHTML = emptyState("No projects yet."); return; }
  allProjects.forEach(p => {
    const status = p.status || "Ongoing";
    const isCompleted = status === "Completed";
    const div = document.createElement("div");
    div.className = "project-item";

    const info = document.createElement("div");
    info.className = "project-item-info";
    info.innerHTML = `
      <span>${escapeHtml(p.name)}</span>
      <span class="project-item-meta">Started ${fmtProjectDate(p.startDate)}${isCompleted ? " · Completed " + fmtProjectDate(p.completedDate) : ""}</span>`;
    div.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "project-item-actions";

    const pill = document.createElement("span");
    pill.className = "project-status-pill " + (isCompleted ? "project-status-completed" : "project-status-ongoing");
    pill.textContent = status;
    actions.appendChild(pill);

    // Only Team Lead can flip a project's status.
    if (currentWorkspaceRole === "admin") {
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "btn-secondary";
      toggleBtn.textContent = isCompleted ? "Mark Ongoing" : "Mark Completed";
      toggleBtn.addEventListener("click", () => {
        if (isCompleted) {
          projectsCol().doc(p.id).update({ status: "Ongoing", completedDate: null });
        } else {
          projectsCol().doc(p.id).update({ status: "Completed", completedDate: todayStr() });
        }
      });
      actions.appendChild(toggleBtn);
    }

    if (p.addedBy === currentUser.uid || currentWorkspaceRole === "admin") {
      const delBtn = document.createElement("button");
      delBtn.className = "danger-btn";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => projectsCol().doc(p.id).delete());
      actions.appendChild(delBtn);
    }

    div.appendChild(actions);
    container.appendChild(div);
  });
}

function populateProjectDropdowns() {
  const addSelect = $("rfiProjectInput");
  const filterSelect = $("rfiFilterProject");
  if (addSelect) {
    const current = addSelect.value;
    addSelect.innerHTML = allProjects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    if (current && allProjects.some(p => p.id === current)) addSelect.value = current;
  }
  if (filterSelect) {
    const current = filterSelect.value;
    filterSelect.innerHTML = `<option value="">All Projects</option>` +
      allProjects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    filterSelect.value = current || "";
  }
}

$("addProjectBtn").addEventListener("click", async () => {
  $("projectError").textContent = "";
  const name = $("newProjectNameInput").value.trim();
  const startDate = $("newProjectStartDateInput").value || todayStr();
  if (!name) { $("projectError").textContent = "Project name is required."; return; }
  try {
    await projectsCol().add({
      name, startDate, status: "Ongoing", completedDate: null,
      addedBy: currentUser.uid, addedByName: currentUserDoc.name, createdAt: nowTs()
    });
    $("newProjectNameInput").value = ""; $("newProjectStartDateInput").value = "";
  } catch (err) {
    $("projectError").textContent = err.message;
  }
});

function rfiStatusClass(status) {
  if (status === "Closed") return "rfi-status-closed";
  if (status === "Partially Closed") return "rfi-status-partial";
  if (status === "Void") return "rfi-status-void";
  return "rfi-status-open";
}

function fmtRfiDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function listenRfiEntries() {
  const unsub = rfiCol().orderBy("createdAt", "desc").onSnapshot(snap => {
    allRfiEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderRfiLog();
    renderRfiDashboard();
  });
  unsubscribers.push(unsub);
}

function renderRfiLog() {
  const container = $("rfiLogContainer");
  if (!container) return;
  const filtered = rfiFilterProjectId ? allRfiEntries.filter(r => r.projectId === rfiFilterProjectId) : allRfiEntries;
  container.innerHTML = "";
  if (!filtered.length) { container.innerHTML = emptyState("No entries yet."); return; }
  filtered.forEach(r => {
    const div = document.createElement("div");
    div.className = "rfi-entry";
    div.innerHTML = `
      <div class="rfi-entry-top">
        <div class="rfi-entry-title">${escapeHtml(r.refNo || "—")} · ${escapeHtml(r.type || "")} — ${escapeHtml(r.subject || "")}</div>
        <span class="rfi-status-pill ${rfiStatusClass(r.status)}">${escapeHtml(r.status || "Open")}</span>
      </div>
      <div class="rfi-entry-meta">
        ${escapeHtml(r.projectName || "—")} · Sent to ${escapeHtml(r.sentTo || "—")} · Sent ${fmtRfiDate(r.dateSent)}${r.dueDate ? " · Due " + fmtRfiDate(r.dueDate) : ""}${r.dateReceived ? " · Received " + fmtRfiDate(r.dateReceived) : ""}
        ${r.responseSummary ? "<br>" + escapeHtml(r.responseSummary) : ""}
        ${r.notes ? "<br>Notes: " + escapeHtml(r.notes) : ""}
      </div>`;
    const delBtn = document.createElement("button");
    delBtn.className = "danger-btn";
    delBtn.textContent = "Delete";
    delBtn.style.marginTop = "8px";
    delBtn.addEventListener("click", () => rfiCol().doc(r.id).delete());
    div.appendChild(delBtn);
    container.appendChild(div);
  });
}

$("rfiFilterProject").addEventListener("change", (e) => {
  rfiFilterProjectId = e.target.value;
  renderRfiLog();
});

function renderRfiDashboard() {
  const container = $("rfiDashboardContainer");
  if (!container) return;
  if (!allProjects.length) { container.innerHTML = emptyState("No projects yet."); return; }
  // Open bucket = Open + Partially Closed. Closed bucket = Closed + Void.
  const rows = allProjects.map(p => {
    const entries = allRfiEntries.filter(r => r.projectId === p.id);
    const open = entries.filter(r => r.status === "Open" || r.status === "Partially Closed" || !r.status).length;
    const closed = entries.filter(r => r.status === "Closed" || r.status === "Void").length;
    return { name: p.name, open, closed, total: entries.length };
  });
  const totalOpen = rows.reduce((s, r) => s + r.open, 0);
  const totalClosed = rows.reduce((s, r) => s + r.closed, 0);
  const totalAll = rows.reduce((s, r) => s + r.total, 0);
  container.innerHTML = `
    <table class="rfi-dashboard-table">
      <thead><tr><th>Project</th><th>Open</th><th>Closed</th><th>Total</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${r.open}</td><td>${r.closed}</td><td>${r.total}</td></tr>`).join("")}
        <tr style="font-weight:700;"><td>Total</td><td>${totalOpen}</td><td>${totalClosed}</td><td>${totalAll}</td></tr>
      </tbody>
    </table>`;
}

$("addRfiBtn").addEventListener("click", async () => {
  $("rfiError").textContent = "";
  const projectId = $("rfiProjectInput").value;
  const project = allProjects.find(p => p.id === projectId);
  const type = $("rfiTypeInput").value;
  const refNo = $("rfiRefNoInput").value.trim();
  const subject = $("rfiSubjectInput").value.trim();
  const sentTo = $("rfiSentToInput").value.trim();
  const dateSent = $("rfiDateSentInput").value;
  const dueDate = $("rfiDueDateInput").value;
  const status = $("rfiStatusInput").value;
  const dateReceived = $("rfiDateReceivedInput").value;
  const responseSummary = $("rfiResponseInput").value.trim();
  const notes = $("rfiNotesInput").value.trim();

  if (!project || !refNo || !subject) {
    $("rfiError").textContent = "Project, Ref No., and Subject are required.";
    return;
  }
  try {
    await rfiCol().add({
      projectId, projectName: project.name, type, refNo, subject, sentTo,
      dateSent, dueDate, status, dateReceived, responseSummary, notes,
      addedBy: currentUser.uid, addedByName: currentUserDoc.name, createdAt: nowTs()
    });
    $("rfiRefNoInput").value = ""; $("rfiSubjectInput").value = ""; $("rfiSentToInput").value = "";
    $("rfiDateSentInput").value = ""; $("rfiDueDateInput").value = ""; $("rfiDateReceivedInput").value = "";
    $("rfiResponseInput").value = ""; $("rfiNotesInput").value = "";
    $("rfiStatusInput").value = "Open";
  } catch (err) {
    $("rfiError").textContent = err.message;
  }
});

function setFormulaCell(ws, addr, formula) {
  ws[addr] = { t: "n", f: formula };
}

$("exportRfiBtn").addEventListener("click", () => {
  const wb = XLSX.utils.book_new();

  // ---- Projects sheet ----
  const projRows = [
    ["PROJECTS"],
    ["Add one project name per row below. These names populate the Project dropdown on the RFI Log sheet."],
    [],
    ["Project Name", "Start Date", "Status", "Completed Date", "Notes"],
    ...allProjects.map(p => [p.name, p.startDate || "", p.status || "Ongoing", p.completedDate || "", ""])
  ];
  const projSheet = XLSX.utils.aoa_to_sheet(projRows);
  XLSX.utils.book_append_sheet(wb, projSheet, "Projects");

  // ---- RFI Log sheet ---- (data starts at row 5, column A=Project ... H=Status)
  const logHeader = ["Project", "Type", "Ref No.", "Subject", "Sent To", "Date Sent", "Due Date", "Status", "Date Received", "Response Summary", "Notes"];
  const logRows = [
    ["Team RFI / CLARIFICATION LOG"],
    ["TRACKING REGISTER"],
    [],
    logHeader,
    ...allRfiEntries.map(r => [
      r.projectName || "", r.type || "", r.refNo || "", r.subject || "", r.sentTo || "",
      r.dateSent || "", r.dueDate || "", r.status || "Open", r.dateReceived || "", r.responseSummary || "", r.notes || ""
    ])
  ];
  const logSheet = XLSX.utils.aoa_to_sheet(logRows);
  XLSX.utils.book_append_sheet(wb, logSheet, "RFI Log");

  // ---- Dashboard sheet ---- (COUNTIFS formulas against a generous fixed range so it
  // keeps working if rows are added to RFI Log later — never hardcoded numbers)
  const RANGE = "$5:$1004";
  const dashRows = [
    ["DASHBOARD"],
    ["Live counts per project, pulled automatically from the RFI Log sheet."],
    [],
    ["Project", "Open", "Closed", "Total"],
    ...allProjects.map(p => [p.name, 0, 0, 0]),
    ["Total", 0, 0, 0]
  ];
  const dashSheet = XLSX.utils.aoa_to_sheet(dashRows);
  const firstRow = 5;
  allProjects.forEach((p, i) => {
    const row = firstRow + i;
    setFormulaCell(dashSheet, `B${row}`,
      `COUNTIFS('RFI Log'!$A${RANGE},A${row},'RFI Log'!$H${RANGE},"Open")+COUNTIFS('RFI Log'!$A${RANGE},A${row},'RFI Log'!$H${RANGE},"Partially Closed")`);
    setFormulaCell(dashSheet, `C${row}`,
      `COUNTIFS('RFI Log'!$A${RANGE},A${row},'RFI Log'!$H${RANGE},"Closed")+COUNTIFS('RFI Log'!$A${RANGE},A${row},'RFI Log'!$H${RANGE},"Void")`);
    setFormulaCell(dashSheet, `D${row}`, `COUNTIF('RFI Log'!$A${RANGE},A${row})`);
  });
  const totalRow = firstRow + allProjects.length;
  if (allProjects.length) {
    setFormulaCell(dashSheet, `B${totalRow}`, `SUM(B${firstRow}:B${totalRow - 1})`);
    setFormulaCell(dashSheet, `C${totalRow}`, `SUM(C${firstRow}:C${totalRow - 1})`);
    setFormulaCell(dashSheet, `D${totalRow}`, `SUM(D${firstRow}:D${totalRow - 1})`);
  }
  XLSX.utils.book_append_sheet(wb, dashSheet, "Dashboard");

  XLSX.writeFile(wb, `rfi-log-${todayStr()}.xlsx`);
});

// ---------- Chat ----------
let readState = {};       // channelId -> millis of last read
let unreadCounts = {};    // channelId -> unread count
let watchedChannels = new Set();

function readStateRef() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("readState").doc(currentUser.uid);
}

function markChannelRead(channelId) {
  readStateRef().set({ [channelId]: nowTs() }, { merge: true }).catch(() => {});
  readState[channelId] = Date.now();
  unreadCounts[channelId] = 0;
  recomputeChatBadge();
}

function listenReadState() {
  const unsub = readStateRef().onSnapshot(snap => {
    const data = snap.data() || {};
    Object.entries(data).forEach(([ch, ts]) => { readState[ch] = ts?.toMillis?.() || 0; });
  }, () => {});
  unsubscribers.push(unsub);
}

function watchChannelUnread(channelId) {
  if (watchedChannels.has(channelId)) return;
  watchedChannels.add(channelId);
  const unsub = db.collection("workspaces").doc(currentWorkspaceId).collection("channels").doc(channelId)
    .collection("messages").orderBy("createdAt", "desc").limit(30)
    .onSnapshot(snap => {
      const lastRead = readState[channelId] || 0;
      let count = 0;
      snap.forEach(d => {
        const m = d.data();
        const ts = m.createdAt?.toMillis?.() || 0;
        if (m.authorUid !== currentUser.uid && ts > lastRead) count++;
      });
      unreadCounts[channelId] = count;
      recomputeChatBadge();
    }, () => {});
  unsubscribers.push(unsub);
}

function recomputeChatBadge() {
  const total = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
  const badge = $("chatBadge");
  if (!badge) return;
  badge.textContent = total;
  badge.classList.toggle("hidden", total === 0);
}

function listenChannels() {
  const unsub = db.collection("workspaces").doc(currentWorkspaceId).collection("channels")
    .onSnapshot(snap => {
      const list = $("channelList");
      list.querySelectorAll(".channel-item").forEach(el => el.remove());
      snap.forEach(doc => {
        watchChannelUnread(doc.id);
        const item = document.createElement("div");
        item.className = "channel-item" + (doc.id === activeChannelId ? " active" : "");
        item.textContent = "# " + doc.data().name;
        item.addEventListener("click", () => {
          activeChannelId = doc.id;
          list.querySelectorAll(".channel-item").forEach(el => el.classList.remove("active"));
          item.classList.add("active");
          listenMessages();
          markChannelRead(activeChannelId);
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
      const isMine = m.authorUid === currentUser.uid;
      div.innerHTML = `
        <div class="avatar">${initials(m.authorName)}</div>
        <div class="msg-body">
          <div class="msg-head">
            <span class="msg-author">${escapeHtml(m.authorName)}</span>
            <span class="msg-time">${fmtDate(m.createdAt)}${m.edited ? ' · <span class="msg-edited">edited</span>' : ""}</span>
            ${isMine ? `<button class="msg-edit-btn" data-id="${d.id}">Edit</button>` : ""}
          </div>
          <div class="msg-text" id="msgText-${d.id}">${rendered}</div>
        </div>`;
      if (isMine) {
        div.querySelector(".msg-edit-btn").addEventListener("click", () => startEditMessage(d.id, m.text));
      }
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  });
  unsubscribers.push(unsub);
}

function startEditMessage(msgId, currentText) {
  const textDiv = $(`msgText-${msgId}`);
  if (!textDiv) return;
  const originalHtml = textDiv.innerHTML;
  textDiv.innerHTML = `
    <textarea class="msg-edit-input" id="msgEditInput-${msgId}">${currentText}</textarea>
    <div class="msg-edit-actions">
      <button class="btn-secondary" id="msgEditCancel-${msgId}">Cancel</button>
      <button class="btn-primary" id="msgEditSave-${msgId}">Save</button>
    </div>`;
  $(`msgEditInput-${msgId}`).focus();
  $(`msgEditCancel-${msgId}`).addEventListener("click", () => { textDiv.innerHTML = originalHtml; });
  $(`msgEditSave-${msgId}`).addEventListener("click", async () => {
    const newText = $(`msgEditInput-${msgId}`).value.trim();
    if (!newText) return;
    await msgCol().doc(msgId).update({ text: newText, edited: true, editedAt: nowTs() });
  });
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
    const canRemove = currentWorkspaceRole === "admin" && uid !== currentUser.uid;
    row.innerHTML = `
      <div class="avatar">${initials(m.name)}</div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;">${escapeHtml(m.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${escapeHtml(m.email)} · ${m.role}</div>
      </div>
      ${canRemove ? `<button class="danger-btn" data-uid="${uid}">Remove</button>` : ""}`;
    if (canRemove) {
      row.querySelector("button").addEventListener("click", () => removeMember(uid, m.name));
    }
    container.appendChild(row);
  });
}

async function removeMember(uid, name) {
  if (!confirm(`Remove ${name} from this workspace?`)) return;
  const wsRef = db.collection("workspaces").doc(currentWorkspaceId);
  await wsRef.update({
    memberUids: firebase.firestore.FieldValue.arrayRemove(uid),
    [`members.${uid}`]: firebase.firestore.FieldValue.delete()
  });
  await enterWorkspace();
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

// ---------- Sticky Notes (personal, private per user) ----------
function notesCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("stickyNotes");
}

let selectedNoteColor = "yellow";
let myNotes = [];

document.querySelectorAll("#noteColorRow .sticky-color-dot").forEach(dot => {
  dot.addEventListener("click", () => {
    document.querySelectorAll("#noteColorRow .sticky-color-dot").forEach(d => d.classList.remove("active"));
    dot.classList.add("active");
    selectedNoteColor = dot.dataset.color;
  });
});

function listenNotes() {
  const unsub = notesCol().where("ownerUid", "==", currentUser.uid).onSnapshot(snap => {
    myNotes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    myNotes.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    renderNotesGrid();
  }, err => {
    console.error("Notes listener error:", err);
  });
  unsubscribers.push(unsub);
}

function renderNotesGrid() {
  const grid = $("notesGrid");
  if (!grid) return;
  grid.innerHTML = "";
  if (!myNotes.length) { grid.innerHTML = emptyState("No sticky notes yet — jot one down above."); return; }
  myNotes.forEach(n => {
    const card = document.createElement("div");
    card.className = `sticky-note color-${n.color || "yellow"}`;
    card.innerHTML = `
      <button class="sticky-note-del" data-id="${n.id}">✕</button>
      <div class="sticky-note-text">${escapeHtml(n.text)}</div>`;
    card.querySelector(".sticky-note-del").addEventListener("click", () => notesCol().doc(n.id).delete());
    grid.appendChild(card);
  });
}

$("addNoteBtn").addEventListener("click", async () => {
  const text = $("newNoteInput").value.trim();
  if (!text) return;
  await notesCol().add({
    text, color: selectedNoteColor, ownerUid: currentUser.uid, createdAt: nowTs()
  });
  $("newNoteInput").value = "";
});

// ---------- Flags (approval / fab-stage watch points) ----------
function flagsCol() {
  return db.collection("workspaces").doc(currentWorkspaceId).collection("flags");
}

let allFlags = [];
function listenFlags() {
  const unsub = flagsCol().orderBy("createdAt", "desc").onSnapshot(snap => {
    allFlags = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFlags();
    populateFlagTaskDropdown();
  });
  unsubscribers.push(unsub);
}

function populateFlagTaskDropdown() {
  const select = $("flagTaskInput");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">General — not tied to a specific task</option>` +
    allTasks.map(t => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join("");
  if (current && allTasks.some(t => t.id === current)) select.value = current;
}

function fmtFlagDate(ts) {
  return ts ? fmtDate(ts) : "";
}

function renderFlags() {
  const openContainer = $("openFlagsContainer");
  const resolvedContainer = $("resolvedFlagsContainer");
  if (!openContainer || !resolvedContainer) return;

  const open = allFlags.filter(f => !f.resolved);
  const resolved = allFlags.filter(f => f.resolved);

  $("flagsBadge").textContent = open.length;
  $("flagsBadge").classList.toggle("hidden", open.length === 0);

  openContainer.innerHTML = "";
  if (!open.length) { openContainer.innerHTML = emptyState("No open flags — nothing pending review."); }
  open.forEach(f => openContainer.appendChild(renderFlagRow(f, false)));

  resolvedContainer.innerHTML = "";
  if (!resolved.length) { resolvedContainer.innerHTML = emptyState("Nothing resolved yet."); }
  resolved.forEach(f => resolvedContainer.appendChild(renderFlagRow(f, true)));
}

function renderFlagRow(f, isResolved) {
  const row = document.createElement("div");
  row.className = "flag-item" + (isResolved ? " resolved" : "");
  row.innerHTML = `
    <div class="flag-text">
      ${f.taskTitle ? `<span class="flag-task-tag">${escapeHtml(f.taskTitle)}</span>` : ""}
      ${escapeHtml(f.text)}
      <div class="flag-meta">Raised by ${escapeHtml(f.createdByName || "")} · ${fmtFlagDate(f.createdAt)}${isResolved ? ` · Resolved by ${escapeHtml(f.resolvedByName || "")}` : ""}</div>
    </div>
    <div class="flag-item-actions"></div>`;
  const actions = row.querySelector(".flag-item-actions");
  if (!isResolved) {
    const resolveBtn = document.createElement("button");
    resolveBtn.className = "btn-secondary";
    resolveBtn.textContent = "Mark resolved";
    resolveBtn.addEventListener("click", () => {
      flagsCol().doc(f.id).update({
        resolved: true, resolvedBy: currentUser.uid, resolvedByName: currentUserDoc.name, resolvedAt: nowTs()
      });
    });
    actions.appendChild(resolveBtn);
  }
  if (f.createdBy === currentUser.uid || currentWorkspaceRole === "admin") {
    const delBtn = document.createElement("button");
    delBtn.className = "danger-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => flagsCol().doc(f.id).delete());
    actions.appendChild(delBtn);
  }
  return row;
}

$("addFlagBtn").addEventListener("click", async () => {
  $("flagError").textContent = "";
  const text = $("flagTextInput").value.trim();
  const taskId = $("flagTaskInput").value;
  const task = taskId ? allTasks.find(t => t.id === taskId) : null;
  if (!text) { $("flagError").textContent = "Enter what the team should watch for."; return; }
  await flagsCol().add({
    text, taskId: taskId || null, taskTitle: task ? task.title : null,
    resolved: false, createdBy: currentUser.uid, createdByName: currentUserDoc.name, createdAt: nowTs()
  });
  $("flagTextInput").value = "";
  $("flagTaskInput").value = "";
});

// ---------- Register service worker ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
