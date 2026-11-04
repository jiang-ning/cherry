// Meaning-based search. A small multilingual embedding model turns file text and queries into vectors,
// so "invoice from last spring" also finds a bill from April that never says "invoice".
// The model runs on this computer with ONNX Runtime; the main process downloads it once (see index.js).
const MODEL_ID = 'Xenova/multilingual-e5-small';
// Small files first, so download progress mostly follows the model file.
const MODEL_FILES = ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'];
// Only the start of a file is embedded; it usually says what the document is about.
const CHUNK_CHARS = 800;
const MAX_CHUNKS = 6;

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];
// Start month of each (northern hemisphere) season; seasons last three months.
const SEASONS = { spring: 2, summer: 5, autumn: 8, fall: 8, winter: 11 };
const PREP = '(?:(?<prep>from|in|during|since|of|on)\\s+)?';
const NAMES = [...Object.keys(SEASONS), ...MONTH_NAMES].join('|');

let extractor = null;

// `modelDir` holds MODEL_ID/<MODEL_FILES>; nothing is fetched from the network here.
async function loadModel(modelDir) {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelDir;
  env.useFSCache = false;
  const loaded = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', local_files_only: true });
  await unloadModel();
  extractor = loaded;
}

async function unloadModel() {
  const previous = extractor;
  extractor = null;
  await previous?.dispose?.();
}

async function embed(texts) {
  if (!extractor) throw new Error('The AI model is not loaded.');
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const size = output.dims.at(-1);
  return texts.map((_, i) => output.data.slice(i * size, (i + 1) * size));
}

// Stored as int8 with a per-vector scale: a quarter of the size of float32 at nearly the same ranking.
function quantize(vector) {
  let max = 0;
  for (const value of vector) max = Math.max(max, Math.abs(value));
  const scale = max ? 127 / max : 1;
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) bytes[i] = Math.round(vector[i] * scale);
  return { vector: Buffer.from(bytes.buffer), scale };
}

// Cosine similarity, since both vectors are normalized.
function similarity(query, blob, scale) {
  const vector = new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  let dot = 0;
  for (let i = 0; i < vector.length; i += 1) dot += query[i] * vector[i];
  return dot / scale;
}

function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + CHUNK_CHARS / 2) end = space;
    }
    chunks.push({ start, length: end - start });
    start = text[end] === ' ' ? end + 1 : end;
  }
  return chunks;
}

// Returns [{ start, length, vector, scale }] for the start of `text`. The e5 model expects these prefixes.
async function embedPassages(name, text) {
  const chunks = chunkText(text);
  const vectors = await embed(chunks.map(({ start, length }) => `passage: ${name}\n${text.slice(start, start + length)}`));
  return chunks.map((chunk, i) => ({ ...chunk, ...quantize(vectors[i]) }));
}

async function embedQuery(query) {
  const [vector] = await embed([`query: ${query}`]);
  return vector;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOf(date, unit) {
  if (unit === 'week') {
    const day = startOfDay(date);
    day.setDate(day.getDate() - ((date.getDay() + 6) % 7));
    return day;
  }
  if (unit === 'month') return new Date(date.getFullYear(), date.getMonth(), 1);
  return new Date(date.getFullYear(), 0, 1);
}

function shift(date, unit, count) {
  const shifted = new Date(date);
  if (unit === 'day') shifted.setDate(shifted.getDate() + count);
  else if (unit === 'week') shifted.setDate(shifted.getDate() + 7 * count);
  else if (unit === 'month') shifted.setMonth(shifted.getMonth() + count);
  else shifted.setFullYear(shifted.getFullYear() + count);
  return shifted;
}

// The latest period starting at `month` that has begun; with `last`, the latest one that has ended.
function namedPeriod(month, months, last, year, now) {
  const span = (startYear) => [new Date(startYear, month, 1), new Date(startYear, month + months, 1)];
  if (year) return span(year);
  let startYear = new Date(now.getFullYear(), month, 1) > now ? now.getFullYear() - 1 : now.getFullYear();
  if (last && span(startYear)[1] > now) startYear -= 1;
  return span(startYear);
}

const TIME_PATTERNS = [
  {
    pattern: new RegExp(`\\b${PREP}(?:the\\s+)?(?:last|past)\\s+(?<count>\\d{1,3})\\s+(?<unit>day|week|month|year)s?\\b`, 'i'),
    range: ({ count, unit }, now) => [shift(now, unit.toLowerCase(), -Number(count)), now]
  },
  {
    pattern: new RegExp(`\\b${PREP}(?<day>today|yesterday)\\b`, 'i'),
    range: ({ day }, now) => {
      const today = startOfDay(now);
      return day.toLowerCase() === 'today' ? [today, now] : [shift(today, 'day', -1), today];
    }
  },
  {
    pattern: new RegExp(`\\b${PREP}(?<which>this|last|past|previous)\\s+(?<unit>week|month|year)\\b`, 'i'),
    range: ({ which, unit }, now) => {
      const start = startOf(now, unit.toLowerCase());
      return which.toLowerCase() === 'this' ? [start, now] : [shift(start, unit.toLowerCase(), -1), start];
    }
  },
  {
    pattern: new RegExp(`\\b${PREP}(?:(?<which>this|last|past|previous)\\s+)?(?<name>${NAMES})(?:\\s+(?:of\\s+)?(?<year>(?:19|20)\\d{2}))?\\b`, 'i'),
    range: ({ prep, which, name, year }, now) => {
      // A bare "may", "march" or "fall" is usually not a date.
      if (!prep && !which && !year) return null;
      const key = name.toLowerCase();
      const season = Object.hasOwn(SEASONS, key);
      const month = season ? SEASONS[key] : MONTH_NAMES.indexOf(key);
      const last = Boolean(which) && which.toLowerCase() !== 'this';
      return namedPeriod(month, season ? 3 : 1, last, year && Number(year), now);
    }
  },
  {
    pattern: new RegExp(`\\b${PREP}(?<year>(?:19|20)\\d{2})\\b`, 'i'),
    range: ({ year }) => [new Date(Number(year), 0, 1), new Date(Number(year) + 1, 0, 1)]
  }
];

// Splits an English time phrase off the query: "invoice from last spring" gives topic "invoice" and
// the modified-time range of last spring as { from, to } in ms (`to` exclusive), or null bounds.
function parseTimeQuery(query, now = new Date()) {
  for (const { pattern, range } of TIME_PATTERNS) {
    const match = pattern.exec(query);
    const found = match && range(match.groups, now);
    if (!found) continue;
    const to = match.groups.prep?.toLowerCase() === 'since' ? now : found[1];
    const topic = `${query.slice(0, match.index)} ${query.slice(match.index + match[0].length)}`;
    return { topic: topic.replace(/\s+/g, ' ').trim(), from: found[0].getTime(), to: to.getTime() };
  }
  return { topic: query.trim(), from: null, to: null };
}

module.exports = {
  MODEL_ID,
  MODEL_FILES,
  embedPassages,
  embedQuery,
  loadModel,
  parseTimeQuery,
  similarity,
  unloadModel
};
