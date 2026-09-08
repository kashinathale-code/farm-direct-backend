const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

router.get('/order/:orderId', verifyToken, async (req, res) => {
  try {
    const [messages] = await db.query(
      `SELECT messages.*, users.name AS sender_name
       FROM messages JOIN users ON messages.sender_id = users.id
       WHERE order_id = ? ORDER BY sent_at ASC`,
      [req.params.orderId]
    );
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', verifyToken, async (req, res) => {
  try {
    const { receiver_id, order_id, message_text } = req.body;
    if (!receiver_id || !message_text) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const [result] = await db.query(
      'INSERT INTO messages (sender_id, receiver_id, order_id, message_text) VALUES (?, ?, ?, ?)',
      [req.user.id, receiver_id, order_id || null, message_text]
    );
    res.status(201).json({ message: 'Message sent', messageId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;