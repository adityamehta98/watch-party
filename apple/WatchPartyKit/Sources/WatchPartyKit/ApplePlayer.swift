import AVFoundation
import AVKit
import Combine
import SwiftUI

@MainActor
public final class AppleSyncPlayer: ObservableObject {
  public let player = AVPlayer()
  @Published public private(set) var buffering = false
  @Published public private(set) var drift = 0.0
  private var movieID: String?
  private var observation: NSKeyValueObservation?

  public init() {
    player.automaticallyWaitsToMinimizeStalling = true
    player.allowsExternalPlayback = true
    observation = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
      Task { @MainActor in self?.buffering = player.timeControlStatus == .waitingToPlayAtSpecifiedRate }
    }
  }

  public func load(movie: RoomMovie?, from invite: WatchPartyInvite?, clientID: String) {
    guard let movie, movie.kind == "file" else { movieID = nil; player.replaceCurrentItem(with: nil); return }
    guard let url = invite?.resourceURL(movie.hls ?? movie.url, clientID: clientID) else { return }
    guard movie.id != movieID else { return }
    movieID = movie.id
    let item = AVPlayerItem(url: url)
    item.preferredForwardBufferDuration = 8
    player.replaceCurrentItem(with: item)
  }

  public func apply(_ state: RoomState?, serverNow: Double) {
    guard let state, movieID == state.movieId, player.currentItem != nil else { return }
    let expected = state.expectedTime(serverNow: serverNow)
    let current = player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0
    drift = current - expected
    if abs(drift) > 0.75 {
      player.seek(to: CMTime(seconds: expected, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    if state.playing && state.waiting != true {
      let rate: Float = abs(drift) < 0.08 ? 1 : drift < 0 ? 1.03 : 0.97
      if player.timeControlStatus != .playing || abs(player.rate - rate) > 0.001 { player.playImmediately(atRate: rate) }
    } else {
      player.pause()
    }
  }

  public var currentTime: Double { max(0, player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0) }

  public var bufferAhead: Double {
    guard let range = player.currentItem?.loadedTimeRanges.last?.timeRangeValue else { return 0 }
    return max(0, CMTimeGetSeconds(CMTimeRangeGetEnd(range)) - currentTime)
  }
}

public struct SystemPlayerView: View {
  let player: AVPlayer
  public init(player: AVPlayer) { self.player = player }
  public var body: some View {
    #if os(iOS)
    PlayerController(player: player)
    #else
    VideoPlayer(player: player)
    #endif
  }
}

#if os(iOS)
private struct PlayerController: UIViewControllerRepresentable {
  let player: AVPlayer
  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    controller.player = player
    controller.showsPlaybackControls = false
    controller.allowsPictureInPicturePlayback = true
    controller.canStartPictureInPictureAutomaticallyFromInline = true
    return controller
  }
  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) { controller.player = player }
}

public struct AirPlayButton: UIViewRepresentable {
  public init() {}
  public func makeUIView(context: Context) -> AVRoutePickerView { AVRoutePickerView() }
  public func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}
#else
public struct AirPlayButton: View {
  public init() {}
  public var body: some View { EmptyView() }
}
#endif
