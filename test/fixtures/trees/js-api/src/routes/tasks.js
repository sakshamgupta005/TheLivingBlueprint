const express = require('express');
const { getDatabase } = require('../db/database');
const router = express.Router();

router.get('/', (req, res) => {
  const db = getDatabase();
  res.json({ tasks: [] });
});

router.post('/', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  res.status(201).json({ id: 1, title });
});

module.exports = { taskRouter: router };
