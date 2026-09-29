# cherry

A desktop app that searches the contents of files in your Documents folder for a keyword. Each match shows the filename, last modified date and time, a content preview, and the keyword highlighted. Files are read on your computer and are not uploaded.

## Supported files

- **Word:** `.docx`
- **Excel:** `.xlsx`
- **PowerPoint:** `.pptx`
- **PDF:** `.pdf` (only PDFs that contain a text layer)
- **OpenDocument:** `.odt`, `.ods`, `.odp`
- **Rich Text:** `.rtf`
- **Text and notes:** `.txt`, `.md`, `.markdown`, `.log`
- **Data and config:** `.csv`, `.tsv`, `.json`, `.xml`, `.yaml`, `.yml`, `.ini`, `.cfg`, `.conf`, `.toml`, `.properties`
- **Web and source code:** `.html`, `.htm`, `.css`, `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, `.java`, `.c`, `.cpp`, `.h`, `.cs`, `.go`, `.rs`, `.rb`, `.sql`, `.sh`, `.ps1`, `bat`

## Limitations
- Documents (Word, Excel, PowerPoint, PDF, OpenDocument, RTF) up to 50MB are searched; text file stay at 5MB. Larger files are skipped.
- Older `.doc`, `.xls`, and `.ppt` formats aren't supported.
- Scanned PDFs without a text layer won't match, because text recognition (OCR) is not used.
- Password-protected documents can't be read and are counted as unreadable.
- Text files are read as UTF-8; files in other encodings may not match.
- Only the Documents folder is searched. The `node_modules`, `.git`, `.svn`, `$Recycle.Bin`, and `System Volume Information` folders are skipped, as are Office's temporary `~$` files.
- Matching is a case-insensitive, literal phrase. A search returns at most the 500 most recently modified matching files.
- Search reads a local SQLite index, not the files themselves, so new or changed files appear only after they are indexed. Files changed in the last 7 days are indexed first; older files are indexed only after the computer has been idle for a minute. The folder is re-checked every 10 minutes while the app is open.
- Up to 2 million characters of text are indexed per file; matches beyond that aren't found.
- Case-insensitive matching covers English letters fully; for other alphabets, the match count and highlight may miss differently-cased occurrences.

## Development

```sh
npm install
npm start
```

`better-sqlite3` is a native module, and Electron Forge compiles it for Electron during `npm start` and `npm run make`. On Windows, this needs Python and the Visual Studio C++ build tools if no prebuilt binary is available.
