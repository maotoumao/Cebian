import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import App from './App.tsx';
import '@/assets/tailwind.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/chat/new']}>
      <App />
    </MemoryRouter>
  </React.StrictMode>,
);
