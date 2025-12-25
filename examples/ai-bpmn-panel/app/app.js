import BpmnModeler from 'bpmn-js/lib/Modeler';

import { getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';

import diagramXML from '../resources/diagram.bpmn';

import customModule from './custom';

import qaExtension from '../resources/qa';

import modelCatalog from './ai/model-catalog.json';

const HIGH_PRIORITY = 1500;
let apiBase = localStorage.getItem('aiApiBase') || 'http://localhost:5174';

const DEFAULT_SYSTEM_PROMPT = [
  'You are a BPMN 2.0 modeler.',
  'Return valid BPMN 2.0 XML only. Do not include code fences or explanations.',
  'Include BPMN DI (bpmndi:BPMNDiagram, bpmndi:BPMNPlane, and shapes/edges).',
  'Use pools and swimlanes when participants are provided.',
  'Ensure every sequenceFlow has sourceRef and targetRef (no dangling arrows).',
  'Ensure nodes are well spaced so they look professional.',
  'Use straight or right-angle sequenceFlow connectors (no diagonals).',
  'Include BPMN DI shapes for lanes.',
  'Ensure to create a pool and swim lanes.',
  'Keep the diagram simple, readable, and consistent with the user request.'
].join(' ');

const DEFAULT_ROLE_ID = 'role-bpmn-modeler';
const DEFAULT_ROLES = [
  {
    id: DEFAULT_ROLE_ID,
    name: 'BPMN Modeler',
    description: 'Generates BPMN 2.0 diagrams with pools, lanes, and clean DI.',
    systemPrompt: DEFAULT_SYSTEM_PROMPT
  },
  {
    id: 'role-doe-directive',
    name: 'DOE Directive',
    description: 'Defines mission, constraints, and success criteria.',
    systemPrompt: [
      'You are the Directive agent in a DOE system.',
      'Define the mission, non-negotiable constraints, and success criteria.',
      'Ask clarifying questions before moving to execution details.'
    ].join(' ')
  },
  {
    id: 'role-doe-orchestrator',
    name: 'DOE Orchestrator',
    description: 'Plans, decomposes work, and coordinates dependencies.',
    systemPrompt: [
      'You are the Orchestrator agent in a DOE system.',
      'Decompose the goal into steps, highlight dependencies, and plan execution.',
      'Ask questions when requirements are unclear.'
    ].join(' ')
  },
  {
    id: 'role-doe-executor',
    name: 'DOE Executor',
    description: 'Produces concrete outputs and actionable steps.',
    systemPrompt: [
      'You are the Executor agent in a DOE system.',
      'Focus on concrete outputs, clear steps, and verification.',
      'Report blockers and request missing inputs.'
    ].join(' ')
  }
];

const DEFAULT_CONFIG = {
  provider: 'ollama',
  model: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.2,
  maxTokens: 1400,
  lanes: '',
  choices: '',
  decisions: '',
  sessions: '',
  requireLanes: true,
  requireDi: true,
  autoFix: true
};

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem('aiConfig') || '{}');
    return { ...DEFAULT_CONFIG, ...stored };
  } catch (err) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  localStorage.setItem('aiConfig', JSON.stringify({
    provider: config.provider,
    model: config.model,
    systemPrompt: config.systemPrompt,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    lanes: config.lanes,
    choices: config.choices,
    decisions: config.decisions,
    sessions: config.sessions,
    requireLanes: config.requireLanes,
    requireDi: config.requireDi,
    autoFix: config.autoFix
  }));
}

const WORKSPACE_KEY = 'aiWorkspaceV1';
function cloneRoles(roles) {
  return roles.map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description || '',
    systemPrompt: role.systemPrompt || ''
  }));
}

const DEFAULT_WORKSPACE = {
  roles: cloneRoles(DEFAULT_ROLES),
  activeRoleId: DEFAULT_ROLE_ID,
  projects: [],
  activeProjectId: null,
  activeChatId: null,
  autoApply: false,
  importMode: 'replace'
};

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeRole(role) {
  if (!role) {
    return null;
  }
  const name = typeof role.name === 'string' && role.name.trim() ? role.name.trim() : 'Role';
  const id = typeof role.id === 'string' && role.id.trim() ? role.id.trim() : createId('role');
  return {
    id,
    name,
    description: typeof role.description === 'string' ? role.description.trim() : '',
    systemPrompt: typeof role.systemPrompt === 'string' ? role.systemPrompt.trim() : ''
  };
}

function normalizeRoles(rawRoles) {
  if (!Array.isArray(rawRoles) || rawRoles.length === 0) {
    return cloneRoles(DEFAULT_ROLES);
  }
  const roles = [];
  const seen = new Set();
  rawRoles.forEach((role) => {
    const normalized = normalizeRole(role);
    if (!normalized) {
      return;
    }
    let id = normalized.id;
    while (seen.has(id)) {
      id = createId('role');
    }
    normalized.id = id;
    seen.add(id);
    roles.push(normalized);
  });
  return roles.length ? roles : cloneRoles(DEFAULT_ROLES);
}

function loadWorkspace() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || '{}');
    return { ...DEFAULT_WORKSPACE, ...stored };
  } catch (err) {
    return { ...DEFAULT_WORKSPACE };
  }
}

function saveWorkspace() {
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
}

function getRoleById(roleId) {
  return workspace.roles.find((role) => role.id === roleId) || null;
}

function getActiveRole(chat) {
  const roleId = chat?.roleId || workspace.activeRoleId || DEFAULT_ROLE_ID;
  return getRoleById(roleId) || workspace.roles[0] || null;
}

function ensureRoleState() {
  workspace.roles = normalizeRoles(workspace.roles);
  const roleIds = new Set(workspace.roles.map((role) => role.id));

  if (!workspace.activeRoleId || !roleIds.has(workspace.activeRoleId)) {
    workspace.activeRoleId = workspace.roles[0]?.id || DEFAULT_ROLE_ID;
  }

  workspace.projects.forEach((project) => {
    project.chats.forEach((chat) => {
      if (!chat.roleId || !roleIds.has(chat.roleId)) {
        chat.roleId = workspace.activeRoleId;
      }
    });
  });

  if (!roleEditorId || !roleIds.has(roleEditorId)) {
    roleEditorId = workspace.activeRoleId;
  }
}

function renderRoleSelect(chatOverride) {
  if (!aiRoleSelectEl) {
    return;
  }
  aiRoleSelectEl.innerHTML = '';
  workspace.roles.forEach((role) => {
    const option = document.createElement('option');
    option.value = role.id;
    option.textContent = role.name;
    aiRoleSelectEl.appendChild(option);
  });
  const project = getActiveProject();
  const chat = chatOverride || getActiveChat(project);
  const roleId = chat?.roleId || workspace.activeRoleId || '';
  aiRoleSelectEl.value = roleId;
}

function renderRoleEditor() {
  if (!aiRolePresetEl) {
    return;
  }
  aiRolePresetEl.innerHTML = '';
  workspace.roles.forEach((role) => {
    const option = document.createElement('option');
    option.value = role.id;
    option.textContent = role.name;
    aiRolePresetEl.appendChild(option);
  });

  if (!roleEditorId || !getRoleById(roleEditorId)) {
    roleEditorId = workspace.activeRoleId;
  }

  aiRolePresetEl.value = roleEditorId || '';
  const role = getRoleById(roleEditorId);
  if (!role) {
    return;
  }
  aiRoleNameEl.value = role.name;
  aiRoleDescriptionEl.value = role.description || '';
  aiRolePromptEl.value = role.systemPrompt || '';
}

function saveRoleFromEditor() {
  const role = getRoleById(roleEditorId);
  if (!role) {
    setPanelStatus(aiRoleStatusEl, 'Select a role first.');
    return;
  }
  role.name = aiRoleNameEl.value.trim() || 'Role';
  role.description = aiRoleDescriptionEl.value.trim();
  role.systemPrompt = aiRolePromptEl.value.trim();
  saveWorkspace();
  renderRoleSelect();
  renderRoleEditor();
  renderChatThread();
  setPanelStatus(aiRoleStatusEl, 'Role saved.');
}

function createNewRole() {
  const role = {
    id: createId('role'),
    name: 'New Role',
    description: '',
    systemPrompt: ''
  };
  workspace.roles.push(role);
  roleEditorId = role.id;
  saveWorkspace();
  renderRoleSelect();
  renderRoleEditor();
  setPanelStatus(aiRoleStatusEl, 'Role created.');
}

function deleteRoleFromEditor() {
  if (workspace.roles.length <= 1) {
    setPanelStatus(aiRoleStatusEl, 'Keep at least one role.');
    return;
  }
  const role = getRoleById(roleEditorId);
  if (!role) {
    return;
  }
  const confirmed = window.confirm(`Delete role "${role.name}"?`);
  if (!confirmed) {
    return;
  }

  workspace.roles = workspace.roles.filter((item) => item.id !== roleEditorId);
  const fallbackRole = workspace.roles[0];
  if (workspace.activeRoleId === roleEditorId) {
    workspace.activeRoleId = fallbackRole.id;
  }
  workspace.projects.forEach((project) => {
    project.chats.forEach((chat) => {
      if (chat.roleId === roleEditorId) {
        chat.roleId = fallbackRole.id;
      }
    });
  });
  roleEditorId = fallbackRole.id;
  saveWorkspace();
  renderRoleSelect();
  renderRoleEditor();
  renderChatThread();
  setPanelStatus(aiRoleStatusEl, 'Role deleted.');
}

let aiConfig = loadConfig();
let credentialCache = '';
let workspace = loadWorkspace();
let roleEditorId = null;

const containerEl = document.getElementById('container');
const qualityAssuranceEl = document.getElementById('quality-assurance');
const suitabilityScoreEl = document.getElementById('suitability-score');
const lastCheckedEl = document.getElementById('last-checked');
const okayEl = document.getElementById('okay');
const formEl = document.getElementById('form');
const warningEl = document.getElementById('warning');

const menuBarEl = document.getElementById('menu-bar');
const menuStatusEl = document.getElementById('menu-status');
const fileInputEl = document.getElementById('file-input');
const importPanelEl = document.getElementById('import-panel');
const importXmlEl = document.getElementById('import-xml');
const importApplyEl = document.getElementById('import-apply');
const importCancelEl = document.getElementById('import-cancel');
const importStatusEl = document.getElementById('import-status');

const aiPanelEl = document.getElementById('ai-panel');
const aiCurrentModelEl = document.getElementById('ai-current-model');
const aiRefreshEl = document.getElementById('ai-refresh');
const aiStatusEl = document.getElementById('ai-status');
const aiSettingsEl = document.getElementById('ai-settings');
const aiCollapseEl = document.getElementById('ai-collapse');
const aiTabButtons = Array.from(document.querySelectorAll('[data-ai-tab]'));
const aiTabPanels = Array.from(document.querySelectorAll('[data-ai-panel]'));
const aiConfigSaveEl = document.getElementById('ai-config-save');
const aiConfigResetEl = document.getElementById('ai-config-reset');
const aiConfigStatusEl = document.getElementById('ai-config-status');

const aiProviderEl = document.getElementById('ai-provider');
const aiModelEl = document.getElementById('ai-model');
const aiApiBaseEl = document.getElementById('ai-api-base');
const aiCredentialEl = document.getElementById('ai-credential');
const aiSystemEl = document.getElementById('ai-system');
const aiTemperatureEl = document.getElementById('ai-temperature');
const aiMaxTokensEl = document.getElementById('ai-max-tokens');
const aiLanesEl = document.getElementById('ai-lanes');
const aiChoicesEl = document.getElementById('ai-choices');
const aiDecisionsEl = document.getElementById('ai-decisions');
const aiSessionsEl = document.getElementById('ai-sessions');
const aiRequireLanesEl = document.getElementById('ai-require-lanes');
const aiRequireDiEl = document.getElementById('ai-require-di');
const aiAutoFixEl = document.getElementById('ai-auto-fix');
const aiProjectSelectEl = document.getElementById('ai-project-select');
const aiProjectNewEl = document.getElementById('ai-project-new');
const aiChatSearchEl = document.getElementById('ai-chat-search');
const aiChatListEl = document.getElementById('ai-chat-list');
const aiChatNewEl = document.getElementById('ai-chat-new');
const aiChatExportEl = document.getElementById('ai-chat-export');
const aiChatImportEl = document.getElementById('ai-chat-import');
const aiChatImportFileEl = document.getElementById('ai-chat-import-file');
const aiImportModeEl = document.getElementById('ai-import-mode');
const aiChatThreadEl = document.getElementById('ai-chat-thread');
const aiChatEmptyEl = document.getElementById('ai-chat-empty');
const aiChatInputEl = document.getElementById('ai-chat-input');
const aiChatSendEl = document.getElementById('ai-chat-send');
const aiApplyLastEl = document.getElementById('ai-apply-last');
const aiAutoApplyEl = document.getElementById('ai-auto-apply');
const aiRoleSelectEl = document.getElementById('ai-role-select');
const aiRolePresetEl = document.getElementById('ai-role-presets');
const aiRoleNameEl = document.getElementById('ai-role-name');
const aiRoleDescriptionEl = document.getElementById('ai-role-description');
const aiRolePromptEl = document.getElementById('ai-role-prompt');
const aiRoleNewEl = document.getElementById('ai-role-new');
const aiRoleSaveEl = document.getElementById('ai-role-save');
const aiRoleDeleteEl = document.getElementById('ai-role-delete');
const aiRoleStatusEl = document.getElementById('ai-role-status');

let providerData = null;

// create modeler
const bpmnModeler = new BpmnModeler({
  container: containerEl,
  additionalModules: [
    customModule
  ],
  moddleExtensions: {
    qa: qaExtension
  }
});

function setMenuStatus(message) {
  menuStatusEl.textContent = message || '';
}

function setPanelStatus(element, message) {
  element.textContent = message || '';
}

function updateCurrentModelLabel() {
  const providers = providerData?.providers || {};
  const provider = providers[aiConfig.provider];
  const providerLabel = provider ? provider.label : aiConfig.provider;
  const modelLabel = aiConfig.model || 'Select model';
  aiCurrentModelEl.textContent = `${providerLabel} / ${modelLabel}`;
}

function formatTimestamp(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getActiveProject() {
  return workspace.projects.find((project) => project.id === workspace.activeProjectId) || workspace.projects[0];
}

function getActiveChat(project) {
  if (!project) {
    return null;
  }
  return project.chats.find((chat) => chat.id === workspace.activeChatId) || project.chats[0] || null;
}

function applyWorkspaceToUi() {
  aiAutoApplyEl.checked = workspace.autoApply;
  aiImportModeEl.value = workspace.importMode;
}

function ensureWorkspaceState() {
  if (!Array.isArray(workspace.projects)) {
    workspace.projects = [];
  }

  ensureRoleState();

  if (!workspace.projects.length) {
    const project = createProject('Default Project');
    createChat(project, 'Chat 1');
  }

  const project = getActiveProject();
  if (!project) {
    workspace.activeProjectId = workspace.projects[0].id;
  }

  const activeProject = getActiveProject();
  if (activeProject && (!Array.isArray(activeProject.chats) || !activeProject.chats.length)) {
    createChat(activeProject, 'Chat 1');
  }

  if (!getActiveChat(activeProject)) {
    workspace.activeChatId = activeProject.chats[0].id;
  }

  saveWorkspace();
}

function createProject(name) {
  const now = new Date().toISOString();
  const project = {
    id: createId('project'),
    name: name || 'New Project',
    chats: [],
    createdAt: now,
    updatedAt: now
  };

  workspace.projects.unshift(project);
  workspace.activeProjectId = project.id;
  workspace.activeChatId = null;
  saveWorkspace();
  return project;
}

function createChat(project, title) {
  const now = new Date().toISOString();
  const chat = {
    id: createId('chat'),
    title: title || 'New Chat',
    messages: [],
    lastBpmnXml: '',
    roleId: workspace.activeRoleId || DEFAULT_ROLE_ID,
    createdAt: now,
    updatedAt: now
  };

  project.chats.unshift(chat);
  project.updatedAt = now;
  workspace.activeChatId = chat.id;
  saveWorkspace();
  return chat;
}

function setActiveProject(projectId) {
  workspace.activeProjectId = projectId;
  const project = getActiveProject();
  if (!project.chats.length) {
    createChat(project, 'Chat 1');
  }
  workspace.activeChatId = project.chats[0].id;
  saveWorkspace();
  renderWorkspace();
}

function setActiveChat(projectId, chatId) {
  workspace.activeProjectId = projectId;
  workspace.activeChatId = chatId;
  saveWorkspace();
  renderWorkspace();
}

function renderWorkspace() {
  applyWorkspaceToUi();
  renderRoleSelect();
  renderRoleEditor();
  renderProjectSelect();
  renderChatList();
  renderChatThread();
}

function renderProjectSelect() {
  aiProjectSelectEl.innerHTML = '';
  workspace.projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    aiProjectSelectEl.appendChild(option);
  });
  aiProjectSelectEl.value = workspace.activeProjectId || '';
}

function getChatListItems(searchTerm) {
  const term = searchTerm.trim().toLowerCase();
  const activeProject = getActiveProject();
  if (!term) {
    return (activeProject?.chats || []).map((chat) => ({ project: activeProject, chat }));
  }

  const matches = [];
  workspace.projects.forEach((project) => {
    project.chats.forEach((chat) => {
      const titleMatch = (chat.title || '').toLowerCase().includes(term);
      const messageMatch = (chat.messages || []).some((message) => {
        const parts = [
          message.content,
          message.summary,
          ...(message.assumptions || []),
          ...(message.questions || []),
          ...(message.actions || [])
        ].filter(Boolean);
        return parts.join(' ').toLowerCase().includes(term);
      });
      if (titleMatch || messageMatch) {
        matches.push({ project, chat });
      }
    });
  });

  return matches.sort((a, b) => {
    const timeA = a.chat.updatedAt || a.chat.createdAt || '';
    const timeB = b.chat.updatedAt || b.chat.createdAt || '';
    return timeA < timeB ? 1 : -1;
  });
}

function renderChatList() {
  aiChatListEl.innerHTML = '';
  const items = getChatListItems(aiChatSearchEl.value || '');

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-chat-meta';
    empty.textContent = 'No chats found.';
    aiChatListEl.appendChild(empty);
    return;
  }

  items.forEach(({ project, chat }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-chat-item';
    if (project.id === workspace.activeProjectId && chat.id === workspace.activeChatId) {
      button.classList.add('is-active');
    }

    const title = document.createElement('div');
    title.textContent = chat.title || 'Untitled chat';
    const meta = document.createElement('div');
    meta.className = 'ai-chat-meta';
    const stamp = formatTimestamp(chat.updatedAt || chat.createdAt);
    meta.textContent = `${project.name}${stamp ? ` · ${stamp}` : ''}`;

    const textWrap = document.createElement('div');
    textWrap.appendChild(title);
    textWrap.appendChild(meta);

    button.appendChild(textWrap);
    button.addEventListener('click', () => {
      setActiveChat(project.id, chat.id);
    });

    aiChatListEl.appendChild(button);
  });
}

function renderChatThread() {
  aiChatThreadEl.innerHTML = '';
  const project = getActiveProject();
  const chat = getActiveChat(project);
  const messages = chat?.messages || [];

  renderRoleSelect(chat);

  aiChatEmptyEl.classList.toggle('hidden', messages.length > 0);

  messages.forEach((message) => {
    aiChatThreadEl.appendChild(createMessageElement(message, chat));
  });

  aiApplyLastEl.disabled = !(chat && chat.lastBpmnXml);
  aiChatThreadEl.scrollTop = aiChatThreadEl.scrollHeight;
}

function createMessageElement(message, chat) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('ai-message');
  wrapper.classList.add(message.role === 'user' ? 'ai-message-user' : 'ai-message-assistant');

  const header = document.createElement('div');
  header.className = 'ai-message-header';
  const title = document.createElement('span');
  title.className = 'ai-message-title';
  if (message.role === 'user') {
    title.textContent = 'You';
  } else {
    const roleLabel = getRoleById(message.roleId)?.name || 'AI Assistant';
    title.textContent = roleLabel;
  }
  const time = document.createElement('span');
  time.textContent = formatTimestamp(message.createdAt);
  header.appendChild(title);
  header.appendChild(time);
  wrapper.appendChild(header);

  if (message.role === 'user') {
    const text = document.createElement('div');
    text.className = 'ai-message-text';
    text.textContent = message.content || '';
    wrapper.appendChild(text);
    return wrapper;
  }

  if (message.summary) {
    const summary = document.createElement('div');
    summary.className = 'ai-message-block';
    const label = document.createElement('strong');
    label.textContent = 'Reasoning summary';
    summary.appendChild(label);
    const content = document.createElement('div');
    content.textContent = message.summary;
    summary.appendChild(content);
    wrapper.appendChild(summary);
  }

  if (message.assumptions?.length) {
    const block = document.createElement('div');
    block.className = 'ai-message-block';
    const label = document.createElement('strong');
    label.textContent = 'Assumptions';
    block.appendChild(label);
    const list = document.createElement('ul');
    list.className = 'ai-message-list';
    message.assumptions.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    });
    block.appendChild(list);
    wrapper.appendChild(block);
  }

  if (message.questions?.length) {
    const block = document.createElement('div');
    block.className = 'ai-message-block';
    const label = document.createElement('strong');
    label.textContent = 'Questions';
    block.appendChild(label);
    const list = document.createElement('ul');
    list.className = 'ai-message-list';
    message.questions.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    });
    block.appendChild(list);
    wrapper.appendChild(block);
  }

  if (message.actions?.length) {
    const block = document.createElement('div');
    block.className = 'ai-message-block';
    const label = document.createElement('strong');
    label.textContent = 'Actions';
    block.appendChild(label);
    const list = document.createElement('ul');
    list.className = 'ai-message-list';
    message.actions.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    });
    block.appendChild(list);
    wrapper.appendChild(block);
  }

  if (message.bpmnXml) {
    const actions = document.createElement('div');
    actions.className = 'ai-message-actions';
    const applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'button-secondary';
    applyButton.textContent = 'Apply to canvas';
    applyButton.addEventListener('click', async () => {
      try {
        const updatedXml = await applyBpmnXml(message.bpmnXml, 'AI chat response');
        chat.lastBpmnXml = updatedXml;
        saveWorkspace();
        renderChatThread();
      } catch (err) {
        setPanelStatus(aiStatusEl, `Apply failed: ${err.message}`);
      }
    });
    actions.appendChild(applyButton);
    wrapper.appendChild(actions);

    const details = document.createElement('details');
    details.className = 'ai-message-xml';
    const summary = document.createElement('summary');
    summary.textContent = 'View BPMN XML';
    const pre = document.createElement('pre');
    pre.textContent = message.bpmnXml;
    details.appendChild(summary);
    details.appendChild(pre);
    wrapper.appendChild(details);
  }

  return wrapper;
}

async function importXml(xml, label) {
  try {
    await bpmnModeler.importXML(xml);
    bpmnModeler.get('canvas').zoom('fit-viewport');
    if (label) {
      setMenuStatus(`Loaded ${label}`);
    }
    return true;
  } catch (err) {
    setMenuStatus(`Import failed: ${err.message}`);
    return false;
  }
}

function downloadFile(content, filename, type) {
  const blob = new Blob([ content ], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function showImportPanel(show) {
  if (show) {
    importPanelEl.classList.remove('hidden');
    importXmlEl.focus();
  } else {
    importPanelEl.classList.add('hidden');
  }
}

function setAiTab(tab) {
  aiTabButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.aiTab === tab);
  });

  aiTabPanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.aiPanel === tab);
  });
}

function setAiCollapsed(collapsed) {
  aiPanelEl.classList.toggle('is-collapsed', collapsed);
  aiPanelEl.setAttribute('aria-expanded', String(!collapsed));
  const collapseIcon = aiCollapseEl.querySelector('.icon-collapse');
  if (collapseIcon) {
    collapseIcon.textContent = collapsed ? '>>' : '<<';
  }
}

function openAiSettings() {
  setAiTab('settings');
  setAiCollapsed(false);
  aiConfigStatusEl.textContent = '';
}

async function handleFileOpen(file) {
  if (!file) {
    return;
  }
  const text = await file.text();
  await importXml(text, file.name);
}

async function handleExportBpmn() {
  try {
    const { xml } = await bpmnModeler.saveXML({ format: true });
    downloadFile(xml, 'diagram.bpmn', 'application/xml');
    setMenuStatus('Saved diagram.bpmn');
  } catch (err) {
    setMenuStatus(`Export failed: ${err.message}`);
  }
}

async function handleExportSvg() {
  try {
    const { svg } = await bpmnModeler.saveSVG({ format: true });
    downloadFile(svg, 'diagram.svg', 'image/svg+xml');
    setMenuStatus('Saved diagram.svg');
  } catch (err) {
    setMenuStatus(`Export failed: ${err.message}`);
  }
}

async function handleNewDiagram() {
  try {
    await bpmnModeler.createDiagram();
    bpmnModeler.get('canvas').zoom('fit-viewport');
    setMenuStatus('New diagram created');
  } catch (err) {
    setMenuStatus(`New diagram failed: ${err.message}`);
  }
}

function normalizeApiBase(base) {
  if (!base) {
    return '';
  }
  return base.trim().replace(/\/+$/, '');
}

function getApiCandidates() {
  const candidates = [];
  const stored = normalizeApiBase(localStorage.getItem('aiApiBase'));
  if (stored) {
    candidates.push(stored);
  }
  const current = normalizeApiBase(apiBase);
  if (current) {
    candidates.push(current);
  }
  const host = window.location.hostname || 'localhost';
  [ 5174, 5175, 5176 ].forEach((port) => {
    candidates.push(`http://${host}:${port}`);
    if (host !== 'localhost') {
      candidates.push(`http://localhost:${port}`);
    }
  });
  return Array.from(new Set(candidates));
}

async function fetchProviders(base) {
  const resp = await fetch(`${base}/api/providers`);
  if (!resp.ok) {
    throw new Error('Provider list unavailable.');
  }
  return resp.json();
}

async function loadProviders() {
  const candidates = getApiCandidates();
  let resolvedBase = null;
  let resolvedData = null;

  for (const candidate of candidates) {
    try {
      resolvedData = await fetchProviders(candidate);
      resolvedBase = candidate;
      break;
    } catch (err) {
      resolvedData = null;
    }
  }

  if (resolvedData) {
    providerData = resolvedData;
    if (resolvedBase && resolvedBase !== apiBase) {
      apiBase = resolvedBase;
      localStorage.setItem('aiApiBase', apiBase);
      if (aiApiBaseEl) {
        aiApiBaseEl.value = apiBase;
      }
      setPanelStatus(aiStatusEl, `AI server detected at ${apiBase}.`);
    } else {
      setPanelStatus(aiStatusEl, 'Providers loaded from local AI server.');
    }
  } else {
    providerData = {
      sources: modelCatalog.sources,
      providers: {
        openai: { label: 'OpenAI', available: false, models: modelCatalog.openai },
        anthropic: { label: 'Claude (Anthropic)', available: false, models: modelCatalog.anthropic },
        gemini: { label: 'Gemini', available: false, models: modelCatalog.gemini },
        ollama: { label: 'Ollama (Local)', available: false, models: [], suggestedModels: modelCatalog.ollamaSuggested }
      }
    };
    setPanelStatus(aiStatusEl, `AI server not reachable at ${apiBase}.`);
  }

  populateProviderSelect();
  ensureDefaultModel();
  applyConfigToUi();
  updateCurrentModelLabel();
}

function populateProviderSelect() {
  const providers = providerData?.providers || {};
  aiProviderEl.innerHTML = '';

  Object.entries(providers).forEach(([ key, provider ]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = provider.label + (provider.available ? '' : ' (key required)');
    aiProviderEl.appendChild(option);
  });

  if (!providers[aiConfig.provider]) {
    aiConfig.provider = Object.keys(providers)[0] || aiConfig.provider;
  }

  aiProviderEl.value = aiConfig.provider;
  updateModelSelect();
}

function updateModelSelect() {
  const providers = providerData?.providers || {};
  const provider = providers[aiProviderEl.value];
  aiModelEl.innerHTML = '';

  if (!provider) {
    return;
  }

  const models = provider.models || [];
  if (!models.length && aiProviderEl.value === 'ollama') {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No local Ollama models found';
    aiModelEl.appendChild(option);
    return;
  }

  models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    aiModelEl.appendChild(option);
  });

  if (models.includes(aiConfig.model)) {
    aiModelEl.value = aiConfig.model;
  } else {
    aiModelEl.value = models[0] || '';
  }
}

function ensureDefaultModel() {
  const providers = providerData?.providers || {};
  const provider = providers[aiConfig.provider];
  const models = provider?.models || [];

  if (!models.length) {
    return;
  }

  if (!aiConfig.model || !models.includes(aiConfig.model)) {
    aiConfig.model = models[0];
    saveConfig(aiConfig);
  }
}

function applyConfigToUi() {
  aiApiBaseEl.value = apiBase;
  aiProviderEl.value = aiConfig.provider;
  updateModelSelect();
  aiSystemEl.value = aiConfig.systemPrompt;
  aiTemperatureEl.value = aiConfig.temperature;
  aiMaxTokensEl.value = aiConfig.maxTokens;
  aiLanesEl.value = aiConfig.lanes;
  aiChoicesEl.value = aiConfig.choices;
  aiDecisionsEl.value = aiConfig.decisions;
  aiSessionsEl.value = aiConfig.sessions;
  aiRequireLanesEl.checked = aiConfig.requireLanes;
  aiRequireDiEl.checked = aiConfig.requireDi;
  aiAutoFixEl.checked = aiConfig.autoFix;
  aiCredentialEl.value = credentialCache;
}

function readConfigFromUi() {
  return {
    ...aiConfig,
    provider: aiProviderEl.value,
    model: aiModelEl.value,
    systemPrompt: aiSystemEl.value.trim() || DEFAULT_SYSTEM_PROMPT,
    temperature: Number(aiTemperatureEl.value) || DEFAULT_CONFIG.temperature,
    maxTokens: Number(aiMaxTokensEl.value) || DEFAULT_CONFIG.maxTokens,
    lanes: aiLanesEl.value.trim(),
    choices: aiChoicesEl.value.trim(),
    decisions: aiDecisionsEl.value.trim(),
    sessions: aiSessionsEl.value.trim(),
    requireLanes: aiRequireLanesEl.checked,
    requireDi: aiRequireDiEl.checked,
    autoFix: aiAutoFixEl.checked
  };
}

function commitConfigFromUi(message) {
  aiConfig = readConfigFromUi();
  credentialCache = aiCredentialEl.value.trim();
  saveConfig(aiConfig);
  updateCurrentModelLabel();
  setPanelStatus(aiConfigStatusEl, message || 'Settings saved.');
}

let configAutosaveTimer = null;

function scheduleConfigSave(message) {
  window.clearTimeout(configAutosaveTimer);
  configAutosaveTimer = window.setTimeout(() => {
    commitConfigFromUi(message || 'Settings updated.');
  }, 400);
}

function saveConfigFromUi() {
  commitConfigFromUi('Settings saved.');
}

function resetConfig() {
  aiConfig = { ...DEFAULT_CONFIG };
  saveConfig(aiConfig);
  credentialCache = '';
  applyConfigToUi();
  updateCurrentModelLabel();
  setPanelStatus(aiConfigStatusEl, 'Settings reset to defaults.');
}

function buildPrompt(userPrompt) {
  const lines = [ userPrompt ];

  if (aiConfig.lanes) {
    lines.push(`Swimlanes: ${aiConfig.lanes}.`);
  }
  if (aiConfig.choices) {
    lines.push(`Choices or menu options: ${aiConfig.choices}.`);
  }
  if (aiConfig.decisions) {
    lines.push(`Decision points: ${aiConfig.decisions}.`);
  }
  if (aiConfig.sessions) {
    lines.push(`Sessions or phases: ${aiConfig.sessions}.`);
  }

  if (aiConfig.requireLanes) {
    lines.push('Use pools and swimlanes for the participants listed above.');
  }

  lines.push('Ensure all sequence flows connect to a source and a target.');
  lines.push('Include end-to-end flow with no dangling arrows.');

  return lines.join('\n');
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEdgeAnchors(xml) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      return xml;
    }

    const boundsByElement = new Map();
    const shapes = Array.from(doc.getElementsByTagName('bpmndi:BPMNShape'));
    shapes.forEach((shape) => {
      const elementId = shape.getAttribute('bpmnElement');
      const bounds = shape.getElementsByTagName('dc:Bounds')[0];
      if (!elementId || !bounds) {
        return;
      }
      const x = parseNumber(bounds.getAttribute('x'));
      const y = parseNumber(bounds.getAttribute('y'));
      const width = parseNumber(bounds.getAttribute('width'));
      const height = parseNumber(bounds.getAttribute('height'));
      if ([ x, y, width, height ].some((value) => value === null)) {
        return;
      }
      boundsByElement.set(elementId, { x, y, width, height });
    });

    const flowMap = new Map();
    const flows = Array.from(doc.getElementsByTagName('bpmn:sequenceFlow'));
    flows.forEach((flow) => {
      const id = flow.getAttribute('id');
      const sourceRef = flow.getAttribute('sourceRef');
      const targetRef = flow.getAttribute('targetRef');
      if (id && sourceRef && targetRef) {
        flowMap.set(id, { sourceRef, targetRef });
      }
    });

    const edges = Array.from(doc.getElementsByTagName('bpmndi:BPMNEdge'));
    edges.forEach((edge) => {
      const flowId = edge.getAttribute('bpmnElement');
      const refs = flowMap.get(flowId);
      if (!refs) {
        return;
      }
      const sourceBounds = boundsByElement.get(refs.sourceRef);
      const targetBounds = boundsByElement.get(refs.targetRef);
      if (!sourceBounds || !targetBounds) {
        return;
      }
      const waypoints = Array.from(edge.getElementsByTagName('di:waypoint'));
      if (waypoints.length < 2) {
        return;
      }
      const points = waypoints.map((point) => ({
        el: point,
        x: parseNumber(point.getAttribute('x')),
        y: parseNumber(point.getAttribute('y'))
      }));

      const adjustEndpoint = (point, anchor, bounds) => {
        if (point.x === null || point.y === null || anchor.x === null || anchor.y === null) {
          return;
        }
        const { x, y, width, height } = bounds;
        const onEdge = point.x === x || point.x === x + width || point.y === y || point.y === y + height;
        const inside = point.x > x && point.x < x + width && point.y > y && point.y < y + height;
        if (!inside || onEdge) {
          return;
        }

        const cx = x + width / 2;
        const cy = y + height / 2;
        const dx = anchor.x - cx;
        const dy = anchor.y - cy;
        if (dx === 0 && dy === 0) {
          return;
        }

        let ix = cx;
        let iy = cy;
        if (dx === 0) {
          ix = cx;
          iy = dy > 0 ? y + height : y;
        } else if (dy === 0) {
          iy = cy;
          ix = dx > 0 ? x + width : x;
        } else {
          const candidates = [];
          if (dx > 0) {
            candidates.push((x + width - cx) / dx);
          } else if (dx < 0) {
            candidates.push((x - cx) / dx);
          }
          if (dy > 0) {
            candidates.push((y + height - cy) / dy);
          } else if (dy < 0) {
            candidates.push((y - cy) / dy);
          }
          const t = Math.min(...candidates.filter((value) => value > 0));
          ix = cx + dx * t;
          iy = cy + dy * t;
        }

        point.el.setAttribute('x', String(Math.round(ix)));
        point.el.setAttribute('y', String(Math.round(iy)));
      };

      adjustEndpoint(points[0], points[1], sourceBounds);
      adjustEndpoint(points[points.length - 1], points[points.length - 2], targetBounds);

    });

    return new XMLSerializer().serializeToString(doc);
  } catch (err) {
    return xml;
  }
}

function validateXml(xml) {
  const issues = new Set();
  const addIssue = (issue) => {
    issues.add(issue);
  };

  if (aiConfig.requireLanes && !/<[^>]*laneSet\\b/i.test(xml)) {
    addIssue('Missing laneSet (swimlanes).');
  }

  if (aiConfig.requireDi) {
    if (!/BPMNDiagram/i.test(xml) || !/BPMNPlane/i.test(xml)) {
      addIssue('Missing BPMN DI (BPMNDiagram/BPMNPlane).');
    }
  }

  if (aiConfig.requireLanes) {
    const laneIds = Array.from(xml.matchAll(/<[^>]*bpmn:lane\\b[^>]*id=\"([^\"]+)\"/gi))
      .map((match) => match[1]);
    if (laneIds.length) {
      const missingLaneShapes = laneIds.filter((laneId) => {
        const laneShape = new RegExp(`bpmndi:BPMNShape[^>]*bpmnElement=\"${laneId}\"`, 'i');
        return !laneShape.test(xml);
      });
      if (missingLaneShapes.length) {
        addIssue('Missing BPMN DI shapes for lanes.');
      }
    }
  }

  const edgeBlocks = xml.match(/<bpmndi:BPMNEdge[\s\S]*?<\/bpmndi:BPMNEdge>/gi) || [];
  edgeBlocks.forEach((edge) => {
    const points = Array.from(edge.matchAll(/<di:waypoint\b[^>]*x="([^"]+)"[^>]*y="([^"]+)"/gi))
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const curr = points[i];
      if (prev.x !== curr.x && prev.y !== curr.y) {
        addIssue('Sequence flow connectors include diagonal segments.');
        break;
      }
    }
  });

  const flows = xml.match(/<[^>]*sequenceFlow\\b[^>]*>/gi) || [];
  flows.forEach((tag, index) => {
    if (!/sourceRef=/.test(tag) || !/targetRef=/.test(tag)) {
      addIssue(`sequenceFlow missing sourceRef/targetRef (index ${index + 1}).`);
    }
  });

  return {
    ok: issues.size === 0,
    issues: Array.from(issues)
  };
}

async function requestGeneration(promptText) {
  const resp = await fetch(`${apiBase}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: aiConfig.provider,
      model: aiConfig.model,
      prompt: promptText,
      credential: credentialCache || undefined,
      systemPrompt: aiConfig.systemPrompt,
      temperature: aiConfig.temperature,
      maxTokens: aiConfig.maxTokens
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || 'Generation failed.');
  }

  return data.xml || '';
}

async function requestChat(messages, systemPromptOverride) {
  const resp = await fetch(`${apiBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: aiConfig.provider,
      model: aiConfig.model,
      messages,
      credential: credentialCache || undefined,
      systemPrompt: systemPromptOverride || aiConfig.systemPrompt,
      temperature: aiConfig.temperature,
      maxTokens: aiConfig.maxTokens
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || 'Chat request failed.');
  }

  return data;
}

function buildChatMessages(chat, latestPrompt) {
  const messages = (chat.messages || []).map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content };
    }

    const parts = [];
    if (message.summary) {
      parts.push(`Summary: ${message.summary}`);
    }
    if (message.assumptions?.length) {
      parts.push(`Assumptions: ${message.assumptions.join('; ')}`);
    }
    if (message.questions?.length) {
      parts.push(`Questions: ${message.questions.join('; ')}`);
    }
    if (message.actions?.length) {
      parts.push(`Actions: ${message.actions.join('; ')}`);
    }
    if (message.bpmnXml) {
      parts.push('BPMN XML generated.');
    }
    return { role: 'assistant', content: parts.join('\n') };
  });

  if (messages.length) {
    messages[messages.length - 1].content = latestPrompt;
  }

  return messages.slice(-12);
}

async function applyBpmnXml(xml, label) {
  let candidate = xml;
  if (!candidate) {
    throw new Error('Empty BPMN XML response.');
  }

  candidate = normalizeEdgeAnchors(candidate);

  setPanelStatus(aiStatusEl, 'Applying BPMN XML...');
  const validation = validateXml(candidate);

  if (!validation.ok && aiConfig.autoFix) {
    setPanelStatus(aiStatusEl, `Fixing issues: ${validation.issues.join(' ')}`);
    const fixPrompt = [
      'Fix the BPMN XML below.',
      'Issues:',
      ...validation.issues.map((issue) => `- ${issue}`),
      'Use straight or right-angle sequenceFlow connectors (no diagonals).',
      'Include BPMN DI lane shapes for each lane.',
      'Return corrected BPMN 2.0 XML only.',
      'XML:',
      candidate
    ].join('\n');
    candidate = await requestGeneration(fixPrompt);
    if (!candidate) {
      throw new Error('Auto-fix returned empty BPMN XML.');
    }
    candidate = normalizeEdgeAnchors(candidate);
  }

  const finalCheck = validateXml(candidate);
  if (!finalCheck.ok) {
    setPanelStatus(aiStatusEl, `Validation issues: ${finalCheck.issues.join(' ')}`);
  }

  const imported = await importXml(candidate, label || 'AI-generated diagram');
  if (imported) {
    setPanelStatus(aiStatusEl, 'Diagram generated and loaded.');
  }

  return candidate;
}

async function handleChatSend() {
  const messageText = aiChatInputEl.value.trim();
  if (!messageText) {
    setPanelStatus(aiStatusEl, 'Please enter a message.');
    return;
  }

  if (!aiConfig.model) {
    setPanelStatus(aiStatusEl, 'Select a model in AI settings.');
    return;
  }

  const project = getActiveProject();
  const chat = getActiveChat(project);
  if (!project || !chat) {
    setPanelStatus(aiStatusEl, 'Create a project and chat first.');
    return;
  }

  const role = getActiveRole(chat);
  if (role?.id) {
    chat.roleId = role.id;
    workspace.activeRoleId = role.id;
  }

  const now = new Date().toISOString();
  chat.messages.push({
    id: createId('msg'),
    role: 'user',
    content: messageText,
    createdAt: now
  });
  chat.updatedAt = now;
  project.updatedAt = now;
  aiChatInputEl.value = '';
  saveWorkspace();
  renderChatList();
  renderChatThread();

  setPanelStatus(aiStatusEl, 'Thinking...');
  aiChatSendEl.disabled = true;

  try {
    const fullPrompt = buildPrompt(messageText);
    const messages = buildChatMessages(chat, fullPrompt);
    const response = await requestChat(messages, role?.systemPrompt);

    const assistantMessage = {
      id: createId('msg'),
      role: 'assistant',
      roleId: role?.id || '',
      summary: response.summary || '',
      assumptions: Array.isArray(response.assumptions) ? response.assumptions : [],
      questions: Array.isArray(response.questions) ? response.questions : [],
      actions: Array.isArray(response.actions) ? response.actions : [],
      bpmnXml: response.bpmnXml || '',
      createdAt: new Date().toISOString()
    };

    chat.messages.push(assistantMessage);
    if (assistantMessage.bpmnXml) {
      chat.lastBpmnXml = assistantMessage.bpmnXml;
    }
    chat.updatedAt = new Date().toISOString();
    project.updatedAt = chat.updatedAt;
    saveWorkspace();
    renderChatList();
    renderChatThread();

    if (assistantMessage.bpmnXml && workspace.autoApply) {
      const updatedXml = await applyBpmnXml(assistantMessage.bpmnXml, 'AI chat response');
      chat.lastBpmnXml = updatedXml;
      saveWorkspace();
      renderChatThread();
    }

    if (assistantMessage.questions?.length) {
      setPanelStatus(aiStatusEl, 'Awaiting your answers.');
    } else {
      setPanelStatus(aiStatusEl, 'Response ready.');
    }
  } catch (err) {
    setPanelStatus(aiStatusEl, `Chat failed: ${err.message}`);
  } finally {
    aiChatSendEl.disabled = false;
  }
}

function exportWorkspace() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace
  };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadFile(JSON.stringify(payload, null, 2), `bpmn-ai-workspace-${stamp}.json`, 'application/json');
  setPanelStatus(aiStatusEl, 'Workspace exported.');
}

function normalizeImportedWorkspace(data) {
  if (!data) {
    return null;
  }
  const raw = data.workspace || data;
  if (!Array.isArray(raw.projects)) {
    return null;
  }

  const roles = normalizeRoles(raw.roles);
  const roleIds = new Set(roles.map((role) => role.id));
  const activeRoleId = roleIds.has(raw.activeRoleId) ? raw.activeRoleId : roles[0]?.id || DEFAULT_ROLE_ID;

  return {
    roles,
    activeRoleId,
    projects: raw.projects.map((project) => ({
      ...project,
      chats: Array.isArray(project.chats) ? project.chats : []
    })),
    activeProjectId: raw.activeProjectId || null,
    activeChatId: raw.activeChatId || null,
    autoApply: typeof raw.autoApply === 'boolean' ? raw.autoApply : workspace.autoApply,
    importMode: workspace.importMode
  };
}

function mergeRoles(importedRoles) {
  const roles = normalizeRoles(importedRoles);
  const existingIds = new Set(workspace.roles.map((role) => role.id));
  roles.forEach((role) => {
    if (!existingIds.has(role.id)) {
      workspace.roles.push(role);
      existingIds.add(role.id);
    }
  });
}

function mergeWorkspace(imported) {
  mergeRoles(imported.roles);
  const existingProjectIds = new Set(workspace.projects.map((project) => project.id));
  const existingChatIds = new Set(
    workspace.projects.flatMap((project) => project.chats.map((chat) => chat.id))
  );

  imported.projects.forEach((project) => {
    const projectId = existingProjectIds.has(project.id) ? createId('project') : project.id;
    existingProjectIds.add(projectId);

    const chats = project.chats.map((chat) => {
      const chatId = existingChatIds.has(chat.id) ? createId('chat') : chat.id;
      existingChatIds.add(chatId);
      return {
        ...chat,
        id: chatId,
        messages: Array.isArray(chat.messages) ? chat.messages : []
      };
    });

    workspace.projects.push({
      ...project,
      id: projectId,
      chats
    });
  });
}

async function handleImportFile(file) {
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const imported = normalizeImportedWorkspace(data);
    if (!imported) {
      setPanelStatus(aiStatusEl, 'Invalid workspace file.');
      return;
    }

    if (workspace.importMode === 'merge') {
      mergeWorkspace(imported);
    } else {
      workspace = { ...DEFAULT_WORKSPACE, ...imported };
    }

    ensureWorkspaceState();
    saveWorkspace();
    renderWorkspace();
    setPanelStatus(aiStatusEl, 'Workspace imported.');
  } catch (err) {
    setPanelStatus(aiStatusEl, `Import failed: ${err.message}`);
  }
}

function setupMenu() {
  menuBarEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    if (action === 'new') {
      handleNewDiagram();
    } else if (action === 'open') {
      fileInputEl.click();
    } else if (action === 'import') {
      showImportPanel(true);
    } else if (action === 'export-bpmn') {
      handleExportBpmn();
    } else if (action === 'export-svg') {
      handleExportSvg();
    }
  });

  fileInputEl.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    await handleFileOpen(file);
    fileInputEl.value = '';
  });

  importApplyEl.addEventListener('click', async () => {
    const xml = importXmlEl.value.trim();
    if (!xml) {
      setPanelStatus(importStatusEl, 'Paste BPMN XML before importing.');
      return;
    }
    setPanelStatus(importStatusEl, 'Importing...');
    const imported = await importXml(xml, 'pasted XML');
    if (imported) {
      setPanelStatus(importStatusEl, 'Imported.');
      showImportPanel(false);
    }
  });

  importCancelEl.addEventListener('click', () => {
    showImportPanel(false);
  });
}

function setupAiPanel() {
  aiRefreshEl.addEventListener('click', loadProviders);
  aiSettingsEl.addEventListener('click', () => openAiSettings());

  aiTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setAiTab(button.dataset.aiTab);
    });
  });

  aiCollapseEl.addEventListener('click', (event) => {
    event.stopPropagation();
    setAiCollapsed(!aiPanelEl.classList.contains('is-collapsed'));
  });

  aiPanelEl.addEventListener('click', () => {
    if (aiPanelEl.classList.contains('is-collapsed')) {
      setAiCollapsed(false);
    }
  });

  if (aiRoleSelectEl) {
    aiRoleSelectEl.addEventListener('change', () => {
      const project = getActiveProject();
      const chat = getActiveChat(project);
      if (!chat) {
        return;
      }
      chat.roleId = aiRoleSelectEl.value;
      workspace.activeRoleId = chat.roleId;
      saveWorkspace();
      renderChatThread();
    });
  }

  if (aiRolePresetEl) {
    aiRolePresetEl.addEventListener('change', () => {
      roleEditorId = aiRolePresetEl.value;
      renderRoleEditor();
    });
  }

  if (aiRoleNewEl) {
    aiRoleNewEl.addEventListener('click', () => {
      createNewRole();
    });
  }

  if (aiRoleSaveEl) {
    aiRoleSaveEl.addEventListener('click', () => {
      saveRoleFromEditor();
    });
  }

  if (aiRoleDeleteEl) {
    aiRoleDeleteEl.addEventListener('click', () => {
      deleteRoleFromEditor();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !aiPanelEl.classList.contains('is-collapsed')) {
      setAiCollapsed(true);
    }
  });

  aiProjectNewEl.addEventListener('click', () => {
    const name = window.prompt('Project name', 'New Project');
    if (name) {
      createProject(name.trim());
      ensureWorkspaceState();
      renderWorkspace();
    }
  });

  aiProjectSelectEl.addEventListener('change', () => {
    setActiveProject(aiProjectSelectEl.value);
  });

  aiChatNewEl.addEventListener('click', () => {
    const project = getActiveProject();
    if (!project) {
      return;
    }
    const name = window.prompt('Chat title', `Chat ${project.chats.length + 1}`);
    createChat(project, name ? name.trim() : `Chat ${project.chats.length + 1}`);
    renderWorkspace();
  });

  aiChatSearchEl.addEventListener('input', () => {
    renderChatList();
  });

  aiChatExportEl.addEventListener('click', exportWorkspace);
  aiChatImportEl.addEventListener('click', () => aiChatImportFileEl.click());
  aiChatImportFileEl.addEventListener('change', async (event) => {
    await handleImportFile(event.target.files[0]);
    aiChatImportFileEl.value = '';
  });

  aiChatSendEl.addEventListener('click', handleChatSend);
  aiChatInputEl.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      handleChatSend();
    }
  });

  aiApplyLastEl.addEventListener('click', async () => {
    const project = getActiveProject();
    const chat = getActiveChat(project);
    if (!chat?.lastBpmnXml) {
      return;
    }
    try {
      const updatedXml = await applyBpmnXml(chat.lastBpmnXml, 'Chat BPMN');
      chat.lastBpmnXml = updatedXml;
      saveWorkspace();
      renderChatThread();
    } catch (err) {
      setPanelStatus(aiStatusEl, `Apply failed: ${err.message}`);
    }
  });

  aiAutoApplyEl.addEventListener('change', () => {
    workspace.autoApply = aiAutoApplyEl.checked;
    saveWorkspace();
  });

  aiImportModeEl.addEventListener('change', () => {
    workspace.importMode = aiImportModeEl.value;
    saveWorkspace();
  });

  aiConfigSaveEl.addEventListener('click', () => saveConfigFromUi());
  aiConfigResetEl.addEventListener('click', () => resetConfig());

  aiProviderEl.addEventListener('change', () => {
    updateModelSelect();
    scheduleConfigSave();
  });
  aiModelEl.addEventListener('change', () => scheduleConfigSave());
  aiCredentialEl.addEventListener('change', () => scheduleConfigSave());
  aiSystemEl.addEventListener('input', () => scheduleConfigSave());
  aiTemperatureEl.addEventListener('input', () => scheduleConfigSave());
  aiMaxTokensEl.addEventListener('input', () => scheduleConfigSave());
  aiLanesEl.addEventListener('input', () => scheduleConfigSave());
  aiChoicesEl.addEventListener('input', () => scheduleConfigSave());
  aiDecisionsEl.addEventListener('input', () => scheduleConfigSave());
  aiSessionsEl.addEventListener('input', () => scheduleConfigSave());
  aiRequireLanesEl.addEventListener('change', () => scheduleConfigSave());
  aiRequireDiEl.addEventListener('change', () => scheduleConfigSave());
  aiAutoFixEl.addEventListener('change', () => scheduleConfigSave());

  aiApiBaseEl.addEventListener('change', () => {
    apiBase = aiApiBaseEl.value.trim() || 'http://localhost:5174';
    localStorage.setItem('aiApiBase', apiBase);
    loadProviders();
  });

  setAiTab('prompt');
  ensureWorkspaceState();
  renderWorkspace();
  loadProviders();
}

function setupQualityAssurance() {
  const moddle = bpmnModeler.get('moddle');
  const modeling = bpmnModeler.get('modeling');

  let analysisDetails;
  let businessObject;
  let element;
  let suitabilityScore;

  function validate() {
    const { value } = suitabilityScoreEl;

    if (isNaN(value)) {
      warningEl.classList.remove('hidden');
      okayEl.disabled = true;
    } else {
      warningEl.classList.add('hidden');
      okayEl.disabled = false;
    }
  }

  bpmnModeler.on('element.contextmenu', HIGH_PRIORITY, (event) => {
    event.originalEvent.preventDefault();
    event.originalEvent.stopPropagation();

    qualityAssuranceEl.classList.remove('hidden');

    ({ element } = event);

    if (!element.parent) {
      return;
    }

    businessObject = getBusinessObject(element);

    let { suitable } = businessObject;
    suitabilityScoreEl.value = suitable ? suitable : '';
    suitabilityScoreEl.focus();

    analysisDetails = getExtensionElement(businessObject, 'qa:AnalysisDetails');
    lastCheckedEl.textContent = analysisDetails ? analysisDetails.lastChecked : '-';

    validate();
  });

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();

    suitabilityScore = Number(suitabilityScoreEl.value);

    if (isNaN(suitabilityScore)) {
      return;
    }

    const extensionElements = businessObject.extensionElements || moddle.create('bpmn:ExtensionElements');

    if (!analysisDetails) {
      analysisDetails = moddle.create('qa:AnalysisDetails');
      extensionElements.get('values').push(analysisDetails);
    }

    analysisDetails.lastChecked = new Date().toISOString();

    modeling.updateProperties(element, {
      extensionElements,
      suitable: suitabilityScore
    });

    qualityAssuranceEl.classList.add('hidden');
  });

  formEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      qualityAssuranceEl.classList.add('hidden');
    }
  });

  suitabilityScoreEl.addEventListener('input', validate);
}

// hide quality assurance if user clicks outside
window.addEventListener('click', (event) => {
  const { target } = event;
  if (target === qualityAssuranceEl || qualityAssuranceEl.contains(target)) {
    return;
  }
  qualityAssuranceEl.classList.add('hidden');
});

// import initial XML and wire UI
setupMenu();
setupAiPanel();

bpmnModeler.importXML(diagramXML).then(() => {
  bpmnModeler.get('canvas').zoom('fit-viewport');
  setupQualityAssurance();
  setMenuStatus('Loaded example diagram');
}).catch((err) => {
  setMenuStatus(`Initial import failed: ${err.message}`);
});

function getExtensionElement(element, type) {
  if (!element.extensionElements) {
    return;
  }

  return element.extensionElements.values.filter((extensionElement) => {
    return extensionElement.$instanceOf(type);
  })[0];
}


