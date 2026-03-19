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
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      reconnectionAttempts: 20,
      timeout: 10000,
    });

    socket.on('connect', () => {
      console.log('✅ Socket connected:', socket.id);
      if (callActiveRef.current) setError(null);
    });

    socket.on('disconnect', (reason) => {
      console.log('🔌 Socket disconnected:', reason);
      if (callActiveRef.current) {
        setError('Connection lost — reconnecting…');
        // Stop mic and audio immediately so we don't keep streaming to a dead socket
        if (streamingAudioContextRef.current) {
          try { streamingAudioContextRef.current.close(); } catch (_) {}
          streamingAudioContextRef.current = null;
        }
        jimmySpeakingRef.current = false;
        setIsPlaying(false);
        setIsProcessing(false);
        setVadActive(false);
      }
    });

    socket.on('connect_error', (err) => {
      if (!callActiveRef.current) return;
      console.error('❌ Socket connection error:', err.message);
      setError('Connection lost — retrying…');
    });

    // ── Greeting ──────────────────────────────────────────────────────────
    socket.on('voiceCharacterGreeting', async (data: {
      sessionId: string;
      text: string;
      ttsProcessingTime: number;
      totalChunks: number;
      streamingComplete: boolean;
      ttfaTime?: number;
    }) => {
      if (!callActiveRef.current) return;

      console.log('🎭 Jimmy greeting:', data.text);
      if (data.ttfaTime) console.log(`   ⚡ Time-to-first-audio: ${data.ttfaTime}ms`);

      // Stop any ringtone
      setPhase('active');

      setMessages(prev => [...prev, { role: 'jimmy', text: data.text, ts: Date.now() }]);

      // Wait for greeting audio to nearly finish (500ms early) then open mic.
      // The 1200ms deaf period in the processor handles remaining echo — no need
      // to also start the echo guard timer here.
      const audioContext = streamingAudioContextRef.current;
      if (audioContext && streamingStartTimeRef.current > 0) {
        const remaining = Math.max(0, streamingStartTimeRef.current - audioContext.currentTime);
        const waitTime = Math.max(0, remaining * 1000 - 500);
        console.log(`   ⏳ Waiting ${waitTime.toFixed(0)}ms for greeting to finish...`);
        await new Promise(r => setTimeout(r, waitTime));
        console.log('   ✅ Streamed greeting complete');
      }

      setIsPlaying(false);
      jimmySpeakingRef.current = false;
      echoGuardRef.current = 0; // let 1200ms deaf period handle echo, don't stack 600ms on top

      // Tell backend greeting playback is done
      if (socketRef.current && sessionIdRef.current) {
        socketRef.current.emit('voicePlaybackComplete', { sessionId: sessionIdRef.current });
      }

      console.log('🎤 Greeting played, NOW enabling microphone...');
      // Open mic — stream already held from requestMicPermission, so this is instant
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

      if (data.isLast) {
        console.log(`📦 Last audio chunk received (#${data.chunkIndex})`);
      }
    });

    // ── Response (fires after last chunk) ─────────────────────────────────
    socket.on('voiceCharacterResponse', async (data: {
      sessionId: string;
      text: string;
      isCallEnding?: boolean;
      sttProcessingTime?: number;
      processingTime?: number;
      ttfaTime?: number;
      ttsProcessingTime?: number;
      totalPipelineTime?: number;
    }) => {
      if (!callActiveRef.current) return;

      // Reset barge-in gate — new Jimmy response means a fresh barge-in is allowed
      bargeInFiredRef.current = false;

      console.log('🎭 Jimmy says:', data.text);
      if (data.sttProcessingTime) console.log(`   STT: ${data.sttProcessingTime}ms`);
      if (data.processingTime) console.log(`   LLM: ${data.processingTime}ms`);
      if (data.ttfaTime) console.log(`   ⚡ Time-to-first-audio: ${data.ttfaTime}ms`);
      if (data.ttsProcessingTime) console.log(`   TTS total: ${data.ttsProcessingTime}ms`);
      if (data.totalPipelineTime) console.log(`   🚀 Total pipeline: ${data.totalPipelineTime}ms`);

      setMessages(prev => [...prev, { role: 'jimmy', text: data.text, ts: Date.now() }]);
      setIsProcessing(false);

      // Wait for audio playback to complete (500ms early so user can respond quickly)
      const audioContext = streamingAudioContextRef.current;
      if (audioContext && streamingStartTimeRef.current > 0) {
        const remaining = Math.max(0, streamingStartTimeRef.current - audioContext.currentTime);
        const waitTime = Math.max(0, remaining * 1000 - 500);
        console.log(`   ⏳ Waiting ${waitTime.toFixed(0)}ms for streaming to complete...`);
        await new Promise(r => setTimeout(r, waitTime));
        console.log('   ✅ Streamed response complete');
      }

      setIsPlaying(false);
      jimmySpeakingRef.current = false;
      echoGuardRef.current = Date.now();

      // Tell backend audio is done so it releases isProcessing immediately
      if (socketRef.current && sessionIdRef.current) {
        socketRef.current.emit('voicePlaybackComplete', { sessionId: sessionIdRef.current });
      }

      if (data.isCallEnding) {
        console.log('👋 Call ending naturally');
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
        console.log(`🔇 Noise/silence rejected: "${data.text}" — ignoring silently`);
        setIsProcessing(false);
        return;
      }
      console.log('🎤 You said:', data.text);
      setIsProcessing(false);
      setMessages(prev => [...prev, { role: 'user', text: data.text, ts: Date.now() }]);
    });

    socket.on('voiceSpeechStart', () => {
      console.log('🗣️ Speech detected (VAD)');
      setVadActive(true);
    });
    socket.on('voiceSpeechEnd', () => {
      console.log('🔚 Speech ended — processing...');
      setVadActive(false);
      setIsProcessing(true);
    });

    socket.on('voiceProcessingStart', () => setIsProcessing(true));

    socket.on('voiceError', (data: { error: string }) => {
      console.error('❌ Voice error:', data.error);
      setIsProcessing(false);
      const isFatal = data.error.toLowerCase().includes('connect') ||
                      data.error.toLowerCase().includes('session');
      if (isFatal) setError(data.error);
    });

    // Backend confirmed barge-in — audio already stopped in the processor
    socket.on('voiceStopAudio', () => {
      console.log('⏹️ voiceStopAudio — barge-in confirmed by backend');
      bargeInFiredRef.current = false;
      jimmySpeakingRef.current = false;
      setIsPlaying(false);
      setIsProcessing(false);
    });

    socket.on('voiceCallEnded', () => {
      console.log('📴 voiceCallEnded received');
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
    console.log('🎤 Requesting mic permission early...');
    try {
      // Don't constrain sampleRate — browsers like Firefox/Safari ignore it and
      // return the device's native rate. We resample to 16kHz in the processor.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;
      console.log('✅ Mic permission granted — stream held, processor not started yet');
    } catch (err) {
      console.error('❌ Mic permission denied:', err);
      setError('Microphone access denied');
    }
  }, []);

  const startMicrophone = useCallback(async () => {
    console.log('🎤 Starting microphone streaming...');
    try {
      // Reuse stream from early permission request if available
      if (!streamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        streamRef.current = stream;
      }

      const stream = streamRef.current!;

      // Use the stream's native sample rate to avoid cross-rate AudioContext errors
      // (Firefox/Safari ignore the sampleRate getUserMedia constraint).
      const nativeSampleRate = stream.getAudioTracks()[0]?.getSettings().sampleRate || 44100;
      const audioCtx = new AudioContext({ sampleRate: nativeSampleRate });
      audioContextRef.current = audioCtx;
      console.log(`   Native sample rate: ${nativeSampleRate}Hz — will resample to 16kHz`);

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      micStartedAtRef.current = Date.now();

      // Linear interpolation resample: nativeSampleRate → TARGET_SAMPLE_RATE
      const TARGET_SAMPLE_RATE = 16000;
      const resample = (input: Float32Array, inRate: number, outRate: number): Float32Array => {
        if (inRate === outRate) return input;
        const ratio = inRate / outRate;
        const outLength = Math.round(input.length / ratio);
        const output = new Float32Array(outLength);
        for (let i = 0; i < outLength; i++) {
          const pos = i * ratio;
          const idx = Math.floor(pos);
          const frac = pos - idx;
          const a = input[idx] ?? 0;
          const b = input[idx + 1] ?? a;
          output[i] = a + frac * (b - a);
        }
        return output;
      };

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!socketRef.current || !sessionIdRef.current) return;

        // 1200ms deaf period to avoid capturing greeting echo
        if (Date.now() - micStartedAtRef.current < 1200) return;

        const rawInput = e.inputBuffer.getChannelData(0);

        // While Jimmy is speaking, check for barge-in before muting
        if (jimmySpeakingRef.current) {
          let sumSq = 0;
          for (let i = 0; i < rawInput.length; i++) sumSq += rawInput[i] * rawInput[i];
          const rms = Math.sqrt(sumSq / rawInput.length);

          if (rms > BARGE_IN_THRESHOLD && !bargeInFiredRef.current && socketRef.current && sessionIdRef.current) {
            bargeInFiredRef.current = true;
            console.log(`🚨 Barge-in detected (rms=${rms.toFixed(4)}) — interrupting Jimmy`);
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

        // Resample to 16kHz before RMS / sending
        const inputData = resample(rawInput, nativeSampleRate, TARGET_SAMPLE_RATE);

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
      console.log('✅ Microphone streaming started');
    } catch (err) {
      console.error('❌ Failed to start microphone:', err);
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
    console.log('📞 Starting call...');
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
      console.log('🎤 Joining voice session:', sessionId);
      console.log('⏸️ Mic stream ready, processor starts after greeting plays...');

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
      console.error('❌ Failed to start call:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect');
      socket.disconnect();
      socketRef.current = null;
    }
  }, [initSocket, requestMicPermission, systemPrompt, voiceId]);

  const endCall = useCallback(() => {
    console.log('📴 Ending call...');
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

  // Status dot color for the avatar indicator
  const dotColor = vadActive       ? '#f87171'   // red — user speaking
    : isProcessing                 ? '#60a5fa'   // blue — thinking
    : isPlaying                    ? '#c084fc'   // purple — Jimmy speaking
    : isCallActive                 ? '#4ade80'   // green — idle in call
    : '#6b7280';                                 // gray — disconnected

  // Status text shown below Jimmy's name during call
  const callStatusText =
      phase === 'connecting' || phase === 'ringing' ? 'Calling...'
    : isProcessing  ? 'Thinking...'
    : isPlaying     ? 'Speaking...'
    : vadActive     ? 'Listening...'
    : phase === 'ending' ? 'Ending call...'
    : 'In call';

  // Top connection label
  const topLabel =
      phase === 'connecting' ? 'Connecting...'
    : phase === 'ringing'    ? 'Calling...'
    : phase === 'active'     ? `Connected · ${formatDuration(duration)}`
    : phase === 'ending'     ? 'Ending...'
    : '';
  const topLabelColor = phase === 'active' ? '#4ade80' : '#fbbf24';

  return (
    <div style={{ height: '100vh', background: '#000', color: '#fff', display: 'flex', flexDirection: 'column' }}>

      {/* ── IDLE: Settings screen ────────────────────────────────────────── */}
      {!isCallActive && (
        <div style={s.idleRoot}>
          <header style={s.idleHeader}>
            <div style={s.idleHeaderLeft}>
              <span style={{ fontSize: 22 }}>🧪</span>
              <div>
                <div style={s.idleTitle}>Jimmy Prompt Tester</div>
                <div style={s.idleSub}>Internal tool · Vice Game</div>
              </div>
            </div>
            <button style={s.settingsToggle} onClick={() => setSettingsOpen(o => !o)}>
              {settingsOpen ? 'Hide Settings' : 'Show Settings'}
            </button>
          </header>

          <div style={s.idleBody}>
            {settingsOpen && (
              <div style={s.settingsPanel}>
                <p style={s.sectionLabel}>Configuration</p>

                <label style={s.fieldLabel}>
                  Backend URL
                  <input style={s.input} value={backendUrl}
                    onChange={e => setBackendUrl(e.target.value)}
                    placeholder="http://localhost:3001" spellCheck={false} />
                </label>

                <label style={s.fieldLabel}>
                  Voice ID
                  <div style={s.row}>
                    <input style={{ ...s.input, fontFamily: 'monospace', flex: 1 }} value={voiceId}
                      onChange={e => setVoiceId(e.target.value)} placeholder="09d4ef3e" spellCheck={false} />
                    <button style={s.resetBtn} onClick={() => setVoiceId(DEFAULT_VOICE_ID)}>↺</button>
                  </div>
                  <span style={s.hint}>Default: <code style={s.mono}>{DEFAULT_VOICE_ID}</code></span>
                </label>

                <label style={s.fieldLabel}>
                  System Prompt
                  <div style={s.row}>
                    <span style={s.hint}>{systemPrompt.length} chars</span>
                    <button style={s.resetBtn} onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}>Reset to default</button>
                  </div>
                  <textarea style={s.textarea} value={systemPrompt}
                    onChange={e => setSystemPrompt(e.target.value)} rows={14} spellCheck={false} />
                </label>
              </div>
            )}

            {error && (
              <div style={s.errorBanner}>
                {error}
                <button style={s.errorClose} onClick={() => setError(null)}>✕</button>
              </div>
            )}

            <div style={s.callBtnWrap}>
              <button style={s.callBtn} onClick={startCall}>
                <span style={{ fontSize: 20 }}>📞</span>
                Call Jimmy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ACTIVE: Phone call UI ───────────────────────────────────────── */}
      {isCallActive && (
        <div style={s.callRoot}>
          <div style={s.callBg} />
          <div style={s.callCard}>
            {/* Top — status */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: topLabelColor, fontSize: 13, fontWeight: 600 }}>{topLabel}</div>
              {error && <div style={{ color: '#f87171', fontSize: 12, marginTop: 4 }}>{error}</div>}
            </div>

            {/* Middle — avatar + name + status */}
            <div style={s.callCenter}>
              <div style={s.avatarWrap}>
                <div style={s.avatarCircle}>
                  <span style={s.avatarLetter}>J</span>
                </div>
                <div style={{
                  ...s.statusDot,
                  background: dotColor,
                  animation: (isProcessing || isPlaying || vadActive) ? 'pulseDot 1.2s ease-in-out infinite' : 'none',
                }} />
              </div>
              <h2 style={s.contactName}>Jimmy</h2>
              <p style={s.callStatus}>{callStatusText}</p>
            </div>

            {/* Bottom — hangup */}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button style={s.hangupBtn} onClick={endCall}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                  <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulseDot {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.35); opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  // Idle / settings screen
  idleRoot: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    background: '#0f1117',
    color: '#e2e8f0',
  },
  idleHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 20px',
    borderBottom: '1px solid #2e3250',
    background: '#1a1d27',
    flexShrink: 0,
  },
  idleHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  idleTitle: { fontWeight: 700, fontSize: 15 },
  idleSub: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  settingsToggle: {
    padding: '6px 14px',
    borderRadius: 6,
    border: '1px solid #2e3250',
    background: 'transparent',
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 13,
  },
  idleBody: {
    flex: 1,
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    maxWidth: 600,
    margin: '0 auto',
    width: '100%',
    padding: '28px 20px',
    gap: 20,
  },
  settingsPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#94a3b8',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    fontSize: 13,
    color: '#94a3b8',
    fontWeight: 500,
  },
  input: {
    padding: '9px 12px',
    borderRadius: 6,
    border: '1px solid #2e3250',
    background: '#222535',
    color: '#e2e8f0',
    fontSize: 13,
    outline: 'none',
    width: '100%',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    justifyContent: 'space-between',
  },
  resetBtn: {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #2e3250',
    background: 'transparent',
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  hint: { fontSize: 11, color: '#475569' },
  mono: {
    fontFamily: 'monospace',
    fontSize: 11,
    background: '#222535',
    padding: '1px 5px',
    borderRadius: 4,
    border: '1px solid #2e3250',
  } as React.CSSProperties,
  textarea: {
    padding: '10px 12px',
    borderRadius: 6,
    border: '1px solid #2e3250',
    background: '#222535',
    color: '#e2e8f0',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 1.6,
    resize: 'vertical' as const,
    outline: 'none',
    minHeight: 220,
    width: '100%',
  } as React.CSSProperties,
  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    borderRadius: 6,
    background: 'rgba(239,68,68,0.12)',
    border: '1px solid rgba(239,68,68,0.3)',
    color: '#ef4444',
    fontSize: 13,
  },
  errorClose: {
    background: 'transparent',
    border: 'none',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
  },
  callBtnWrap: {
    display: 'flex',
    justifyContent: 'center',
    paddingTop: 12,
  },
  callBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '15px 52px',
    borderRadius: 50,
    border: 'none',
    background: '#22c55e',
    color: '#fff',
    fontWeight: 700,
    fontSize: 16,
    cursor: 'pointer',
    boxShadow: '0 6px 24px rgba(34,197,94,0.35)',
  } as React.CSSProperties,

  // Active call screen
  callRoot: {
    position: 'fixed' as const,
    inset: 0,
    background: '#000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBg: {
    position: 'absolute' as const,
    inset: 0,
    background: 'radial-gradient(ellipse at 50% 30%, rgba(109,40,217,0.5) 0%, rgba(0,0,0,0) 68%)',
    pointerEvents: 'none' as const,
  },
  callCard: {
    position: 'relative' as const,
    width: '100%',
    maxWidth: 360,
    height: '100%',
    maxHeight: 760,
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between',
    padding: '64px 32px',
  },
  callCenter: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    gap: 16,
  },
  avatarWrap: {
    position: 'relative' as const,
    width: 192,
    height: 192,
    marginBottom: 8,
  },
  avatarCircle: {
    width: '100%',
    height: '100%',
    borderRadius: '50%',
    border: '4px solid rgba(255,255,255,0.15)',
    background: 'linear-gradient(135deg, #6d28d9 0%, #a855f7 55%, #ec4899 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 24px 64px rgba(109,40,217,0.55)',
  },
  avatarLetter: {
    fontSize: 84,
    fontWeight: 800,
    color: 'rgba(255,255,255,0.95)',
    lineHeight: 1,
    textShadow: '0 2px 16px rgba(0,0,0,0.4)',
  },
  statusDot: {
    position: 'absolute' as const,
    top: 16,
    right: 16,
    width: 18,
    height: 18,
    borderRadius: '50%',
    border: '2.5px solid #fff',
    transition: 'background 0.3s',
  } as React.CSSProperties,
  contactName: {
    fontSize: 28,
    fontWeight: 600,
    color: '#fff',
    letterSpacing: '-0.02em',
  },
  callStatus: {
    fontSize: 17,
    color: 'rgba(255,255,255,0.6)',
    minHeight: 26,
  },
  hangupBtn: {
    width: 68,
    height: 68,
    borderRadius: '50%',
    border: 'none',
    background: '#ef4444',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    boxShadow: '0 8px 28px rgba(239,68,68,0.5)',
  } as React.CSSProperties,
};
