const express = require('express');
const tasksRouter = require('./routes/tasks.js');

const app = express();
app.use(express.json());
app.use('/tasks', tasksRouter);

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

module.exports = app;
