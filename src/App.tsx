import { Suspense, lazy } from 'react';
import { useUI } from './store';
import StartScreen from './ui/StartScreen';
import GameScreen from './ui/GameScreen';

const PilotSetup = lazy(() => import('./ui/pilot/PilotSetup'));
const PilotScreen = lazy(() => import('./ui/pilot/PilotScreen'));

export default function App() {
  const screen = useUI((s) => s.screen);
  const cfg = useUI((s) => s.pilotCfg);
  const key = useUI((s) => s.pilotKey);
  if (screen === 'game') return <GameScreen />;
  if (screen === 'pilotSetup' || (screen === 'pilot' && cfg)) {
    return <Suspense fallback={<div className="h-full flex items-center justify-center text-slate-500">Loading flight deck…</div>}>{screen === 'pilot' && cfg ? <PilotScreen key={key} cfg={cfg} /> : <PilotSetup />}</Suspense>;
  }
  return <StartScreen />;
}
