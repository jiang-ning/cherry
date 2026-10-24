# cherry

A desktop app that searches the contents of files in your Documents folder for a keyword. Each match shows the filename, last modified date and time, a content preview, and the keyword highlighted. Files are read on your computer and are not uploaded.

## Supported files

- **Word:** `.docx`
- **Excel:** `.xlsx`
- **PowerPoint:** `.pptx`
- **PDF:** `.pdf`. On Windows, scanned PDFs without a text layer are read with text recognition (OCR).
- **Images (Windows only):** `.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`. Text in images and scans, including every page of a multi-page TIFF, is read with text recognition (OCR).
- **OpenDocument:** `.odt`, `.ods`, `.odp`
- **Rich Text:** `.rtf`
- **Email:** `.eml`, `.msg` (Outlook). The subject, sender, recipients, message body, and the names and contents of attachments are searched.
- **Archives:** `.zip`, `.7z`, `.rar` (RAR 4 and RAR 5), `.tar`, `.tgz`, `.tar.gz`, and `.gz`. The names and contents of the files inside are searched. A `.gz` file that isn't a tar archive, such as `report.txt.gz`, is searched as the file it contains.
- **Text and notes:** `.txt`, `.md`, `.markdown`, `.log`
- **Data and config:** `.csv`, `.tsv`, `.json`, `.xml`, `.yaml`, `.yml`, `.ini`, `.cfg`, `.conf`, `.toml`, `.properties`
- **Web and source code:** `.html`, `.htm`, `.css`, `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, `.java`, `.c`, `.cpp`, `.h`, `.cs`, `.go`, `.rs`, `.rb`, `.sql`, `.sh`, `.ps1`, `bat`

## Limitations
- Documents (Word, Excel, PowerPoint, PDF, OpenDocument, RTF) up to 50MB are searched; text file stay at 5MB. Larger files are skipped.
- Older `.doc`, `.xls`, and `.ppt` formats aren't supported.
- Email attachments and files inside archives are searched only when their extension is in the indexed file extensions list and they are within the maximum file size. Archives and emails inside each other are opened up to 3 levels deep, and up to 1,000 files are read from each archive. A match opens the email or archive, not the attachment or file inside it.
- Encrypted ZIP archives, and ZIP archives that use compression other than Deflate, can't be read; only the names of the files inside are searched. Encrypted files inside 7z and RAR archives are searched by name only, and 7z and RAR archives with encrypted file names can't be read at all.
- Text recognition (OCR) uses the OCR engine built into Windows (`Windows.Media.Ocr`), so it runs on your computer and nothing is uploaded. It reads text in the first Windows display language that has OCR installed; add an OCR language in Windows Settings > Time & language > Language & region if none is installed. A PDF is OCR'd when its text layer has fewer than 100 characters. Up to 50 pages are read from each scanned PDF or TIFF. Images and scanned PDFs inside emails and archives aren't OCR'd. OCR isn't available on macOS or Linux.
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
