import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SessionProvider } from './auth/Session';
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><SessionProvider><App /></SessionProvider></React.StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(console.error));
}
