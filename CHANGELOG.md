# Changelog

## [Unreleased]

### Supported files
- Email files (`.eml` and Outlook `.msg`): the subject, sender, recipients, body, and attachment names and contents are searched.
- ZIP archives (`.zip`): the names and contents of the files inside are searched, including archives and emails nested up to 3 levels deep.
- 7-ZIP (`.7z`), RAR (`.rar`, RAR 4 and RAR 5), tar (`.tar`) and gzip (`.tgz`, `.tar.gz`, `.gz`) archives are searched the same way as ZIP archives. A `.gz` file that isn't tar archive is searched as the file it contains.
- Text recognition (OCR) for scanned PDFs and images (`.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`), using Tesseract (tesseract.js). OCR runs on your computer with language data that ships with the app or that you choose to download; your files are never uploaded. Previously skipped scanned PDFs are indexed again automatically.
- Choose the languages text recognition reads in Settings > Search: add languages from the available list to the selected list. English is always included and the app language is added by default. The app languages' data ships with the app; any of the other 100+ Tesseract languages is downloaded once when you add it. Changing the languages reads scanned files again.
- Search results for scanned PDFs and images show a thumbnail of the part of the page where the match was recognized, with the match highlighted.

- Existing installs get the new extensions added to the indexed file extensions automatically.

## [1.0.0] - 2026-10-19

First public release of CherryQuery, a desktop app that searches inside the files in your Documents folder. Files are read and indexed on your computer and are never uploaded.

### Search
- Search file contents by keyword. Each result shows the file name, last modified date and time, and a content preview with matches highlighted.
- Combine terms with the `AND`, `OR` and `NOT` operators. Operators are highlighted as you type.
- Put a term in double quotes (`"term"`) to match whole words only.
- Optional case-sensitive matching.
- Optional file name search, so files whose names match are also shown.
- Configurable maximum number of results (500 by default). Results are sorted with the most recently modified files first.
- Open a matching file, or its containing folder, from the results list.

### Supported files
- Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`) and PDF files with a text layer.
- OpenDocument (`.odt`, `.ods`, `.odp`) and Rich Text (`.rtf`).
- Plain text, data, configuration, web and source code files. See [README.md](README.md#supported-files) for the full list.

### Indexing
- Local SQLite index for fast searches.
- Files changed in the last 7 days are indexed first. Older files are indexed after the computer has been idle for a minute.
- The indexed folders are checked again every 10 minutes while the app is open.
- Choose which folder to index and which file extensions to include.
- Set a maximum file size to index.
- Pause and resume indexing, or clear the index.
- Settings show the number or indexed files, the disk space the index uses, and where the index database is stored.

### App
- Show or hide the search window from anywhere with a global hotkey (`Ctrl+Shift+Space` by default), which you can change in Settings.
- Runs in the system tray, with an option to start when you sign in.
- Welcome screen on first run.
- Light, dark and system (auto) themes.
- Interface available in Arabic, Chinese, English, French, German, Italian, Japanese and Spanish.
- Animated logo with eyes that follow your pointer.
- Windows installer with a splash screen and a desktop shortcut.

### Know limitations
- Older `.doc`, `.xls` and `.ppt` files, scanned PDFs without a text layer, and password-protected documents can't be searched.
- Text files are read as UTF-8.
- New or changed files appear in results only after they are indexed.
- See [README.md](README.md#limitations) for details.

[1.0.0]: https://github.com/jiang-ning/cherry/releases/tag/v1.0.0
