import express from 'express';
import { userRouter } from './routes/users';

export const app = express();
app.use(express.json());
app.use('/api/v1/users', userRouter);
