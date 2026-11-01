import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '../components/ui/button';
type Theme = 'system' | 'light' | 'dark';
export function ThemeToggle() {
 const [theme, setTheme] = useState<Theme>(() => { try {const stored = localStorage.getItem('locker-theme'); return stored === 'light' || stored === 'dark' ? stored : 'system';} catch {return 'system';} });
 useEffect(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches));};
  apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
 }, [theme]);
 const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
 return <Button variant="ghost" onClick={() => {setTheme(next); try {if (next === 'system') localStorage.removeItem('locker-theme'); else localStorage.setItem('locker-theme', next);} catch {/* Theme still works in memory. */}}} aria-label={`Theme: ${theme}. Switch to ${next}`}>
  {theme === 'system' ? <Monitor size={17} /> : theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}<span>{theme === 'system' ? 'System theme' : theme === 'dark' ? 'Dark theme' : 'Light theme'}</span>
 </Button>;
}
