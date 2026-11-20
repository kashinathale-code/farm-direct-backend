const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { createNotification } = require('./notifications');
require('dotenv').config();

const router = express.Router();

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

// 1. POST REVIEW FOR DELIVERED ORDER (Strict verification: buyer must have received the order)
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'buyer') {
      return res.status(403).json({ error: 'Only buyers can submit crop & farmer reviews' });
    }

    const { order_id, rating, review_text } = req.body;
    if (!order_id || !rating) {
      return res.status(400).json({ error: 'Order ID and rating (1-5 stars) are required' });
    }

    const numericRating = parseInt(rating, 10);
    if (isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
    }

    // Verify order exists, belongs to current buyer, and status is 'delivered'
    const [orders] = await db.query(
      `SELECT orders.*, crops.farmer_id, crops.crop_name 
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id 
       WHERE orders.id = ?`,
      [order_id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    if (order.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only review orders that you placed' });
    }

    if (order.status !== 'delivered') {
      return res.status(400).json({
        error: `Reviews can only be submitted for completed orders that have been delivered (current status: '${order.status}')`
      });
    }

    // Check if review already submitted for this order
    const [existing] = await db.query(
      `SELECT id FROM reviews WHERE order_id = ?`,
      [order_id]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'You have already reviewed this order' });
    }

    // Insert review
    const sanitizedText = review_text ? review_text.trim() : '';
    const [result] = await db.query(
      `INSERT INTO reviews (order_id, buyer_id, farmer_id, crop_id, rating, review_text) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [order_id, req.user.id, order.farmer_id, order.crop_id, numericRating, sanitizedText]
    );

    // Notify farmer about new feedback
    await createNotification(
      order.farmer_id,
      'New Review Received ⭐',
      `Buyer gave ${numericRating} stars for order #${order.id} (${order.crop_name}). "${sanitizedText.slice(0, 50)}${sanitizedText.length > 50 ? '...' : ''}"`,
      'farmer-dashboard.html',
      'review'
    );

    res.status(201).json({
      message: 'Review submitted successfully! Thank you for supporting our farmers.',
      reviewId: result.insertId
    });
  } catch (err) {
    console.error('POST /api/reviews error:', err.message);
    res.status(500).json({ error: 'Server error submitting review: ' + err.message });
  }
});

// 2. GET REVIEWS FOR A FARMER
router.get('/farmer/:farmerId', async (req, res) => {
  try {
    const farmerId = req.params.farmerId;

    const [reviews] = await db.query(
      `SELECT 
         reviews.id,
         reviews.order_id,
         reviews.rating,
         reviews.review_text,
         reviews.created_at,
         users.name AS buyer_name,
         crops.crop_name
       FROM reviews
       JOIN users ON reviews.buyer_id = users.id
       JOIN crops ON reviews.crop_id = crops.id
       WHERE reviews.farmer_id = ?
       ORDER BY reviews.created_at DESC`,
      [farmerId]
    );

    const [[stats]] = await db.query(
      `SELECT 
         COUNT(*) AS total_reviews,
         COALESCE(ROUND(AVG(rating), 2), 5.0) AS average_rating,
         SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS five_star,
         SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS four_star,
         SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS three_star,
         SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS two_star,
         SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS one_star
       FROM reviews
       WHERE farmer_id = ?`,
      [farmerId]
    );

    res.json({
      summary: {
        total_reviews: stats ? parseInt(stats.total_reviews, 10) : 0,
        average_rating: stats ? parseFloat(stats.average_rating) : 5.0,
        breakdown: {
          5: stats ? parseInt(stats.five_star, 10) : 0,
          4: stats ? parseInt(stats.four_star, 10) : 0,
          3: stats ? parseInt(stats.three_star, 10) : 0,
          2: stats ? parseInt(stats.two_star, 10) : 0,
          1: stats ? parseInt(stats.one_star, 10) : 0
        }
      },
      reviews
    });
  } catch (err) {
    console.error('GET /api/reviews/farmer/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch farmer reviews' });
  }
});

// 3. CHECK IF ORDER HAS BEEN REVIEWED
router.get('/order/:orderId', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM reviews WHERE order_id = ? AND buyer_id = ?`,
      [req.params.orderId, req.user.id]
    );

    res.json({
      has_reviewed: rows.length > 0,
      review: rows.length > 0 ? rows[0] : null
    });
  } catch (err) {
    console.error('GET /api/reviews/order/:orderId error:', err.message);
    res.status(500).json({ error: 'Failed to check order review status' });
  }
});

module.exports = router;
