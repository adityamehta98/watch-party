import Combine
import Foundation

@MainActor
public final class RoomClient: ObservableObject {
  public enum Status: String { case idle, connecting, waiting, connected, failed }

  @Published public private(set) var status: Status = .idle
  @Published public private(set) var movie: RoomMovie?
  @Published public private(set) var state: RoomState?
  @Published public private(set) var errorMessage = ""
  public private(set) var invite: WatchPartyInvite?
  public let clientID = UUID().uuidString

  private var clock = RoomClock()
  private var socket: URLSessionWebSocketTask?
  private var session: URLSession?
  private var connectionTask: Task<Void, Never>?
  private var pingTask: Task<Void, Never>?

  public init() {}

  public func connect(invite text: String, name: String) {
    disconnect()
    errorMessage = ""
    do { invite = try WatchPartyInvite(text) } catch { errorMessage = error.localizedDescription; status = .failed; return }
    status = .connecting
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    let session = URLSession(configuration: config)
    let socket = session.webSocketTask(with: invite!.webSocketURL)
    self.session = session
    self.socket = socket
    socket.resume()
    send(["type": "hello", "clientId": clientID, "name": String(name.prefix(32)), "capabilities": ["hls": true, "mse": false]])
    connectionTask = Task { [weak self] in await self?.receive(from: socket) }
    pingTask = Task { [weak self] in
      for _ in 0..<6 {
        guard let self, !Task.isCancelled else { return }
        self.send(["type": "ping", "t0": Self.now()])
        try? await Task.sleep(nanoseconds: 150_000_000)
      }
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        guard let self else { return }
        self.send(["type": "ping", "t0": Self.now()])
      }
    }
  }

  public func disconnect() {
    connectionTask?.cancel(); pingTask?.cancel()
    socket?.cancel(with: .goingAway, reason: nil)
    session?.invalidateAndCancel()
    connectionTask = nil; pingTask = nil; socket = nil; session = nil
    movie = nil; state = nil
    if status != .failed { status = .idle }
  }

  public func command(_ action: String, position: Double) {
    send(["type": "cmd", "action": action, "position": max(0, position), "at": clock.now()])
  }

  public func report(buffering: Bool, ahead: Double, drift: Double, sequence: Int) {
    send(["type": "status", "status": ["loaded": movie != nil, "ready": !buffering, "buffering": buffering,
      "ahead": max(0, ahead), "drift": drift * 1_000, "health": min(100, ahead * 12.5), "rtt": clock.rtt,
      "rate": 1, "stalls": 0, "dev": "Apple native", "seq": sequence]])
  }

  public func serverNow() -> Double { clock.now() }

  private func receive(from task: URLSessionWebSocketTask) async {
    do {
      while !Task.isCancelled, task === socket {
        let message = try await task.receive()
        let data: Data
        switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: continue }
        let envelope = try JSONDecoder().decode(RoomEnvelope.self, from: data)
        handle(envelope)
      }
    } catch {
      guard !Task.isCancelled, task === socket else { return }
      errorMessage = "Connection lost. Check the invite link and use Safari if its certificate is not trusted."
      status = .failed
    }
  }

  private func handle(_ message: RoomEnvelope) {
    switch message.type {
    case "welcome": state = message.state; movie = message.movie; status = .connected
    case "pending": status = .waiting
    case "state": state = message.state
    case "movie": movie = message.movie
    case "pong": if let sent = message.t0, let server = message.ts { clock.sample(sent: sent, server: server, received: Self.now()) }
    case "denied": errorMessage = message.reason ?? "The room did not admit this device."; status = .failed
    default: break
    }
  }

  private func send(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object),
          let text = String(data: data, encoding: .utf8), let socket else { return }
    Task { try? await socket.send(.string(text)) }
  }

  private static func now() -> Double { Date().timeIntervalSince1970 * 1_000 }
}
