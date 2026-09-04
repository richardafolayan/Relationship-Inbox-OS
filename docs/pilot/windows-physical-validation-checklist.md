# Windows physical validation checklist

Status: required before Tovi can be described as ready for a Windows student
pilot. CI and installer automation do not replace this physical pass.

Use a clean Windows 11 x64 user account and privacy-safe synthetic
conversations. Do not send, react, edit, vote, create a poll, reset a session,
or reconnect a real platform unless Richard has authorised that exact external
action.

## Record before testing

- Candidate commit:
- Pull request or release identifier:
- Installer file name and SHA-256:
- Windows edition and build:
- CPU architecture:
- Windows display scaling:
- Chrome version:
- Tovi Electron version:
- Included platforms:
- Test account state:
- Tester:
- Date and time:

For every failure, record the starting state, exact steps, expected result,
actual result, severity, and privacy-safe evidence. Never include a private
message, contact detail, token, QR code, platform session, or pairing URL in
shared evidence.

## Clean install

1. Use a fresh Windows user account where practical. Otherwise, record any
   prior Tovi installation, process, shortcut, data, or platform state.
2. Download the exact candidate installer and its adjacent `.sha256` file from
   the same successful workflow artifact. Recompute the installer SHA-256 and
   confirm it matches the published digest before running it.
3. Start a timer. Count every action, external application, prompt, and point
   where Richard must intervene.
4. Run the NSIS installer and record Windows SmartScreen behaviour.
5. Confirm whether installation works per user, without Terminal or
   administrator elevation.
6. Check the Start menu and desktop shortcuts.
7. Launch Tovi and confirm only one app window and one runtime start.

## First run

8. Record time from launch to the visible setup assistant.
9. Confirm setup copy says PC or Windows, not Mac, Applications, or DMG.
10. Confirm iMessage and macOS Contacts birthday sync are absent or clearly
    unavailable.
11. Confirm Google Messages and LinkedIn appear.
12. Confirm WhatsApp appears only if its fresh-install default fix is included
    in this exact build.
13. Exercise Back, Finish later, close, reopen, and resume.
14. Make each setup save fail with the local runner unavailable. Confirm the
    assistant remains open, preserves the user's choices, and offers retry.
15. Complete setup with AI and transcription disabled.
16. Repeat with local transcription enabled. Verify download progress,
    cancellation, failure, retry, and completion.

## Platform connection

17. Pair Google Messages. Confirm the account and pairing emoji match the
    phone, then verify the connected state in Tovi.
18. Restart Tovi and confirm Google Messages pairing persists.
19. Connect LinkedIn in Tovi's isolated browser. Complete any security or 2FA
    challenge manually.
20. Restart Tovi and confirm the LinkedIn session persists.
21. If WhatsApp is included, scan its QR code, verify connection, restart, and
    confirm the session persists.
22. Test authentication expired, platform disconnected, phone offline,
    permission denied, and reconnect states one at a time. Each state must
    explain what happened and give one useful next action.

## Incoming message to reply

23. Send one privacy-safe synthetic inbound message to each included platform.
24. Confirm the correct platform, person, thread, sender, timestamp, content,
    and media appear exactly once.
25. Confirm Today and Inbox update once and the row does not move while it is
    being clicked.
26. Open the same item from Today and Inbox. Confirm the intended thread opens
    every time.
27. Repeat with a normal conversation, long name, long message, media, empty
    draft, and existing saved draft.
28. Save a draft, navigate away and back, reload, quit and reopen, then sleep
    and wake. Confirm the draft remains intact at every boundary.
29. Open two dashboard tabs. Confirm draft, pending action, and queue state do
    not diverge.
30. Test slow request, runner offline, interrupted request, platform offline,
    authentication expired, and permission denied states.

## One controlled send

31. Obtain explicit authorisation for one exact recipient, platform, and
    message before continuing.
32. Immediately before pressing Send, confirm the recipient, thread, platform,
    message text, reply target, attachments, and schedule state.
33. Exercise repeated input against a non-dispatching test path or synthetic
    harness first. Never press the live platform Send control twice. Then
    press Send once for the authorised recipient and message.
34. Confirm one visible pending state, one physical platform action, one sent
    message, and one honest delivery result.
35. Confirm the draft clears and Today or Inbox updates only at the safe
    persistence boundary.
36. Do not repeat on another platform without separate explicit
    authorisation.
37. Test a definite local failure before dispatch. Confirm the draft remains
    and retry is useful.
38. Do not force a real delivery-uncertain action merely to test uncertainty.

## Restart, sleep, and displays

39. Quit and reopen Tovi while a saved draft exists.
40. Put the laptop to sleep with Tovi open, then wake it.
41. Change between laptop-only and an external monitor.
42. Move Tovi between monitors at 100%, 125%, and 150% display scaling.
43. Disconnect the external monitor while Tovi is on it. Confirm the window
    returns to a visible display.
44. Smoke-check 1024 x 768, 1280 x 800, 1920 x 1080, 2560 x 1440, and
    3840 x 2160.
45. Check maximize, restore, full screen, Back, menus, overlay dismissal,
    scrolling, keyboard focus, and focus restoration.

## Update and uninstall

The one authorised Tovi live send in steps 31 to 36 is the limit for the entire
checklist. Resetting app data, installing an older candidate, upgrading,
uninstalling, or reinstalling does not reset that limit. Do not use the older
candidate, upgrade, or reinstall to send again. Use inbound-only test traffic,
saved drafts, connection status, and session checks for the remaining steps.

46. Pin and prepare the upgrade source before installing the new candidate:
    - Record the earlier candidate commit or release identifier, installer file
      name, SHA-256, and included-platform set.
    - Start from a fresh Windows user account, or fully remove the current
      synthetic test installation and its app data.
    - Install that exact older candidate and confirm its displayed version
      matches the recorded commit or release.
    - Obtain explicit authorisation before connecting or reconnecting each test
      account.
    - Establish a real authenticated session for every included platform while
      the older candidate is still installed. Confirm each platform reports the
      expected test account as connected without recording credentials, tokens,
      QR codes, or pairing URLs.
    - Create the privacy-safe synthetic data, settings, and saved draft with the
      older candidate so its original database schema is the upgrade source.
    - Quit and reopen the older candidate.
    - Confirm every included platform session is still connected before
      installing the newer candidate. Also confirm the synthetic database,
      settings, and saved draft are present.
47. Install the newer Windows installer over it.
48. Confirm the database, settings, included platform sessions, and draft
    survive.
49. Confirm the interface does not imply that the macOS DMG updater works on
    Windows. Record the actual Windows update instructions.
50. Uninstall Tovi through Windows Installed Apps.
51. Confirm the executable, shortcuts, and background processes are removed.
52. Confirm `%APPDATA%\Relationship Inbox OS` remains. Uninstall intentionally
    retains the database, settings, and saved browser sessions unless the user
    deletes that folder separately.
53. Reinstall and confirm the database, settings, and saved platform sessions
    return. Record any provider that requires sign-in again because its own
    session expired.
54. Review logs and evidence for private-data leakage before sharing anything.

## Pass rule

Windows can pass the assisted-pilot gate only when every included platform
completes the installed golden journey and the register has zero unresolved P0
or P1 defects. Record blocked steps as blocked. Do not infer success from CI or
from another operating system.
