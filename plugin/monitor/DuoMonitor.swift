// claude-duo monitor: a small window showing both accounts' quota. It behaves like
// any other app (Dock icon, Cmd+Tab, goes behind other apps); the pin button keeps
// it on top of everything instead.
// Built by `duo monitor` into ~/.claude-duo/bin/ClaudeDuoMonitor.app with:
//   xcrun swiftc -O -parse-as-library -o duo-monitor DuoMonitor.swift
// Usage: duo-monitor <node> <duo.mjs>. SIGUSR1 brings the window to the front.
// It runs `node duo.mjs quota --watch` and draws each JSON line it prints.
// Lines written to the child's stdin: "refresh" (fresh quota request),
// "use A|B" (plain `claude` opens that account), "mode manual|auto", "threshold N".
import AppKit
import SwiftUI

// MARK: - Data (mirrors QuotaWatcher.snapshot() in plugin/lib/quota.mjs)

struct Bar: Decodable, Hashable {
    let pct: Int
    let resets_at: String?
    let label: String?
}

struct Quota: Decodable {
    let ok: Bool?
    let error: String?
    let plan: String?
    let session: Bar?
    let weekly: Bar?
    let scoped: [Bar]?
    let stale: Bool?
    let fetched_at: String?
}

struct Tokens: Decodable {
    let input: Int
    let output: Int
    let messages: Int
}

struct Peer: Decodable {
    let name: String
    let quota: Quota?
    let state: String?
    let sessions: Int?
    let open_tasks: Int?
    let working_on: [String]?
    let tokens_5h: Tokens?
    let last_activity_at: String?
}

/// Which account a plain `claude` opens (plugin/lib/switch.mjs).
struct SwitchState: Decodable {
    let active: String
    let mode: String
    let threshold: Int
    let changed_at: String?
    let reason: String?
}

struct Snapshot: Decodable {
    let at: String
    let peers: [String: Peer]
    let sw: SwitchState?
    enum CodingKeys: String, CodingKey { case at, peers, sw = "switch" }
}

func parseDate(_ s: String?) -> Date? {
    guard let s = s else { return nil }
    // The API sends 6 fractional digits ("…00.403464+00:00"): drop them.
    let plain = s.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
    return ISO8601DateFormatter().date(from: plain)
}

// MARK: - Child process

final class Store: ObservableObject {
    @Published var snap: Snapshot?
    @Published var lastLine: Date?
    @Published var compact: Bool = UserDefaults.standard.bool(forKey: "compact") {
        didSet { UserDefaults.standard.set(compact, forKey: "compact") }
    }
    @Published var pinned: Bool = UserDefaults.standard.bool(forKey: "pinned") {
        didSet { UserDefaults.standard.set(pinned, forKey: "pinned"); onPin?(pinned) }
    }
    @Published var problem: String?
    var onSize: ((CGSize) -> Void)?
    var onPin: ((Bool) -> Void)?

    private var proc: Process?
    private var input: Pipe?
    private var buffer = Data()
    private var quitting = false
    private let node: String
    private let duo: String

    init(node: String, duo: String) {
        self.node = node
        self.duo = duo
    }

    func start() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [duo, "quota", "--watch"]
        let out = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardInput = inp
        p.standardError = FileHandle.nullDevice
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { return }
            DispatchQueue.main.async { self?.consume(d) }
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.problem = "Lost connection to duo, restarting…"
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.start() }
            }
        }
        do {
            try p.run()
            proc = p
            input = inp
        } catch {
            problem = "Could not start node: \(error.localizedDescription)"
        }
    }

    private func consume(_ d: Data) {
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let s = try? JSONDecoder().decode(Snapshot.self, from: line) {
                snap = s
                lastLine = Date()
                problem = nil
            }
        }
    }

    private func send(_ line: String) {
        input?.fileHandleForWriting.write("\(line)\n".data(using: .utf8)!)
    }

    func refresh() { send("refresh") }
    func use(_ peer: String) { send("use \(peer)") }
    func setMode(_ mode: String) { send("mode \(mode)") }
    func setThreshold(_ t: Int) { send("threshold \(t)") }

    func stop() {
        quitting = true
        try? input?.fileHandleForWriting.close()
        proc?.terminate()
    }
}

// MARK: - Views

func barColor(_ pct: Int) -> Color {
    pct >= 90 ? .red : pct >= 70 ? .orange : .green
}

func shortReset(_ iso: String?, now: Date) -> String {
    guard let d = parseDate(iso) else { return "" }
    let m = max(0, Int(d.timeIntervalSince(now) / 60))
    if m < 60 { return "\(m)m" }
    if m < 48 * 60 { return String(format: "%dh%02d", m / 60, m % 60) }
    return "\(m / 1440)d\((m % 1440) / 60)h"
}

func fullReset(_ iso: String?) -> String {
    guard let d = parseDate(iso) else { return "" }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US")
    f.dateFormat = "EEE MMM d, HH:mm"
    return "Resets \(f.string(from: d))"
}

func fmtTokens(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1e6) }
    if n >= 1_000 { return "\(n / 1000)k" }
    return "\(n)"
}

let stateText = ["busy": "working", "awaiting_user": "needs you", "idle": "idle", "offline": "closed"]
let stateColor: [String: Color] = ["busy": .green, "awaiting_user": .orange, "idle": .blue, "offline": .gray]

func errorText(_ code: String, peer: String) -> String {
    let cmd = peer == "B" ? "claude-b" : "claude"
    switch code {
    case "token_expired": return "Login expired · open \(cmd) once to refresh"
    case "not_logged_in": return "Not logged in · run \(cmd), then /login"
    case "keychain": return "Cannot read the Keychain"
    case "rate_limited": return "Too many requests · retrying in 5 min"
    case "network": return "Cannot reach Anthropic"
    default: return "Error \(code)"
    }
}

struct Meter: View {
    let label: String
    let bar: Bar
    let now: Date
    let dim: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 42, alignment: .leading)
                .lineLimit(1)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule().fill(barColor(bar.pct))
                        .frame(width: max(4, g.size.width * CGFloat(min(100, max(0, bar.pct))) / 100))
                }
            }
            .frame(height: 6)
            Text("\(bar.pct)%")
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .frame(width: 38, alignment: .trailing)
            Text(shortReset(bar.resets_at, now: now))
                .font(.system(size: 11).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 40, alignment: .trailing)
        }
        .opacity(dim ? 0.45 : 1)
        .help(fullReset(bar.resets_at))
    }
}

func peerColor(_ k: String) -> Color { k == "A" ? .blue : .purple }

struct Badge: View {
    let letter: String
    var active: Bool = false
    var body: some View {
        Text(letter)
            .font(.system(size: 13, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: 26, height: 26)
            .background(RoundedRectangle(cornerRadius: 7).fill(peerColor(letter)))
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .stroke(peerColor(letter), lineWidth: 2)
                    .padding(-3)
                    .opacity(active ? 1 : 0)
            )
    }
}

/// "IN USE" tag next to the account a plain `claude` opens.
struct InUsePill: View {
    let peer: String
    var body: some View {
        Text("IN USE")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Capsule().fill(peerColor(peer)))
            .help("A plain `claude` in any terminal opens this account")
    }
}

struct StateDot: View {
    let state: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(stateColor[state] ?? .gray).frame(width: 7, height: 7)
            Text(stateText[state] ?? state).font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }
}

struct PeerCard: View {
    let key_: String
    let peer: Peer
    let now: Date
    var active: Bool = false
    var onUse: () -> Void = {}
    @State private var hover = false

    var body: some View {
        Button(action: { if !active { onUse() } }) { content }
            .buttonStyle(.plain)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(active ? peerColor(key_).opacity(0.10) : Color.primary.opacity(hover ? 0.05 : 0))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
            )
            .onHover { hover = $0 }
            .help(active ? "In use: a plain `claude` opens this account" : "Click to use this account for `claude` (open sessions keep theirs)")
    }

    @ViewBuilder var content: some View {
        let q = peer.quota
        let dim = q?.ok != true
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 9) {
                Badge(letter: key_, active: active)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        Text(peer.name == key_ ? "Account \(key_)" : peer.name)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        if active { InUsePill(peer: key_) }
                        if hover && !active {
                            Text("Use").font(.system(size: 10, weight: .semibold)).foregroundStyle(peerColor(key_))
                        }
                    }
                    Text(q?.plan ?? "—").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                StateDot(state: peer.state ?? "offline")
            }
            if let e = q?.error {
                Label(errorText(e, peer: key_), systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
            }
            if let s = q?.session { Meter(label: "5h", bar: s, now: now, dim: dim) }
            if let w = q?.weekly { Meter(label: "Week", bar: w, now: now, dim: dim) }
            ForEach(q?.scoped ?? [], id: \.self) { b in
                Meter(label: b.label ?? "", bar: b, now: now, dim: dim)
            }
            if q?.session == nil && q?.error == nil {
                Text("Loading…").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                if let t = peer.tokens_5h {
                    Text("Tokens: \(fmtTokens(t.output))")
                        .help("Output tokens in the last 5 hours")
                }
                if let n = peer.open_tasks, n > 0 {
                    Text("· \(n) duo task\(n == 1 ? "" : "s")")
                }
                Spacer()
            }
            .font(.system(size: 10.5))
            .foregroundStyle(.tertiary)
            if let w = peer.working_on?.first {
                Text("▸ \(w)").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// Compact mode: just the account badge, with a dot for its state.
/// Hover shows the numbers; clicking opens the full view.
struct CompactIcon: View {
    let key_: String
    let peer: Peer?
    var active: Bool = false

    var summary: String {
        guard let p = peer else { return key_ }
        var parts = ["\(key_)\(active ? " (in use)" : "") · \(stateText[p.state ?? "offline"] ?? "")"]
        if let s = p.quota?.session { parts.append("5h \(s.pct)%") }
        if let w = p.quota?.weekly { parts.append("Week \(w.pct)%") }
        if let e = p.quota?.error { parts.append(errorText(e, peer: key_)) }
        if !active { parts.append("click to use for `claude`") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        Badge(letter: key_, active: active)
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(stateColor[peer?.state ?? "offline"] ?? .gray)
                    .frame(width: 9, height: 9)
                    .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
                    .offset(x: 3, y: 3)
            }
            .help(summary)
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    var size: CGFloat = 22
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.5, weight: .semibold))
                .frame(width: size, height: size)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help(help)
    }
}

/// Bottom bar: which account `claude` opens, Manual / Auto, and the auto threshold.
struct SwitchBar: View {
    @ObservedObject var store: Store
    let sw: SwitchState
    let name: String
    let now: Date

    var recentlyChanged: Bool {
        guard let d = parseDate(sw.changed_at) else { return false }
        return now.timeIntervalSince(d) < 12
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Image(systemName: "terminal").font(.system(size: 11)).foregroundStyle(.secondary)
                Text("claude → \(sw.active)")
                    .font(.system(size: 11, weight: .semibold).monospaced())
                    .help("A plain `claude` in any terminal opens account \(sw.active) (\(name))")
                Spacer()
                if sw.mode == "auto" {
                    Menu {
                        ForEach([70, 80, 90, 95, 100], id: \.self) { t in
                            Button("Switch at \(t)%\(t == sw.threshold ? "  ✓" : "")") { store.setThreshold(t) }
                        }
                    } label: {
                        Text("at \(sw.threshold)%").font(.system(size: 11))
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Switch when the account in use reaches this much of its 5h or weekly limit")
                }
                Picker("", selection: Binding(get: { sw.mode }, set: { store.setMode($0) })) {
                    Text("Manual").tag("manual")
                    Text("Auto").tag("auto")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()
                .help("Manual: click an account above to switch. Auto: move to the other account when this one is nearly used up.")
            }
            if recentlyChanged {
                Text((sw.reason ?? "").hasPrefix("auto")
                     ? "Auto-switched to \(sw.active). The next `claude` uses it; open sessions keep their account."
                     : "The next `claude` you start uses \(sw.active). Open sessions keep their account.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

struct MonitorView: View {
    @ObservedObject var store: Store

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let now = ctx.date
            if store.compact {
                // Click an icon (or ↗) to expand; drag the space around them to move the window.
                HStack(spacing: 10) {
                    ForEach(["A", "B"], id: \.self) { k in
                        CompactIcon(key_: k, peer: store.snap?.peers[k], active: store.snap?.sw?.active == k)
                            .onTapGesture { if store.snap?.sw?.active != k { store.use(k) } }
                    }
                    VStack(spacing: 0) {
                        IconButton(symbol: "arrow.up.left.and.arrow.down.right", help: "Expand", size: 16) { store.compact = false }
                        IconButton(symbol: "xmark", help: "Quit", size: 16) { NSApp.terminate(nil) }
                    }
                    .padding(.leading, -2)
                }
                .padding(.leading, 12)
                .padding(.trailing, 6)
                .padding(.vertical, 9)
            } else {
            VStack(spacing: 0) {
                header
                Divider()
                if let snap = store.snap {
                    ForEach(["A", "B"], id: \.self) { k in
                        if let p = snap.peers[k] {
                            PeerCard(key_: k, peer: p, now: now, active: snap.sw?.active == k) { store.use(k) }
                            if k == "A" { Divider().padding(.horizontal, 14) }
                        }
                    }
                    if let sw = snap.sw {
                        Divider()
                        SwitchBar(store: store, sw: sw, name: snap.peers[sw.active]?.name ?? sw.active, now: now)
                    }
                } else {
                    Text(store.problem ?? "Starting…")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .padding(20)
                }
                // Only shown when updates stop arriving.
                if let msg = problemText(now: now) {
                    Divider()
                    HStack(spacing: 6) {
                        Circle().fill(Color.red).frame(width: 6, height: 6)
                        Text(msg)
                        Spacer()
                    }
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .frame(height: 28)
                }
            }
            .frame(width: 320)
            }
        }
        .fixedSize()
        .background(GeometryReader { g in
            Color.clear
                .onAppear { store.onSize?(g.size) }
                .onChange(of: g.size) { store.onSize?($0) }
        })
        .ignoresSafeArea() // draw into the (hidden) title bar area
    }

    var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "gauge.with.dots.needle.33percent")
                .font(.system(size: 13, weight: .semibold))
            Text("claude-duo").font(.system(size: 13, weight: .semibold))
            Spacer()
            IconButton(symbol: store.pinned ? "pin.fill" : "pin",
                       help: store.pinned ? "Pinned on top · click to unpin" : "Pin: keep on top of other windows") { store.pinned.toggle() }
            IconButton(symbol: "arrow.clockwise", help: "Refresh quota now") { store.refresh() }
            IconButton(symbol: store.compact ? "arrow.up.left.and.arrow.down.right" : "arrow.down.right.and.arrow.up.left",
                       help: store.compact ? "Expand" : "Compact") { store.compact.toggle() }
            IconButton(symbol: "xmark", help: "Quit") { NSApp.terminate(nil) }
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .frame(height: 34)
    }

    func problemText(now: Date) -> String? {
        if let p = store.problem { return p }
        guard store.snap != nil else { return nil }
        let late = store.lastLine.map { now.timeIntervalSince($0) > 90 } ?? true
        return late ? "No updates from duo" : nil
    }
}

// MARK: - Window

func appIcon() -> NSImage {
    NSImage(size: NSSize(width: 512, height: 512), flipped: false) { r in
        let bg = NSBezierPath(roundedRect: r.insetBy(dx: 50, dy: 50), xRadius: 92, yRadius: 92)
        NSGradient(starting: .systemBlue, ending: .systemPurple)?.draw(in: bg, angle: -60)
        let cfg = NSImage.SymbolConfiguration(pointSize: 230, weight: .semibold)
            .applying(.init(paletteColors: [.white]))
        if let sym = NSImage(systemSymbolName: "gauge.with.dots.needle.33percent", accessibilityDescription: nil)?
            .withSymbolConfiguration(cfg) {
            let s = sym.size
            sym.draw(in: NSRect(x: (r.width - s.width) / 2, y: (r.height - s.height) / 2, width: s.width, height: s.height))
        }
        return true
    }
}

func mainMenu() -> NSMenu {
    let menu = NSMenu()
    let appItem = NSMenuItem()
    menu.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Hide claude-duo", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit claude-duo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    let winItem = NSMenuItem()
    menu.addItem(winItem)
    let winMenu = NSMenu(title: "Window")
    winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
    winMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    winItem.submenu = winMenu
    return menu
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var store: Store!

    func applicationDidFinishLaunching(_ n: Notification) {
        let args = CommandLine.arguments
        guard args.count >= 3 else {
            FileHandle.standardError.write("usage: duo-monitor <node> <duo.mjs>\n".data(using: .utf8)!)
            exit(2)
        }
        NSApp.applicationIconImage = appIcon()
        NSApp.mainMenu = mainMenu()
        store = Store(node: args[1], duo: args[2])

        let host = NSHostingController(rootView: MonitorView(store: store))
        host.sizingOptions = []
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 300),
                          styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.contentViewController = host
        window.title = "claude-duo"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(b)?.isHidden = true
        }
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        applyPin(store.pinned)
        store.onPin = { [weak self] on in self?.applyPin(on) }

        // Size always follows the content (reported by MonitorView); the top edge stays put.
        // Only the top-left corner is remembered between runs.
        store.onSize = { [weak self] size in
            guard let w = self?.window, size.width > 0, size.height > 0 else { return }
            let top = w.frame.maxY
            w.setFrame(NSRect(x: w.frame.minX, y: top - size.height, width: size.width, height: size.height), display: true)
        }
        let d = UserDefaults.standard
        if d.object(forKey: "topLeftX") != nil {
            window.setFrameTopLeftPoint(NSPoint(x: d.double(forKey: "topLeftX"), y: d.double(forKey: "topLeftY")))
        } else if let screen = NSScreen.main {
            let v = screen.visibleFrame
            window.setFrameTopLeftPoint(NSPoint(x: v.maxX - 340, y: v.maxY - 16))
        }
        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: window, queue: .main) { [weak self] _ in
            guard let f = self?.window.frame else { return }
            d.set(f.minX, forKey: "topLeftX")
            d.set(f.maxY, forKey: "topLeftY")
        }
        store.start()
        bringToFront()
    }

    /// Pinned: above every window, on every Space. Otherwise an ordinary window.
    func applyPin(_ on: Bool) {
        window.level = on ? .floating : .normal
        window.collectionBehavior = on ? [.canJoinAllSpaces, .fullScreenAuxiliary] : []
    }

    func bringToFront() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Clicking the Dock icon shows the window again.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        bringToFront()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ n: Notification) {
        store?.stop()
    }
}

@main
enum DuoMonitorApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular) // Dock icon + Cmd+Tab, like any app
        // `duo monitor stop` sends SIGTERM: quit cleanly so the child exits too.
        // `duo monitor` while running sends SIGUSR1: come to the front.
        signal(SIGTERM, SIG_IGN)
        signal(SIGUSR1, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { NSApp.terminate(nil) }
        term.resume()
        let front = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        front.setEventHandler { delegate.bringToFront() }
        front.resume()
        app.run()
        _ = (term, front)
    }
}
