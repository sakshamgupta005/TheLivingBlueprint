import React from 'react';
import type { UserProfile } from '../../../shared/src/types';

export const UserList: React.FC = () => {
  const users: UserProfile[] = [{ id: 'u1', name: 'Alice', role: 'admin' }];
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name} ({u.role})</li>
      ))}
    </ul>
  );
};
