import Foundation

public enum InviteError: LocalizedError {
  case invalid
  public var errorDescription: String? { "Paste a complete Watch Party /join/ link." }
}

public struct WatchPartyInvite: Equatable, Sendable {
  public let url: URL
  public let key: String

  public init(_ url: URL) throws {
    let parts = url.path.split(separator: "/").map(String.init)
    guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
          parts.count == 2, parts[0] == "join",
          parts[1].range(of: "^[A-Za-z0-9]{16,64}$", options: .regularExpression) != nil else { throw InviteError.invalid }
    self.url = url
    key = parts[1]
  }

  public init(_ text: String) throws {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw InviteError.invalid }
    try self.init(url)
  }

  public var webSocketURL: URL {
    var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    c.scheme = c.scheme == "https" ? "wss" : "ws"
    c.path = "/ws"
    c.queryItems = [URLQueryItem(name: "k", value: key)]
    c.fragment = nil
    return c.url!
  }

  public func resourceURL(_ path: String, clientID: String) -> URL? {
    guard path.hasPrefix("/"), var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    c.path = path
    c.queryItems = [URLQueryItem(name: "k", value: key), URLQueryItem(name: "c", value: clientID)]
    c.fragment = nil
    return c.url
  }
}

public struct RoomState: Codable, Equatable, Sendable {
  public let movieId: String?
  public let playing: Bool
  public let position: Double
  public let anchor: Double
  public let seq: Int
  public let waiting: Bool?

  public func expectedTime(serverNow: Double) -> Double {
    max(0, position + (playing && waiting != true ? max(0, serverNow - anchor) / 1_000 : 0))
  }
}

public struct RoomMovie: Codable, Equatable, Sendable {
  public let kind: String
  public let id: String
  public let title: String
  public let duration: Double?
  public let url: String
  public let hls: String?
}

struct RoomEnvelope: Decodable {
  let type: String
  let state: RoomState?
  let movie: RoomMovie?
  let reason: String?
  let t0: Double?
  let ts: Double?
}

public struct RoomClock: Sendable {
  public private(set) var offset = 0.0
  public private(set) var rtt = 0.0
  private var samples: [(rtt: Double, offset: Double)] = []

  public init() {}

  public mutating func sample(sent: Double, server: Double, received: Double) {
    let latency = received - sent
    guard latency >= 0, latency <= 10_000 else { return }
    samples.append((latency, server - (sent + received) / 2))
    if samples.count > 12 { samples.removeFirst() }
    let best = samples.sorted { $0.rtt < $1.rtt }.prefix(4)
    offset = best.reduce(0) { $0 + $1.offset } / Double(best.count)
    rtt = best.first?.rtt ?? 0
  }

  public func now(local: Double = Date().timeIntervalSince1970 * 1_000) -> Double { local + offset }
}
