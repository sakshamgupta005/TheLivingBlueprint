import React from 'react';
import { UserList } from './components/UserList';

export const App: React.FC = () => {
  return (
    <div>
      <h1>SaaS Platform Admin</h1>
      <UserList />
    </div>
  );
};
