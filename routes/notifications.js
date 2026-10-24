const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
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

// Reusable helper to send persistent notification to a user
async function createNotification(userId, title, message, link = '', type = 'order') {
  try {
    if (!userId || !title || !message) return;
    await db.query(
      `INSERT INTO notifications (user_id, title, message, link, type, is_read) VALUES (?, ?, ?, ?, ?, FALSE)`,
      [userId, title, message, link, type]
    );
  } catch (err) {
    console.error('Notification creation failed:', err.message);
  }
}

// 1. GET ALL NOTIFICATIONS FOR LOGGED IN USER
router.get('/', verifyToken, async (req, res) => {
  try {
    const [notifications] = await db.query(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(notifications);
  } catch (err) {
    console.error('GET /notifications error:', err.message);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// 2. GET UNREAD NOTIFICATION COUNT
router.get('/unread-count', verifyToken, async (req, res) => {
  try {
    const [[result]] = await db.query(
      `SELECT COUNT(*) AS unreadCount FROM notifications WHERE user_id = ? AND is_read = FALSE`,
      [req.user.id]
    );
    res.json({ count: result ? result.unreadCount : 0 });
  } catch (err) {
    console.error('GET /notifications/unread-count error:', err.message);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// 3. MARK SINGLE NOTIFICATION AS READ
const markSingleRead = async (req, res) => {
  try {
    const [result] = await db.query(
      `UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    console.error('PUT /notifications/:id/read error:', err.message);
    res.status(500).json({ error: 'Failed to update notification' });
  }
};
router.put('/:id/read', verifyToken, markSingleRead);
router.patch('/:id/read', verifyToken, markSingleRead);

// 4. MARK ALL NOTIFICATIONS AS READ
router.put('/read-all', verifyToken, async (req, res) => {
  try {
    await db.query(
      `UPDATE notifications SET is_read = TRUE WHERE user_id = ?`,
      [req.user.id]
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('PUT /notifications/read-all error:', err.message);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

module.exports = {
  router,
  createNotification
};
