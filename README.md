# GST Filing Status Checker

A cross-platform desktop app (Electron) for bulk-checking GST return filing status.

## Features

- Reads a list of GSTINs from a CSV or Excel file (`.xlsx`, `.xls`, `.csv`)
- Logs into the GST API with captcha support (auto-retry on wrong captcha)
- Checks filing status for every GSTIN sequentially with gentle rate-limiting
- Supports GSTR1, GSTR3B, GSTR9, GSTR4 and both monthly/quarterly filer matching
- Exports results to Excel
- Emails non-filers via SMTP (Gmail App Password, plain SMTP, etc.)
- Persists all settings locally (except passwords)

---

## Requirements

- **Node.js 18+** (global `fetch` is used in the main process)
- npm 8+

---

## Quick Start

```bash
cd gst-filing-status-checker
npm install
npm start
```

---

## Input File Format

Your CSV or Excel file must have at least a **GSTIN** column (case-insensitive).
An optional **Email** (or **Mail**) column enables per-recipient defaulter emails.

| GSTIN              | Email               |
|--------------------|---------------------|
| 27AAAAA0000A1Z5    | client1@example.com |
| 29BBBBB1111B1Z3    |                     |
| 33CCCCC2222C1Z1    | client3@example.com |

---

## Financial Year Logic

| Selected Period  | FY Start Year Sent |
|------------------|--------------------|
| April – December | Selected year      |
| January – March  | Selected year − 1  |

Example: May 2026 → sends `financialYear = "2026"` (FY 2026-27)

---

## Gmail SMTP Setup

1. Enable 2-Step Verification on your Google account.
2. Go to **Google Account → Security → App passwords**.
3. Create an App Password for "Mail".
4. Use that 16-character password in the **App Password** field.
5. Host: `smtp.gmail.com`, Port: `465` (SSL).

---

## Email Placeholders

In the Subject and Body fields you can use:

| Placeholder      | Replaced with                         |
|------------------|---------------------------------------|
| `{gstin}`        | The GSTIN of the non-filer            |
| `{period}`       | e.g. "May 2026"                       |
| `{returnType}`   | e.g. "GSTR1"                          |

---

## Session Handling

The app reuses one login session for the entire batch.
If the session expires mid-batch (detectable via server error messages), the app automatically re-authenticates — including re-prompting for a captcha if needed — then resumes from the current GSTIN.

---

## Packaging (optional)

To build a distributable:

```bash
npm run dist
```

Output goes to the `dist/` folder. Requires `electron-builder` (already in devDependencies).

> **Note:** For Windows, the build produces an NSIS installer. For macOS, a DMG. For Linux, an AppImage.

---

## Project Structure

```
├── main.js        – Electron main process (IPC, file I/O, network, email)
├── preload.js     – contextBridge between main and renderer
├── index.html     – App UI markup
├── renderer.js    – UI logic, flow, filing-status matching
├── styles.css     – Styles
└── package.json
```
