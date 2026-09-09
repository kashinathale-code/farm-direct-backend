const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = decoded;
    next();
  });
}

// GET MESSAGES FOR AN ORDER
router.get('/order/:orderId', verifyToken, async (req, res) => {
  try {
    const [messages] = await db.query(
      `SELECT messages.*, users.name AS sender_name 
       FROM messages 
       JOIN users ON messages.sender_id = users.id 
       WHERE messages.order_id = ? 
       ORDER BY messages.created_at ASC`,
      [req.params.orderId]
    );
    res.json(messages);
  } catch (err) {
    console.error("GET /messages Error:", err);
    res.status(500).json({ error: 'Server error fetching messages' });
  }
});

// SEND A MESSAGE
router.post('/', verifyToken, async (req, res) => {
  try {
    const order_id = req.body.order_id || req.body.orderId;
    const receiver_id = req.body.receiver_id || req.body.receiverId;
    const message_text = req.body.message_text || req.body.message || req.body.text;

    if (!message_text) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (!order_id) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    await db.query(
      'INSERT INTO messages (order_id, sender_id, receiver_id, message_text) VALUES (?, ?, ?, ?)',
      [order_id, req.user.id, receiver_id || null, message_text]
    );

    res.status(201).json({ message: 'Message sent!' });
  } catch (err) {
    console.error("POST /messages Error:", err.message);
    res.status(500).json({ error: 'Server error sending message: ' + err.message });
  }
});

module.exports = router;