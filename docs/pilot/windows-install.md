# Windows pilot install

The Windows pilot supports WhatsApp and LinkedIn. iMessage is shown as not
available. Google Messages for web is not included in this build.

## Install

1. Install the current version of Google Chrome. Tovi uses it for LinkedIn
   and WhatsApp on Windows.
2. Download the `tovi-windows-pilot-installer` artifact from the successful
   Windows installer workflow run for the pilot commit.
3. Unzip the artifact and open `Tovi-Setup-0.1.15-x64.exe`.
4. If Windows SmartScreen appears, choose **More info**, then **Run anyway**.
   The pilot installer is not yet code-signed.
5. Keep the default per-user install location and finish setup.
6. Open Tovi from the Start menu or desktop shortcut.

## Connect platforms

- LinkedIn: choose Connect and sign in inside Tovi's dedicated browser. The
  Windows pilot does not copy cookies from the student's normal Chrome
  profile.
- WhatsApp: choose Connect and scan the QR code with WhatsApp on the phone.

The student always reviews and triggers every send. Tovi never sends on its
own.

## Quick pilot check

1. Confirm Settings shows iMessage as **Not available** without asking for
   Full Disk Access.
2. Connect LinkedIn and WhatsApp.
3. Scan both platforms and open one conversation from each.
4. Record a short dictated reply, review the text, then edit it.
5. Send a test reply only after confirming the recipient and final wording.

If startup fails, open **Tovi > Show Logs** and attach the log to a bug report.
Do not paste private message content into the report.
