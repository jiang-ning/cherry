# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

The author takes security bugs in CherryQuery seriously. I appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/jiang-ning/cherry/security/advisories/new) tab. Please do not report security vulnerabilities through public GitHub issues.

Because CherryQuery reads and indexes the contents of local files, reports involving the following are especially welcome:

- Access to files or folders outside the locations the user chose to index.
- Leakage of indexed content or search queries off the device.
- Code execution through crafted documents (for example `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.odt`, or `.rtf` files).
- Weaknesses in the Electron renderer, preload script, or IPC handlers.

The author will send a response indicating the next steps in handling your report. After the initial reply to your report, I will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

Report security bugs in third-party modules (such as Electron, `better-sqlite3`, or `officeparser`) to the person or team maintaining the module. You can also report a vulnerability through the [npm contact form](https://www.npmjs.com/support) by selecting "I'm reporting a security vulnerability".
