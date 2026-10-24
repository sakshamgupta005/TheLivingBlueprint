const express = require('express');
const router = express.Router();

const tasks = [
  { id: 1, title: 'Write tests', completed: false },
  { id: 2, title: 'Build blueprint', completed: true }
];

router.get('/', (req, res) => {
  res.json(tasks);
});

router.get('/:id', (req, res) => {
  const task = tasks.find((t) => t.id === parseInt(req.params.id, 10));
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

module.exports = router;
