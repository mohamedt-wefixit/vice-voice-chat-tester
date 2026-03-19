import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { io, Socket } from 'socket.io-client';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are Jimmy, a desperate crack addict calling your dealer. You need $20 of crack urgently.

Your goals (pursue naturally through conversation, don't rush):
- Confirm they're holding and order $20 worth
- Arrange where/when to pick it up
- Mention your friends Steve and Mike also need a connect

React to the dealer's responses realistically. If they're difficult, brush you off, or say no: beg, guilt-trip, get more desperate, try a different angle. Don't give up after one rejection — you NEED this. Match their energy: if they're rude, push back or plead harder.

Say goodbye (peace/later/bye/gotta go) ONLY after: (a) you've successfully arranged a pickup and covered your topics, OR (b) you've been stonewalled/refused across many exchanges and truly given up.

10-15 words per reply, one punchy sentence, swear occasionally. No markdown. No stage directions.`;

const DEFAULT_VOICE_ID = '09d4ef3e';
const DEFAULT_BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  'https://vice-game-backend-production.up.railway.app';
const NOISE_GATE = 0.02;       // Filters background noise; speech is typically 0.03-0.15
const BARGE_IN_THRESHOLD = 0.06; // ~3x noise gate — requires actual speech to trigger barge-in

// ── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'jimmy' | 'user';
  text: string;
  ts: number;
}

type CallPhase =
  | 'idle'
  | 'connecting'
  | 'ringing'
  | 'active'
  | 'ending';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function App() {
  // Settings
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [settingsOpen, setSettingsOpen] = useState(true);

  // Call state
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [vadActive, setVadActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const socketRef = useRef<Socket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const callActiveRef = useRef(false);
  const jimmySpeakingRef = useRef(false);
  const echoGuardRef = useRef<number>(0);
  const micStartedAtRef = useRef<number>(0);
  const streamingAudioContextRef = useRef<AudioContext | null>(null);
  const streamingStartTimeRef = useRef<number>(0);
  const streamingSampleRateRef = useRef<number>(16000);
  const streamingChannelsRef = useRef<number>(1);
  const firstChunkTimeRef = useRef<number | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStartTimeRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Barge-in: prevents firing voiceBargeIn multiple times per Jimmy turn
  const bargeInFiredRef = useRef(false);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Audio: play streaming PCM chunks ──────────────────────────────────────

  const playPcmChunk = useCallback(async (base64Chunk: string, isFirst: boolean) => {
    try {
      const audioContext = streamingAudioContextRef.current;
      if (!audioContext) return;

      const binaryString = atob(base64Chunk);
      let byteLength = binaryString.length;
      if (byteLength % 2 !== 0) byteLength++;

      const bytes = new Uint8Array(byteLength);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      if (float32Array.length === 0) return;

      const sampleRate = streamingSampleRateRef.current;
      const channels = streamingChannelsRef.current;
      const audioBuffer = audioContext.createBuffer(channels, float32Array.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      if (isFirst) {
        const startTime = audioContext.currentTime + 0.05;
        streamingStartTimeRef.current = startTime + audioBuffer.duration;
        source.start(startTime);
        setIsPlaying(true);
        jimmySpeakingRef.current = true;
      } else {
        source.start(streamingStartTimeRef.current);
        streamingStartTimeRef.current += audioBuffer.duration;
      }
    } catch (e) {
      console.error('PCM chunk error:', e);
    }
  }, []);

  // ── Socket setup ─────────────────────────────────────────────────────────

  const initSocket = useCallback(() => {
    if (socketRef.current?.connected) return socketRef.current;

    const wsUrl = backendUrl.replace('/api', '');
    const socket = io(wsUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: 10,
      timeout: 8000,
    });

    socket.on('connect', () => {
      console.log('✅ Socket connected');
      if (callActiveRef.current) setError(null);
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
    });

    socket.on('connect_error', (err) => {
      if (!callActiveRef.current) return;
      console.error('Socket error:', err.message);
      setError('Connection lost — retrying…');
    });

    // ── Greeting ──────────────────────────────────────────────────────────
    socket.on('voiceCharacterGreeting', async (data: {
      sessionId: string;
      text: string;
      ttsProcessingTime: number;
      totalChunks: number;
      streamingComplete: boolean;
    }) => {
      if (!callActiveRef.current) return;

      // Stop any ringtone
      setPhase('active');

      setMessages(prev => [...prev, { role: 'jimmy', text: data.text, ts: Date.now() }]);

      // Wait for audio to finish, then enable mic
      const audioContext = streamingAudioContextRef.current;
      if (audioContext && streamingStartTimeRef.current > 0) {
        const remaining = Math.max(0, streamingStartTimeRef.current - audioContext.currentTime);
        await new Promise(r => setTimeout(r, remaining * 1000 + 150));
      }

      setIsPlaying(false);
      jimmySpeakingRef.current = false;
      echoGuardRef.current = Date.now();

      // Open mic
      startMicrophone();
    });

    // ── Streaming audio chunks ─────────────────────────────────────────────
    socket.on('voiceCharacterAudioChunk', async (data: {
      sessionId: string;
      audioChunk: string;
      chunkIndex: number;
      isFirst: boolean;
      isLast: boolean;
      format?: string;
      sampleRate?: number;
      channels?: number;
    }) => {
      if (!callActiveRef.current) return;

      // Drop in-flight chunks from an interrupted (barged-in) response.
      // When isFirst arrives it means a fresh response is starting — reset the gate.
      if (bargeInFiredRef.current && !data.isFirst) return;
      if (data.isFirst) bargeInFiredRef.current = false;

      if (data.isFirst) {
        firstChunkTimeRef.current = Date.now();
        streamingSampleRateRef.current = data.sampleRate || 16000;
        streamingChannelsRef.current = data.channels || 1;
        streamingStartTimeRef.current = 0;

        if (streamingAudioContextRef.current) {
          try { await streamingAudioContextRef.current.close(); } catch (_) {}
        }
        streamingAudioContextRef.current = new AudioContext({
          sampleRate: data.sampleRate || 16000,
        });
        if (streamingAudioContextRef.current.state === 'suspended') {
          await streamingAudioContextRef.current.resume();
        }
      }

      if (data.audioChunk) {
        await playPcmChunk(data.audioChunk, data.isFirst);
      }
    });

    // ── Response (fires after last chunk) ─────────────────────────────────
    socket.on('voiceCharacterResponse', async (data: {
      sessionId: string;
      text: string;
      isCallEnding?: boolean;
    }) => {
      if (!callActiveRef.current) return;

      // Reset barge-in gate — new Jimmy response means a fresh barge-in is allowed
      bargeInFiredRef.current = false;

      setMessages(prev => [...prev, { role: 'jimmy', text: data.text, ts: Date.now() }]);
      setIsProcessing(false);

      // Wait for audio playback to complete (500ms early so user can respond quickly)
      const audioContext = streamingAudioContextRef.current;
      if (audioContext && streamingStartTimeRef.current > 0) {
        const remaining = Math.max(0, streamingStartTimeRef.current - audioContext.currentTime);
        const waitTime = Math.max(0, remaining * 1000 - 500);
        await new Promise(r => setTimeout(r, waitTime));
      }

      setIsPlaying(false);
      jimmySpeakingRef.current = false;
      echoGuardRef.current = Date.now();

      // Tell backend audio is done so it releases isProcessing immediately
      if (socketRef.current && sessionIdRef.current) {
        socketRef.current.emit('voicePlaybackComplete', { sessionId: sessionIdRef.current });
      }

      if (data.isCallEnding) {
        setPhase('ending');
        setTimeout(() => {
          if (callActiveRef.current) cleanupCall();
        }, 2000);
      }
    });

    // ── Transcription ──────────────────────────────────────────────────────
    socket.on('voiceTranscription', (data: { sessionId: string; text: string; isFinal?: boolean }) => {
      if (!callActiveRef.current || !data.text.trim()) return;
      // Drop sentinel values (noise/unclear rejections) — just clear processing state
      if (
        data.text === '[Unclear]' ||
        data.text === '[No speech detected]' ||
        data.text === '[Transcription failed]'
      ) {
        setIsProcessing(false);
        return;
      }
      setIsProcessing(false);
      setMessages(prev => [...prev, { role: 'user', text: data.text, ts: Date.now() }]);
    });

    socket.on('voiceSpeechStart', () => setVadActive(true));
    socket.on('voiceSpeechEnd', () => { setVadActive(false); setIsProcessing(true); });

    socket.on('voiceProcessingStart', () => setIsProcessing(true));

    socket.on('voiceError', (data: { error: string }) => {
      console.error('Voice error:', data.error);
      setIsProcessing(false);
      const isFatal = data.error.toLowerCase().includes('connect') ||
                      data.error.toLowerCase().includes('session');
      if (isFatal) setError(data.error);
    });

    // Backend confirmed barge-in — audio already stopped in the processor
    socket.on('voiceStopAudio', () => {
      bargeInFiredRef.current = false;
      jimmySpeakingRef.current = false;
      setIsPlaying(false);
      setIsProcessing(false);
    });

    socket.on('voiceCallEnded', () => {
      if (callActiveRef.current) cleanupCall();
    });

    socketRef.current = socket;
    return socket;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, playPcmChunk]);

  // ── Microphone ────────────────────────────────────────────────────────────

  // Request mic permission early (before Jimmy speaks) — holds the stream but
  // doesn't start the audio processor yet so nothing is sent to the backend.
  const requestMicPermission = useCallback(async () => {
    if (streamRef.current) return; // already granted
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
        },
      });
      streamRef.current = stream;
      console.log('✅ Mic permission granted — stream held, processor not started yet');
    } catch (err) {
      console.error('Mic permission denied:', err);
      setError('Microphone access denied');
    }
  }, []);

  const startMicrophone = useCallback(async () => {
    try {
      // Reuse stream from early permission request if available
      if (!streamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 16000,
            channelCount: 1,
          },
        });
        streamRef.current = stream;
      }

      const stream = streamRef.current!;
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      micStartedAtRef.current = Date.now();

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!socketRef.current || !sessionIdRef.current) return;

        // 1200ms deaf period to avoid capturing greeting echo
        if (Date.now() - micStartedAtRef.current < 1200) return;

        // While Jimmy is speaking, check for barge-in before muting
        if (jimmySpeakingRef.current) {
          const inputData = e.inputBuffer.getChannelData(0);
          let sumSq = 0;
          for (let i = 0; i < inputData.length; i++) sumSq += inputData[i] * inputData[i];
          const rms = Math.sqrt(sumSq / inputData.length);

          if (rms > BARGE_IN_THRESHOLD && !bargeInFiredRef.current && socketRef.current && sessionIdRef.current) {
            bargeInFiredRef.current = true;
            // Stop Jimmy's audio immediately
            if (streamingAudioContextRef.current) {
              streamingAudioContextRef.current.close();
              streamingAudioContextRef.current = null;
            }
            socketRef.current.emit('voiceBargeIn', { sessionId: sessionIdRef.current });
            jimmySpeakingRef.current = false;
            echoGuardRef.current = 0;
            setIsPlaying(false);
            setIsProcessing(false);
          }
          return;
        }

        // 600ms echo guard after Jimmy stops
        if (Date.now() - echoGuardRef.current < 600) return;

        const inputData = e.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < inputData.length; i++) sumSq += inputData[i] * inputData[i];
        const rms = Math.sqrt(sumSq / inputData.length);

        if (rms < NOISE_GATE) {
          const silentBuf = new Int16Array(inputData.length);
          socketRef.current.emit('voiceAudioData', {
            sessionId: sessionIdRef.current,
            audioData: Array.from(silentBuf),
          });
          return;
        }

        const int16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        socketRef.current.emit('voiceAudioData', {
          sessionId: sessionIdRef.current,
          audioData: Array.from(int16),
        });
      };
    } catch (err) {
      console.error('Mic error:', err);
      setError('Microphone access denied');
    }
  }, []);

  const stopMicrophone = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // ── Call lifecycle ────────────────────────────────────────────────────────

  const cleanupCall = useCallback(() => {
    callActiveRef.current = false;
    sessionIdRef.current = null;
    jimmySpeakingRef.current = false;
    bargeInFiredRef.current = false;

    stopMicrophone();

    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    if (streamingAudioContextRef.current) {
      try { streamingAudioContextRef.current.close(); } catch (_) {}
      streamingAudioContextRef.current = null;
    }

    socketRef.current?.disconnect();
    socketRef.current = null;

    setPhase('idle');
    setVadActive(false);
    setIsProcessing(false);
    setIsPlaying(false);
    setDuration(0);
  }, [stopMicrophone]);

  const startCall = useCallback(async () => {
    setError(null);
    setMessages([]);
    setPhase('connecting');

    const socket = initSocket();
    callActiveRef.current = true;

    try {
      // Wait for socket connection
      await new Promise<void>((resolve, reject) => {
        if (socket.connected) { resolve(); return; }
        const t = setTimeout(() => reject(new Error('Server not reachable')), 8000);
        socket.once('connect', () => { clearTimeout(t); resolve(); });
      });

      setPhase('ringing');

      // Start duration timer
      callStartTimeRef.current = Date.now();
      durationIntervalRef.current = setInterval(() => {
        if (callStartTimeRef.current) {
          setDuration(Math.floor((Date.now() - callStartTimeRef.current) / 1000));
        }
      }, 1000);

      // Request mic permission NOW — before Jimmy speaks, so there's no popup mid-greeting.
      // The stream is held in streamRef; the processor won't start until greeting ends.
      await requestMicPermission();

      const sessionId = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      sessionIdRef.current = sessionId;

      socket.emit('joinVoiceSession', {
        sessionId,
        characterName: 'jimmy',
        playerId: `tester_${Date.now()}`,
        customSystemPrompt: systemPrompt.trim() || undefined,
        customVoiceId: voiceId.trim() || undefined,
      });

    } catch (err) {
      callActiveRef.current = false;
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'Failed to connect');
      socket.disconnect();
      socketRef.current = null;
    }
  }, [initSocket, requestMicPermission, systemPrompt, voiceId]);

  const endCall = useCallback(() => {
    if (sessionIdRef.current && socketRef.current?.connected) {
      socketRef.current.emit('leaveVoiceSession', { sessionId: sessionIdRef.current });
    }
    cleanupCall();
  }, [cleanupCall]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupCall();
    };
  }, [cleanupCall]);

  // ── UI ────────────────────────────────────────────────────────────────────

  const isCallActive = phase !== 'idle';
  const statusText: Record<CallPhase, string> = {
    idle: '',
    connecting: 'Connecting…',
    ringing: 'Calling Jimmy…',
    active: formatDuration(duration),
    ending: 'Call ending…',
  };

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}></div>
          <div>
            <div style={styles.headerTitle}>Jimmy Prompt Tester</div>
            <div style={styles.headerSub}>Internal tool · Vice Game</div>
          </div>
        </div>
        {!isCallActive && (
          <button
            style={styles.settingsBtn}
            onClick={() => setSettingsOpen(o => !o)}
          >
            {settingsOpen ? 'Hide Settings' : 'Show Settings'}
          </button>
        )}
      </header>

      <div style={styles.body}>
        {/* Settings panel */}
        {settingsOpen && !isCallActive && (
          <aside style={styles.settings}>
            <h2 style={styles.sectionTitle}>Configuration</h2>

            <label style={styles.label}>
              Backend URL
              <input
                style={styles.input}
                value={backendUrl}
                onChange={e => setBackendUrl(e.target.value)}
                placeholder="http://localhost:3001"
                spellCheck={false}
              />
            </label>

            <label style={styles.label}>
              Voice ID
              <div style={styles.voiceRow}>
                <input
                  style={{ ...styles.input, fontFamily: 'JetBrains Mono, monospace' }}
                  value={voiceId}
                  onChange={e => setVoiceId(e.target.value)}
                  placeholder="09d4ef3e"
                  spellCheck={false}
                />
                <button
                  style={styles.resetBtn}
                  onClick={() => setVoiceId(DEFAULT_VOICE_ID)}
                  title="Reset to default"
                >
                  ↺
                </button>
              </div>
              <span style={styles.hint}>Default: <code style={styles.code}>{DEFAULT_VOICE_ID}</code> (Jimmy's Resemble AI voice)</span>
            </label>

            <label style={styles.label}>
              System Prompt
              <div style={styles.promptHeader}>
                <span style={styles.charCount}>{systemPrompt.length} chars</span>
                <button
                  style={styles.resetBtn}
                  onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
                >
                  Reset to default
                </button>
              </div>
              <textarea
                style={styles.textarea}
                value={systemPrompt}
                onChange={e => setSystemPrompt(e.target.value)}
                rows={14}
                spellCheck={false}
              />
            </label>
          </aside>
        )}

        {/* Call panel */}
        <main style={styles.main}>
          {/* Status bar */}
          {isCallActive && (
            <div style={styles.statusBar}>
              <div style={styles.statusDot(phase)} />
              <span style={styles.statusText}>{statusText[phase]}</span>
              {phase === 'active' && (
                <div style={styles.indicators}>
                  {vadActive && <span style={styles.badge('green')}>🎤 Speaking</span>}
                  {isProcessing && !isPlaying && <span style={styles.badge('yellow')}>⚡ Thinking</span>}
                  {isPlaying && <span style={styles.badge('purple')}>🔊 Playing</span>}
                </div>
              )}
            </div>
          )}

          {/* Conversation log */}
          <div style={styles.log}>
            {messages.length === 0 && !isCallActive && (
              <div style={styles.emptyState}>
                <div style={styles.emptyIcon}></div>
                <div style={styles.emptyTitle}>Ready to test</div>
                <div style={styles.emptySub}>Configure the prompt and voice ID, then start a call.</div>
              </div>
            )}
            {messages.length === 0 && phase === 'ringing' && (
              <div style={styles.emptyState}>
                <div style={{ ...styles.emptyIcon, animation: 'pulse 1s infinite' }}>📲</div>
                <div style={styles.emptyTitle}>Calling Jimmy…</div>
                <div style={styles.emptySub}>Generating greeting with your prompt.</div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={styles.message(msg.role)}>
                <div style={styles.msgMeta}>
                  <span style={styles.msgRole(msg.role)}>
                    {msg.role === 'jimmy' ? ' Jimmy' : '🧑 You'}
                  </span>
                  <span style={styles.msgTime}>
                    {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
                <div style={styles.msgText}>{msg.text}</div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Error banner */}
          {error && (
            <div style={styles.errorBanner}>
               {error}
              <button style={styles.errorClose} onClick={() => setError(null)}>✕</button>
            </div>
          )}

          {/* Action buttons */}
          <div style={styles.actions}>
            {!isCallActive ? (
              <button style={styles.callBtn} onClick={startCall}>
                 Start Call
              </button>
            ) : (
              <button style={styles.hangupBtn} onClick={endCall}>
                 End Call
              </button>
            )}
          </div>

          {/* Active config summary (visible during call) */}
          {isCallActive && (
            <div style={styles.callInfo}>
              <span style={styles.callInfoItem}>
                <span style={styles.callInfoLabel}>Voice:</span>
                <code style={styles.code}>{voiceId || DEFAULT_VOICE_ID}</code>
              </span>
              <span style={styles.callInfoDot}>·</span>
              <span style={styles.callInfoItem}>
                <span style={styles.callInfoLabel}>Prompt:</span>
                {systemPrompt.slice(0, 60).trim()}…
              </span>
            </div>
          )}
        </main>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.15); opacity: 0.7; }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    background: 'var(--bg)',
    color: 'var(--text)',
  },

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 20px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  logo: {
    fontSize: 26,
  },
  headerTitle: {
    fontWeight: 700,
    fontSize: 15,
    color: 'var(--text)',
  },
  headerSub: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 1,
  },
  settingsBtn: {
    padding: '6px 14px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 13,
    transition: 'all 0.15s',
  },

  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },

  settings: {
    width: 400,
    flexShrink: 0,
    padding: '20px',
    borderRight: '1px solid var(--border)',
    overflowY: 'auto' as const,
    background: 'var(--surface)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 20,
  },

  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    marginBottom: 4,
  },

  label: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    fontSize: 13,
    color: 'var(--text-muted)',
    fontWeight: 500,
  },

  input: {
    padding: '9px 12px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
    background: 'var(--surface2)',
    color: 'var(--text)',
    fontSize: 13,
    outline: 'none',
  } as React.CSSProperties,

  voiceRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },

  resetBtn: {
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap' as const,
  },

  hint: {
    fontSize: 11,
    color: 'var(--text-faint)',
  },

  code: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    background: 'var(--surface2)',
    padding: '1px 5px',
    borderRadius: 4,
    border: '1px solid var(--border)',
  } as React.CSSProperties,

  promptHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  charCount: {
    fontSize: 11,
    color: 'var(--text-faint)',
  },

  textarea: {
    padding: '10px 12px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
    background: 'var(--surface2)',
    color: 'var(--text)',
    fontSize: 13,
    fontFamily: 'JetBrains Mono, monospace',
    lineHeight: 1.6,
    resize: 'vertical' as const,
    outline: 'none',
    minHeight: 220,
  } as React.CSSProperties,

  // ── Main call area ────────────────────────────────────────────────────────

  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    padding: 20,
    gap: 16,
  },

  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
    borderRadius: 'var(--radius)',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    flexShrink: 0,
  },

  statusDot: (phase: CallPhase): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: phase === 'active' ? 'var(--green)'
               : phase === 'ringing' || phase === 'connecting' ? 'var(--yellow)'
               : phase === 'ending' ? 'var(--red)'
               : 'var(--text-faint)',
    flexShrink: 0,
    animation: phase === 'ringing' || phase === 'connecting' ? 'blink 1s infinite' : 'none',
  }),

  statusText: {
    fontWeight: 600,
    fontSize: 14,
    color: 'var(--text)',
    minWidth: 60,
  },

  indicators: {
    display: 'flex',
    gap: 8,
    marginLeft: 'auto',
  },

  badge: (color: 'green' | 'yellow' | 'purple'): React.CSSProperties => ({
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 20,
    fontWeight: 500,
    background: color === 'green' ? 'var(--green-dim)'
              : color === 'yellow' ? 'rgba(245,158,11,0.12)'
              : 'var(--accent-dim)',
    color: color === 'green' ? 'var(--green)'
         : color === 'yellow' ? 'var(--yellow)'
         : 'var(--accent)',
    border: `1px solid ${
      color === 'green' ? 'rgba(34,197,94,0.25)'
      : color === 'yellow' ? 'rgba(245,158,11,0.25)'
      : 'rgba(108,99,255,0.25)'
    }`,
  }),

  log: {
    flex: 1,
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    padding: 4,
  },

  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: '60px 20px',
    textAlign: 'center' as const,
    color: 'var(--text-faint)',
    gap: 10,
  },

  emptyIcon: {
    fontSize: 42,
    marginBottom: 8,
  },

  emptyTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-muted)',
  },

  emptySub: {
    fontSize: 13,
    maxWidth: 300,
    lineHeight: 1.6,
  },

  message: (role: 'jimmy' | 'user'): React.CSSProperties => ({
    padding: '12px 16px',
    borderRadius: 'var(--radius)',
    background: role === 'jimmy' ? 'var(--surface)' : 'var(--accent-dim)',
    border: `1px solid ${role === 'jimmy' ? 'var(--border)' : 'rgba(108,99,255,0.3)'}`,
    alignSelf: role === 'jimmy' ? 'flex-start' : 'flex-end',
    maxWidth: '80%',
  }),

  msgMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 5,
    gap: 16,
  },

  msgRole: (role: 'jimmy' | 'user'): React.CSSProperties => ({
    fontSize: 11,
    fontWeight: 600,
    color: role === 'jimmy' ? 'var(--text-muted)' : 'var(--accent)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  }),

  msgTime: {
    fontSize: 11,
    color: 'var(--text-faint)',
  },

  msgText: {
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--text)',
  },

  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--red-dim)',
    border: '1px solid rgba(239,68,68,0.3)',
    color: 'var(--red)',
    fontSize: 13,
    flexShrink: 0,
  },

  errorClose: {
    background: 'transparent',
    border: 'none',
    color: 'var(--red)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
  },

  actions: {
    display: 'flex',
    justifyContent: 'center',
    flexShrink: 0,
  },

  callBtn: {
    padding: '14px 48px',
    borderRadius: 40,
    border: 'none',
    background: 'var(--green)',
    color: '#fff',
    fontWeight: 700,
    fontSize: 15,
    cursor: 'pointer',
    boxShadow: '0 4px 20px rgba(34,197,94,0.3)',
    transition: 'all 0.2s',
  } as React.CSSProperties,

  hangupBtn: {
    padding: '14px 48px',
    borderRadius: 40,
    border: 'none',
    background: 'var(--red)',
    color: '#fff',
    fontWeight: 700,
    fontSize: 15,
    cursor: 'pointer',
    boxShadow: '0 4px 20px rgba(239,68,68,0.3)',
    transition: 'all 0.2s',
  } as React.CSSProperties,

  callInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 11,
    color: 'var(--text-faint)',
    justifyContent: 'center',
    flexWrap: 'wrap' as const,
    flexShrink: 0,
  },

  callInfoItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
  },

  callInfoLabel: {
    fontWeight: 600,
    color: 'var(--text-faint)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    fontSize: 10,
  },

  callInfoDot: {
    color: 'var(--text-faint)',
  },
};
