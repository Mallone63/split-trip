import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializePwa } from './lib/pwa';
import './index.css';

initializePwa();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
