import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { CardlingWindow } from './CardlingWindow';
import { ShadowWindow } from './ShadowWindow';
import './styles/theme.css';
import './styles/app.css';

const rendererWindow = new URLSearchParams(window.location.search).get('window');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {rendererWindow === 'cardling' ? (
      <CardlingWindow />
    ) : rendererWindow === 'shadow' ? (
      <ShadowWindow />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
