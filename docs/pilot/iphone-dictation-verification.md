# Physical iPhone dictation verification

Run this checklist on the signed pilot build. Desktop emulation is not
sufficient.

Record the build, iPhone model, iOS version, Mac model, macOS version, date, and
tester before starting.

## Safari

1. Open Tovi through the protected HTTPS phone link.
2. Open a conversation and tap Dictate.
3. Confirm the iPhone microphone privacy indicator appears.
4. Confirm the Mac microphone privacy indicator does not appear.
5. Record a known sentence, tap Stop, and confirm the editable raw transcript.
6. Edit the transcript and choose Keep as transcript.
7. Repeat, choose Turn into messages, edit both message bubbles, and confirm
   nothing sends automatically.
8. Deny microphone permission and confirm the recovery instruction matches
   Safari's current settings.
9. Start another recording, tap Cancel, and confirm the iPhone indicator turns
   off immediately.
10. Start another recording, navigate away, and confirm the indicator turns
    off immediately.
11. Confirm no camera interface or camera privacy indicator appears.

## Home Screen app

1. Add Tovi to the Home Screen from the HTTPS Safari page.
2. Repeat the recording, transcript, formatting, denial, Cancel, and navigation
   checks above.
3. Leave Tovi idle, lock and unlock the iPhone, then confirm the existing
   authenticated session returns without microphone activity.

## Evidence

For each check, record pass/fail and a short observation. If a check fails,
include only device/build details and safe diagnostic context. Do not include
message content or the private phone URL.
