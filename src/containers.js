// Text extraction for files that contain other files: emails (.eml, .msg) and archives
// (.zip, .7z, .rar, .tar, .tgz, .gz).
// Each reader takes a `readNested(name, bytes)` callback that returns the text of an attachment
// or archive entry, or null when it is unsupported or unreadable.
const path = require('node:path');

const MAX_ARCHIVE_ENTRIES = 1000;
// Archive entries are decompressed in batches of about this many bytes, yielding in between.
const ARCHIVE_BATCH_BYTES = 16 * 1024 * 1024;
// WebAssembly memory never shrinks, so the libarchive module is replaced once it grows past this.
const ARCHIVE_HEAP_LIMIT = 128 * 1024 * 1024;
const NAMES_PER_YIELD = 256;
const GZIP_CHUNK_BYTES = 1024 * 1024;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

let fflate;
let PostalMime;
let MsgReader;
let libarchive;
let archiveModule = null;
let archiveModuleUsers = 0;

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code[0] !== '#') return HTML_ENTITIES[code.toLowerCase()] ?? entity;
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10FFFF ? String.fromCodePoint(point) : ' ';
    });
}

function formatAddress(name, address) {
  if (name && address && name !== address) return `${name} <${address}>`;
  return name || address || '';
}

// `html` is a string or bytes. `context.readHtml` gives the best text; the regex version is a fallback.
async function readHtmlBody(html, context) {
  try {
    return await context.readHtml(html);
  } catch {
    return htmlToText(typeof html === 'string' ? html : new TextDecoder().decode(html));
  }
}

// Joins parts until the character budget is used up.
class TextCollector {
  constructor(maxChars) {
    this.parts = [];
    this.length = 0;
    this.maxChars = maxChars;
  }

  get full() {
    return this.length >= this.maxChars;
  }

  add(...values) {
    for (const value of values) {
      if (!value || this.null) continue;
      this.parts.push(value);
      this.length += value.length + 1;
    }
  }

  text() {
    return this.parts.join('\n');
  }
}

async function addAttachment(collector, name, bytes, readNested) {
  if (collector.full) return;
  collector.add(name, bytes ? await readNested(name, bytes) : null);
  await yieldToEventLoop();
}

async function readEmlText(buffer, context, readNested) {
  PostalMime ??= require('postal-mime').default;
  const email = await PostalMime.parse(buffer, { attachmentEncoding: 'arraybuffer' });
  const collector = new TextCollector(context.maxChars);
  const addresses = (list) => (list ?? [])
    .flatMap((item) => (item.group ? item.group : [item]))
    .map((item) => formatAddress(item.name, item.address))
    .filter(Boolean)
    .join('; ');

  collector.add(
    email.subject && `Subject: ${email.subject}`,
    email.from && `From: ${formatAddress(email.from.name, email.from.address)}`,
    email.to?.length && `To: ${addresses(email.to)}`,
    email.cc?.length && `Cc: ${addresses(email.cc)}`,
    email.text || (email.html && await readHtmlBody(email.html, context))
  );

  for (const attachment of email.attachment ?? []) {
    const isMessage = attachment.mimeType === 'message/rfc822';
    let name = attachment.filename;
    if (!name && !isMessage) continue;
    if (isMessage && path.extname(name ?? '').toLowerCase() !== '.eml') name = `${name ?? 'message'}.eml`;
    await addAttachment(collector, name, new Uint8Array(attachment.content), readNested);
  }
  return collector.text();
}

async function readMsgText(buffer, context, readNested) {
  MsgReader ??= require('@kenjiuno/msgreader').default;
  const reader = new MsgReader(new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  const message = reader.getFileData();
  if (message.error) throw new Error(message.error);
  const collector = new TextCollector(context.maxChars);

  const addMessage = async (fields, depth) => {
    const recipients = (type) => (fields.recipients ?? [])
      .filter((recipient) => recipient.recipType === type)
      .map((recipient) => formatAddress(recipient.name, recipient.email))
      .filter(Boolean)
      .join('; ');
    const to = recipients('to');
    const cc = recipients('cc');
    collector.add(
      fields.subject && `Subject: ${fields.subject}`,
      (fields.senderName || fields.senderEmail) && `From: ${formatAddress(fields.senderName, fields.senderEmail)}`,
      to && `To: ${to}`,
      cc && `Cc: ${cc}`,
      fields.body || (fields.bodyHtml && await readHtmlBody(fields.bodyHtml, context))
        || (fields.html && await readHtmlBody(fields.html, context))
    );

    for (const attachment of fields.attachments ?? []) {
      // Hidden attachments are images embeded in the HTML body.
      if (collector.full || attachment.attachmentHidden) continue;
      const name = attachment.fileName || attachment.fileNameShort || attachment.name;
      if (attachment.innerMsgContent) {
        collector.add(name);
        if (attachment.innerMsgContentFields && depth < context.maxDepth) {
          await addMessage(attachment.innerMsgContentFields, depth + 1);
        }
        continue;
      }
      if (!name) continue;
      let content = null;
      try {
        content = reader.getAttachment(attachment).content;
      } catch {
        // An unreadable attachment still has its name indexed.
      }
      await addAttachment(collector, name, content, readNested);
    }
  };

  await addMessage(message, context.depth);
  return collector.text();
}

function unzipEntries(buffer, names) {
  try {
    return fflate.unzipSync(buffer, { filter: (file) => names.has(file.name) });
  } catch {
    // One corrupt or encrypted entry fails the whole batch, so retry the entries one at a time.
    const files = {};
    for (const name of names) {
      try {
        Object.assign(files, fflate.unzipSync(buffer, { filter: (file) => file.name === name }));
      } catch {
        // Skip the unreadable entry.
      }
    }
    return files;
  }
}

async function readZipText(buffer, context, readNested, isSupported) {
  fflate ??= require('fflate');
  const wanted = [];
  const otherNames = [];
  // Returning false from the filter lists the entries without decompressing them.
  fflate.unzipSync(buffer, {
    filter: (file) => {
      if (file.name.endWith('/') || file.name.startWith('__MACOSX/')) return false;
      const readable = (file.compression === ZIP_STORED || file.compression === ZIP_DEFLATED)
        && file.originalSize > 0 && file.originalSize <= context.maxBytes
        && isSupported(path.posix.basename(file.name));
      if (readable && wanted.length < MAX_ARCHIVE_ENTRIES) wanted.push(file);
      else otherNames.push(file.name);
      return false;
    }
  });

  const collector = new TextCollector(context, maxChars);
  let index = 0;
  while (index < wanted.length && !collector.full) {
    const batch = [];
    let bytes = 0;
    while (index < wanted.length && (!batch.length || bytes + wanted[index].originalSize <= ARCHIVE_BATCH_BYTES)) {
      bytes += wanted[index].originalSize;
      batch.push(wanted[index++].name);
    }
    const files = unzipEntries(buffer, new Set(batch));
    for (const name of batch) await addAttachment(collector, name, files[name], readNested);
  }
  // Entries that are not read are still searchable by name.
  collector.add(...wanted.slice(index).map((file) => file.name), ...otherNames);
  return collector.text();
}

async function acquireArchiveModule() {
  libarchive ??= require('libarchive-wasm');
  archiveModule ??= libarchive.libarchiveWasm();
  const pending = archiveModule;
  try {
    const module = await pending;
    archiveModuleUsers += 1;
    return module;
  } catch (error) {
    if (archiveModule === pending) archiveModule = null;
    throw error;
  }
}

// Nested archives share the module, so a large one is only replaced once nothing is using it.
// A module that failed may be in a broken state and is replaced straight away.
function releaseArchiveModule(module, failed) {
  archiveModuleUsers -= 1;
  const tooLarge = archiveModuleUsers === 0 && module.module.HEAP8.byteLength > ARCHIVE_HEAP_LIMIT;
  if (failed || tooLarge) archiveModule = null;
}

// Moves past an entry's data. Returns false when the archive can't be read any further.
function freeEntry(entry) {
  try {
    entry.free();
    return true;
  } catch {
    return false;
  }
}

// Reads 7-Zip, RAR (v4 and v5) and tar archives, including gzip-compressed tar, with libarchive.
async function readArchiveText(buffer, context, readNested, isSupported) {
  const module = await acquireArchiveModule();
  let failed = false;
  let reader = null;
  try {
    reader = new libarchive.ArchiveReader(module, new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    const collector = new TextCollector(context.maxChars);
    let readCount = 0;
    let namesSinceYield = 0;
    for (let entry = reader.nextEntry(); entry && !collector.full; entry = reader.nextEntry()) {
      const name = entry.getPathname();
      if (!name || entry.getFiletype() !== 'File' || name.startsWith('__MACOSX/')) {
        if (!freeEntry(entry)) break;
        continue;
      }
      const size = entry.getSize();
      const readable = readCount < MAX_ARCHIVE_ENTRIES && size > 0 && size <= context.maxBytes
        && !entry.isEncrypted() && isSupported(path.posix.basename(name));
      let bytes = null;
      if (readable) {
        readCount += 1;
        try {
          bytes = entry.readData() ?? null;
        } catch {
          // An entry with an unsupported compression method or damaged data is still searchable by name.
        }
      }
      if (!freeEntry(entry)) {
        collector.add(name);
        break;
      }
      if (bytes) {
        await addAttachment(collector, name, bytes, readNested);
      } else {
        collector.add(name);
        if (++namesSinceYield >= NAMES_PER_YIELD) {
          namesSinceYield = 0;
          await yieldToEventLoop();
        }
      }
    }
    return collector.text();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      reader?.free();
    } catch {
      failed = true;
    }
    releaseArchiveModule(module, failed);
  }
}

// Decompresses up to `limit` bytes. `complete` is false when the data is larger than that.
function gunzipLimited(buffer, limit) {
  fflate ??= require('fflate');
  const chunks = [];
  let length = 0;
  let complete = true;
  const gunzip = new fflate.Gunzip((chunk) => {
    if (!complete) return;
    if (length + chunk.length > limit) {
      complete = false;
      chunks.push(chunk.subarray(0, limit - length));
      length = limit;
      return;
    }
    chunks.push(chunk);
    length += chunk.length;
  });
  for (let offset = 0; offset < buffer.length && complete; offset += GZIP_CHUNK_BYTES) {
    gunzip.push(buffer.subarray(offset, offset + GZIP_CHUNK_BYTES), offset + GZIP_CHUNK_BYTES >= buffer.length);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, complete };
}

function isTar(bytes) {
  return bytes.length >= 262 && Buffer.from(bytes.buffer, bytes.byteOffset + 257, 5).toString('latin1') === 'ustar';
}

// A .tgz or .tar.gz file is a compressed tar archive; any other .gz file holds a single compressed
// file, such as report.txt.gz, which is read by the name it has without the .gz extension.
async function readGzipText(name, buffer, context, readNested, isSupported) {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith('.tgz') || lowerName.endsWith('.tar.gz')) {
    return readArchiveText(buffer, context, readNested, isSupported);
  }
  const { bytes, complete } = gunzipLimited(buffer, context.maxBytes);
  if (isTar(bytes)) return readArchiveText(buffer, context, readNested, isSupported);
  if (!complete) return null;
  return readNested(path.basename(name, path.extname(name)), bytes);
}

module.exports = { readEmlText, readMsgText, readZipText, readArchiveText, readGzipText };
