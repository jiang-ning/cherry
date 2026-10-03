const keywordInput = document.getElementById('keyword');
const fileList = document.getElementById('fileList');

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let currentSearchId = 0;
let statusLine;
let indexStatus = null;

let debounceTimer;

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
  header.append(name);

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

    const details = [`${results.length} matched files`, describeIndex(status)];
    if (limitReached) details.push(`showing the ${results.length} most recently modified`);
    showResults(details.join(` • `), results.map(renderFile));
  } catch (error) {
    if (searchId === currentSearchId) showResults(`Search failed: ${error.message}`, []);
  }
}

// Swap content in one step; the previous list stays visible until then, so the window never collapses between searches.
function showResults(summary, items) {
  statusLine = document.createElement('div');
  statusLine.className = 'search-status';
  statusLine.textContent = summary;
  fileList.replaceChildren(statusLine, ...items);
  if (fileList.hidden) {
    fileList.classList.add('reveal');
    fileList.hidden = false;
    setTimeout(() => fileList.classList.remove('reveal'), 250);
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

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.electronAPI.hideToTray();
});
keywordInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 150);
});
