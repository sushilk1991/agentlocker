import { createRoot } from 'react-dom/client';
import App from './app';
import { setNonce } from 'get-nonce';
import './style.css';
setNonce(document.querySelector<HTMLMetaElement>('meta[name=csp-nonce]')?.content || '');
createRoot(document.getElementById('root')!).render(<App />);
