# Free, owner-operated device sync

No paid service, billing account, card, subscription, or paid AI API is required.
The owner uses their own Google account's free Apps Script, Sheets, and Mail quotas.
Google can change quotas or availability; this is best-effort sync, not a guaranteed
backup service. Local progress and JSON export/import always work without it.

1. Open https://script.google.com and create a **New project** under your own account.
2. Copy both `Code.gs` and `Chat.gs` into the same Apps Script project as separate
   script files (or use `clasp push` to upload both).
3. In **Project Settings → Script Properties**, set **PEPPER** to a long random string
   (keep it private and stable). Optionally set **SITE_URL** to your Pages URL; the
   default is `https://ledinhduy281.github.io/daily-learning-heart/`. Also set
   **GROQ_API_KEY**, never in browser code. Optional chat properties:
   **CHAT_DAILY_CAP** (default `300`) and **GROQ_MODEL** (default `openai/gpt-oss-120b`).
4. Choose **Deploy → New deployment → Web app**, **Execute as: Me**,
   **Who has access: Anyone**. Authorize Sheets and sending mail from your account.
   If your Workspace administrator forbids anonymous web apps, this setup cannot
   work there; leave cloud sync disabled. Never enable billing to work around it.
5. One deployment serves both sync and chat. Copy its **/exec** URL
   (not `/dev`) into `sync_config.js` and commit it.
   This URL is public, not a secret. Leave it empty to disable cloud sync.
6. After deploying, select **testChat** in the Apps Script editor and click **Run**.
   Authorize it if prompted. The execution log should start with **OK:**.
7. Visit the site, read a lesson, and try restore on another browser. Test an email
   backup and restore email. Apps Script creates a **private** spreadsheet on the
   first request. Follow the backup email's confirmation link before requesting
   a restore email; unconfirmed email links never become active. Confirmation
   tokens are stored hashed, expire after 24 hours, and can only be used once.
   Its ID is stored in `SYNC_SHEET_ID`. Do not publish/share the Sheet.
8. For code updates, deploy a **new version** using Manage deployments. Keep PEPPER,
   the spreadsheet, and its property stable or email lookups will be lost.

## Security, limits, and operations

The visible user ID is a **bearer sync key**: anyone who has it or a restore link
can read/change that profile. Share it only with your own trusted devices. It is
kept separately from the dev server's device credential when restoring another ID;
JSON progress exports contain neither ID. Downloading the ID creates a separate
plain-text file; it needs a configured cloud endpoint to retrieve progress.

Profiles are keyed by SHA-256(UUID); emails by HMAC-SHA-256(normalized email, PEPPER).
Plain emails are used only as MailApp recipients, never written to the Sheet or
Script Properties. Google necessarily processes the recipient to deliver mail;
this is not a claim that Google retains no email delivery metadata. Profiles may
contain user-entered chat text: do not put sensitive information in them.

Profiles are capped at 256 KiB UTF-8. Mail is limited to 70/day (also checking the
remaining Google quota), with 10-minute cooldowns per fingerprint and per ID.
Backup and restore requests return the same generic success message, including
unknown addresses and cooldowns. Revision checks under a ScriptLock prevent
concurrent devices overwriting unseen updates; clients merge and retry conflicts.
The Sheet is capped at 5,000 rows; the owner may remove old `day:` rows or unused
profiles and their `e:`/`rate:` rows. At capacity new writes fail safely and local
learning remains available. Free public endpoints cannot prevent all denial of
service; monitor the Sheet and Apps Script executions, disable the deployment if
abused, and keep JSON backups. Do not log request bodies or email addresses.

Requests use POST `Content-Type: text/plain` with JSON bodies to avoid browser
preflight. Apps Script ContentService redirects responses to Google's content
host; the browser must follow redirects. Verify CORS with the deployed `/exec`
endpoint on your real Pages site before announcing sync. Node tests cannot
certify Google's deployment permissions, CORS behavior, quotas, or mail delivery.
