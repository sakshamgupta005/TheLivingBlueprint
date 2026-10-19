const express = require('express');
const { taskRouter } = require('./routes/tasks');
const { authMiddleware } = require('./middleware/auth');

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use('/api/tasks', taskRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = { app };
