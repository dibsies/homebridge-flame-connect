import AppKit
import CryptoKit
import CoreServices
import Foundation

private let clientID = "1af761dc-085a-411f-9cb9-53e5e2115bd2"
private let callbackScheme = "msal\(clientID)"
private let redirectURI = "\(callbackScheme)://auth"
private let authority = "https://gdhvb2cflameconnect.b2clogin.com/gdhvb2cflameconnect.onmicrosoft.com/B2C_1A_FirePhoneSignUpOrSignInWithPhoneOrEmail"
private let scope = "openid profile offline_access https://gdhvb2cflameconnect.onmicrosoft.com/Mobile/read"
private let helperBundleID = "com.dibsies.FlameConnectTokenHelper"

private func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func randomURLSafe(byteCount: Int) -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        fatalError("Secure random-number generation failed")
    }
    return base64URL(Data(bytes))
}

private func sha256URLSafe(_ value: String) -> String {
    base64URL(Data(SHA256.hash(data: Data(value.utf8))))
}

private struct AuthFlow {
    let state: String
    let verifier: String
    let authorizationURL: URL

    static func create() throws -> AuthFlow {
        let verifier = randomURLSafe(byteCount: 48)
        let state = randomURLSafe(byteCount: 24)
        let nonce = randomURLSafe(byteCount: 24)
        var components = URLComponents(string: "\(authority)/oauth2/v2.0/authorize")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "client_info", value: "1"),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_mode", value: "query"),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: sha256URLSafe(nonce)),
            URLQueryItem(name: "code_challenge", value: sha256URLSafe(verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let url = components.url else { throw HelperError.invalidAuthorizationURL }
        return AuthFlow(state: state, verifier: verifier, authorizationURL: url)
    }
}

private enum HelperError: LocalizedError {
    case invalidAuthorizationURL
    case invalidCallback
    case stateMismatch
    case authorization(String)
    case token(String)
    case missingRefreshToken

    var errorDescription: String? {
        switch self {
        case .invalidAuthorizationURL: return "Could not create the Flame Connect authorization URL."
        case .invalidCallback: return "The Flame Connect callback did not contain an authorization code."
        case .stateMismatch: return "The security state did not match. Please start the login again."
        case .authorization(let message): return message
        case .token(let message): return "Token exchange failed: \(message)"
        case .missingRefreshToken: return "Flame Connect signed in, but did not return a refresh token."
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var startButton: NSButton!
    private var copyButton: NSButton!
    private var flow: AuthFlow?
    private var refreshToken: String?
    private var previousHandler: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        if CommandLine.arguments.contains("--self-test") {
            runSelfTestAndExit()
            return
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startAuthorization()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { $0.scheme == callbackScheme }) else { return }
        handleCallback(url)
    }

    func applicationWillTerminate(_ notification: Notification) {
        restorePreviousHandler()
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 230),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Flame Connect Token Helper"
        window.center()

        let title = NSTextField(labelWithString: "Flame Connect sign-in")
        title.font = .boldSystemFont(ofSize: 22)
        title.alignment = .center

        statusLabel = NSTextField(wrappingLabelWithString: "Preparing secure sign-in…")
        statusLabel.alignment = .center
        statusLabel.maximumNumberOfLines = 4

        startButton = NSButton(title: "Start Again", target: self, action: #selector(startAgain))
        startButton.bezelStyle = .rounded

        copyButton = NSButton(title: "Copy Refresh Token", target: self, action: #selector(copyToken))
        copyButton.bezelStyle = .rounded
        copyButton.isHidden = true

        let buttons = NSStackView(views: [startButton, copyButton])
        buttons.orientation = .horizontal
        buttons.spacing = 12
        buttons.alignment = .centerY

        let stack = NSStackView(views: [title, statusLabel, buttons])
        stack.orientation = .vertical
        stack.spacing = 22
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -32),
            stack.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor),
        ])
    }

    @objc private func startAgain() { startAuthorization() }

    @objc private func copyToken() {
        guard let refreshToken else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(refreshToken, forType: .string)
        statusLabel.stringValue = "Refresh token copied. Paste it into Homebridge → Flame Connect → Refresh Token."
    }

    private func startAuthorization() {
        do {
            refreshToken = nil
            copyButton.isHidden = true
            flow = try AuthFlow.create()
            claimCallbackScheme()
            statusLabel.stringValue = "Safari will open. Sign in, then choose Allow when asked to open this helper."
            NSWorkspace.shared.open(flow!.authorizationURL)
        } catch {
            show(error)
        }
    }

    private func claimCallbackScheme() {
        if previousHandler == nil,
           let current = LSCopyDefaultHandlerForURLScheme(callbackScheme as CFString)?.takeRetainedValue() as String?,
           current != helperBundleID {
            previousHandler = current
        }
        LSSetDefaultHandlerForURLScheme(callbackScheme as CFString, helperBundleID as CFString)
    }

    private func restorePreviousHandler() {
        if let previousHandler {
            LSSetDefaultHandlerForURLScheme(callbackScheme as CFString, previousHandler as CFString)
            self.previousHandler = nil
        }
    }

    private func handleCallback(_ url: URL) {
        guard let flow else { return }
        do {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
            if let description = values["error_description"], !description.isEmpty {
                throw HelperError.authorization(description)
            }
            if let error = values["error"], !error.isEmpty { throw HelperError.authorization(error) }
            guard values["state"] == flow.state else { throw HelperError.stateMismatch }
            guard let code = values["code"], !code.isEmpty else { throw HelperError.invalidCallback }
            statusLabel.stringValue = "Finishing sign-in…"
            exchange(code: code, verifier: flow.verifier)
        } catch {
            show(error)
        }
    }

    private func exchange(code: String, verifier: String) {
        let endpoint = URL(string: "\(authority)/oauth2/v2.0/token")!
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let fields = [
            "client_id": clientID,
            "client_info": "1",
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirectURI,
            "code_verifier": verifier,
            "scope": scope,
        ]
        var components = URLComponents()
        components.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = components.percentEncodedQuery?.data(using: .utf8)

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            Task { @MainActor in
                guard let self else { return }
                do {
                    if let error { throw HelperError.token(error.localizedDescription) }
                    guard let data else { throw HelperError.token("No response received.") }
                    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                    if let description = object?["error_description"] as? String {
                        throw HelperError.token(description)
                    }
                    guard let token = object?["refresh_token"] as? String, !token.isEmpty else {
                        throw HelperError.missingRefreshToken
                    }
                    self.refreshToken = token
                    self.restorePreviousHandler()
                    self.copyButton.isHidden = false
                    self.statusLabel.stringValue = "Success. Copy the refresh token, then paste it into the Homebridge plugin settings."
                    NSApp.activate(ignoringOtherApps: true)
                    self.window.makeKeyAndOrderFront(nil)
                } catch {
                    self.show(error)
                }
            }
        }.resume()
    }

    private func show(_ error: Error) {
        statusLabel.stringValue = error.localizedDescription
        copyButton.isHidden = true
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func runSelfTestAndExit() {
        do {
            let testFlow = try AuthFlow.create()
            let components = URLComponents(url: testFlow.authorizationURL, resolvingAgainstBaseURL: false)
            let values = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            precondition(values["client_info"] == "1")
            precondition(values["state"] == testFlow.state)
            precondition(values["nonce"]?.isEmpty == false)
            precondition(values["code_challenge"]?.isEmpty == false)
            precondition(values["redirect_uri"] == redirectURI)
            print("Self-test passed")
            NSApp.terminate(nil)
        } catch {
            fputs("Self-test failed: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
