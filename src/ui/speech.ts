/** Browser speech glue (optional): Web Speech recognition for commands, speechSynthesis for pilot readbacks, WebAudio alert tones. */
type Rec = { start(): void; stop(): void; abort(): void; lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };

export const speechSupported = () => typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

let rec: Rec | null = null;
export function listen(onText: (text: string, final: boolean) => void, onEnd: (err?: string) => void): () => void {
  const C = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!C) { onEnd('Speech recognition is not available in this browser.'); return () => {}; }
  rec?.abort();
  const r: Rec = new C();
  rec = r;
  r.lang = 'en-US';
  r.interimResults = true;
  r.continuous = false;
  let err: string | undefined;
  r.onresult = (e) => {
    let text = '';
    let final = false;
    for (let i = 0; i < e.results.length; i++) { text += e.results[i][0].transcript; if (e.results[i].isFinal) final = true; }
    onText(text, final);
  };
  r.onerror = (e) => { err = e.error === 'not-allowed' ? 'Microphone permission denied.' : `Speech error: ${e.error}`; };
  r.onend = () => { rec = null; onEnd(err); };
  try { r.start(); } catch { onEnd('Could not start speech recognition.'); }
  return () => r.stop();
}

/** speak a pilot transmission with a voice/pitch derived from the aircraft id so pilots sound distinct */
export function speak(text: string, seed: number) {
  if (!ttsSupported()) return;
  const synth = window.speechSynthesis;
  if (synth.pending && synth.speaking) return; // don't build an endless backlog
  const u = new SpeechSynthesisUtterance(text.replace(/niner/g, 'niner'));
  const voices = synth.getVoices().filter((v) => v.lang.startsWith('en'));
  if (voices.length) u.voice = voices[seed % voices.length];
  u.rate = 1.12 + (seed % 5) * 0.03;
  u.pitch = 0.8 + (seed % 7) * 0.06;
  u.volume = 0.9;
  synth.speak(u);
}
export const stopSpeaking = () => { if (ttsSupported()) window.speechSynthesis.cancel(); };

let actx: AudioContext | null = null;
export function tone(kind: 'request' | 'alert' | 'critical' | 'ok' | 'error') {
  try {
    actx ??= new AudioContext();
    const t0 = actx.currentTime;
    const seq: [number, number][] = kind === 'critical' ? [[880, 0], [660, 0.16], [880, 0.32], [660, 0.48]] : kind === 'alert' ? [[740, 0], [740, 0.2]] : kind === 'request' ? [[520, 0]] : kind === 'ok' ? [[660, 0]] : [[220, 0]];
    for (const [f, dt] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = kind === 'critical' ? 'square' : 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(kind === 'request' || kind === 'ok' ? 0.04 : 0.09, t0 + dt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.13);
      o.connect(g).connect(actx.destination);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.15);
    }
  } catch { /* audio unavailable */ }
}
