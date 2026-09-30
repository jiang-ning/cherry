const keywordInput = document.getElementById('keyword');
const searchButton = document.getElementById('search');
const cancelButton = document.getElementById('cancel');
const fileList = document.getElementById('fileList');

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let currentSearchId = 0;
let statusLine;
let indexStatus = null;

cancelButton.disabled = true;

function setStatus(message) {
  statusLine.textContent = message;
}

function describeIndex(status) {
  if (!status) return 'Index starting...';
  if (status.error) return `Index error: ${status.error}`;
  const parts = [`${status.indexed.toLocaleString()} files indexed in ${status.root}`];
  if (status.pending) {
    const note = status.initialIndexing
      ? ' (first-time indexing, newest files first)'
      : status.idle ? '' : ' (older files are indexed when the computer is idle)';
    parts.push(`${status.pending.toLocaleString()} waiting${note}`);
  }
  if (status.scanning) parts.push('checking for changes');
  return parts.join(' • ');
}

function showIdleStatus() {
  statusLine = document.createElement('div');
  statusLine.className = 'search-status';
  fileList.replaceChildren(statusLine);
  setStatus(describeIndex(indexStatus));
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
  header.append(name, modified);

  const location = document.createElement('div');
  location.className = 'file-path';
  location.textContent = `${file.path} • ${file.matchCount} ${file.matchCount === 1 ? 'match' : 'matches'}`;

  const preview = document.createElement('p');
  preview.className = 'file-preview';
  preview.append(highlightedPreview(file.preview, file.highlights));

  item.append(header, location, preview);
  return item;
}

function setSearching(isSearching) {
  searchButton.disabled = isSearching;
  cancelButton.disabled = !isSearching;
}

async function runSearch() {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    keywordInput.focus();
    return;
  }

  const searchId = ++currentSearchId;
  statusLine = document.createElement('div');
  statusLine.className = 'search-status';
  fileList.replaceChildren(statusLine);
  setStatus(`Searching for "${keyword}"…`);
  setSearching(true);

  try {
    const { results, limitReached, status } = await window.electronAPI.search(keyword);
    if (searchId !== currentSearchId) return;
    indexStatus = status;
    for (const file of results) fileList.append(renderFile(file));

    const details = [`${results.length} matched files`, describeIndex(status)];
    if (limitReached) details.push(`showing the ${results.length} most recently modified`);
    setStatus(details.join(` • `));
  } catch (error) {
    if (searchId === currentSearchId) setStatus(`Search failed: ${error.message}`);
  } finally {
    if (searchId === currentSearchId) setSearching(false);
  }
}

window.electronAPI.onIndexStatus((status) => {
  indexStatus = status;
  // Search summaries stay put; live index numbers are shown only before the first search.
  if (currentSearchId === 0) showIdleStatus();
});
window.electronAPI.getIndexStatus().then((status) => {
  indexStatus = status ?? indexStatus;
  if (currentSearchId === 0) showIdleStatus();
});

searchButton.addEventListener('click', runSearch);
keywordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runSearch();
});
cancelButton.addEventListener('click', () => {
  currentSearchId += 1;
  setSearching(false);
  setStatus('Search cancelled');
});
