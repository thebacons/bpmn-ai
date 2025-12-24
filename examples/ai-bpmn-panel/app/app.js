import BpmnModeler from 'bpmn-js/lib/Modeler';

import { getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';

import diagramXML from '../resources/diagram.bpmn';

import customModule from './custom';

import qaExtension from '../resources/qa';

import modelCatalog from './ai/model-catalog.json';

const HIGH_PRIORITY = 1500;
const API_BASE = localStorage.getItem('aiApiBase') || 'http://localhost:5174';

const DEFAULT_SYSTEM_PROMPT = [
  'You are a BPMN 2.0 modeler.',
  'Return valid BPMN 2.0 XML only. Do not include code fences or explanations.',
  'Include BPMN DI (bpmndi:BPMNDiagram, bpmndi:BPMNPlane, and shapes/edges).',
  'Use pools and swimlanes when participants are provided.',
  'Ensure every sequenceFlow has sourceRef and targetRef (no dangling arrows).',
  'Keep the diagram simple, readable, and consistent with the user request.'
].join(' ');

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

let aiConfig = loadConfig();
let credentialCache = '';

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
const aiPromptEl = document.getElementById('ai-prompt');
const aiGenerateEl = document.getElementById('ai-generate');
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

async function loadProviders() {
  try {
    const resp = await fetch(`${API_BASE}/api/providers`);
    if (!resp.ok) {
      throw new Error('Provider list unavailable.');
    }
    providerData = await resp.json();
    setPanelStatus(aiStatusEl, 'Providers loaded from local AI server.');
  } catch (err) {
    providerData = {
      sources: modelCatalog.sources,
      providers: {
        openai: { label: 'OpenAI', available: false, models: modelCatalog.openai },
        anthropic: { label: 'Claude (Anthropic)', available: false, models: modelCatalog.anthropic },
        gemini: { label: 'Gemini', available: false, models: modelCatalog.gemini },
        ollama: { label: 'Ollama (Local)', available: false, models: [], suggestedModels: modelCatalog.ollamaSuggested }
      }
    };
    setPanelStatus(aiStatusEl, `AI server not reachable at ${API_BASE}.`);
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

function validateXml(xml) {
  const issues = [];

  if (aiConfig.requireLanes && !/<[^>]*laneSet\\b/i.test(xml)) {
    issues.push('Missing laneSet (swimlanes).');
  }

  if (aiConfig.requireDi) {
    if (!/BPMNDiagram/i.test(xml) || !/BPMNPlane/i.test(xml)) {
      issues.push('Missing BPMN DI (BPMNDiagram/BPMNPlane).');
    }
  }

  const flows = xml.match(/<[^>]*sequenceFlow\\b[^>]*>/gi) || [];
  flows.forEach((tag, index) => {
    if (!/sourceRef=/.test(tag) || !/targetRef=/.test(tag)) {
      issues.push(`sequenceFlow missing sourceRef/targetRef (index ${index + 1}).`);
    }
  });

  return {
    ok: issues.length === 0,
    issues
  };
}

async function requestGeneration(promptText) {
  const resp = await fetch(`${API_BASE}/api/generate`, {
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

async function handleGenerate() {
  const prompt = aiPromptEl.value.trim();
  if (!prompt) {
    setPanelStatus(aiStatusEl, 'Please enter a prompt.');
    return;
  }

  if (!aiConfig.model) {
    setPanelStatus(aiStatusEl, 'Select a model in AI settings.');
    return;
  }

  setPanelStatus(aiStatusEl, 'Generating BPMN XML...');

  try {
    const fullPrompt = buildPrompt(prompt);
    let xml = await requestGeneration(fullPrompt);

    if (!xml) {
      throw new Error('Empty BPMN XML response.');
    }

    const validation = validateXml(xml);
    if (!validation.ok && aiConfig.autoFix) {
      setPanelStatus(aiStatusEl, `Fixing issues: ${validation.issues.join(' ')}`);
      const fixPrompt = [
        'Fix the BPMN XML below.',
        'Issues:',
        ...validation.issues.map((issue) => `- ${issue}`),
        'Return corrected BPMN 2.0 XML only.',
        'XML:',
        xml
      ].join('\n');
      xml = await requestGeneration(fixPrompt);
    }

    const finalCheck = validateXml(xml);
    if (!finalCheck.ok) {
      setPanelStatus(aiStatusEl, `Validation issues: ${finalCheck.issues.join(' ')}`);
    }

    const imported = await importXml(xml, 'AI-generated diagram');
    if (imported) {
      setPanelStatus(aiStatusEl, 'Diagram generated and loaded.');
    }
  } catch (err) {
    setPanelStatus(aiStatusEl, `Generate failed: ${err.message}`);
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
  aiGenerateEl.addEventListener('click', handleGenerate);
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

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !aiPanelEl.classList.contains('is-collapsed')) {
      setAiCollapsed(true);
    }
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

  setAiTab('prompt');
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


