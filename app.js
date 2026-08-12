function createEmptyState() {
  const listId = uniqueId("list");
  return {
    activeListId: listId,
    lists: [{ id: listId, name: "我的求职记录", applications: [] }]
  };
}

let state = createEmptyState();
let currentUser = null;
let storageKey = null;
let authConfig = {
  enabled: true,
  inviteRequired: false,
  setupRequired: false,
  passwordChangeEnabled: false
};
let backendReady = false;
let backendRevision = 0;
let pendingBackendSnapshot = null;
let backendSyncRunning = false;
const ui = {
  activeFilter: "all",
  search: "",
  type: "all",
  calendarDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  listDialogMode: "new",
  toastTimer: null
};

const els = {
  appShell: document.querySelector("#app-shell"),
  profileAvatar: document.querySelector("#profile-avatar"),
  profileUsername: document.querySelector("#profile-username"),
  logoutButton: document.querySelector("#logout-button"),
  passwordButton: document.querySelector("#password-button"),
  passwordDialog: document.querySelector("#password-dialog"),
  passwordForm: document.querySelector("#password-form"),
  currentPassword: document.querySelector("#current-password"),
  newPassword: document.querySelector("#new-password"),
  newPasswordConfirm: document.querySelector("#new-password-confirm"),
  passwordError: document.querySelector("#password-error"),
  passwordSubmit: document.querySelector("#password-submit"),
  listTabs: document.querySelector("#list-tabs"),
  trackerTitle: document.querySelector("#tracker-title"),
  statsLine: document.querySelector("#stats-line"),
  filterChips: document.querySelector("#filter-chips"),
  searchInput: document.querySelector("#search-input"),
  typeFilter: document.querySelector("#type-filter"),
  tableBody: document.querySelector("#application-body"),
  rowTemplate: document.querySelector("#row-template"),
  emptyState: document.querySelector("#empty-state"),
  visibleCount: document.querySelector("#visible-count"),
  listDialog: document.querySelector("#list-dialog"),
  listDialogTitle: document.querySelector("#list-dialog-title"),
  listForm: document.querySelector("#list-form"),
  listNameInput: document.querySelector("#list-name-input"),
  interviewDialog: document.querySelector("#interview-dialog"),
  interviewForm: document.querySelector("#interview-form"),
  interviewId: document.querySelector("#interview-id"),
  interviewDate: document.querySelector("#interview-date"),
  interviewTime: document.querySelector("#interview-time"),
  interviewRound: document.querySelector("#interview-round"),
  interviewMode: document.querySelector("#interview-mode"),
  interviewPlace: document.querySelector("#interview-place"),
  clearInterview: document.querySelector("#clear-interview-button"),
  calendarMonth: document.querySelector("#calendar-month"),
  calendarGrid: document.querySelector("#calendar-grid"),
  weekInterviews: document.querySelector("#week-interviews"),
  activeApplications: document.querySelector("#active-applications"),
  offerCount: document.querySelector("#offer-count"),
  syncStatus: document.querySelector("#sync-status"),
  toast: document.querySelector("#toast")
};

const filterDefinitions = [
  { key: "all", label: "全部" },
  { key: "progress", label: "进行中" },
  { key: "interview", label: "面试中" },
  { key: "offer", label: "Offer" },
  { key: "closed", label: "已拒 / 结束" }
];

function loadLocalState() {
  if (!storageKey) return createEmptyState();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.lists?.length) return saved;
  } catch (error) {
    console.warn("Could not load saved data", error);
  }
  return createEmptyState();
}

function setSyncStatus(status, label) {
  els.syncStatus.dataset.state = status;
  els.syncStatus.querySelector("span").textContent = label;
}

async function persistBackend(snapshot) {
  const response = await fetch("/api/state", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-Match": String(backendRevision),
      "X-OfferFlow-CSRF": "1"
    },
    body: JSON.stringify(snapshot),
    keepalive: true
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Save failed with status ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  backendRevision = payload.revision;
}

function applyBackendState(payload) {
  if (!payload.initialized || !payload.state?.lists?.length) return false;
  backendRevision = payload.revision;
  state = payload.state;
  if (storageKey) localStorage.setItem(storageKey, JSON.stringify(state));
  return true;
}

async function flushBackendQueue() {
  if (!backendReady || backendSyncRunning || !pendingBackendSnapshot) return;
  backendSyncRunning = true;
  try {
    while (pendingBackendSnapshot) {
      const snapshot = pendingBackendSnapshot;
      pendingBackendSnapshot = null;
      await persistBackend(snapshot);
    }
    setSyncStatus("saved", "已保存");
  } catch (error) {
    console.warn("Could not save to SQLite backend", error);
    pendingBackendSnapshot = null;
    if (error.status === 401) {
      showAuthScreen("登录已失效，请重新登录");
    } else if (error.status === 409 && applyBackendState(error.payload.latest)) {
      setSyncStatus("saved", "已同步新版本");
      render();
      showToast("另一台设备已更新数据，已载入最新版本");
    } else {
      backendReady = false;
      setSyncStatus("local", "仅本地保存");
    }
  } finally {
    backendSyncRunning = false;
    if (pendingBackendSnapshot) void flushBackendQueue();
  }
}

function saveState() {
  const serialized = JSON.stringify(state);
  if (storageKey) localStorage.setItem(storageKey, serialized);
  if (!backendReady) {
    setSyncStatus("local", "仅本地保存");
    return;
  }
  pendingBackendSnapshot = JSON.parse(serialized);
  setSyncStatus("saving", "保存中");
  void flushBackendQueue();
}

async function connectBackend() {
  setSyncStatus("connecting", "连接中");
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.status === 401) {
      showAuthScreen("登录已失效，请重新登录");
      return;
    }
    if (!response.ok) throw new Error(`Backend returned status ${response.status}`);
    const payload = await response.json();
    backendReady = true;
    backendRevision = payload.revision;
    if (!applyBackendState(payload)) {
      try {
        await persistBackend(state);
      } catch (error) {
        if (error.status !== 409 || !applyBackendState(error.payload.latest)) throw error;
        showToast("云端已由另一台设备初始化，已载入云端数据");
      }
    }
    setSyncStatus("saved", "已保存");
  } catch (error) {
    backendReady = false;
    console.warn("SQLite backend is unavailable; using browser storage", error);
    setSyncStatus("local", "仅本地保存");
  }
}

async function refreshBackendState() {
  if (!currentUser || !backendReady || backendSyncRunning || pendingBackendSnapshot) return;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.status === 401) {
      showAuthScreen("登录已失效，请重新登录");
      return;
    }
    if (!response.ok) throw new Error(`Backend returned status ${response.status}`);
    const payload = await response.json();
    if (payload.revision > backendRevision && applyBackendState(payload)) {
      render();
      setSyncStatus("saved", "已同步新版本");
      showToast("已同步另一台设备的修改");
    }
  } catch (error) {
    console.warn("Could not refresh state from SQLite backend", error);
  }
}

function activeList() {
  return state.lists.find((list) => list.id === state.activeListId) || state.lists[0];
}

function allApplications() {
  return state.lists.flatMap((list) => list.applications);
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function statusGroup(status) {
  if (["一面", "二面", "三面", "终面"].includes(status)) return "interview";
  if (status === "Offer") return "offer";
  if (["已拒绝", "已结束"].includes(status)) return "closed";
  return "progress";
}

function statusClass(status) {
  const group = statusGroup(status);
  if (group === "interview") return "status-interview";
  if (group === "offer") return "status-offer";
  if (group === "closed") return "status-closed";
  return "status-active";
}

function filteredApplications() {
  const query = ui.search.trim().toLowerCase();
  return activeList().applications.filter((application) => {
    const groupMatch = ui.activeFilter === "all" || statusGroup(application.status) === ui.activeFilter;
    const typeMatch = ui.type === "all" || application.type === ui.type;
    const searchMatch = !query || [application.company, application.role, application.notes]
      .some((value) => String(value || "").toLowerCase().includes(query));
    return groupMatch && typeMatch && searchMatch;
  });
}

function render() {
  renderListTabs();
  renderSummary();
  renderFilters();
  renderTable();
  renderCalendar();
}

function renderListTabs() {
  els.listTabs.replaceChildren();
  state.lists.forEach((list) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `list-tab${list.id === state.activeListId ? " active" : ""}`;
    button.dataset.listId = list.id;
    button.innerHTML = `${escapeHtml(list.name)} <span>${list.applications.length}</span>`;
    els.listTabs.append(button);
  });
  els.trackerTitle.textContent = activeList().name;
  document.querySelector("#delete-list-button").disabled = state.lists.length === 1;
}

function renderSummary() {
  const apps = activeList().applications;
  const counts = apps.reduce((result, app) => {
    result[statusGroup(app.status)] += 1;
    return result;
  }, { progress: 0, interview: 0, offer: 0, closed: 0 });
  const active = counts.progress + counts.interview;
  els.statsLine.innerHTML = `<strong>共 ${apps.length} 条</strong><i>·</i>进行中 ${active}<i>·</i>面试 ${counts.interview}<i>·</i>Offer ${counts.offer}<i>·</i>已结束 ${counts.closed}`;
  els.activeApplications.textContent = active;
  els.offerCount.textContent = counts.offer;

  const today = new Date();
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const thisWeek = allApplications().filter((app) => {
    if (!app.interview?.date) return false;
    const date = parseLocalDate(app.interview.date);
    return date >= monday && date <= sunday;
  }).length;
  els.weekInterviews.textContent = thisWeek;
}

function renderFilters() {
  const apps = activeList().applications;
  els.filterChips.replaceChildren();
  filterDefinitions.forEach((filter) => {
    const count = filter.key === "all" ? apps.length : apps.filter((app) => statusGroup(app.status) === filter.key).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter-chip${ui.activeFilter === filter.key ? " active" : ""}`;
    button.dataset.filter = filter.key;
    button.innerHTML = `${filter.label}<span>${count}</span>`;
    els.filterChips.append(button);
  });
}

function renderTable() {
  const applications = filteredApplications();
  els.tableBody.replaceChildren();
  applications.forEach((application) => {
    const fragment = els.rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    row.dataset.id = application.id;
    row.querySelector(".row-index").textContent = activeList().applications.indexOf(application) + 1;
    row.querySelectorAll("[data-field]").forEach((input) => {
      input.value = application[input.dataset.field] || "";
    });
    const statusSelect = row.querySelector(".status-select");
    statusSelect.classList.add(statusClass(application.status));
    const scheduleButton = row.querySelector(".schedule-button");
    if (application.interview) {
      scheduleButton.innerHTML = `<strong>${escapeHtml(application.interview.round)}</strong><br>${formatShortDate(application.interview.date)} ${escapeHtml(application.interview.time)}`;
    } else {
      scheduleButton.textContent = "＋ 安排面试";
      scheduleButton.classList.add("no-schedule");
    }
    els.tableBody.append(fragment);
  });
  els.emptyState.hidden = applications.length > 0;
  els.visibleCount.textContent = applications.length === activeList().applications.length
    ? `共 ${applications.length} 条记录`
    : `显示 ${applications.length} / ${activeList().applications.length} 条`;
}

function renderCalendar() {
  const year = ui.calendarDate.getFullYear();
  const month = ui.calendarDate.getMonth();
  els.calendarMonth.textContent = `${year} 年 ${month + 1} 月`;
  els.calendarGrid.replaceChildren();

  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);
  const today = new Date();

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const dateString = toDateString(date);
    const events = allApplications().filter((app) => app.interview?.date === dateString);
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    if (date.getMonth() !== month) cell.classList.add("outside");
    if (isSameDate(date, today)) cell.classList.add("today");
    if (events.length) cell.classList.add("has-event");
    cell.innerHTML = `<span class="day-number">${date.getDate()}</span>`;

    events.forEach((application) => {
      const event = document.createElement("button");
      event.type = "button";
      event.className = "calendar-event";
      event.dataset.applicationId = application.id;
      event.innerHTML = `<strong>${escapeHtml(application.company)} · ${escapeHtml(application.interview.round)}</strong><span>${escapeHtml(application.interview.time)} ${escapeHtml(application.interview.mode)}</span>`;
      cell.append(event);
    });
    els.calendarGrid.append(cell);
  }
}

function updateApplication(id, field, value) {
  const application = activeList().applications.find((item) => item.id === id);
  if (!application) return;
  application[field] = value;
  saveState();
  if (field === "status") render();
  else renderSummary();
}

function addApplication() {
  const today = toDateString(new Date());
  const application = {
    id: uniqueId("app"),
    company: "新公司",
    type: "私企",
    role: "待填写岗位",
    date: today,
    status: "待投递",
    notes: "",
    interview: null
  };
  activeList().applications.push(application);
  ui.activeFilter = "all";
  ui.search = "";
  ui.type = "all";
  els.searchInput.value = "";
  els.typeFilter.value = "all";
  saveState();
  render();
  requestAnimationFrame(() => {
    const input = els.tableBody.querySelector(`tr[data-id="${application.id}"] .company-input`);
    input?.focus();
    input?.select();
  });
  showToast("已添加一条投递记录");
}

function deleteApplication(id) {
  const list = activeList();
  const index = list.applications.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [removed] = list.applications.splice(index, 1);
  saveState();
  render();
  showToast(`已删除 ${removed.company}`);
}

function openListDialog(mode) {
  ui.listDialogMode = mode;
  const renaming = mode === "rename";
  els.listDialogTitle.textContent = renaming ? "重命名列表" : "新建列表";
  els.listNameInput.value = renaming ? activeList().name : "";
  els.listDialog.showModal();
  requestAnimationFrame(() => els.listNameInput.focus());
}

function saveList(event) {
  event.preventDefault();
  const name = els.listNameInput.value.trim();
  if (!name) return;
  if (ui.listDialogMode === "rename") {
    activeList().name = name;
    showToast("列表名称已更新");
  } else {
    const list = { id: uniqueId("list"), name, applications: [] };
    state.lists.push(list);
    state.activeListId = list.id;
    resetFilters();
    showToast("已创建新列表");
  }
  saveState();
  els.listDialog.close();
  render();
}

function deleteCurrentList() {
  if (state.lists.length === 1) return;
  const list = activeList();
  if (!window.confirm(`确定删除“${list.name}”及其中的 ${list.applications.length} 条记录吗？`)) return;
  const index = state.lists.findIndex((item) => item.id === list.id);
  state.lists.splice(index, 1);
  state.activeListId = state.lists[Math.max(0, index - 1)].id;
  resetFilters();
  saveState();
  render();
  showToast("列表已删除");
}

function resetFilters() {
  ui.activeFilter = "all";
  ui.search = "";
  ui.type = "all";
  els.searchInput.value = "";
  els.typeFilter.value = "all";
}

function findApplicationAcrossLists(id) {
  for (const list of state.lists) {
    const application = list.applications.find((item) => item.id === id);
    if (application) return { application, list };
  }
  return null;
}

function openInterviewDialog(id) {
  const result = findApplicationAcrossLists(id);
  if (!result) return;
  const { application } = result;
  const interview = application.interview || {};
  els.interviewId.value = id;
  document.querySelector("#interview-dialog-title").textContent = `${application.company} · 面试安排`;
  els.interviewDate.value = interview.date || toDateString(new Date());
  els.interviewTime.value = interview.time || "10:00";
  els.interviewRound.value = interview.round || "一面";
  els.interviewMode.value = interview.mode || "线上";
  els.interviewPlace.value = interview.place || "";
  els.clearInterview.hidden = !application.interview;
  els.interviewDialog.showModal();
}

function saveInterview(event) {
  event.preventDefault();
  const result = findApplicationAcrossLists(els.interviewId.value);
  if (!result) return;
  result.application.interview = {
    date: els.interviewDate.value,
    time: els.interviewTime.value,
    round: els.interviewRound.value,
    mode: els.interviewMode.value,
    place: els.interviewPlace.value.trim()
  };
  if (["待投递", "已投递", "笔试"].includes(result.application.status)) {
    result.application.status = els.interviewRound.value;
  }
  ui.calendarDate = parseLocalDate(els.interviewDate.value);
  ui.calendarDate.setDate(1);
  saveState();
  els.interviewDialog.close();
  render();
  showToast("面试安排已保存");
}

function clearInterview() {
  const result = findApplicationAcrossLists(els.interviewId.value);
  if (!result) return;
  result.application.interview = null;
  saveState();
  els.interviewDialog.close();
  render();
  showToast("面试安排已清除");
}

function exportCsv() {
  const headers = ["公司名称", "性质", "岗位名称", "投递日期", "投递状态", "备注", "面试日期", "面试时间", "面试轮次", "面试形式", "会议链接或地点"];
  const rows = activeList().applications.map((app) => [
    app.company, app.type, app.role, app.date, app.status, app.notes,
    app.interview?.date || "", app.interview?.time || "", app.interview?.round || "", app.interview?.mode || "", app.interview?.place || ""
  ]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `${activeList().name}-投递记录.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("CSV 已导出");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function showToast(message) {
  window.clearTimeout(ui.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  ui.toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function formatShortDate(dateString) {
  const date = parseLocalDate(dateString);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function parseLocalDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isSameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function showAuthScreen(message = "") {
  currentUser = null;
  storageKey = null;
  backendReady = false;
  backendRevision = 0;
  pendingBackendSnapshot = null;
  state = createEmptyState();
  els.appShell.hidden = true;
  window.OfferFlowAuth?.show({
    ...authConfig,
    message,
    mode: authConfig.setupRequired ? "register" : "login"
  });
  [els.listDialog, els.interviewDialog].forEach((dialog) => {
    if (dialog.open) dialog.close();
  });
}

async function activateSession(user) {
  currentUser = user;
  storageKey = `offerflow-data-v2:${user.id}`;
  state = loadLocalState();
  backendReady = false;
  backendRevision = 0;
  pendingBackendSnapshot = null;
  els.profileUsername.textContent = user.username;
  els.profileAvatar.textContent = Array.from(user.username)[0]?.toUpperCase() || "个";
  els.passwordButton.hidden = !authConfig.passwordChangeEnabled;
  window.OfferFlowAuth?.hide();
  els.appShell.hidden = false;
  await connectBackend();
  render();
}

async function logout() {
  els.logoutButton.disabled = true;
  try {
    await flushBackendQueue();
    while (backendSyncRunning) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "X-OfferFlow-CSRF": "1" }
    });
  } finally {
    els.logoutButton.disabled = false;
    authConfig.setupRequired = false;
    showAuthScreen();
  }
}

function openPasswordDialog() {
  els.passwordForm.reset();
  els.passwordError.textContent = "";
  els.passwordDialog.showModal();
  requestAnimationFrame(() => els.currentPassword.focus());
}

async function changeAccountPassword(event) {
  event.preventDefault();
  els.passwordError.textContent = "";
  if (els.newPassword.value !== els.newPasswordConfirm.value) {
    els.passwordError.textContent = "两次输入的新密码不一致";
    return;
  }
  els.passwordSubmit.disabled = true;
  try {
    const response = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OfferFlow-CSRF": "1" },
      body: JSON.stringify({
        currentPassword: els.currentPassword.value,
        newPassword: els.newPassword.value
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      els.passwordDialog.close();
      showAuthScreen("登录已失效，请重新登录");
      return;
    }
    if (!response.ok) throw new Error(payload.error || "密码更新失败");
    els.passwordDialog.close();
    showToast("密码已更新，其他设备需要重新登录");
  } catch (error) {
    els.passwordError.textContent = error.message;
  } finally {
    els.passwordSubmit.disabled = false;
  }
}

async function bootstrap() {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) throw new Error(`Session check failed with status ${response.status}`);
    const payload = await response.json();
    authConfig = {
      enabled: payload.registration?.enabled !== false,
      inviteRequired: Boolean(payload.registration?.inviteRequired),
      setupRequired: Boolean(payload.setupRequired),
      passwordChangeEnabled: Boolean(payload.passwordChangeEnabled)
    };
    if (payload.authenticated && payload.user) {
      await activateSession(payload.user);
      return;
    }
    showAuthScreen();
  } catch (error) {
    console.warn("Could not check account session", error);
    showAuthScreen("服务暂时不可用，请稍后重试");
  }
}

els.listTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-list-id]");
  if (!button) return;
  state.activeListId = button.dataset.listId;
  resetFilters();
  saveState();
  render();
});

els.filterChips.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filter]");
  if (!chip) return;
  ui.activeFilter = chip.dataset.filter;
  renderFilters();
  renderTable();
});

els.searchInput.addEventListener("input", (event) => {
  ui.search = event.target.value;
  renderTable();
});

els.typeFilter.addEventListener("change", (event) => {
  ui.type = event.target.value;
  renderTable();
});

els.tableBody.addEventListener("input", (event) => {
  const target = event.target.closest("[data-field]");
  const row = event.target.closest("tr[data-id]");
  if (!target || !row || !target.matches("input:not([type='date'])")) return;
  updateApplication(row.dataset.id, target.dataset.field, target.value);
});

els.tableBody.addEventListener("change", (event) => {
  const target = event.target.closest("[data-field]");
  const row = event.target.closest("tr[data-id]");
  if (!target || !row || !target.matches("select, input[type='date']")) return;
  updateApplication(row.dataset.id, target.dataset.field, target.value);
});

els.tableBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  if (event.target.closest(".delete-row-button")) deleteApplication(row.dataset.id);
  if (event.target.closest(".schedule-button")) openInterviewDialog(row.dataset.id);
});

els.calendarGrid.addEventListener("click", (event) => {
  const calendarEvent = event.target.closest("[data-application-id]");
  if (calendarEvent) openInterviewDialog(calendarEvent.dataset.applicationId);
});

document.querySelector("#add-row-button").addEventListener("click", addApplication);
document.querySelector("#new-list-button").addEventListener("click", () => openListDialog("new"));
document.querySelector("#rename-list-button").addEventListener("click", () => openListDialog("rename"));
document.querySelector("#delete-list-button").addEventListener("click", deleteCurrentList);
document.querySelector("#export-button").addEventListener("click", exportCsv);
window.addEventListener("offerflow:auth-success", (event) => {
  const { user, passwordChangeEnabled } = event.detail || {};
  if (!user) return;
  authConfig.setupRequired = false;
  authConfig.passwordChangeEnabled = Boolean(passwordChangeEnabled);
  void activateSession(user);
});
els.logoutButton.addEventListener("click", () => void logout());
els.passwordButton.addEventListener("click", openPasswordDialog);
els.passwordForm.addEventListener("submit", changeAccountPassword);
els.listForm.addEventListener("submit", saveList);
els.interviewForm.addEventListener("submit", saveInterview);
els.clearInterview.addEventListener("click", clearInterview);

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => document.querySelector(`#${button.dataset.closeDialog}`).close());
});

document.querySelectorAll(".primary-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".primary-nav a").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

document.querySelector("#prev-month").addEventListener("click", () => {
  ui.calendarDate.setMonth(ui.calendarDate.getMonth() - 1);
  renderCalendar();
});

document.querySelector("#next-month").addEventListener("click", () => {
  ui.calendarDate.setMonth(ui.calendarDate.getMonth() + 1);
  renderCalendar();
});

document.querySelector("#today-button").addEventListener("click", () => {
  const today = new Date();
  ui.calendarDate = new Date(today.getFullYear(), today.getMonth(), 1);
  renderCalendar();
});

[els.listDialog, els.interviewDialog, els.passwordDialog].forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

if (!["", "#top", "#main", "#calendar"].includes(window.location.hash)) {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#main`);
}

void bootstrap();
window.setInterval(() => void refreshBackendState(), 30000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshBackendState();
});
