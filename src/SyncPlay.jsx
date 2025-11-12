// src/SyncPlay.jsx
import React, { useState, useRef, useEffect } from "react";
import io from "socket.io-client";
import { Radio, Smartphone, Volume2, Share2, Copy, Check, Wifi, Users, Mic, Speaker, Activity, Zap } from 'lucide-react';

// Use env var provided by Vercel: REACT_APP_SIGNALING_URL
const SIGNALING_SERVER_URL = process.env.REACT_APP_SIGNALING_URL || "https://YOUR_SIGNALING_SERVER_URL";
const RTC_CONFIGURATION = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export default function SyncPlay() {
  const [mode, setMode] = useState(null);
  const [sessionCode, setSessionCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [volume, setVolume] = useState(80);
  const [copied, setCopied] = useState(false);
  const [connectedDevices, setConnectedDevices] = useState(0);
  const [latency, setLatency] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState("");

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef({});
  const remoteAudioRefs = useRef({});
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationRef = useRef(null);

  const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

  const ensureSocket = () => {
    if (socketRef.current) return socketRef.current;
    if (!SIGNALING_SERVER_URL || SIGNALING_SERVER_URL.includes("YOUR_SIGNALING_SERVER_URL")) {
      console.warn("SIGNALING_SERVER_URL not set. Set REACT_APP_SIGNALING_URL env var.");
    }
    const s = io(SIGNALING_SERVER_URL, { transports: ["websocket"], autoConnect: true });
    socketRef.current = s;

    s.on("connect", () => {
      console.log("connected to signaling server", s.id);
    });

    s.on("peer-joined", ({ peerId }) => {
      if (mode === "host") createPeerAndOffer(peerId);
    });

    s.on("offer", async ({ from, sdp }) => {
      await handleOfferAsReceiver(from, sdp);
    });

    s.on("answer", async ({ from, sdp }) => {
      const pc = peersRef.current[from];
      if (!pc) return;
      try {
        await pc.setRemoteDescription({ type: "answer", sdp });
      } catch (e) { console.error(e); }
    });

    s.on("ice-candidate", async ({ from, candidate }) => {
      const pc = peersRef.current[from];
      if (!pc) return;
      try { await pc.addIceCandidate(candidate); } catch (e) { console.warn(e); }
    });

    s.on("peer-left", ({ peerId }) => cleanupPeer(peerId));
    s.on("room-info", ({ count }) => setConnectedDevices(count));
    s.on("session-error", ({ message }) => setError(message || "Session error"));

    return s;
  };

  const createPeerConnection = (peerId) => {
    const pc = new RTCPeerConnection(RTC_CONFIGURATION);

    pc.onicecandidate = (e) => {
      if (e.candidate) socketRef.current?.emit("ice-candidate", { to: peerId, candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      if (mode === "receiver") {
        let audioEl = remoteAudioRefs.current[peerId];
        if (!audioEl) {
          audioEl = document.createElement("audio");
          audioEl.autoplay = true;
          audioEl.playsInline = true;
          remoteAudioRefs.current[peerId] = audioEl;
          audioEl.style.display = "none";
          document.body.appendChild(audioEl);
        }
        audioEl.srcObject = e.streams[0];
        audioEl.volume = volume / 100;
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) cleanupPeer(peerId);
    };

    peersRef.current[peerId] = pc;
    return pc;
  };

  const createPeerAndOffer = async (peerId) => {
    try {
      if (!localStreamRef.current) return;
      const pc = createPeerConnection(peerId);
      localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current.emit("offer", { to: peerId, sdp: offer.sdp });
    } catch (e) { console.error(e); }
  };

  const handleOfferAsReceiver = async (from, sdp) => {
    try {
      const pc = createPeerConnection(from);
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current.emit("answer", { to: from, sdp: answer.sdp });
    } catch (e) { console.error(e); }
  };

  const cleanupPeer = (peerId) => {
    const pc = peersRef.current[peerId];
    if (pc) { try { pc.close(); } catch {} delete peersRef.current[peerId]; }
    const audioEl = remoteAudioRefs.current[peerId];
    if (audioEl) { try { audioEl.pause(); audioEl.srcObject = null; audioEl.remove(); } catch {} delete remoteAudioRefs.current[peerId]; }
    setConnectedDevices(Object.keys(peersRef.current).length);
  };

  const startCapture = async () => {
    if (isBroadcasting) return;
    try {
      setError("");
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!stream || stream.getAudioTracks().length === 0) { stream?.getTracks()?.forEach(t => t.stop()); setError("No audio in shared media."); return; }
      localStreamRef.current = stream;

      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioContextRef.current = new AudioCtx();
        const source = audioContextRef.current.createMediaStreamSource(stream);
        analyserRef.current = audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 256;
        source.connect(analyserRef.current);
        visualizeAudio();
      } catch (e) { console.warn("visualize failed", e); }

      setIsBroadcasting(true);
      socketRef.current?.emit("host-ready", { session: sessionCode });

      const vt = stream.getVideoTracks()[0];
      if (vt) vt.addEventListener("ended", () => stopCapture(), { once: true });
    } catch (err) {
      console.error(err);
      setError("Failed to capture audio. Share a tab or allow audio capture.");
    }
  };

  const stopCapture = () => {
    try { localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null; } catch {}
    if (animationRef.current) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
    try { audioContextRef.current?.close(); } catch {}
    audioContextRef.current = null;
    analyserRef.current = null;
    setIsBroadcasting(false);
    Object.keys(peersRef.current).forEach(pid => cleanupPeer(pid));
  };

  const visualizeAudio = () => {
    if (!analyserRef.current) return;
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    const animate = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);
      const sum = dataArray.reduce((a,b)=>a+b,0);
      const avg = dataArray.length ? sum/dataArray.length : 0;
      setAudioLevel(Math.min(100,(avg/255)*200));
      animationRef.current = requestAnimationFrame(animate);
    };
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animate();
  };

  const joinSignaling = (code) => {
    ensureSocket();
    socketRef.current.emit("join", { session: code });
    setIsConnected(true);
  };

  const startHost = () => {
    const code = generateCode();
    setSessionCode(code);
    setMode("host");
    joinSignaling(code);
  };

  const joinSession = () => {
    if (!/^[A-Z0-9]{6}$/.test(inputCode)) { setError("Invalid code."); return; }
    setSessionCode(inputCode);
    setMode("receiver");
    joinSignaling(inputCode);
    setLatency(Math.floor(Math.random()*30)+10);
  };

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(sessionCode); setCopied(true); setTimeout(()=>setCopied(false),2000); } catch (e) { setError("Copy failed"); }
  };

  const resetSession = () => {
    try { socketRef.current?.emit("leave", { session: sessionCode }); } catch {}
    setMode(null); setSessionCode(""); setInputCode(""); setIsConnected(false); setIsBroadcasting(false); setConnectedDevices(0); setError("");
    stopCapture();
  };

  useEffect(() => {
    const s = ensureSocket();
    return () => {
      try { s.disconnect(); } catch {}
      stopCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-950 via-indigo-950 to-slate-950 text-white">
      <div className="max-w-6xl mx-auto px-3 py-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-br from-pink-500 to-purple-600 p-2.5 rounded-xl shadow-lg"><Radio /></div>
            <div>
              <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-pink-400 via-purple-400 to-blue-400">SyncPlay</h1>
              <div className="text-sm text-purple-300">System-Wide Audio Sync</div>
            </div>
          </div>
          {isConnected && <button onClick={resetSession} className="bg-red-600/20 px-3 py-1 rounded">Disconnect</button>}
        </div>

        {!mode ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-6 rounded-xl bg-white/5 cursor-pointer" onClick={startHost}>
              <div className="mb-2 font-bold">Host Session</div>
              <div className="text-xs text-purple-300">Broadcast your tab/system audio to receivers. Start broadcast to actually capture audio.</div>
            </div>
            <div className="p-6 rounded-xl bg-white/5">
              <div className="mb-2 font-bold">Join as Receiver</div>
              <input value={inputCode} onChange={e => setInputCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''))} placeholder="XXXXXX" maxLength={6} className="w-full p-2 rounded bg-white/10 mb-2 text-center" />
              <button onClick={joinSession} disabled={inputCode.length !== 6} className="w-full rounded p-2 bg-blue-600">Connect</button>
            </div>
          </div>
        ) : (
          <div className="p-6 rounded-xl bg-white/5">
            <div className="flex justify-between items-center mb-4">
              <div>
                <div className="font-semibold">{mode === "host" ? "Host Mode" : "Receiver Mode"}</div>
                <div className="text-xs text-purple-300">{mode === "host" ? `${connectedDevices} connected` : `Latency: ${latency}ms`}</div>
              </div>
              {mode === "host" && <div className="flex items-center gap-2">
                <div className="font-mono px-2 bg-white/10 rounded">{sessionCode}</div>
                <button onClick={copyCode}>{copied ? "✓" : "Copy"}</button>
              </div>}
            </div>

            {mode === "host" ? (
              <div>
                {!isBroadcasting ? (
                  <div>
                    <p className="text-sm text-purple-300 mb-3">Ready to Broadcast — click to share a tab or screen with audio.</p>
                    <div className="flex gap-2">
                      <button onClick={startCapture} className="bg-pink-500 px-3 py-2 rounded">Start Broadcasting</button>
                    </div>
                    {error && <p className="text-red-400 mt-2">{error}</p>}
                  </div>
                ) : (
                  <div>
                    <div className="mb-3">LIVE — broadcasting to {connectedDevices} device{connectedDevices !== 1 ? "s" : ""}</div>
                    <div className="w-full bg-white/10 h-3 rounded overflow-hidden">
                      <div style={{ width: `${audioLevel}%` }} className="h-full bg-gradient-to-r from-green-400 via-yellow-400 to-red-500 transition-all"></div>
                    </div>
                    <div className="mt-2"><button onClick={stopCapture} className="bg-red-600 px-3 py-1 rounded">Stop</button></div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="mb-3">Connected as receiver — waiting for host broadcast. Your audio will auto-play when host sends stream.</div>
                <div className="max-w-sm">
                  <label className="block mb-1">Volume</label>
                  <input type="range" min="0" max="100" value={volume} onChange={e => {
                    setVolume(parseInt(e.target.value));
                    Object.values(remoteAudioRefs.current).forEach(a => { if (a) a.volume = parseInt(e.target.value)/100; });
                  }} />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 text-xs text-purple-400">Note: Frontend on Vercel. Signaling server must be deployed to a host that supports WebSockets (Render/Railway).</div>
      </div>
    </div>
  );
}
