import React from 'react';
import { createRoot } from 'react-dom/client';
import VibeTextAnimation from '../wave';
import './index.css';

const container = document.getElementById('root');
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <VibeTextAnimation />
  </React.StrictMode>
);
