# Windows pilot install

The Windows pilot supports Google Messages, WhatsApp, and LinkedIn. iMessage
is shown as not available because Apple does not provide it on Windows.

Before describing a candidate as ready for a Windows student pilot, complete
the [physical Windows validation checklist](./windows-physical-validation-checklist.md).
Installer CI is necessary but does not replace this installed-device gate.

## Install

1. Install the current version of Google Chrome. Tovi uses it for LinkedIn
   and WhatsApp on Windows.
2. Download the `tovi-windows-pilot-installer` artifact from the successful
   Windows installer workflow run for the pilot commit.
3. Unzip the artifact. Recompute the installer's SHA-256 and confirm it matches
   the adjacent `.sha256` file before opening `Tovi-Setup-0.1.15-x64.exe`.
4. If Windows SmartScreen appears, choose **More info**, then **Run anyway**.
   The pilot installer is not yet code-signed.
5. Keep the default per-user install location and finish setup.
6. Open Tovi from the Start menu or desktop shortcut.

## Connect platforms

- Google Messages: choose **Pair Android phone**. Sign in with the same Google
  account used by Google Messages on the phone, then confirm the matching
  emoji on the phone if asked. Tovi can read and send SMS, MMS, and RCS through
  the paired web session. The phone must stay online.
- LinkedIn: choose Connect and sign in inside Tovi's dedicated browser. The
  Windows pilot does not copy cookies from the student's normal Chrome
  profile.
- WhatsApp: choose Connect and scan the QR code with WhatsApp on the phone.

The student always reviews and triggers every send. Tovi never sends on its
own.

## Quick pilot check

1. Confirm Settings shows iMessage as **Not available** without asking for
   Full Disk Access.
2. Pair Google Messages, then connect LinkedIn and WhatsApp.
3. Scan all three platforms and open one conversation from each.
4. In Google Messages, check a one-to-one SMS or RCS chat and a group chat.
5. Attach one photo to a Google Messages reply and remove it before sending.
6. Record a short dictated reply, review the text, then edit it.
7. Send a test reply only after confirming the recipient and final wording.

Google Messages on the web can show quoted replies but cannot create a new
quoted reply. Open the paired Google Messages window for that action.
Google documents the pairing flow and web requirements in
[Use Messages for web](https://support.google.com/messages/answer/7611075),
and documents the desktop quoted-reply limitation in
[Reply to a message](https://support.google.com/messages/answer/10456318).

If startup fails, open **Tovi > Show Logs** and attach the log to a bug report.
Do not paste private message content into the report.
