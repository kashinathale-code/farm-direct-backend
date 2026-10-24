const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { createNotification } = require('./notifications');
require('dotenv').config();

const router = express.Router();

// Middleware to verify JWT token
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

// GET MESSAGES FOR AN ORDER (Authorized: Only buyer or farmer of this order)
router.get('/order/:orderId', verifyToken, async (req, res) => {
  try {
    const orderId = req.params.orderId;

    // Verify order exists and user is an authorized participant
    const [orders] = await db.query(
      `SELECT orders.id, orders.buyer_id, crops.farmer_id 
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id 
       WHERE orders.id = ?`,
      [orderId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];
    if (req.user.id !== order.buyer_id && req.user.id !== order.farmer_id) {
      return res.status(403).json({ error: 'Not authorized to access conversations for this order' });
    }

    const [messages] = await db.query(
      `SELECT messages.*, users.name AS sender_name 
       FROM messages 
       JOIN users ON messages.sender_id = users.id 
       WHERE messages.order_id = ? 
       ORDER BY messages.created_at ASC`,
      [orderId]
    );

    res.json(messages);
  } catch (err) {
    console.error("GET /messages Error:", err.message);
    res.status(500).json({ error: 'Server error fetching messages' });
  }
});

// SEND A MESSAGE (Authorized participant check and notification trigger)
router.post('/', verifyToken, async (req, res) => {
  try {
    const order_id = req.body.order_id || req.body.orderId;
    const raw_message = req.body.message_text || req.body.message || req.body.text;
    const message_text = raw_message ? raw_message.trim() : '';

    if (!message_text) {
      return res.status(400).json({ error: 'Message text cannot be empty' });
    }

    if (message_text.length > 2000) {
      return res.status(400).json({ error: 'Message is too long (maximum 2000 characters)' });
    }

    if (!order_id) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    // Verify user is either the buyer or the farmer for this order
    const [orders] = await db.query(
      `SELECT orders.id, orders.buyer_id, crops.farmer_id, crops.crop_name 
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id 
       WHERE orders.id = ?`,
      [order_id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];
    if (req.user.id !== order.buyer_id && req.user.id !== order.farmer_id) {
      return res.status(403).json({ error: 'Not authorized to send messages for this order' });
    }

    // Determine target recipient automatically to prevent user impersonation
    const receiver_id = req.user.id === order.buyer_id ? order.farmer_id : order.buyer_id;

    await db.query(
      'INSERT INTO messages (order_id, sender_id, receiver_id, message_text) VALUES (?, ?, ?, ?)',
      [order_id, req.user.id, receiver_id, message_text]
    );

    // Send persistent notification to receiver
    await createNotification(
      receiver_id,
      'New Message',
      `${req.user.name || 'User'} sent you a message regarding Order #${order.id} (${order.crop_name}).`,
      req.user.id === order.buyer_id ? 'farmer-dashboard.html' : 'buyer-dashboard.html',
      'message'
    );

    res.status(201).json({ message: 'Message sent!' });
  } catch (err) {
    console.error("POST /messages Error:", err.message);
    res.status(500).json({ error: 'Server error sending message: ' + err.message });
  }
});

module.exports = router;