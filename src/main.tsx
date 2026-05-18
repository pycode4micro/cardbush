import React from 'react';
import ReactDOM from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';

import { App } from './App';
import { CardlingWindow } from './CardlingWindow';
import './styles/theme.css';
import './styles/app.css';

const isCardlingWindow =
  new URLSearchParams(window.location.search).get('window') === 'cardling';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCardlingWindow ? <CardlingWindow /> : <App />}
  </React.StrictMode>,
);
