import Combine
import Foundation
import GroupActivities

public struct WatchPartyActivity: GroupActivity {
  public static let activityIdentifier = "io.github.adityamehta98.watchparty.shared-room"
  public let invite: URL
  public let title: String

  public init(invite: URL, title: String) { self.invite = invite; self.title = title }

  public var metadata: GroupActivityMetadata {
    var value = GroupActivityMetadata()
    value.title = title
    value.subtitle = "Watch together in sync"
    value.type = .watchTogether
    return value
  }
}

@MainActor
public final class SharePlayCoordinator: ObservableObject {
  @Published public private(set) var pendingInvite: URL?
  @Published public private(set) var message = ""
  private var session: GroupSession<WatchPartyActivity>?
  private var listener: Task<Void, Never>?

  public init() {
    listener = Task { [weak self] in
      for await session in WatchPartyActivity.sessions() {
        guard let self else { return }
        self.session?.leave()
        self.session = session
        self.pendingInvite = session.activity.invite
        session.join()
        self.message = "Joined SharePlay"
      }
    }
  }

  public func start(invite: URL, title: String) {
    Task {
      let activity = WatchPartyActivity(invite: invite, title: title)
      switch await activity.prepareForActivation() {
      case .activationPreferred:
        do { _ = try await activity.activate(); message = "SharePlay started" }
        catch { message = "SharePlay could not start: \(error.localizedDescription)" }
      case .activationDisabled: message = "SharePlay is disabled on this device"
      case .cancelled: message = "SharePlay cancelled"
      @unknown default: message = "SharePlay is unavailable"
      }
    }
  }
}
