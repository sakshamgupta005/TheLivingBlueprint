function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = { authMiddleware };
