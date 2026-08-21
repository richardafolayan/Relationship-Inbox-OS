# Tovi iPhone companion

The companion keeps the existing Tovi web UI and uses a native
`AVAudioSession` recorder for dictation. The recorder writes AAC audio to the
app support directory as it arrives, keeps the recording category active while
the app is backgrounded or the screen is locked, and only returns the saved
file to the web UI when the user stops dictation or iOS interrupts capture.

## Run on a physical iPhone

1. Open `ToviIOS.xcodeproj` in Xcode.
2. Select the `ToviIOS` target and your development team.
3. Run on an iPhone with iOS 17 or later.
4. In the app, paste the HTTPS private phone address from Tovi Settings on the
   Mac.
5. Allow microphone access when starting the first dictation.

The app intentionally accepts only HTTPS phone addresses. Transcript review,
Turn into messages, and sending remain in the existing web UI. The native
bridge never sends a message.

## Issue 1035 physical check

1. Record for 30 seconds.
2. Switch to another app for 2 minutes while continuing to speak.
3. Return and record for another 30 seconds.
4. Repeat with the screen locked for 2 minutes.
5. Stop dictation and review the transcript.

The iPhone status indicator should remain active throughout both background
intervals. If iOS interrupts the audio session, Tovi stops showing Recording
and offers the audio saved before the interruption for recovery.
