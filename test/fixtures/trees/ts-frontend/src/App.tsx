import React from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './views/DashboardView';

export const App: React.FC = () => {
  return (
    <div className="layout">
      <Header title="Mission Control" />
      <Sidebar />
      <main>
        <DashboardView />
      </main>
    </div>
  );
};
