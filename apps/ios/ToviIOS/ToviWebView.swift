import Foundation
import SwiftUI
import WebKit

struct ToviWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "toviDictation")
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.webView = webView
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url == nil else { return }
        webView.load(URLRequest(url: url))
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: "toviDictation"
        )
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        private let recorder = DictationRecorder()

        override init() {
            super.init()
            recorder.onCompletion = { [weak self] sessionID, completion in
                self?.emitRecording(sessionID: sessionID, completion: completion)
            }
            recorder.onError = { [weak self] sessionID, error in
                self?.emit([
                    "type": "error",
                    "sessionId": sessionID,
                    "message": error.localizedDescription
                ])
            }
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "toviDictation",
                  let body = message.body as? [String: Any],
                  let command = body["command"] as? String,
                  let sessionID = body["sessionId"] as? String else {
                return
            }

            switch command {
            case "start":
                recorder.requestPermission { [weak self] allowed in
                    guard let self else { return }
                    guard allowed else {
                        self.emit([
                            "type": "error",
                            "sessionId": sessionID,
                            "message": "Microphone access is off. Open iPhone Settings, find Tovi, allow Microphone, then reopen Tovi."
                        ])
                        return
                    }
                    do {
                        try self.recorder.start(sessionID: sessionID)
                        self.emit(["type": "started", "sessionId": sessionID])
                    } catch {
                        self.emit([
                            "type": "error",
                            "sessionId": sessionID,
                            "message": error.localizedDescription
                        ])
                    }
                }
            case "stop":
                recorder.stop(sessionID: sessionID)
            case "cancel":
                recorder.cancel(sessionID: sessionID)
                emit(["type": "cancelled", "sessionId": sessionID])
            case "status":
                if recorder.isRecording(sessionID: sessionID) {
                    emit([
                        "type": "status",
                        "sessionId": sessionID,
                        "active": true
                    ])
                } else if !recorder.redeliver(sessionID: sessionID) {
                    emit([
                        "type": "status",
                        "sessionId": sessionID,
                        "active": false,
                        "message": "The iPhone recorder is no longer active."
                    ])
                }
            case "acknowledge":
                recorder.acknowledge(sessionID: sessionID)
            default:
                break
            }
        }

        private func emitRecording(
            sessionID: String,
            completion: DictationRecorder.Completion
        ) {
            do {
                let data = try Data(contentsOf: completion.url)
                var payload: [String: Any] = [
                    "type": "recorded",
                    "sessionId": sessionID,
                    "dataUrl": "data:audio/mp4;base64,\(data.base64EncodedString())",
                    "mimeType": "audio/mp4",
                    "startedAt": Int(completion.startedAt.timeIntervalSince1970 * 1_000),
                    "endedAt": Int(completion.endedAt.timeIntervalSince1970 * 1_000)
                ]
                if let reason = completion.interruptionReason {
                    payload["interruptionReason"] = reason
                }
                emit(payload)
            } catch {
                emit([
                    "type": "error",
                    "sessionId": sessionID,
                    "message": "The saved iPhone recording could not be read."
                ])
            }
        }

        private func emit(_ detail: [String: Any]) {
            guard JSONSerialization.isValidJSONObject(detail),
                  let data = try? JSONSerialization.data(withJSONObject: detail),
                  let json = String(data: data, encoding: .utf8) else {
                return
            }
            webView?.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('tovi-native-dictation',{detail:\(json)}));"
            )
        }
    }
}
