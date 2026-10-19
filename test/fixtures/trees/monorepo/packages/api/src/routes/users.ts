import { Router } from 'express';
import type { UserProfile } from '../../../shared/src/types';

export const userRouter = Router();
userRouter.get('/', (req, res) => {
  const users: UserProfile[] = [{ id: 'u1', name: 'Alice', role: 'admin' }];
  res.json({ users });
});
