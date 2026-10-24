// Text recognition (OCR) for scanned PDFs and images with the OCR engine built into Windows
// (Windows.Media.Ocr). PDF pages are rendered with Windows.Data.Pdf. Everything runs this computer.
// The WinRT APIs are reached through one long-lived Windows PowerShell 5.1 process, which reads one
// request per line on stdin and answers one line on stdout. Paths and text are sent as base64.
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const MAX_OCR_PAGES = 50;
const STARTUP_TIMEOUT_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// The PowerShell process is closed after this long without requests to free its memory.
const IDLE_EXIT_MS = 60 * 1000;
// Thumbnail pixel size; the result list shows it at half size for high-DPI screens.
const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_HEIGHT = 160;
const MAX_THUMBNAIL_UPSCALE = 2;
const MAX_CACHED_THUMBNAILS = 200;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$asTaskOperation = $asTaskMethods | Where-Object { $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation?1' } | Select-Object -First 1
$asTaskAction = $asTaskMethods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1

function Wait-Operation($operation, [Type]$resultType) {
  $task = $asTaskOperation.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $null = $task.Wait(-1)
  return $task.Result
}

function Wait-Action($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  $null = $task.Wait(-1)
}

$utf8 = New-Object System.Text.UTF8Encoding $false
$newLine = [string][char]10

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  foreach ($language in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -ne $engine) { break }
  }
}
if ($null -eq $engine) {
  [Console]::Out.WriteLine('unavailable')
  [Console]::Out.Flush()
  exit
}

$maxDimension = [double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
# PDF pages are rendered at 2.5 times 96 DPI (240 DPI), which suits OCR.
$pdfRenderScale = 2.5
$tab = [string][char]9

# Thumbnails rely on this giving the same pixel size every time a page is read.
function Get-FrameBitmap($frame) {
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  $scale = [Math]::Min(1.0, $maxDimension / [Math]::Max(1.0, [Math]::Max($frame.PixelWidth, $frame.PixelHeight)))
  if ($scale -lt 1.0) {
    $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($frame.PixelWidth * $scale))
    $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($frame.PixelHeight * $scale))
  }
  return Wait-Operation ($frame.GetSoftwareBitmapAsync(
    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
    $transform,
    [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
}

function Get-PdfPageBitmap($document, $index) {
  $page = $document.GetPage([uint32]$index)
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  try {
    $size = $page.Size
    $scale = [Math]::Min($pdfRenderScale, $maxDimension / [Math]::Max(1.0, [Math]::Max($size.Width, $size.Height)))
    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $options.DestinationWidth = [uint32][Math]::Max(1, [Math]::Floor($size.Width * $scale))
    $options.DestinationHeight = [uint32][Math]::Max(1, [Math]::Floor($size.Height * $scale))
    Wait-Action ($page.RenderToStreamAsync($stream, $options))
    $decoder = Wait-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $frame = Wait-Operation ($decoder.GetFrameAsync([uint32]0)) ([Windows.Graphics.Imaging.BitmapFrame])
    return Get-FrameBitmap $frame
  } finally {
    $stream.Dispose()
    $page.Dispose()
  }
}

function Open-File($filePath) {
  return Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($filePath)) ([Windows.Storage.StorageFile])
}

function Open-Pdf($filePath) {
  return Wait-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync((Open-File $filePath))) ([Windows.Data.Pdf.PdfDocument])
}

function Open-Stream($filePath) {
  return Wait-Operation ((Open-File $filePath).OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
}

function Open-Decoder($stream) {
  return Wait-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
}

# Writes a "P page width height" record, then a "W line x y width height text" record per word.
function Read-Bitmap($bitmap, $index) {
  try {
    $result = Wait-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    @('P', $index, $bitmap.PixelWidth, $bitmap.PixelHeight) -join $tab
    $lineIndex = 0
    foreach ($line in $result.Lines) {
      foreach ($word in $line.Words) {
        $box = $word.BoundingRect
        @('W', $lineIndex, [int][Math]::Round($box.X), [int][Math]::Round($box.Y),
          [int][Math]::Round($box.Width), [int][Math]::Round($box.Height), $word.Text) -join $tab
      }
      $lineIndex++
    }
  } finally {
    $bitmap.Dispose()
  }
}

function Read-Image($filePath, $maxPages) {
  $stream = Open-Stream $filePath
  try {
    $decoder = Open-Decoder $stream
    # Multi-page TIFF files have one frame per page.
    $count = [Math]::Min([int]$decoder.FrameCount, $maxPages)
    for ($i = 0; $i -lt $count; $i++) {
      $frame = Wait-Operation ($decoder.GetFrameAsync([uint32]$i)) ([Windows.Graphics.Imaging.BitmapFrame])
      Read-Bitmap (Get-FrameBitmap $frame) $i
    }
  } finally {
    $stream.Dispose()
  }
}

function Read-Pdf($filePath, $maxPages) {
  $document = Open-Pdf $filePath
  $count = [Math]::Min([int]$document.PageCount, $maxPages)
  for ($i = 0; $i -lt $count; $i++) {
    Read-Bitmap (Get-PdfPageBitmap $document $i) $i
  }
}

function Get-PageBitmap($filePath, $kind, $index) {
  if ($kind -eq 'pdf') { return Get-PdfPageBitmap (Open-Pdf $filePath) $index }
  $stream = Open-Stream $filePath
  try {
    $frame = Wait-Operation ((Open-Decoder $stream).GetFrameAsync([uint32]$index)) ([Windows.Graphics.Imaging.BitmapFrame])
    return Get-FrameBitmap $frame
  } finally {
    $stream.Dispose()
  }
}

# Returns a base64 PNG of the crop rectangle (in page bitmap pixels), scaled to outWidth x outHeight.
function Get-Thumbnail($filePath, $kind, $index, [double]$x, [double]$y, [double]$width, [double]$height, [double]$outWidth, [double]$outHeight) {
  $bitmap = Get-PageBitmap $filePath $kind $index
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  try {
    $encoder = Wait-Operation ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync(
      [Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId, $stream)) ([Windows.Graphics.Imaging.BitmapEncoder])
    $encoder.SetSoftwareBitmap($bitmap)
    $scale = $outWidth / $width
    [double]$scaledWidth = [Math]::Max(1.0, [Math]::Round($bitmap.PixelWidth * $scale))
    [double]$scaledHeight = [Math]::Max(1.0, [Math]::Round($bitmap.PixelHeight * $scale))
    $transform = $encoder.BitmapTransform
    $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    $transform.ScaledWidth = [uint32]$scaledWidth
    $transform.ScaledHeight = [uint32]$scaledHeight
    # Bounds are in scaled pixels.
    $bounds = New-Object Windows.Graphics.Imaging.BitmapBounds
    $bounds.X = [uint32][Math]::Min($scaledWidth - 1.0, [Math]::Floor($x * $scale))
    $bounds.Y = [uint32][Math]::Min($scaledHeight - 1.0, [Math]::Floor($y * $scale))
    $bounds.Width = [uint32][Math]::Max(1.0, [Math]::Min($outWidth, $scaledWidth - [double]$bounds.X))
    $bounds.Height = [uint32][Math]::Max(1.0, [Math]::Min($outHeight, $scaledHeight - [double]$bounds.Y))
    $transform.Bounds = $bounds
    Wait-Action ($encoder.FlushAsync())
    $memory = New-Object System.IO.MemoryStream
    [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0)).CopyTo($memory)
    return [Convert]::ToBase64String($memory.ToArray())
  } finally {
    $stream.Dispose()
    $bitmap.Dispose()
  }
}

function Write-Response($id, $status, $text) {
  [Console]::Out.WriteLine($id + ' ' + $status + ' ' + [Convert]::ToBase64String($utf8.GetBytes([string]$text)))
  [Console]::Out.Flush()
}

[Console]::Out.WriteLine('ready ' + $engine.RecognizerLanguage.LanguageTag)
[Console]::Out.Flush()

# ReadLine returns null when the app closes stdin or exits, which ends this process.
while ($null -ne ($request = [Console]::In.ReadLine())) {
  $parts = $request.Split(' ')
  try {
    $filePath = $utf8.GetString([Convert]::FromBase64String($parts[2]))
    if ($parts[1] -eq 'thumb') {
      $text = Get-Thumbnail $filePath $parts[3] ([int]$parts[4]) $parts[5] $parts[6] $parts[7] $parts[8] $parts[9] $parts[10]
    } elseif ($parts[1] -eq 'pdf') {
      $text = (Read-Pdf $filePath ([int]$parts[3])) -join $newLine
    } else {
      $text = (Read-Image $filePath ([int]$parts[3])) -join $newLine
    }
    Write-Response $parts[0] 'ok' $text
  } catch {
    Write-Response $parts[0] 'error' $_.Exception.Message
  }
}
`;

// False once Windows OCR turned out to be missing, e.g. no OCR language installed.
let available = process.platform === 'win32';
let engine = null;
let queue = Promise.resolve();
let nextId = 1;
let idleTimer = null;
let wordSeparator = ' ';
const thumbnailCache = new Map();

function startEngine() {
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  const child = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });

  const waiters = [];
  const state = { child, exited: false };
  const stop = (reason) => {
    state.exited = true;
    if (engine === state) engine = null;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(reason));
  };

  readline.createInterface({ input: child.stdout }).on('line', (line) => waiters.shift()?.resolve(line));
  child.on('error', (error) => stop(error.message));
  child.on('exit', () => stop('The OCR process stopped.'));
  // Writing to a process that just exited raises EPIPE; the exit handler already failed the request.
  child.stdin.on('error', () => {});

  state.nextLine = (timeoutMs) => new Promise((resolve, reject) => {
    if (state.exited) {
      reject(new Error('The OCR process stopped.'));
      return;
    }
    const timer = setTimeout(() => {
      state.kill();
      reject(new Error('OCR timed out.'));
    }, timeoutMs);
    waiters.push({
      resolve: (line) => { clearTimeout(timer); resolve(line); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
  });
  state.kill = () => {
    if (!state.exited) child.kill();
    stop('The OCR process stopped.');
  };
  return state;
}

function scheduleIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!engine) return;
    engine.child.stdin.end();
    engine = null;
  }, IDLE_EXIT_MS);
  idleTimer.unref();
}

async function getEngine() {
  if (engine) return engine;
  const started = startEngine();
  let firstLine = null;
  try {
    firstLine = await started.nextLine(STARTUP_TIMEOUT_MS);
  } catch {
    // Treated as unavailable below.
  }
  if (!firstLine?.startsWith('ready')) {
    // Starting again for every file would only fail the same way.
    available = false;
    started.kill();
    return null;
  }
  // Japanese and Chinese results put a space between every word, which would break phrase searches.
  wordSeparator = /^(ja|zh)/i.test(firstLine.split(' ')[1] ?? '') ? '' : ' ';
  engine = started;
  return engine;
}

async function runRequest(args) {
  if (!available) return null;
  clearTimeout(idleTimer);
  try {
    const current = await getEngine();
    if (!current) return null;
    const id = nextId++;
    current.child.stdin.write(`${id} ${args}\n`);
    const [responseId, status, payload = ''] = (await current.nextLine(REQUEST_TIMEOUT_MS)).split(' ');
    if (Number(responseId) !== id) {
      current.kill();
      throw new Error('Unexpected OCR response.');
    }
    const text = Buffer.from(payload, 'base64').toString('utf8');
    if (status !== 'ok') throw new Error(text);
    return text;
  } finally {
    scheduleIdleExit();
  }
}

function request(args) {
  const result = queue.then(() => runRequest(args));
  queue = result.catch(() => {});
  return result;
}

const encodePath = (filePath) => Buffer.from(filePath, 'utf8').toString('base64');

// Builds the text from the word records, with each word's offset in it and its box on the page.
// `layout.words` is flat: page, start, end, x, y, width, height, for each word.
function parseRecognized(payload) {
  const pages = [];
  const words = [];
  let text = '';
  let previousLine = null;
  for (const record of payload.split('\n')) {
    const fields = record.split('\t');
    if (fields[0] === 'P') {
      pages[Number(fields[1])] = [Number(fields[2]), Number(fields[3])];
      previousLine = null;
      continue;
    }
    if (fields[0] !== 'W') continue;
    const word = fields.slice(6).join(' ').replace(/\s+/g, ' ').trim();
    if (!word) continue;
    const page = pages.length - 1;
    const line = `${page}:${fields[1]}`;
    const separator = !text ? '' : line === previousLine ? wordSeparator : ' ';
    previousLine = line;
    const start = text.length + separator.length;
    text += separator + word;
    words.push(page, start, text.length, ...fields.slice(2, 6).map(Number));
  }
  return { text, layout: { pages, words } };
}

// Returns { text, layout } for an image ('image') or a PDF's rendered pages ('pdf'),
// or null when Windows OCR isn't available. Throws when the file can't be read.
async function recognize(filePath, kind) {
  const payload = await request(`${kind} ${encodePath(filePath)} ${MAX_OCR_PAGES}`);
  return payload === null ? null : parseRecognized(payload);
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// A crop with the thumbnail's aspect ratio, centered on the match with a little context around it.
function cropAround({ pageWidth, pageHeight, box }) {
  const aspect = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  let height = box.height * 4;
  let width = Math.max(box.width + box.height * 4, height * aspect);
  height = Math.min(Math.max(height, width / aspect), pageHeight);
  width = Math.min(width, pageWidth);
  const x = Math.round(clamp(box.x + (box.width - width) / 2, 0, pageWidth - width));
  const y = Math.round(clamp(box.y + (box.height - height) / 2, 0, pageHeight - height));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(width), pageWidth - x)),
    height: Math.max(1, Math.min(Math.round(height), pageHeight - y))
  };
}

// `region` comes from FileIndex.ocrRegion. Returns { src, mark } where `mark` places the match on the
// thumbnail in percent, or null when Windows OCR isn't available.
async function renderMatchThumbnail(filePath, region) {
  const key = JSON.stringify([filePath, region.modifiedMs, region.page, region.box]);
  if (thumbnailCache.has(key)) return thumbnailCache.get(key);

  const crop = cropAround(region);
  const scale = Math.min(THUMBNAIL_WIDTH / crop.width, THUMBNAIL_HEIGHT / crop.height, MAX_THUMBNAIL_UPSCALE);
  const outWidth = Math.max(1, Math.round(crop.width * scale));
  const outHeight = Math.max(1, Math.round(crop.height * scale));
  const kind = path.extname(filePath).toLowerCase() === '.pdf' ? 'pdf' : 'image';
  const png = await request([
    'thumb', encodePath(filePath), kind, region.page,
    crop.x, crop.y, crop.width, crop.height, outWidth, outHeight
  ].join(' '));
  if (png === null) return null;

  const percent = (value, total) => Math.round(clamp(value / total, 0, 1) * 10000) / 100;
  const { box } = region;
  const thumbnail = {
    src: `data:image/png;base64,${png}`,
    mark: {
      left: percent(box.x - crop.x, crop.width),
      top: percent(box.y - crop.y, crop.height),
      width: percent(box.width, crop.width),
      height: percent(box.height, crop.height)
    }
  };
  thumbnailCache.set(key, thumbnail);
  if (thumbnailCache.size > MAX_CACHED_THUMBNAILS) thumbnailCache.delete(thumbnailCache.keys().next().value);
  return thumbnail;
}

module.exports = { recognize, renderMatchThumbnail };
