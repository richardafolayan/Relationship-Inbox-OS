import SwiftUI

struct ContentView: View {
    @AppStorage("toviPhoneAccessURL") private var savedAddress = ""
    @State private var address = ""
    @State private var connectedURL: URL?
    @State private var errorMessage = ""

    var body: some View {
        Group {
            if let connectedURL {
                ToviWebView(url: connectedURL)
                    .ignoresSafeArea(.container, edges: .bottom)
            } else {
                NavigationStack {
                    Form {
                        Section {
                            TextField("https://your-mac.ts.net:3111/connect/...", text: $address)
                                .textInputAutocapitalization(.never)
                                .keyboardType(.URL)
                                .autocorrectionDisabled()
                        } header: {
                            Text("Private phone address")
                        } footer: {
                            Text("On your Mac, open Tovi Settings, choose Phone access, then copy the HTTPS address.")
                        }

                        if !errorMessage.isEmpty {
                            Section {
                                Text(errorMessage)
                                    .foregroundStyle(.red)
                            }
                        }

                        Button("Open Tovi") {
                            connect()
                        }
                        .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .navigationTitle("Tovi")
                }
            }
        }
        .onAppear {
            address = savedAddress
            if let url = validatedURL(savedAddress) {
                connectedURL = url
            }
        }
        .onOpenURL { url in
            guard url.scheme == "tovi",
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let value = components.queryItems?.first(where: { $0.name == "url" })?.value,
                  let phoneURL = validatedURL(value) else {
                return
            }
            savedAddress = phoneURL.absoluteString
            address = phoneURL.absoluteString
            connectedURL = phoneURL
        }
    }

    private func connect() {
        guard let url = validatedURL(address) else {
            errorMessage = "Paste the complete HTTPS phone address from Tovi on your Mac."
            return
        }
        savedAddress = url.absoluteString
        errorMessage = ""
        connectedURL = url
    }

    private func validatedURL(_ value: String) -> URL? {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https",
              url.host != nil else {
            return nil
        }
        return url
    }
}
