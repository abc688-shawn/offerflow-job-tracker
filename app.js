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
let documentStorageKey = null;
let personalDocumentContent = "";
let documentBackendReady = false;
let documentRevision = 0;
let documentLocalRevision = 0;
let documentLocalDirty = false;
let documentLocalUpdatedAt = 0;
let pendingDocumentContent = null;
let documentSyncRunning = false;
let documentSaveTimer = null;
let lastDocumentRange = null;
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
  documentSyncStatus: document.querySelector("#document-sync-status"),
  documentEditor: document.querySelector("#document-editor"),
  documentCount: document.querySelector("#document-count"),
  documentToolbar: document.querySelector(".document-toolbar"),
  documentSaveButton: document.querySelector("#document-save-button"),
  documentLastSaved: document.querySelector("#document-last-saved"),
  documentOwnerLabel: document.querySelector("#document-owner-label"),
  documentLinkButton: document.querySelector("#document-link-button"),
  documentImageButton: document.querySelector("#document-image-button"),
  documentImageInput: document.querySelector("#document-image-input"),
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

const DOCUMENT_ALLOWED_TAGS = new Set([
  "P", "BR", "DIV", "H2", "H3", "STRONG", "B", "EM", "I", "U",
  "UL", "OL", "LI", "BLOCKQUOTE", "A", "IMG"
]);
const DOCUMENT_BLOCKED_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "FORM", "INPUT", "BUTTON"
]);
const MAX_PERSONAL_DOCUMENT_BYTES = 6.5 * 1024 * 1024;

function sanitizeDocumentHtml(source) {
  const template = document.createElement("template");
  template.innerHTML = String(source || "");
  Array.from(template.content.querySelectorAll("*")).forEach((element) => {
    if (DOCUMENT_BLOCKED_TAGS.has(element.tagName)) {
      element.remove();
      return;
    }
    if (!DOCUMENT_ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      return;
    }

    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    const imageSource = element.tagName === "IMG" ? element.getAttribute("src") : null;
    const imageAlt = element.tagName === "IMG" ? element.getAttribute("alt") : null;
    Array.from(element.attributes).forEach((attribute) => element.removeAttribute(attribute.name));

    if (element.tagName === "A" && href) {
      try {
        const url = new URL(href, window.location.origin);
        if (["http:", "https:"].includes(url.protocol)) {
          element.setAttribute("href", url.href);
          element.setAttribute("target", "_blank");
          element.setAttribute("rel", "noopener noreferrer");
        }
      } catch (error) {
        // Invalid links remain as plain formatted text.
      }
    }
    if (element.tagName === "IMG") {
      if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(imageSource || "")) {
        element.remove();
        return;
      }
      element.setAttribute("src", imageSource);
      element.setAttribute("alt", String(imageAlt || "文档图片").slice(0, 160));
    }
  });

  const content = template.innerHTML;
  const hasImage = Boolean(template.content.querySelector("img"));
  const hasText = Boolean(template.content.textContent.replace(/\s/g, ""));
  return hasImage || hasText ? content : "";
}

function setDocumentSyncStatus(status, label) {
  els.documentSyncStatus.dataset.state = status;
  els.documentSyncStatus.querySelector("span").textContent = label;
  els.documentSaveButton.disabled = status === "connecting" || documentSyncRunning;
}

function updateDocumentSavedTime(timestamp = documentLocalUpdatedAt, prefix = "最近保存") {
  if (!timestamp) {
    els.documentLastSaved.textContent = "尚未保存";
    return;
  }
  const time = new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  els.documentLastSaved.textContent = `${prefix} ${time}`;
}

function updateDocumentCount(content = personalDocumentContent) {
  const template = document.createElement("template");
  template.innerHTML = content;
  const characters = template.content.textContent.replace(/\s/g, "").length;
  const images = template.content.querySelectorAll("img").length;
  els.documentCount.textContent = `${characters} 字${images ? ` · ${images} 张图片` : ""}`;
}

function loadLocalDocument() {
  const emptyDocument = { content: "", dirty: false, revision: 0, updatedAt: 0 };
  if (!documentStorageKey) return emptyDocument;
  try {
    const saved = JSON.parse(localStorage.getItem(documentStorageKey));
    if (!saved || typeof saved !== "object") return emptyDocument;
    const content = sanitizeDocumentHtml(saved.content || "");
    const modernCache = saved.version === 2;
    return {
      content,
      dirty: modernCache ? Boolean(saved.dirty) : Boolean(content),
      revision: modernCache && Number.isInteger(saved.revision) ? saved.revision : -1,
      updatedAt: modernCache && Number.isFinite(saved.updatedAt) ? saved.updatedAt : 0
    };
  } catch (error) {
    console.warn("Could not load the local personal document", error);
    return emptyDocument;
  }
}

function storeDocumentLocally() {
  if (!documentStorageKey) return;
  try {
    localStorage.setItem(documentStorageKey, JSON.stringify({
      version: 2,
      content: personalDocumentContent,
      dirty: documentLocalDirty,
      revision: documentLocalRevision,
      updatedAt: documentLocalUpdatedAt
    }));
  } catch (error) {
    console.warn("Could not cache the personal document locally", error);
  }
}

function applyPersonalDocument(payload) {
  documentRevision = payload.revision;
  documentLocalRevision = documentRevision;
  documentLocalDirty = false;
  documentLocalUpdatedAt = Date.now();
  pendingDocumentContent = null;
  personalDocumentContent = sanitizeDocumentHtml(payload.content || "");
  storeDocumentLocally();
  els.documentEditor.innerHTML = personalDocumentContent;
  updateDocumentCount();
  updateDocumentSavedTime(documentLocalUpdatedAt, "已同步");
}

async function persistPersonalDocument(content) {
  const response = await fetch("/api/document", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-Match": String(documentRevision),
      "X-OfferFlow-CSRF": "1"
    },
    body: JSON.stringify({ content })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Document save failed with status ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  documentRevision = payload.revision;
  documentLocalRevision = documentRevision;
  documentLocalUpdatedAt = payload.savedAt ? Date.parse(payload.savedAt) : Date.now();
}

async function flushDocumentQueue() {
  window.clearTimeout(documentSaveTimer);
  documentSaveTimer = null;
  if (!documentBackendReady || documentSyncRunning || pendingDocumentContent === null) return;
  documentSyncRunning = true;
  let haltQueue = false;
  setDocumentSyncStatus("saving", "正在保存");
  try {
    while (pendingDocumentContent !== null) {
      const snapshot = pendingDocumentContent;
      pendingDocumentContent = null;
      await persistPersonalDocument(snapshot);
      documentLocalDirty = pendingDocumentContent !== null;
      storeDocumentLocally();
    }
    documentLocalDirty = false;
    storeDocumentLocally();
    setDocumentSyncStatus("saved", "已保存");
    updateDocumentSavedTime();
  } catch (error) {
    console.warn("Could not save the personal document", error);
    haltQueue = true;
    if (error.status === 401) {
      showAuthScreen("登录已失效，请重新登录");
    } else if (error.status === 409 && error.payload?.latest) {
      const latestContent = sanitizeDocumentHtml(error.payload.latest.content || "");
      if (latestContent === personalDocumentContent) {
        applyPersonalDocument(error.payload.latest);
        setDocumentSyncStatus("saved", "已保存");
      } else {
        documentRevision = error.payload.latest.revision;
        documentLocalRevision = documentRevision;
        documentLocalDirty = true;
        pendingDocumentContent = personalDocumentContent;
        storeDocumentLocally();
        setDocumentSyncStatus("error", "需要重新保存");
        els.documentLastSaved.textContent = "检测到其他设备的更新";
        showToast("个人文档存在新版本，请确认内容后再次保存");
      }
    } else {
      documentBackendReady = false;
      documentLocalDirty = true;
      pendingDocumentContent = personalDocumentContent;
      storeDocumentLocally();
      setDocumentSyncStatus("local", "草稿已保留");
      els.documentLastSaved.textContent = "网络恢复后可再次保存";
    }
  } finally {
    documentSyncRunning = false;
    setDocumentSyncStatus(els.documentSyncStatus.dataset.state, els.documentSyncStatus.querySelector("span").textContent);
    if (!haltQueue && pendingDocumentContent !== null) void flushDocumentQueue();
  }
}

function captureDocumentDraft() {
  const content = sanitizeDocumentHtml(els.documentEditor.innerHTML);
  if (!content && els.documentEditor.innerHTML) els.documentEditor.replaceChildren();
  updateDocumentCount(content);
  if (new Blob([content]).size > MAX_PERSONAL_DOCUMENT_BYTES) {
    setDocumentSyncStatus("error", "内容过大");
    showToast("个人文档已超过容量限制，请删除部分图片");
    return;
  }
  if (content === personalDocumentContent && !documentLocalDirty) return;
  if (!documentLocalDirty) documentLocalRevision = documentRevision;
  personalDocumentContent = content;
  documentLocalDirty = true;
  documentLocalUpdatedAt = Date.now();
  storeDocumentLocally();
  pendingDocumentContent = content;
  els.documentLastSaved.textContent = "本地草稿已保留";
  if (!documentBackendReady) {
    setDocumentSyncStatus("local", "等待同步");
    return;
  }
  setDocumentSyncStatus("saving", "待保存");
  window.clearTimeout(documentSaveTimer);
  documentSaveTimer = window.setTimeout(() => void flushDocumentQueue(), 350);
}

async function connectPersonalDocument() {
  setDocumentSyncStatus("connecting", "连接中");
  try {
    const response = await fetch("/api/document", { cache: "no-store" });
    if (response.status === 401) {
      showAuthScreen("登录已失效，请重新登录");
      return;
    }
    if (!response.ok) throw new Error(`Backend returned status ${response.status}`);
    const payload = await response.json();
    documentBackendReady = true;
    documentRevision = payload.revision;
    const remoteContent = sanitizeDocumentHtml(payload.content || "");
    if (documentLocalDirty && personalDocumentContent === remoteContent) {
      applyPersonalDocument(payload);
      setDocumentSyncStatus("saved", "已保存");
    } else if (documentLocalDirty && documentLocalRevision === payload.revision) {
      pendingDocumentContent = personalDocumentContent;
      setDocumentSyncStatus("saving", "恢复草稿");
      await flushDocumentQueue();
      showToast("未完成同步的本地草稿已恢复");
    } else if (documentLocalDirty) {
      documentLocalRevision = payload.revision;
      pendingDocumentContent = personalDocumentContent;
      storeDocumentLocally();
      setDocumentSyncStatus("error", "需要重新保存");
      els.documentLastSaved.textContent = "云端已有其他版本";
    } else if (payload.initialized) {
      applyPersonalDocument(payload);
      setDocumentSyncStatus("saved", "已保存");
    } else {
      documentLocalDirty = true;
      documentLocalRevision = payload.revision;
      pendingDocumentContent = personalDocumentContent;
      storeDocumentLocally();
      await flushDocumentQueue();
    }
  } catch (error) {
    documentBackendReady = false;
    console.warn("Personal document backend is unavailable", error);
    setDocumentSyncStatus("local", documentLocalDirty ? "草稿已保留" : "仅本地保存");
    els.documentLastSaved.textContent = documentLocalDirty ? "网络恢复后可再次保存" : "云端暂时不可用";
  }
}

async function refreshPersonalDocument() {
  if (!currentUser || !documentBackendReady || documentLocalDirty || documentSyncRunning || pendingDocumentContent !== null) return;
  try {
    const response = await fetch("/api/document", { cache: "no-store" });
    if (response.status === 401) {
      showAuthScreen("登录已失效，请重新登录");
      return;
    }
    if (!response.ok) throw new Error(`Backend returned status ${response.status}`);
    const payload = await response.json();
    if (payload.revision > documentRevision) {
      applyPersonalDocument(payload);
      setDocumentSyncStatus("saved", "已同步新版本");
      showToast("已同步另一台设备的个人文档修改");
    }
  } catch (error) {
    console.warn("Could not refresh the personal document", error);
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
  if (["HR 沟通", "一面", "二面", "三面", "终面"].includes(status)) return "interview";
  if (status === "Offer") return "offer";
  if (["已拒绝", "已结束"].includes(status)) return "closed";
  return "progress";
}

function statusClass(status) {
  const classes = {
    "待投递": "status-pending",
    "已投递": "status-applied",
    "笔试": "status-assessment",
    "HR 沟通": "status-hr",
    "一面": "status-interview-one",
    "二面": "status-interview-two",
    "三面": "status-interview-three",
    "终面": "status-final",
    "Offer": "status-offer",
    "已拒绝": "status-rejected",
    "已结束": "status-ended"
  };
  return classes[status] || "status-pending";
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

function resizeExpandedCell(textarea) {
  const maxHeight = 154;
  textarea.style.height = "34px";
  const contentHeight = textarea.scrollHeight + 2;
  const expandedHeight = Math.min(Math.max(contentHeight, 54), maxHeight);
  textarea.style.height = `${expandedHeight}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
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

function rememberDocumentRange() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (els.documentEditor.contains(range.commonAncestorContainer)) {
    lastDocumentRange = range.cloneRange();
  }
}

function currentDocumentRange() {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    if (els.documentEditor.contains(range.commonAncestorContainer)) return range.cloneRange();
  }
  if (lastDocumentRange && els.documentEditor.contains(lastDocumentRange.commonAncestorContainer)) {
    return lastDocumentRange.cloneRange();
  }
  const range = document.createRange();
  range.selectNodeContents(els.documentEditor);
  range.collapse(false);
  return range;
}

function restoreDocumentRange(range = currentDocumentRange()) {
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  els.documentEditor.focus();
  return range;
}

function insertDocumentNode(node, range = currentDocumentRange()) {
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  restoreDocumentRange(range);
  lastDocumentRange = range.cloneRange();
  return range;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(file);
  });
}

async function compressDocumentImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 15 * 1024 * 1024) throw new Error("单张图片不能超过 15 MB");
  const source = await readFileAsDataUrl(file);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("图片格式无法识别"));
    image.src = source;
  });

  const render = (maxSide, quality) => {
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/webp", quality);
  };

  let result = render(1600, 0.82);
  if (result.length > 1.5 * 1024 * 1024) result = render(1100, 0.74);
  return result;
}

async function insertDocumentImages(files, initialRange = currentDocumentRange()) {
  const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  let range = initialRange;
  setDocumentSyncStatus("saving", "处理图片");
  try {
    const preparedImages = [];
    for (const file of images) {
      const dataUrl = await compressDocumentImage(file);
      preparedImages.push({ dataUrl, name: file.name });
      if (new Blob([personalDocumentContent, ...preparedImages.map((item) => item.dataUrl)]).size > MAX_PERSONAL_DOCUMENT_BYTES) {
        throw new Error("个人文档容量不足，请先删除部分图片");
      }
    }
    for (const item of preparedImages) {
      const image = document.createElement("img");
      image.src = item.dataUrl;
      image.alt = item.name ? item.name.slice(0, 160) : "文档图片";
      range = insertDocumentNode(image, range);
      range = insertDocumentNode(document.createElement("br"), range);
    }
    captureDocumentDraft();
    showToast(images.length > 1 ? `已插入 ${images.length} 张图片` : "已插入图片");
  } catch (error) {
    showToast(error.message);
    setDocumentSyncStatus(documentBackendReady ? "saved" : "local", documentBackendReady ? "已保存" : "仅本地保存");
  }
}

function normalizeDocumentUrl(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch (error) {
    return null;
  }
}

function updateDocumentToolbarState() {
  els.documentToolbar.querySelectorAll("[data-document-command]").forEach((button) => {
    const active = document.queryCommandState(button.dataset.documentCommand);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const block = String(document.queryCommandValue("formatBlock") || "p").replace(/[<>]/g, "").toLowerCase();
  const activeBlock = ["h2", "h3", "blockquote"].includes(block) ? block : "p";
  els.documentToolbar.querySelectorAll("[data-document-block]").forEach((button) => {
    const active = button.dataset.documentBlock === activeBlock;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function wrapDocumentSelection(tagName) {
  const range = currentDocumentRange();
  if (range.collapsed) return false;
  const wrapper = document.createElement(tagName);
  wrapper.append(range.extractContents());
  range.insertNode(wrapper);
  range.selectNodeContents(wrapper);
  restoreDocumentRange(range);
  lastDocumentRange = range.cloneRange();
  return true;
}

function applyDocumentCommand(command) {
  restoreDocumentRange();
  const applied = document.execCommand(command, false);
  if (!applied && command === "bold") wrapDocumentSelection("strong");
  if (!applied && command === "italic") wrapDocumentSelection("em");
  rememberDocumentRange();
  captureDocumentDraft();
  updateDocumentToolbarState();
}

function applyDocumentBlock(tagName) {
  restoreDocumentRange();
  const applied = document.execCommand("formatBlock", false, `<${tagName}>`);
  if (!applied) document.execCommand("formatBlock", false, tagName);
  rememberDocumentRange();
  captureDocumentDraft();
  updateDocumentToolbarState();
}

async function savePersonalDocumentNow() {
  const currentContent = sanitizeDocumentHtml(els.documentEditor.innerHTML);
  if (currentContent !== personalDocumentContent) captureDocumentDraft();
  if (!documentLocalDirty && pendingDocumentContent === null) {
    showToast("个人文档已是最新版本");
    return;
  }
  if (!documentBackendReady) await connectPersonalDocument();
  else await flushDocumentQueue();
  if (!documentLocalDirty) showToast("个人文档已保存");
}

function showAuthScreen(message = "") {
  currentUser = null;
  storageKey = null;
  backendReady = false;
  backendRevision = 0;
  pendingBackendSnapshot = null;
  documentStorageKey = null;
  personalDocumentContent = "";
  documentBackendReady = false;
  documentRevision = 0;
  documentLocalRevision = 0;
  documentLocalDirty = false;
  documentLocalUpdatedAt = 0;
  pendingDocumentContent = null;
  documentSyncRunning = false;
  lastDocumentRange = null;
  window.clearTimeout(documentSaveTimer);
  documentSaveTimer = null;
  els.documentEditor.replaceChildren();
  updateDocumentCount("");
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
  documentStorageKey = `offerflow-document-v1:${user.id}`;
  state = loadLocalState();
  const localDocument = loadLocalDocument();
  personalDocumentContent = localDocument.content;
  documentLocalRevision = localDocument.revision;
  documentLocalDirty = localDocument.dirty;
  documentLocalUpdatedAt = localDocument.updatedAt;
  backendReady = false;
  backendRevision = 0;
  pendingBackendSnapshot = null;
  documentBackendReady = false;
  documentRevision = 0;
  pendingDocumentContent = null;
  documentSyncRunning = false;
  els.documentEditor.innerHTML = personalDocumentContent;
  updateDocumentCount();
  updateDocumentSavedTime(documentLocalUpdatedAt, documentLocalDirty ? "本地草稿" : "最近保存");
  els.profileUsername.textContent = user.username;
  els.profileAvatar.textContent = Array.from(user.username)[0]?.toUpperCase() || "个";
  els.documentOwnerLabel.textContent = `${user.username} · 私人文档`;
  els.passwordButton.hidden = !authConfig.passwordChangeEnabled;
  window.OfferFlowAuth?.hide();
  els.appShell.hidden = false;
  await Promise.all([connectBackend(), connectPersonalDocument()]);
  render();
}

async function logout() {
  els.logoutButton.disabled = true;
  try {
    if (els.documentEditor.innerHTML !== personalDocumentContent) captureDocumentDraft();
    await flushBackendQueue();
    await flushDocumentQueue();
    while (backendSyncRunning) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    while (documentSyncRunning) {
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
  if (!target || !row || !target.matches("input:not([type='date']), textarea")) return;
  if (target.matches(".cell-textarea.expanded")) resizeExpandedCell(target);
  updateApplication(row.dataset.id, target.dataset.field, target.value);
});

els.tableBody.addEventListener("focusin", (event) => {
  const textarea = event.target.closest(".cell-textarea");
  if (!textarea) return;
  textarea.classList.add("expanded");
  resizeExpandedCell(textarea);
});

els.tableBody.addEventListener("focusout", (event) => {
  const textarea = event.target.closest(".cell-textarea");
  if (!textarea) return;
  textarea.classList.remove("expanded");
  textarea.style.height = "";
  textarea.style.overflowY = "";
  textarea.scrollLeft = 0;
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

els.documentEditor.addEventListener("input", captureDocumentDraft);
els.documentEditor.addEventListener("keyup", updateDocumentToolbarState);
els.documentEditor.addEventListener("mouseup", updateDocumentToolbarState);
els.documentEditor.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  event.preventDefault();
  const range = currentDocumentRange();
  if (files.length) {
    void insertDocumentImages(files, range);
    return;
  }
  const text = event.clipboardData?.getData("text/plain") || "";
  restoreDocumentRange(range);
  document.execCommand("insertText", false, text);
  captureDocumentDraft();
});
els.documentEditor.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.items || []).some((item) => item.type.startsWith("image/"))) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
});
els.documentEditor.addEventListener("drop", (event) => {
  const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(event.clientX, event.clientY);
  void insertDocumentImages(files, range || currentDocumentRange());
});

els.documentToolbar.addEventListener("mousedown", (event) => {
  rememberDocumentRange();
  if (event.target.closest("button")) event.preventDefault();
});
els.documentToolbar.addEventListener("click", (event) => {
  const blockButton = event.target.closest("[data-document-block]");
  if (blockButton) {
    applyDocumentBlock(blockButton.dataset.documentBlock);
    return;
  }
  const button = event.target.closest("[data-document-command]");
  if (!button) return;
  applyDocumentCommand(button.dataset.documentCommand);
});
els.documentLinkButton.addEventListener("click", () => {
  const range = currentDocumentRange();
  const selectedText = range.toString();
  const url = normalizeDocumentUrl(window.prompt("输入链接地址", "https://"));
  if (!url) return;
  restoreDocumentRange(range);
  if (selectedText) {
    document.execCommand("createLink", false, url);
  } else {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = url;
    insertDocumentNode(link, range);
  }
  captureDocumentDraft();
});
els.documentImageButton.addEventListener("click", () => els.documentImageInput.click());
els.documentImageInput.addEventListener("change", () => {
  void insertDocumentImages(els.documentImageInput.files, currentDocumentRange());
  els.documentImageInput.value = "";
});
els.documentSaveButton.addEventListener("click", () => void savePersonalDocumentNow());
document.addEventListener("selectionchange", () => {
  rememberDocumentRange();
  updateDocumentToolbarState();
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

if (!["", "#top", "#main", "#calendar", "#document"].includes(window.location.hash)) {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#main`);
}

void bootstrap();
window.setInterval(() => {
  void refreshBackendState();
  void refreshPersonalDocument();
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshBackendState();
    void refreshPersonalDocument();
  } else if (documentLocalDirty) {
    void flushDocumentQueue();
  }
});
window.addEventListener("pagehide", () => {
  const currentContent = sanitizeDocumentHtml(els.documentEditor.innerHTML);
  if (currentUser && currentContent !== personalDocumentContent) captureDocumentDraft();
});
