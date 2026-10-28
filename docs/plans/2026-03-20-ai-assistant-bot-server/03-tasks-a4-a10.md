> Part 3 of 3 of [AI Assistant — Bot Server Implementation Plan](../2026-03-20-ai-assistant-bot-server.md) — previous: [02-tasks-7-a3.md](02-tasks-7-a3.md)

## Task A4: WebSocket client

**Files:**
- Create: `HyperBotAgent/WebSocketClient.swift`
- Create: `HyperBotAgentTests/WebSocketClientTests.swift`

- [ ] **Step 1: Write failing test**

```swift
// HyperBotAgentTests/WebSocketClientTests.swift
import XCTest
@testable import HyperBotAgent

final class WebSocketClientTests: XCTestCase {
  func testInitialStateIsDisconnected() {
    let client = WebSocketClient(url: URL(string: "wss://example.com/ws/agent")!)
    XCTAssertFalse(client.isConnected)
  }
}
```

Run: Cmd+U. Expected: FAIL.

- [ ] **Step 2: Implement WebSocketClient.swift**

```swift
// HyperBotAgent/WebSocketClient.swift
import Foundation

typealias MessageHandler = (Data) -> Void

@MainActor
class WebSocketClient: NSObject {
  private let url: URL
  private let jwt: String?
  private var task: URLSessionWebSocketTask?
  private var reconnectDelay: TimeInterval = 1
  private var pingTimer: Timer?

  var onMessage: MessageHandler?
  var onConnected: (() -> Void)?
  var onDisconnected: (() -> Void)?
  private(set) var isConnected = false

  init(url: URL, jwt: String? = nil) {
    self.url = url
    self.jwt = jwt
  }

  func connect() {
    var request = URLRequest(url: url)
    if let jwt { request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization") }
    let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    task = session.webSocketTask(with: request)
    task?.resume()
    receive()
    schedulePing()
  }

  func disconnect() {
    pingTimer?.invalidate()
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
    isConnected = false
  }

  func send(_ data: Data) {
    task?.send(.data(data)) { _ in }
  }

  private func receive() {
    task?.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let msg):
        switch msg {
        case .data(let d):   self.onMessage?(d)
        case .string(let s): self.onMessage?(Data(s.utf8))
        @unknown default: break
        }
        self.receive()
      case .failure:
        self.handleDisconnect()
      }
    }
  }

  private func schedulePing() {
    pingTimer?.invalidate()
    pingTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
      guard let self, self.isConnected else { return }
      let ping = try? JSONEncoder().encode(AgentPing())
      if let ping { self.send(ping) }
    }
  }

  private func handleDisconnect() {
    Task { @MainActor in
      self.isConnected = false
      self.onDisconnected?()
      // exponential backoff reconnect
      try? await Task.sleep(nanoseconds: UInt64(self.reconnectDelay * 1_000_000_000))
      self.reconnectDelay = min(self.reconnectDelay * 2, 60)
      self.connect()
    }
  }
}

extension WebSocketClient: URLSessionWebSocketDelegate {
  nonisolated func urlSession(_ session: URLSession,
                               webSocketTask: URLSessionWebSocketTask,
                               didOpenWithProtocol protocol: String?) {
    Task { @MainActor in
      self.isConnected = true
      self.reconnectDelay = 1
      self.onConnected?()
    }
  }

  nonisolated func urlSession(_ session: URLSession,
                               webSocketTask: URLSessionWebSocketTask,
                               didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                               reason: Data?) {
    Task { @MainActor in self.handleDisconnect() }
  }
}
```

- [ ] **Step 3: Run tests**

Cmd+U. isConnected test passes.

- [ ] **Step 4: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): WebSocket client with reconnect"
```

---

## Task A5: App.swift — first-launch detection + wizard window

**Files:**
- Modify: `HyperBotAgent/App.swift`
- Create: `HyperBotAgent/WizardView.swift`

- [ ] **Step 1: Implement App.swift**

```swift
// HyperBotAgent/App.swift
import SwiftUI
import LaunchAtLogin

@main
struct HyperBotAgentApp: App {
  @StateObject private var appState = AppState()

  var body: some Scene {
    MenuBarExtra("HyperBot Agent", systemImage: appState.isConnected ? "circle.fill" : "circle") {
      TrayMenu(appState: appState)
    }
    .menuBarExtraStyle(.menu)
  }

  init() {
    // First launch: show wizard window
    if PairingManager.isFirstLaunch {
      // Enable launch at login by default
      LaunchAtLogin.isEnabled = true

      // Temporarily allow window focus
      NSApp.setActivationPolicy(.regular)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        WizardWindowController.show()
        NSApp.activate(ignoringOtherApps: true)
      }
    }
  }
}
```

- [ ] **Step 2: Create WizardWindowController**

```swift
// HyperBotAgent/WizardView.swift
import SwiftUI

class WizardWindowController {
  private static var window: NSWindow?

  static func show() {
    let view = WizardView(onComplete: { dismiss() })
    let hosting = NSHostingController(rootView: view)
    let win = NSWindow(contentViewController: hosting)
    win.title = "Настройка HyperBot Agent"
    win.setContentSize(NSSize(width: 520, height: 420))
    win.styleMask = [.titled, .closable]
    win.center()
    win.makeKeyAndOrderFront(nil)
    self.window = win
  }

  static func dismiss() {
    window?.close()
    window = nil
    // Restore tray-only mode
    NSApp.setActivationPolicy(.accessory)
  }
}

// 3-step wizard: Welcome → Claude Detection → Pairing
struct WizardView: View {
  let onComplete: () -> Void
  @State private var step = 0
  @State private var claudePath = "/Applications/Claude.app"
  @State private var pairingCode = PairingManager.generateCode()

  var body: some View {
    VStack(spacing: 0) {
      // Step indicator
      HStack(spacing: 8) {
        ForEach(0..<3, id: \.self) { i in
          Circle().fill(i == step ? Color.accentColor : Color.secondary.opacity(0.3))
            .frame(width: 8, height: 8)
        }
      }.padding(.top, 24)

      Spacer()

      switch step {
      case 0: WelcomeStep()
      case 1: ClaudeDetectionStep(claudePath: $claudePath)
      case 2: PairingStep(code: pairingCode, onComplete: onComplete)
      default: EmptyView()
      }

      Spacer()

      HStack {
        if step > 0 {
          Button("Назад") { step -= 1 }
        }
        Spacer()
        if step < 2 {
          Button("Продолжить") { step += 1 }
            .buttonStyle(.borderedProminent)
        }
      }
      .padding([.horizontal, .bottom], 24)
    }
  }
}
```

- [ ] **Step 3: Build and manually test first launch**

Cmd+R. Should show wizard window. After close, only tray icon visible.

- [ ] **Step 4: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): first-launch wizard with activation policy toggle"
```

---

## Task A6: Tray menu with status + launch-at-login toggle

**Files:**
- Create: `HyperBotAgent/TrayMenu.swift`
- Create: `HyperBotAgent/AppState.swift`

- [ ] **Step 1: Create AppState.swift**

```swift
// HyperBotAgent/AppState.swift
import SwiftUI
import LaunchAtLogin

@MainActor
class AppState: ObservableObject {
  @Published var isConnected = false
  @Published var pairingCode: String? = nil

  var launchAtLogin: Bool {
    get { LaunchAtLogin.isEnabled }
    set { LaunchAtLogin.isEnabled = newValue }
  }
}
```

- [ ] **Step 2: Create TrayMenu.swift**

```swift
// HyperBotAgent/TrayMenu.swift
import SwiftUI
import LaunchAtLogin

struct TrayMenu: View {
  @ObservedObject var appState: AppState

  var body: some View {
    // Status
    Label(
      appState.isConnected ? "Подключено" : "Не подключён",
      systemImage: appState.isConnected ? "checkmark.circle.fill" : "exclamationmark.circle"
    )
    .foregroundColor(appState.isConnected ? .green : .secondary)

    Divider()

    // Launch at login toggle
    Toggle("Запускать при старте системы", isOn: Binding(
      get: { appState.launchAtLogin },
      set: { appState.launchAtLogin = $0 }
    ))

    Divider()

    // Disconnect / re-pair
    if appState.isConnected {
      Button("Отключить агент") {
        // disconnect and show pairing code
        // AppState.disconnect() — implemented in Task A7
      }
    } else if let code = appState.pairingCode {
      Button("Скопировать код: /activate \(code)") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("/activate \(code)", forType: .string)
      }
    }

    Divider()

    Button("Выход") {
      NSApplication.shared.terminate(nil)
    }
  }
}
```

- [ ] **Step 3: Build + visually verify tray menu**

Cmd+R. Check: status label, launch-at-login toggle works, quit works.

- [ ] **Step 4: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): tray menu — status, launch-at-login toggle, disconnect"
```

---

## Task A7: WebSocket pairing flow integration

**Files:**
- Modify: `HyperBotAgent/App.swift`
- Modify: `HyperBotAgent/AppState.swift`

Wire WebSocketClient into AppState. On connect: send pair message if no jwt, handle `paired` response.

- [ ] **Step 1: Extend AppState with WebSocket lifecycle**

```swift
// AppState.swift additions:
private var wsClient: WebSocketClient?
private let botUrl = URL(string: ProcessInfo.processInfo.environment["BOT_WS_URL"]
                         ?? "wss://your-bot-host/ws/agent")!

func startWebSocket() {
  let jwt = KeychainStore.loadJwt()
  wsClient = WebSocketClient(url: botUrl, jwt: jwt)
  wsClient?.onConnected = { [weak self] in
    guard let self else { return }
    if jwt == nil, let code = self.pairingCode {
      // Pairing mode: send pair message
      let msg = AgentPairRequest(code: code)
      if let data = try? JSONEncoder().encode(msg) { self.wsClient?.send(data) }
    } else {
      self.isConnected = true
    }
  }
  wsClient?.onMessage = { [weak self] data in self?.handleMessage(data) }
  wsClient?.onDisconnected = { [weak self] in
    Task { @MainActor in self?.isConnected = false }
  }
  wsClient?.connect()
}

private func handleMessage(_ data: Data) {
  guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let type = json["type"] as? String else { return }

  Task { @MainActor in
    switch type {
    case "paired":
      if let jwt = json["jwt"] as? String {
        try? KeychainStore.saveJwt(jwt)
        self.isConnected = true
        self.pairingCode = nil
        WizardWindowController.dismiss()
      }
    case "pair_error":
      // show error in wizard
      break
    case "pong":
      break
    default:
      // AgentCommand — route to CommandRouter (Task A9)
      break
    }
  }
}

func disconnect() {
  try? KeychainStore.deleteJwt()
  wsClient?.disconnect()
  isConnected = false
  pairingCode = PairingManager.generateCode()
  // show wizard again
  NSApp.setActivationPolicy(.regular)
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
    WizardWindowController.show()
    NSApp.activate(ignoringOtherApps: true)
  }
}
```

- [ ] **Step 2: Call startWebSocket in App.swift init**

```swift
init() {
  if PairingManager.isFirstLaunch {
    LaunchAtLogin.isEnabled = true
    // ... wizard logic ...
  }
  // Always start WebSocket (connects immediately if JWT exists, else waits for wizard)
  DispatchQueue.main.async { appState.startWebSocket() }
}
```

Wait — `appState` is `@StateObject` which can't be accessed in `init`. Move startWebSocket call to `.onAppear` or use `.task` modifier on the MenuBarExtra content.

- [ ] **Step 3: Wire disconnect button in TrayMenu**

```swift
Button("Отключить агент") { appState.disconnect() }
```

- [ ] **Step 4: End-to-end test: run bot server locally, connect agent**

1. Set `BOT_WS_URL` env var to local bot server
2. Run agent, copy `/activate xxx-xxxx` command from tray
3. Send command to bot in Telegram
4. Verify tray icon turns green ("Подключено")

- [ ] **Step 5: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): WebSocket pairing — JWT flow, connected state, disconnect"
```

---

## Task A8: Claude Desktop Bridge (cookie extraction + claude.ai API)

**Files:**
- Create: `HyperBotAgent/ClaudeBridge.swift`
- Create: `HyperBotAgent/CircuitBreaker.swift`
- Create: `HyperBotAgentTests/ClaudeBridgeTests.swift`
- Create: `HyperBotAgentTests/CircuitBreakerTests.swift`

- [ ] **Step 1: Write failing tests**

```swift
// CircuitBreakerTests.swift
final class CircuitBreakerTests: XCTestCase {
  func testOpensAfterThreshold() async {
    let cb = CircuitBreaker(threshold: 2, resetAfter: 60)
    cb.recordFailure()
    XCTAssertFalse(cb.isOpen)
    cb.recordFailure()
    XCTAssertTrue(cb.isOpen)
  }

  func testClosedAllowsRequests() {
    let cb = CircuitBreaker(threshold: 5, resetAfter: 60)
    XCTAssertFalse(cb.isOpen)
  }
}
```

Run: Cmd+U → FAIL.

- [ ] **Step 2: Implement CircuitBreaker.swift**

```swift
// HyperBotAgent/CircuitBreaker.swift
import Foundation

class CircuitBreaker {
  private let threshold: Int
  private let resetAfter: TimeInterval
  private var failureCount = 0
  private var openedAt: Date?

  init(threshold: Int, resetAfter: TimeInterval) {
    self.threshold = threshold
    self.resetAfter = resetAfter
  }

  var isOpen: Bool {
    guard let openedAt else { return false }
    if Date().timeIntervalSince(openedAt) > resetAfter {
      failureCount = 0
      self.openedAt = nil
      return false
    }
    return true
  }

  func recordFailure() {
    failureCount += 1
    if failureCount >= threshold { openedAt = Date() }
  }

  func recordSuccess() { failureCount = 0; openedAt = nil }
}
```

- [ ] **Step 3: Write ClaudeBridge cookie test**

```swift
// ClaudeBridgeTests.swift
final class ClaudeBridgeTests: XCTestCase {
  func testCookiePathExists() {
    // Verify the cookies file path is correct
    let path = ClaudeBridge.cookiesDbPath
    // Path must point to expected location
    XCTAssertTrue(path.contains("Claude/Cookies"))
  }
}
```

Run: Cmd+U → FAIL.

- [ ] **Step 4: Implement ClaudeBridge.swift**

```swift
// HyperBotAgent/ClaudeBridge.swift
import Foundation
import GRDB

struct ClaudeSession {
  let orgId: String
  let cookies: [HTTPCookie]
}

enum ClaudeError: Error {
  case authFailed
  case apiChanged
  case rateLimited
  case circuitOpen
}

class ClaudeBridge {
  static let cookiesDbPath: String = {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Claude/Cookies").path
  }()

  private let breaker = CircuitBreaker(threshold: 5, resetAfter: 300)

  // Read session cookies from Claude Desktop's SQLite Cookies file
  func loadCookies() throws -> [HTTPCookie] {
    let db = try DatabaseQueue(path: ClaudeBridge.cookiesDbPath)
    let rows = try db.read { db in
      try Row.fetchAll(db, sql: "SELECT name, value, host_key, path, is_secure FROM cookies WHERE host_key LIKE '%claude.ai'")
    }
    return rows.compactMap { row in
      HTTPCookie(properties: [
        .name: row["name"] as String,
        .value: row["value"] as String,
        .domain: row["host_key"] as String,
        .path: row["path"] as String,
        .secure: (row["is_secure"] as Int) == 1 ? "TRUE" : "FALSE",
      ])
    }
  }

  // Get organization ID
  func fetchOrgId(cookies: [HTTPCookie]) async throws -> String {
    guard !breaker.isOpen else { throw ClaudeError.circuitOpen }
    let url = URL(string: "https://claude.ai/api/organizations")!
    let data = try await apiGet(url: url, cookies: cookies)
    breaker.recordSuccess()
    guard let orgs = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
          let id = orgs.first?["id"] as? String else { throw ClaudeError.apiChanged }
    return id
  }

  // Send message + stream SSE response
  func sendMessage(orgId: String, chatId: String, message: String,
                   cookies: [HTTPCookie], onChunk: @escaping (String) -> Void) async throws {
    guard !breaker.isOpen else { throw ClaudeError.circuitOpen }
    let url = URL(string: "https://claude.ai/api/organizations/\(orgId)/chat_conversations/\(chatId)/completion")!
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(agentVersion, forHTTPHeaderField: "X-Agent-Version")
    req.httpBody = try JSONSerialization.data(withJSONObject: ["prompt": message, "timezone": TimeZone.current.identifier])
    HTTPCookieStorage.shared.setCookies(cookies, for: url, mainDocumentURL: nil)

    let (bytes, response) = try await URLSession.shared.bytes(for: req)
    guard let http = response as? HTTPURLResponse else { throw ClaudeError.apiChanged }
    try handleStatus(http.statusCode)

    for try await line in bytes.lines {
      if line.hasPrefix("data: ") {
        let chunk = String(line.dropFirst(6))
        if chunk == "[DONE]" { break }
        if let json = try? JSONSerialization.jsonObject(with: Data(chunk.utf8)) as? [String: Any],
           let text = json["completion"] as? String {
          onChunk(text)
        }
      }
    }
    breaker.recordSuccess()
  }

  private func apiGet(url: URL, cookies: [HTTPCookie]) async throws -> Data {
    var req = URLRequest(url: url)
    req.setValue(agentVersion, forHTTPHeaderField: "X-Agent-Version")
    HTTPCookieStorage.shared.setCookies(cookies, for: url, mainDocumentURL: nil)
    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw ClaudeError.apiChanged }
    try handleStatus(http.statusCode)
    return data
  }

  private func handleStatus(_ code: Int) throws {
    switch code {
    case 200...299: return
    case 401, 403: breaker.recordFailure(); throw ClaudeError.authFailed
    case 404:       breaker.recordFailure(); throw ClaudeError.apiChanged
    case 429:       throw ClaudeError.rateLimited
    default:        breaker.recordFailure(); throw ClaudeError.apiChanged
    }
  }

  private let agentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
}
```

- [ ] **Step 5: Run tests**

Cmd+U.

- [ ] **Step 6: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): Claude Desktop bridge — cookie extraction, SSE, circuit breaker"
```

---

## Task A9: Action executors + CommandRouter

**Files:**
- Create: `HyperBotAgent/BashExecutor.swift`
- Create: `HyperBotAgent/AppleScriptExecutor.swift`
- Create: `HyperBotAgent/PlaywrightExecutor.swift`
- Create: `HyperBotAgent/CommandRouter.swift`
- Create: `HyperBotAgentTests/CommandRouterTests.swift`

- [ ] **Step 1: Write failing test**

```swift
// CommandRouterTests.swift
final class CommandRouterTests: XCTestCase {
  func testUnknownCommandReturnsError() async {
    let router = CommandRouter(bridge: ClaudeBridge())
    let cmd = AgentCommand(id: "x", type: "unknown_tool", payload: [:], timeoutMs: nil)
    let response = await router.route(cmd)
    XCTAssertEqual(response.type, "error")
  }
}
```

Run: Cmd+U → FAIL.

- [ ] **Step 2: Implement BashExecutor.swift**

```swift
// HyperBotAgent/BashExecutor.swift
import Foundation

struct BashResult { let stdout: String; let stderr: String; let exitCode: Int32 }

struct BashExecutor {
  static func run(command: String, timeoutMs: Int?) async -> BashResult {
    await withCheckedContinuation { continuation in
      let proc = Process()
      proc.executableURL = URL(fileURLWithPath: "/bin/bash")
      proc.arguments = ["-c", command]

      let outPipe = Pipe(); let errPipe = Pipe()
      proc.standardOutput = outPipe; proc.standardError = errPipe

      try? proc.run()

      if let ms = timeoutMs {
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(ms)) {
          if proc.isRunning { proc.terminate() }
        }
      }

      proc.waitUntilExit()
      let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      // Truncate to 50KB
      let maxBytes = 50 * 1024
      continuation.resume(returning: BashResult(
        stdout: String(out.prefix(maxBytes)),
        stderr: String(err.prefix(maxBytes)),
        exitCode: proc.terminationStatus
      ))
    }
  }
}
```

- [ ] **Step 3: Implement AppleScriptExecutor.swift**

```swift
// HyperBotAgent/AppleScriptExecutor.swift
import Foundation

struct AppleScriptExecutor {
  static func run(script: String) async -> (result: String, error: String?) {
    await withCheckedContinuation { continuation in
      var error: NSDictionary?
      let appleScript = NSAppleScript(source: script)
      let output = appleScript?.executeAndReturnError(&error)
      let result = output?.stringValue ?? ""
      let errMsg = error?[NSAppleScript.errorMessage] as? String
      continuation.resume(returning: (result, errMsg))
    }
  }
}
```

- [ ] **Step 4: Implement PlaywrightExecutor.swift**

```swift
// HyperBotAgent/PlaywrightExecutor.swift
// Calls a bundled Node.js script that runs Playwright actions
// The Node binary + playwright are bundled in the app's Resources folder

struct PlaywrightExecutor {
  static func run(action: String, params: [String: Any], timeoutMs: Int?) async -> BashResult {
    guard let nodePath = Bundle.main.path(forResource: "node", ofType: nil),
          let scriptPath = Bundle.main.path(forResource: "playwright-runner", ofType: "js") else {
      return BashResult(stdout: "", stderr: "Playwright not bundled", exitCode: 1)
    }
    let paramsJson = (try? JSONSerialization.data(withJSONObject: ["action": action, "params": params]))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return await BashExecutor.run(command: "\(nodePath) \(scriptPath) '\(paramsJson)'", timeoutMs: timeoutMs)
  }
}
```

- [ ] **Step 5: Implement CommandRouter.swift**

```swift
// HyperBotAgent/CommandRouter.swift
import Foundation

class CommandRouter {
  private let bridge: ClaudeBridge

  init(bridge: ClaudeBridge) { self.bridge = bridge }

  func route(_ cmd: AgentCommand) async -> AgentResponse {
    do {
      switch cmd.type {
      case "bash_execute":
        let command = cmd.payload["command"] as? String ?? ""
        let result = await BashExecutor.run(command: command, timeoutMs: cmd.timeoutMs)
        let output = result.stdout + (result.stderr.isEmpty ? "" : "\nSTDERR: \(result.stderr)")
        return AgentResponse(id: cmd.id, type: "done", text: nil, data: output, exitCode: Int(result.exitCode))

      case "applescript_run":
        let script = cmd.payload["script"] as? String ?? ""
        let (result, error) = await AppleScriptExecutor.run(script: script)
        if let error { return AgentResponse(id: cmd.id, type: "error", error: error) }
        return AgentResponse(id: cmd.id, type: "done", data: result, exitCode: 0)

      case "playwright_action":
        let action = cmd.payload["action"] as? String ?? ""
        let params = cmd.payload["params"] as? [String: Any] ?? [:]
        let result = await PlaywrightExecutor.run(action: action, params: params, timeoutMs: cmd.timeoutMs)
        return AgentResponse(id: cmd.id, type: "done", data: result.stdout, exitCode: Int(result.exitCode))

      case "claude_chat", "claude_new_chat", "claude_open_chat",
           "claude_list_chats", "claude_list_projects", "claude_artifact":
        return try await routeClaudeCommand(cmd)

      default:
        return AgentResponse(id: cmd.id, type: "error", error: "Unknown command: \(cmd.type)")
      }
    } catch {
      return AgentResponse(id: cmd.id, type: "error", error: error.localizedDescription)
    }
  }

  private func routeClaudeCommand(_ cmd: AgentCommand) async throws -> AgentResponse {
    let cookies = try bridge.loadCookies()
    // Implement each claude_* command against ClaudeBridge methods
    // Returns AgentResponse with data = JSON-encoded result
    return AgentResponse(id: cmd.id, type: "done", data: "[]", exitCode: 0)
  }
}
```

- [ ] **Step 6: Run tests**

Cmd+U.

- [ ] **Step 7: Wire CommandRouter into AppState message handler**

In `AppState.handleMessage`, route AgentCommand messages to `commandRouter.route(cmd)`, then send the response back via `wsClient.send(...)`.

- [ ] **Step 8: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): bash, AppleScript, Playwright executors + CommandRouter"
```

---

## Task A10: DMG packaging

**Files:**
- Create: `packages/agent-macos/scripts/make-dmg.sh`

- [ ] **Step 1: Install create-dmg**
```bash
brew install create-dmg
```

- [ ] **Step 2: Build release archive in Xcode**

Product → Archive → Distribute App → Copy App → choose output folder `build/`

- [ ] **Step 3: Create make-dmg.sh**

```bash
#!/bin/bash
# packages/agent-macos/scripts/make-dmg.sh
set -e
APP="build/HyperBotAgent.app"
OUT="build/HyperBotAgent.dmg"

create-dmg \
  --volname "HyperBot Agent" \
  --volicon "$APP/Contents/Resources/AppIcon.icns" \
  --window-pos 200 120 \
  --window-size 540 380 \
  --icon-size 128 \
  --icon "HyperBotAgent.app" 130 180 \
  --hide-extension "HyperBotAgent.app" \
  --app-drop-link 410 180 \
  "$OUT" \
  "$APP"

echo "Created: $OUT"
```

- [ ] **Step 4: Run script and verify DMG**
```bash
chmod +x packages/agent-macos/scripts/make-dmg.sh
./packages/agent-macos/scripts/make-dmg.sh
```

Open the resulting .dmg — should show app icon + arrow + Applications shortcut.

- [ ] **Step 5: Commit**
```bash
git add packages/agent-macos/scripts/make-dmg.sh
git commit -m "feat(agent-macos): DMG packaging with create-dmg"
```

---

## Acceptance Criteria (macOS Agent)

- [ ] App launches with no dock icon, only tray icon
- [ ] First launch: wizard window opens, shows pairing code
- [ ] `/activate code` in Telegram → tray turns green, wizard closes
- [ ] Tray menu: status, launch-at-login toggle works, disconnect re-shows wizard
- [ ] Launch at login enabled by default after first setup
- [ ] Reconnect: kill bot server, restart → agent reconnects automatically
- [ ] `bash_execute` command returns stdout/exitCode correctly
- [ ] `applescript_run` executes script and returns result
- [ ] Claude Desktop bridge reads cookies (requires Claude Desktop installed + logged in)
- [ ] `make-dmg.sh` produces a valid .dmg with drag-to-Applications layout
