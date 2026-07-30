import AVFoundation
import Foundation

@MainActor
final class DictationRecorder: NSObject, AVAudioRecorderDelegate {
    struct Completion {
        let endedAt: Date
        let interruptionReason: String?
        let startedAt: Date
        let url: URL
    }

    var onCompletion: ((String, Completion) -> Void)?
    var onError: ((String, Error) -> Void)?

    private var activeSessionID: String?
    private var completedFiles: [String: Completion] = [:]
    private var recorder: AVAudioRecorder?
    private var startedAt: Date?
    private var statusTimer: Timer?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioSessionInterrupted),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioServicesReset),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    func requestPermission(_ completion: @escaping (Bool) -> Void) {
        AVAudioSession.sharedInstance().requestRecordPermission { allowed in
            Task { @MainActor in completion(allowed) }
        }
    }

    func start(sessionID: String) throws {
        if let activeSessionID {
            throw RecorderError.alreadyRecording(activeSessionID)
        }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .record,
            mode: .measurement,
            options: [.allowBluetoothHFP]
        )
        try audioSession.setActive(true)

        let directory = try recordingsDirectory()
        let url = directory.appendingPathComponent("\(sessionID).m4a")
        try? FileManager.default.removeItem(at: url)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord(), recorder.record() else {
            throw RecorderError.couldNotStart
        }

        self.recorder = recorder
        activeSessionID = sessionID
        startedAt = Date()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.activeSessionID != nil else { return }
                if self.recorder?.isRecording != true {
                    self.finish(interruptionReason: "stalled")
                }
            }
        }
    }

    func stop(sessionID: String) {
        guard activeSessionID == sessionID else {
            _ = redeliver(sessionID: sessionID)
            return
        }
        finish(interruptionReason: nil)
    }

    func cancel(sessionID: String) {
        if activeSessionID == sessionID {
            recorder?.stop()
            cleanupActiveSession()
        }
        if let completion = completedFiles.removeValue(forKey: sessionID) {
            try? FileManager.default.removeItem(at: completion.url)
        }
    }

    func acknowledge(sessionID: String) {
        guard let completion = completedFiles.removeValue(forKey: sessionID) else { return }
        try? FileManager.default.removeItem(at: completion.url)
    }

    func isRecording(sessionID: String) -> Bool {
        activeSessionID == sessionID && recorder?.isRecording == true
    }

    func redeliver(sessionID: String) -> Bool {
        guard let completion = completedFiles[sessionID] else { return false }
        onCompletion?(sessionID, completion)
        return true
    }

    func audioRecorderDidFinishRecording(
        _ recorder: AVAudioRecorder,
        successfully flag: Bool
    ) {
        guard !flag, let sessionID = activeSessionID else { return }
        onError?(sessionID, RecorderError.encoderStopped)
        cleanupActiveSession()
    }

    func audioRecorderEncodeErrorDidOccur(
        _ recorder: AVAudioRecorder,
        error: Error?
    ) {
        guard let sessionID = activeSessionID else { return }
        onError?(sessionID, error ?? RecorderError.encoderStopped)
        finish(interruptionReason: "recorder-error")
    }

    @objc
    private func audioSessionInterrupted(_ notification: Notification) {
        guard activeSessionID != nil,
              let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType),
              type == .began else {
            return
        }
        finish(interruptionReason: "audio-interruption")
    }

    @objc
    private func audioServicesReset() {
        guard activeSessionID != nil else { return }
        finish(interruptionReason: "recorder-error")
    }

    private func finish(interruptionReason: String?) {
        guard let sessionID = activeSessionID,
              let recorder,
              let startedAt else {
            return
        }
        recorder.stop()
        let completion = Completion(
            endedAt: Date(),
            interruptionReason: interruptionReason,
            startedAt: startedAt,
            url: recorder.url
        )
        completedFiles[sessionID] = completion
        cleanupActiveSession()
        onCompletion?(sessionID, completion)
    }

    private func cleanupActiveSession() {
        statusTimer?.invalidate()
        statusTimer = nil
        recorder = nil
        activeSessionID = nil
        startedAt = nil
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }

    private func recordingsDirectory() throws -> URL {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = root.appendingPathComponent("Dictation", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    enum RecorderError: LocalizedError {
        case alreadyRecording(String)
        case couldNotStart
        case encoderStopped

        var errorDescription: String? {
            switch self {
            case .alreadyRecording:
                return "Another dictation is already recording."
            case .couldNotStart:
                return "The iPhone microphone could not start."
            case .encoderStopped:
                return "The iPhone audio encoder stopped unexpectedly."
            }
        }
    }
}
