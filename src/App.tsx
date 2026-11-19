import { useUI } from './store';
import StartScreen from './ui/StartScreen';
import GameScreen from './ui/GameScreen';

export default function App() {
  const screen = useUI((s) => s.screen);
  return screen === 'game' ? <GameScreen /> : <StartScreen />;
}
