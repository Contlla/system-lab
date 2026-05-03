require('dotenv').config();

const jwt = require('jsonwebtoken');
const { get } = require('../db');
const { buildAuthUser } = require('../permissions');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('FATAL: JWT_SECRET is not set in authMiddleware.');
  process.exit(1);
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ error: 'No token provided' });
  }

  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Invalid token format' });
  }

  const token = header.split(' ')[1];

  try {
    const decoded = jwt.verify(token, SECRET);
    const user = await get(
      `SELECT id, usuario, role, permissions FROM usuarios WHERE id = ?`,
      [decoded.id]
    );
    if (!user) {
      return res.status(401).json({ error: 'Session user is no longer valid' });
    }
    req.user = buildAuthUser(user);
    next();

  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}

module.exports = authMiddleware;
