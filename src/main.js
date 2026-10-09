const keywordInput = document.getElementById('keyword');
const keywordHighlight = document.getElementById('keywordHighlight');
const fileList = document.getElementById('fileList');
const brandMark = document.querySelector('.brand-mark');
const pupils = [...(brandMark?.querySelectorAll('.pupil') ?? [])];
const eyes = [...(brandMark?.querySelectorAll('.eye') ?? [])];
const eyeCenters = [
  { x: 32, y: 46 },
  { x: 58, y: 46}
];
const blinkDelay = 10000;
let blinkTimer;

function startBlinkTimer() {
  clearTimeout(blinkTimer);
  eyes.forEach((eye) => eye.classList.remove('blinking'));
  blinkTimer = setTimeout(() => {
    eyes.forEach((eye) => eye.classList.add('blinking'));
  }, blinkDelay);
}

function trackEyes(event) {
  if (!brandMark) return;

  startBlinkTimer();
  const rect = brandMark.getBoundingClientRect();
  const viewBox = brandMark.viewBox.baseVal;
  if (!rect.width || !rect.height) return;

  const mouseX = (event.clientX - rect.left) * viewBox.width / rect.width + viewBox.x;
  const mouseY = (event.clientY - rect.top) * viewBox.height / rect.height + viewBox.y;
  const maxDistance = 2.5;

  pupils.forEach((pupil, index) => {
    const dx = mouseX - eyeCenters[index].x;
    const dy = mouseY - eyeCenters[index].y;
    const distance = Math.hypot(dx, dy);
    const scale = distance > maxDistance ? maxDistance / distance : 1;
    pupil.setAttribute('transform', `translate(${dx * scale} ${dy * scale})`);
  });
}

function resetEyes() {
  pupils.forEach((pupil) => pupil.removeAttribute('transform'));
  startBlinkTimer();
}

document.addEventListener('mousemove', trackEyes);
document.addEventListener('mouseleave', resetEyes);
startBlinkTimer();

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let currentSearchId = 0;
let statusLine;
let indexStatus = null;

let debounceTimer;

function describeIndex(status) {
  if (!status) return 'Index starting...';
  if (status.error) return `Index error: ${status.error}`;
  const parts = [`${status.indexed.toLocaleString()} files indexed`];
  if (status.pending) {
    const note = status.initialIndexing
      ? ' (first-time indexing, newest files first)'
      : status.idle ? '' : ' (older files are indexed when the computer is idle)';
    parts.push(`${status.pending.toLocaleString()} waiting${note}`);
  }
  if (status.scanning) parts.push('checking for changes');
  return parts.join(' • ');
}

// Set when the user opens the welcome screen from settings; index status updates must not hide it.
let welcomePinned = false;
const WELCOME_DISMISSED_KEY = 'welcomeDismissed';

// Welcome appears on first run until the user click OK, afterwards index progress lives in settings.
function updateWelcome() {
  const welcome = document.getElementById('welcome');
  const showProgress = welcomePinned || !localStorage.getItem(WELCOME_DISMISSED_KEY);
  document.getElementById('welcome-indexSummary').textContent = describeIndex(indexStatus);
  welcome.hidden = !showProgress || (!welcomePinned && Boolean(keywordInput.value.trim())) || !settingsPanel.hidden;
  if (!welcome.hidden) updateWideKeys(welcomeHotkey);
}

function highlightedPreview(preview, highlights) {
  const fragment = document.createDocumentFragment();
  let position = 0;
  for (const { start, length } of highlights) {
    fragment.append(preview.slice(position, start));
    const mark = document.createElement('mark');
    mark.textContent = preview.slice(start, start + length);
    fragment.append(mark);
    position = start + length;
  }
  fragment.append(preview.slice(position));
  return fragment;
}

function updateKeywordHighlight() {
  const query = keywordInput.value;
  const fragment = document.createDocumentFragment();
  const tokenPattern = /"[^"]*"|\S+/g;
  let position = 0;
  for (const match of query.matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith('"') || !['AND', 'OR', 'NOT'].includes(token)) continue;
    fragment.append(query.slice(position, match.index));
    const operator = document.createElement('span');
    operator.className = 'query-operator';
    operator.textContent = token;
    fragment.append(operator);
    position = match.index + token.length;
  }
  fragment.append(query.slice(position));
  keywordHighlight.replaceChildren(fragment);
  keywordHighlight.scrollLeft = keywordInput.scrollLeft;
}

function renderFile(file) {
  const item = document.createElement('div');
  item.className = 'file-item';

  const header = document.createElement('div');
  header.className = 'file-header';
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.name;
  const modified = document.createElement('time');
  modified.className = 'file-modified';
  modified.dateTime = new Date(file.modified).toISOString();
  modified.textContent = dateFormat.format(file.modified);
  const actions = document.createElement('div');
  const btnOpenFile = document.createElement('span');
  btnOpenFile.className = 'open-file';
  btnOpenFile.addEventListener('click', () => window.electronAPI.openFile(file.path));
  const btnOpenFolder = document.createElement('span');
  btnOpenFolder.className = 'open-folder';
  btnOpenFolder.addEventListener('click', () => window.electronAPI.openFolder(file.path));
  actions.append(btnOpenFile, btnOpenFolder);
  header.append(name, actions);

  const location = document.createElement('div');
  location.className = 'file-path';
  // location.textContent = `${file.path} • ${file.matchCount} ${file.matchCount === 1 ? 'match' : 'matches'}`;
  location.textContent = `${file.matchCount} ${file.matchCount === 1 ? 'match' : 'matches'} • `;
  location.append(modified);

  const preview = document.createElement('p');
  preview.className = 'file-preview';
  preview.append(highlightedPreview(file.preview, file.highlights));

  item.append(header, location, preview);
  return item;
}

async function runSearch() {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    currentSearchId += 1;
    fileList.hidden = true;
    fileList.classList.remove('reveal');
    return;
  }

  const searchId = ++currentSearchId;

  try {
    const { results, limitReached, status } = await window.electronAPI.search(keyword);
    if (searchId !== currentSearchId) return;
    indexStatus = status;

    const details = [`${results.length} matched files`];
    if (limitReached) details.push(`showing the ${results.length} most recently modified`);
    showResults(details.join(` • `), results.map(renderFile));
  } catch (error) {
    if (searchId === currentSearchId) showResults(`Search failed: ${error.message}`, []);
  }
}

// Swap content in one step; the previous list stays visible until then, so the window never collapses between searches.
function showResults(summary, items) {
  // Match counts are not useful to users, so no status line is shown.
  // statusLine = document.createElement('div');
  // statusLine.className = 'search-status';
  // statusLine.textContent = summary;
  // fileList.replaceChildren(statusLine, ...items);
  fileList.replaceChildren(...items);
  if (!items.length) {
    fileList.hidden = true;
    return;
  }
  if (fileList.hidden) {
    fileList.classList.add('reveal');
    fileList.hidden = false;
    setTimeout(() => fileList.classList.remove('reveal'), 250);
  }
}

const settingsPanel = document.getElementById('settings');
const indexAmount = document.getElementById('indexAmount');
const diskSpaceUsed = document.getElementById('diskSpaceUsed');
const diskUsageRatioChart = document.getElementById('diskUsageRatioChart');
const indexFileLocation = document.querySelector('#indexFileLocation span');
const MB = 1024 * 1024;
const GB = 1024 * MB;

window.electronAPI.getIndexLocation().then((location) => {
  indexFileLocation.textContent = location;
  indexFileLocation.title = location;
});

function updateIndexAmount() {
  indexAmount.textContent = (indexStatus?.indexed ?? 0).toLocaleString();
}

function chartSegment(className, bytes, totalBytes, label) {
  const segment = document.createElement('div');
  segment.className = `disk-segment ${className}`;
  segment.style.flexGrow = bytes / totalBytes;
  segment.title = label;
  return segment;
}

async function updateDiskUsage() {
  try {
    const { indexBytes, totalBytes, freeBytes } = await window.electronAPI.getDiskUsage();
    diskSpaceUsed.textContent = (indexBytes / MB).toFixed(1);
    const otherBytes = Math.max(0, totalBytes - freeBytes - indexBytes);
    diskUsageRatioChart.replaceChildren(
      chartSegment('disk-used', otherBytes, totalBytes, `Disk used: ${(otherBytes / GB).toFixed(1)} GB`),
      chartSegment('disk-index', indexBytes, totalBytes, `Index: ${(indexBytes / MB).toFixed(1)} MB`),
      chartSegment('disk-free', freeBytes, totalBytes, `Free: ${(freeBytes / GB).toFixed(1)} GB`)
    );
  } catch (error) {
    diskUsageRatioChart.replaceChildren();
    diskUsageRatioChart.title = `Disk usage unavailable: ${error.message}`;
  }
}

const indexPathList = document.getElementById('indexPathList');
let selectedIndexPath = null;

function renderIndexPaths(paths) {
  if (!paths.includes(selectedIndexPath)) selectedIndexPath = null;
  indexPathList.replaceChildren(...paths.map((folder) => {
    const item = document.createElement('div');
    item.className = 'index-path-item';
    item.classList.toggle('selected', folder === selectedIndexPath);
    item.textContent = folder;
    item.title = folder;
    item.addEventListener('click', () => {
      selectedIndexPath = folder;
      renderIndexPaths(paths);
    });
    return item;
  }));
}

const settingMenuItems = settingsPanel.querySelectorAll('.setting-menu-item');
const settingItems = settingsPanel.querySelectorAll('.setting-item');

function showSettingItem(index) {
  settingMenuItems.forEach((menuItem, i) => menuItem.classList.toggle('active', i === index));
  settingItems.forEach((item, i) => {
    item.classList.toggle('active', i === index);
    item.style.transform = `translateX(${-index * 100}%)`;
  });
}

settingMenuItems.forEach((menuItem, index) => {
  menuItem.addEventListener('click', () => showSettingItem(index));
});

const themeButtons = {
  system: document.querySelector('#themeSelection .theme.auto'),
  light: document.querySelector('#themeSelection .theme.light'),
  dark: document.querySelector('#themeSelection .theme.dark')
}

function renderTheme(theme) {
  for (const [name, button] of Object.entries(themeButtons)) button.classList.toggle('active', name === theme);
}

for (const [name, button] of Object.entries(themeButtons)) {
  button.addEventListener('click', async () => renderTheme(await window.electronAPI.setTheme(name)));
}
window.electronAPI.getTheme().then(renderTheme);

const maximumResults = document.getElementById('maximumResults');
const maximumResultsValue = document.getElementById('maximumResultsValue');
function renderMaximumResults() {
  const { min, max, value } = maximumResults;
  maximumResults.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
  maximumResultsValue.textContent = value;
}
maximumResults.addEventListener('input', renderMaximumResults);
renderMaximumResults();

const launchAtStartup = document.getElementById('launchAtStartup');
window.electronAPI.getLaunchAtStartup().then((enabled) => { launchAtStartup.checked = enabled; });
launchAtStartup.addEventListener('change', async () => {
  try {
    launchAtStartup.checked = await window.electronAPI.setLaunchAtStartup(launchAtStartup.checked);
  } catch {
    launchAtStartup.checked = !launchAtStartup.checked;
  }
});

document.getElementById('btnWelcomeScreen').addEventListener('click', () => {
  const welcome = document.getElementById('welcome');
  settingsPanel.hidden = true;
  fileList.hidden = true;
  welcomePinned = true;
  document.getElementById('welcome-indexSummary').textContent = describeIndex(indexStatus);
  welcome.hidden = false;
  updateWideKeys(welcomeHotkey);
});
document.getElementById('welcome-ok').addEventListener('click', () => {
  localStorage.setItem(WELCOME_DISMISSED_KEY, '1');
  welcomePinned = false;
  fileList.hidden = fileList.childElementCount === 0;
  showSettingItem(0);
  updateWelcome();
});
document.getElementById('btnSettings').addEventListener('click', () => {
  welcomePinned = false;
  settingsPanel.hidden = false;
  fileList.hidden = true;
  showSettingItem(0);
  updateWelcome();
  updateIndexAmount();
  updateDiskUsage();
});
document.getElementById('indexPathAdd').addEventListener('click', async () => {
  renderIndexPaths(await window.electronAPI.addIndexPath());
});
document.getElementById('indexPathRemove').addEventListener('click', async () => {
  if (!selectedIndexPath) return;
  renderIndexPaths(await window.electronAPI.removeIndexPath(selectedIndexPath));
});
window.electronAPI.getIndexPaths().then(renderIndexPaths);

const indexFileExtensionList = document.getElementById('indexFileExtensionList');
let indexExtensions = [];
let selectedIndexExtension = null;

function renderIndexExtensions(extensions) {
  indexExtensions = extensions;
  if (!extensions.includes(selectedIndexExtension)) selectedIndexExtension = null;
  indexFileExtensionList.replaceChildren(...extensions.map((extension) => {
    const item = document.createElement('div');
    item.className = 'index-path-item';
    item.classList.toggle('selected', extension === selectedIndexExtension);
    item.textContent = extension;
    item.addEventListener('click', () => {
      selectedIndexExtension = extension;
      renderIndexExtensions(indexExtensions);
    });
    return item;
  }));
}

document.getElementById('indexFileExtensionAdd').addEventListener('click', () => {
  const existing = indexFileExtensionList.querySelector('.index-extension-input');
  if (existing) return existing.focus();

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'index-extension-input';
  input.placeholder = '.ext';
  input.maxLength = 17;
  let committing = false;

  input.addEventListener('keydown', async (event) => {
    // Keep Escape from hiding the window while editing.
    event.stopPropagation();
    if (event.key === 'Escape') return input.remove();
    if (event.key !== 'Enter' || !input.value.trim()) return;
    committing = true;
    try {
      renderIndexExtensions(await window.electronAPI.addIndexExtension(input.value));
    } catch {
      input.classList.add('invalid');
      input.title = 'Use letters, digits, _ + or -, e.g. .txt';
      committing = false;
    }
  });
  input.addEventListener('input', () => input.classList.remove('invalid'));
  input.addEventListener('blur', () => {
    if (!committing) input.remove();
  });

  indexFileExtensionList.append(input);
  input.scrollIntoView({ block: 'nearest' });
  input.focus();
});
document.getElementById('indexFileExtensionRemove').addEventListener('click', async () => {
  if (!selectedIndexExtension) return;
  renderIndexExtensions(await window.electronAPI.removeIndexExtension(selectedIndexExtension));
});
window.electronAPI.getIndexExtensions().then(renderIndexExtensions);

const excludedFolderList = document.getElementById('indexExcludeFolderList');
let excludedFolders = [];
let selectedExcludedFolder = null;

function renderExcludedFolders(folders) {
  excludedFolders = folders;
  if (!folders.includes(selectedExcludedFolder)) selectedExcludedFolder = null;
  excludedFolderList.replaceChildren(...folders.map((folder) => {
    const item = document.createElement('div');
    item.className = 'index-path-item';
    item.classList.toggle('selected', folder === selectedExcludedFolder);
    item.textContent = folder;
    item.addEventListener('click', () => {
      selectedExcludedFolder = folder;
      renderExcludedFolders(excludedFolders);
    });
    return item;
  }));
}

document.getElementById('indexExcludeFolderAdd').addEventListener('click', () => {
  const existing = excludedFolderList.querySelector('.index-extension-input');
  if (existing) return existing.focus();

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'index-extension-input';
  input.placeholder = 'folder name';
  input.maxLength = 255;
  let committing = false;

  input.addEventListener('keydown', async (event) => {
    // Keep Escape from hid ing the window while editing.
    event.stopPropagation();
    if (event.key === 'Escape') return input.remove();
    if (event.key !== 'Enter' || !input.value.trim()) return;
    committing = true;
    try {
      renderExcludedFolders(await window.electronAPI.addExcludedFolder(input.value));
    } catch {
      input.classList.add('invalid');
      input.title = 'Enter a folder name only, without slashes or special characters';
      committing = false;
    }
  });
  input.addEventListener('input', () => input.classList.remove('invalid'));
  input.addEventListener('blur', () => {
    if (!committing) input.remove();
  });

  excludedFolderList.append(input);
  input.scrollIntoView({ block: 'nearest' });
  input.focus();
});
document.getElementById('indexExcludeFolderRemove').addEventListener('click', async () => {
  if (!selectedExcludedFolder) return;
  renderExcludedFolders(await window.electronAPI.removeExcludedFolder(selectedExcludedFolder));
});
window.electronAPI.getExcludedFolders().then(renderExcludedFolders);

window.electronAPI.onIndexStatus((status) => {
  indexStatus = status;
  updateIndexAmount();
  updateWelcome();
});
window.electronAPI.getIndexStatus().then((status) => {
  indexStatus = status ?? indexStatus;
  updateIndexAmount();
  updateWelcome();
});

// Window height follows the content, including the margin that leaves room for the shadow.
let resizeFrame = 0;
new ResizeObserver(() => {
  // Coalesce bursts (results rendering incrementally) into one animation target.
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const container = document.querySelector('.container');
    const style = getComputedStyle(container);
    const height = container.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    window.electronAPI.resizeToContent(height + 2);
  });
}).observe(document.querySelector('.container'));

const hotkeys = document.getElementById('hotkeys');
const hotkeysMessage = document.getElementById('hotkeys-message');
const spaceKeyTemplate = hotkeys.querySelector('.spaceKey').cloneNode(true);
const shiftKeyTemplate = hotkeys.querySelector('.shiftKey').cloneNode(true);
const backspaceKeyTemplate = Object.assign(document.createElement('template'), { innerHTML: `
  <span class="backspaceKey">Backspace
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
      <path d="M5.83 5.146a.5.5 0 0 0 0 .708L7.975 8l-2.147 2.146a.5.5 0 0 0 .707.708l2.147-2.147 2.146 2.147a.5.5 0 0 0 .707-.708L9.39 8l2.146-2.146a.5.5 0 0 0-.707-.708L8.683 7.293 6.536 5.146a.5.5 0 0 0-.707 0z"/>
      <path d="M13.683 1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7.08a2 2 0 0 1-1.519-.698L.241 8.65a1 1 0 0 1 0-1.302L5.084 1.7A2 2 0 0 1 6.603 1zm-7.08 1a1 1 0 0 0-.76.35L1 8l4.844 5.65a1 1 0 0 0 .759.35h7.08a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z"/>
    </svg>
  </span>`.trim() }).content.firstElementChild;
const enterTemplate = Object.assign(document.createElement('template'), { innerHTML: `
  <span class="enterKey">Enter
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
      <path fill-rule="evenodd" d="M14.5 1.5a.5.5 0 0 1 .5.5v4.8a2.5 2.5 0 0 1-2.5 2.5H2.707l3.347 3.346a.5.5 0 0 1-.708.708l-4.2-4.2a.5.5 0 0 1 0-.708l4-4a.5.5 0 1 1 .708.708L2.707 8.3H12.5A1.5 1.5 0 0 0 14 6.8V2a.5.5 0 0 1 .5-.5"/>
    </svg>
  </span>`.trim() }).content.firstElementChild;
const MODIFIERS = ['Ctrl', 'Shift', 'Alt'];
let hotkeyCombo = [];
let hotkeyReleased = true;
let savedHotkeyCombo = [];
const btnHotkeysSave = document.getElementById('btnHotkeysSave');
const btnHotkeysReset = document.getElementById('btnHotkeysReset');
const ACCELERATOR_NAMES = {
  Ctrl: 'Control', Meta: 'Super', Escape: 'Esc', Enter: 'Return', '+': 'Plus',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};
const KEY_NAMES = Object.fromEntries(Object.entries(ACCELERATOR_NAMES).map(([key, value]) => [value, key]));

btnHotkeysSave.disabled = true;

function isValidHotkeyCombo(combo) {
  return combo.length >= 2 && MODIFIERS.includes(combo[0]);
}

function showSavedHotkey() {
  hotkeyCombo = [...savedHotkeyCombo];
  renderHotkeyCombo();
  renderWelcomeHotkey();
  btnHotkeysSave.disabled = true;
}

window.electronAPI.getHotkey().then((accelerator) => {
  savedHotkeyCombo = accelerator.split('+').map((name) => KEY_NAMES[name] ?? name);
  showSavedHotkey();
});

btnHotkeysSave.addEventListener('click', async () => {
  if (!isValidHotkeyCombo(hotkeyCombo)) return;
  const combo = [...hotkeyCombo];
  try {
    await window.electronAPI.setHotkey(combo.map((name) => ACCELERATOR_NAMES[name] ?? name).join('+'));
    savedHotkeyCombo = combo;
    renderWelcomeHotkey();
    btnHotkeysSave.disabled = true;
    hotkeysMessage.textContent = `Hotkey applied: ${combo.join(' + ')}`;
  } catch (error) {
    hotkeysMessage.textContent = error.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }
});

btnHotkeysReset.addEventListener('click', () => {
  showSavedHotkey();
  hotkeyReleased = true;
  hotkeysMessage.textContent = `Restored the current hotkey: ${savedHotkeyCombo.join(' + ')}`;
});

function hotkeyName(event) {
  if (event.key === ' ') return 'Space';
  if (event.key === 'Control') return 'Ctrl';
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

function comboNodes(combo) {
  const nodes = [];
  combo.forEach((name, i) => {
    if (i > 0) nodes.push(document.createTextNode(' + '));
    if (name === 'Space') return nodes.push(spaceKeyTemplate.cloneNode(true));
    if (name === 'Shift') return nodes.push(shiftKeyTemplate.cloneNode(true));
    if (name === 'Backspace') return nodes.push(backspaceKeyTemplate.cloneNode(true));
    if (name === 'Enter') return nodes.push(enterTemplate.cloneNode(true));
    const span = document.createElement('span');
    span.textContent = name;
    nodes.push(span);
  });
  return nodes;
}

function updateWideKeys(container) {
  container.querySelectorAll(':scope > span:not(.spaceKey)').forEach((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    // Inner width excludes the 1px borders.
    span.classList.toggle('wide', span.textContent === 'Enter' || range.getBoundingClientRect().width > span.clientWidth);
  });
}

const welcomeHotkey = document.querySelector('.welcome-shortcutKeys .shortcutKeys');

function renderWelcomeHotkey() {
  const desc = welcomeHotkey.querySelector('.shortcutKeys-desc');
  welcomeHotkey.replaceChildren(...comboNodes(savedHotkeyCombo), desc);
  // Measuring needs a visible element; updateWelcome() and the Welcome Screen button re-measure when shown.
  updateWideKeys(welcomeHotkey);
}

function renderHotkeyCombo() {
  hotkeys.replaceChildren(...comboNodes(hotkeyCombo));
  updateWideKeys(hotkeys);
}

function isHotkeyRecording() {
  return !settingsPanel.hidden && settingItems[1].classList.contains('active');
}

// Capture phase so Escape is recorded instead of hiding the window.
window.addEventListener('keydown', (event) => {
  if (!isHotkeyRecording()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (hotkeyReleased) {
    hotkeyCombo = [];
    hotkeyReleased = false;
  }
  const name = hotkeyName(event);
  if (!hotkeyCombo.includes(name)) hotkeyCombo.push(name);
  renderHotkeyCombo();
  btnHotkeysSave.disabled = true;
  hotkeysMessage.textContent = 'Recording...';
}, true);

window.addEventListener('keyup', (event) => {
  if (!isHotkeyRecording() || hotkeyReleased) return;
  event.preventDefault();
  hotkeyReleased = true;
  if (hotkeyCombo.length < 2) {
    hotkeysMessage.textContent = 'Invalid: a single key is not allowed. Combine a modifier (Ctrl, Alt or Shift) with another key.';
  } else if (!MODIFIERS.includes(hotkeyCombo[0])) {
    hotkeysMessage.textContent = 'Invalid: the first key must be Ctrl, Alt or Shift.';
  } else {
    hotkeysMessage.textContent = `Valid combination: ${hotkeyCombo.join(' + ')}. Click Save to apply it.`;
    btnHotkeysSave.disabled = hotkeyCombo.join('+') === savedHotkeyCombo.join('+');
  }
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!keywordInput.value.trim()) return window.electronAPI.hideToTray();

  event.preventDefault();
  event.stopPropagation();
  keywordInput.value = '';
  keywordInput.dispatchEvent(new Event('input', { bubbles: true }));
  clearTimeout(debounceTimer);
  runSearch();
  keywordInput.focus();
});
keywordInput.addEventListener('input', () => {
  updateKeywordHighlight();
  settingsPanel.hidden = true;
  welcomePinned = false;
  updateWelcome();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 150);
});
keywordInput.addEventListener('scroll', () => {
  keywordHighlight.scrollLeft = keywordInput.scrollLeft;
});
updateKeywordHighlight();
brandMark.addEventListener('click', () => {
  welcomePinned = false;
  settingsPanel.hidden = !settingsPanel.hidden;
  fileList.hidden = !settingsPanel.hidden || fileList.childElementCount === 0;
  updateWelcome();
  if (!settingsPanel.hidden) {
    updateIndexAmount();
    updateDiskUsage();
  }
});
