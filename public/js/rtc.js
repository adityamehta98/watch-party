// Peer-to-peer webcam/mic mesh (fine for a handful of people).
// The newest person in the room calls everyone else; each connection carries one audio + one video slot,
// and turning the camera/mic on or off just swaps the track in that slot, with no renegotiation needed.

const CAM_MAX_BITRATE = 450_000; // keep webcams light so your upload is saved for the movie

export class Mesh {
  constructor({ send, iceServers, onRemoteStream, onPeerGone }) {
    this.send = send;
    this.iceServers = iceServers || [];
    this.onRemoteStream = onRemoteStream;
    this.onPeerGone = onPeerGone;
    this.peers = new Map();
    this.local = { audio: null, video: null };
  }

  setIceServers(s, relayOnly) { this.iceServers = s || []; this.relayOnly = !!relayOnly && this.iceServers.some(x => /^turn:/.test([].concat(x.urls)[0])); }

  createPeer(id) {
    this.closePeer(id);
    // ?relay=1 forces everything through the host's built-in relay (for troubleshooting)
    // Webcam video goes through the host's own relay, so guests never connect to (or learn the
    // internet address of) each other. ?relay=1 forces this even if the host turned it off.
    const forceRelay = this.relayOnly || new URLSearchParams(location.search).has('relay');
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: forceRelay ? 'relay' : 'all' });
    const peer = { id, pc, stream: new MediaStream(), pendingIce: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = e => { if (e.candidate) this.send({ type: 'rtc', to: id, data: { ice: e.candidate } }); };
    pc.ontrack = e => {
      if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
      this.onRemoteStream(id, peer.stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && peer.initiator) {
        try { pc.restartIce(); this.makeOffer(peer, true); } catch {}
      }
    };
    return peer;
  }

  // Called for each person already in the room when we join.
  async call(id) {
    const peer = this.createPeer(id);
    peer.initiator = true;
    const a = peer.pc.addTransceiver('audio', { direction: 'sendrecv' });
    const v = peer.pc.addTransceiver('video', { direction: 'sendrecv' });
    await a.sender.replaceTrack(this.local.audio);
    await v.sender.replaceTrack(this.local.video);
    await this.makeOffer(peer);
  }

  async makeOffer(peer, iceRestart) {
    const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await peer.pc.setLocalDescription(offer);
    this.send({ type: 'rtc', to: peer.id, data: { sdp: peer.pc.localDescription } });
  }

  async onSignal(from, data) {
    let peer = this.peers.get(from);
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          if (!peer || peer.initiator) peer = this.createPeer(from);
          await peer.pc.setRemoteDescription(data.sdp);
          for (const t of peer.pc.getTransceivers()) {
            const kind = t.receiver.track && t.receiver.track.kind;
            if (!kind) continue;
            t.direction = 'sendrecv';
            await t.sender.replaceTrack(this.local[kind] || null);
          }
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          this.send({ type: 'rtc', to: from, data: { sdp: peer.pc.localDescription } });
        } else if (peer) {
          await peer.pc.setRemoteDescription(data.sdp);
        }
        if (peer) {
          for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
          this.limitBitrate(peer);
        }
      } else if (data.ice && peer) {
        if (!peer.pc.remoteDescription) peer.pendingIce.push(data.ice);
        else await peer.pc.addIceCandidate(data.ice).catch(() => {});
      }
    } catch (e) {
      console.warn('rtc signal error', e);
    }
  }

  async limitBitrate(peer) {
    for (const s of peer.pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      try {
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = CAM_MAX_BITRATE;
        await s.setParameters(p);
      } catch { /* not negotiated yet */ }
    }
  }

  async setLocalTrack(kind, track) {
    const old = this.local[kind];
    this.local[kind] = track;
    for (const peer of this.peers.values()) {
      for (const t of peer.pc.getTransceivers()) {
        const k = t.receiver.track && t.receiver.track.kind;
        if (k === kind) { try { await t.sender.replaceTrack(track); } catch {} }
      }
      if (kind === 'video' && track) this.limitBitrate(peer);
    }
    if (old && old !== track) old.stop();
  }

  closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    try { peer.pc.close(); } catch {}
    this.peers.delete(id);
    this.onPeerGone && this.onPeerGone(id);
  }

  closeAll() { for (const id of [...this.peers.keys()]) this.closePeer(id); }
}
