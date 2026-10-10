import Combine
import SwiftUI

public struct WatchPartyCompanionView: View {
  @StateObject private var room = RoomClient()
  @StateObject private var syncPlayer = AppleSyncPlayer()
  @StateObject private var sharePlay = SharePlayCoordinator()
  @State private var invite = ""
  @State private var name = ""

  public init() {}

  public var body: some View {
    NavigationStack {
      Group {
        if room.status == .connected { party }
        else { join }
      }
      .navigationTitle("Watch Party")
    }
    .onReceive(room.$movie) { syncPlayer.load(movie: $0, from: room.invite, clientID: room.clientID) }
    .onReceive(sharePlay.$pendingInvite.compactMap { $0 }) { url in invite = url.absoluteString; room.connect(invite: invite, name: name) }
    .task {
      while !Task.isCancelled {
        syncPlayer.apply(room.state, serverNow: room.serverNow())
        if let state = room.state { room.report(buffering: syncPlayer.buffering, ahead: syncPlayer.bufferAhead, drift: syncPlayer.drift, sequence: state.seq) }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
      }
    }
  }

  private var join: some View {
    Form {
      Section("Join securely") {
        TextField("Your name", text: $name)
        TextField("https://…/join/…", text: $invite)
        Button("Join room") { room.connect(invite: invite, name: name) }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || invite.isEmpty)
      }
      if room.status == .waiting { ContentUnavailableView("Waiting for the host", systemImage: "person.badge.clock") }
      if !room.errorMessage.isEmpty { Text(room.errorMessage).foregroundStyle(.red) }
      Text("The invite key stays in memory. If native playback cannot trust the host certificate, open the same link in Safari.").font(.footnote).foregroundStyle(.secondary)
    }
  }

  private var party: some View {
    VStack(spacing: 12) {
      if room.movie?.kind == "file" {
        SystemPlayerView(player: syncPlayer.player).aspectRatio(16 / 9, contentMode: .fit).background(.black)
        HStack {
          Button { room.command("play", position: syncPlayer.currentTime) } label: { Label("Play", systemImage: "play.fill") }
          Button { room.command("pause", position: syncPlayer.currentTime) } label: { Label("Pause", systemImage: "pause.fill") }
          Spacer()
          AirPlayButton().frame(width: 32, height: 32)
        }.padding(.horizontal)
        Text("Drift \(Int(syncPlayer.drift * 1_000)) ms · buffer \(Int(syncPlayer.bufferAhead)) s").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
      } else {
        ContentUnavailableView("Continue in Safari", systemImage: "safari", description: Text("Streaming services use the signed Safari extension; AVPlayer is only for host-owned movies."))
      }
      List {
        Section("Now playing") { Text(room.movie?.title ?? "Nothing yet") }
        if let url = room.invite?.url {
          Section {
            Button { sharePlay.start(invite: url, title: room.movie?.title ?? "Watch Party") } label: { Label("Start SharePlay", systemImage: "shareplay") }
            Link(destination: url) { Label("Open web room", systemImage: "safari") }
          }
        }
        if !sharePlay.message.isEmpty { Text(sharePlay.message).font(.footnote) }
      }
    }
  }
}
