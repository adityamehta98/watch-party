import XCTest
@testable import WatchPartyKit

final class NativeSecurityTests: XCTestCase {
  func testInviteRejectsEmbeddedCredentialsAndRetainsSecureSocketScheme() throws {
    XCTAssertThrowsError(try WatchPartyInvite("https://user:password@party.example/join/AbCdEf23456789Gh"))
    XCTAssertThrowsError(try WatchPartyInvite("https://user@party.example/join/AbCdEf23456789Gh"))
    let invite = try WatchPartyInvite("HTTPS://party.example/join/AbCdEf23456789Gh")
    XCTAssertEqual(invite.webSocketURL.scheme, "wss")
  }

  func testMediaResourceCannotChangeInviteOrigin() throws {
    let invite = try WatchPartyInvite("https://party.example:8443/join/AbCdEf23456789Gh")
    XCTAssertNil(invite.resourceURL("https://other.example/media/file", clientID: "device"))
    let resource = try XCTUnwrap(invite.resourceURL("//other.example/media/file", clientID: "device"))
    XCTAssertEqual(resource.host, "party.example")
    XCTAssertEqual(resource.port, 8443)
    XCTAssertEqual(resource.scheme, "https")
  }

  func testNonfiniteClockSampleCannotPoisonSynchronization() {
    var clock = RoomClock()
    clock.sample(sent: 1_000, server: 1_055, received: 1_010)
    clock.sample(sent: 2_000, server: .nan, received: 2_010)
    clock.sample(sent: .infinity, server: 3_055, received: 3_010)
    XCTAssertEqual(clock.now(local: 3_000), 3_050, accuracy: 0.001)
  }
}
