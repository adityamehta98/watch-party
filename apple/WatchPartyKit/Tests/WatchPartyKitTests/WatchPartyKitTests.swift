import XCTest
@testable import WatchPartyKit

final class WatchPartyKitTests: XCTestCase {
  func testInviteBuildsAuthenticatedWebSocketAndMediaURLs() throws {
    let invite = try WatchPartyInvite("https://party.example/join/AbCdEf23456789Gh")
    XCTAssertEqual(invite.key, "AbCdEf23456789Gh")
    XCTAssertEqual(invite.webSocketURL.absoluteString, "wss://party.example/ws?k=AbCdEf23456789Gh")
    XCTAssertEqual(invite.resourceURL("/media/movie/hls/index.m3u8", clientID: "ios-device")?.absoluteString,
      "https://party.example/media/movie/hls/index.m3u8?k=AbCdEf23456789Gh&c=ios-device")
    XCTAssertThrowsError(try WatchPartyInvite("https://party.example/join/short"))
    XCTAssertThrowsError(try WatchPartyInvite("javascript:alert(1)"))
  }

  func testClockRejectsOutliersAndTimelineAdvancesOnlyWhilePlaying() throws {
    var clock = RoomClock()
    clock.sample(sent: 1_000, server: 1_055, received: 1_010)
    clock.sample(sent: 2_000, server: 99_000, received: 20_001)
    XCTAssertEqual(clock.rtt, 10, accuracy: 0.001)
    XCTAssertEqual(clock.now(local: 3_000), 3_050, accuracy: 0.001)
    let playing = try JSONDecoder().decode(RoomState.self, from: Data(#"{"movieId":"m","playing":true,"position":12,"anchor":1000,"seq":2,"waiting":false}"#.utf8))
    XCTAssertEqual(playing.expectedTime(serverNow: 2_500), 13.5, accuracy: 0.001)
    let waiting = try JSONDecoder().decode(RoomState.self, from: Data(#"{"movieId":"m","playing":true,"position":12,"anchor":1000,"seq":2,"waiting":true}"#.utf8))
    XCTAssertEqual(waiting.expectedTime(serverNow: 2_500), 12, accuracy: 0.001)
  }
}
