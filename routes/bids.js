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

// 1. GET ALL NEGOTIATIONS FOR CURRENT BUYER
router.get('/buyer', verifyToken, async (req, res) => {
  try {
    const [bids] = await db.query(
      `SELECT 
         crop_bids.*, 
         crop_bids.offered_price_per_kg AS counter_price_per_kg,
         crops.crop_name, 
         crops.price_per_kg AS original_price, 
         crops.quantity_available AS stock_left,
         users.name AS farmer_name,
         users.location AS farmer_location
       FROM crop_bids 
       JOIN crops ON crop_bids.crop_id = crops.id 
       JOIN users ON crop_bids.farmer_id = users.id 
       WHERE crop_bids.buyer_id = ? 
       ORDER BY crop_bids.updated_at DESC`,
      [req.user.id]
    );
    res.json(bids);
  } catch (err) {
    console.error('GET /bids/buyer error:', err.message);
    res.status(500).json({ error: 'Failed to fetch buyer negotiations' });
  }
});

// 2. GET ALL NEGOTIATIONS FOR CURRENT FARMER
router.get('/farmer', verifyToken, async (req, res) => {
  try {
    const [bids] = await db.query(
      `SELECT 
         crop_bids.*, 
         crops.crop_name, 
         crops.price_per_kg AS original_price, 
         crops.quantity_available AS stock_left,
         crops.min_bidding_price,
         users.name AS buyer_name,
         users.location AS buyer_location
       FROM crop_bids 
       JOIN crops ON crop_bids.crop_id = crops.id 
       JOIN users ON crop_bids.buyer_id = users.id 
       WHERE crop_bids.farmer_id = ? 
       ORDER BY crop_bids.updated_at DESC`,
      [req.user.id]
    );
    res.json(bids);
  } catch (err) {
    console.error('GET /bids/farmer error:', err.message);
    res.status(500).json({ error: 'Failed to fetch farmer negotiations' });
  }
});

// 3. GET SINGLE NEGOTIATION DETAILS WITH HISTORY
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [bids] = await db.query(
      `SELECT 
         crop_bids.*, 
         crops.crop_name, 
         crops.price_per_kg AS original_price, 
         crops.quantity_available AS stock_left,
         farmer.name AS farmer_name,
         buyer.name AS buyer_name
       FROM crop_bids 
       JOIN crops ON crop_bids.crop_id = crops.id 
       JOIN users AS farmer ON crop_bids.farmer_id = farmer.id 
       JOIN users AS buyer ON crop_bids.buyer_id = buyer.id 
       WHERE crop_bids.id = ?`,
      [req.params.id]
    );

    if (bids.length === 0) {
      return res.status(404).json({ error: 'Negotiation not found' });
    }

    const bid = bids[0];

    // Authorization check: Only participating buyer or farmer can view
    if (req.user.id !== bid.buyer_id && req.user.id !== bid.farmer_id) {
      return res.status(403).json({ error: 'Not authorized to view this negotiation' });
    }

    // Never expose min_bidding_price to buyers
    if (req.user.id === bid.buyer_id) {
      delete bid.min_bidding_price;
    }

    // Fetch conversation / negotiation history rounds
    const [history] = await db.query(
      `SELECT * FROM negotiation_history WHERE bid_id = ? ORDER BY created_at ASC`,
      [bid.id]
    );

    res.json({ bid, history });
  } catch (err) {
    console.error('GET /bids/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch negotiation details' });
  }
});

// 4. BUYER SUBMITS A NEW OFFER / OPENS NEGOTIATION
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'buyer') {
      return res.status(403).json({ error: 'Only buyers can submit offers' });
    }

    const crop_id = req.body.crop_id;
    const qty = parseInt(req.body.quantity || req.body.offered_quantity, 10);
    const offerPrice = parseFloat(req.body.offered_price_per_kg || req.body.price_per_kg || req.body.price);
    const note = req.body.note || req.body.notes || '';

    if (!crop_id || isNaN(qty) || qty <= 0 || isNaN(offerPrice) || offerPrice <= 0) {
      return res.status(400).json({ error: 'Valid crop ID, quantity, and offer price are required' });
    }

    // Fetch crop and check if bidding is enabled
    const [crops] = await db.query(
      `SELECT id, farmer_id, crop_name, quantity_available, bidding_enabled, min_bidding_price FROM crops WHERE id = ?`,
      [crop_id]
    );

    if (crops.length === 0) {
      return res.status(404).json({ error: 'Crop listing not found' });
    }

    const crop = crops[0];

    if (!crop.bidding_enabled) {
      return res.status(400).json({ error: 'Price negotiation is not enabled for this crop listing' });
    }

    if (crop.quantity_available < qty) {
      return res.status(400).json({ 
        error: `Requested quantity exceeds available stock (${crop.quantity_available} kg available)` 
      });
    }

    // Check if buyer already has an active pending/countered bid on this crop
    const [existing] = await db.query(
      `SELECT id FROM crop_bids WHERE crop_id = ? AND buyer_id = ? AND status IN ('pending', 'countered')`,
      [crop_id, req.user.id]
    );

    if (existing.length > 0) {
      return res.status(400).json({ 
        error: 'You already have an active negotiation for this crop. Please view it in your dashboard.' 
      });
    }

    // Insert new bid
    const [bidResult] = await db.query(
      `INSERT INTO crop_bids (crop_id, buyer_id, farmer_id, quantity, offered_price_per_kg, current_by, status) 
       VALUES (?, ?, ?, ?, ?, 'buyer', 'pending')`,
      [crop_id, req.user.id, crop.farmer_id, qty, offerPrice]
    );

    const bidId = bidResult.insertId;

    // Record in history
    await db.query(
      `INSERT INTO negotiation_history (bid_id, offered_by, user_id, price_per_kg, quantity, note) 
       VALUES (?, 'buyer', ?, ?, ?, ?)`,
      [bidId, req.user.id, offerPrice, qty, note || 'Initial offer submitted']
    );

    // Notify farmer
    await createNotification(
      crop.farmer_id,
      'New Price Offer Received',
      `${req.user.name || 'A buyer'} offered ₹${offerPrice}/kg for ${qty} kg of ${crop.crop_name}.`,
      'farmer-dashboard.html',
      'bid'
    );

    res.status(201).json({ message: 'Offer submitted successfully!', bidId });
  } catch (err) {
    console.error('POST /bids error:', err.message);
    res.status(500).json({ error: 'Server error submitting offer: ' + err.message });
  }
});

// 5. SUBMIT COUNTEROFFER (Farmer or Buyer)
router.post('/:id/counter', verifyToken, async (req, res) => {
  try {
    const counterPrice = parseFloat(req.body.price_per_kg || req.body.counter_price_per_kg || req.body.price);
    const counterQty = req.body.quantity || req.body.counter_quantity ? parseInt(req.body.quantity || req.body.counter_quantity, 10) : null;
    const note = req.body.note || req.body.notes || '';

    if (isNaN(counterPrice) || counterPrice <= 0) {
      return res.status(400).json({ error: 'Valid counter price per kg is required' });
    }

    const [bids] = await db.query(
      `SELECT crop_bids.*, crops.crop_name, crops.quantity_available 
       FROM crop_bids 
       JOIN crops ON crop_bids.crop_id = crops.id 
       WHERE crop_bids.id = ?`,
      [req.params.id]
    );

    if (bids.length === 0) return res.status(404).json({ error: 'Negotiation not found' });
    const bid = bids[0];

    // Must be in active state
    if (!['pending', 'countered'].includes(bid.status)) {
      return res.status(400).json({ error: `Cannot counteroffer on a negotiation with status '${bid.status}'` });
    }

    // Role and turn check
    const isFarmer = req.user.id === bid.farmer_id;
    const isBuyer = req.user.id === bid.buyer_id;

    if (!isFarmer && !isBuyer) {
      return res.status(403).json({ error: 'Not authorized for this negotiation' });
    }

    const senderRole = isFarmer ? 'farmer' : 'buyer';
    const recipientId = isFarmer ? bid.buyer_id : bid.farmer_id;

    const finalQty = counterQty && counterQty > 0 ? counterQty : bid.quantity;
    if (finalQty > bid.quantity_available) {
      return res.status(400).json({ error: 'Counteroffer quantity exceeds available crop stock' });
    }

    // Update bid state
    await db.query(
      `UPDATE crop_bids 
       SET offered_price_per_kg = ?, quantity = ?, current_by = ?, status = 'countered' 
       WHERE id = ?`,
      [counterPrice, finalQty, senderRole, bid.id]
    );

    // Record in history
    await db.query(
      `INSERT INTO negotiation_history (bid_id, offered_by, user_id, price_per_kg, quantity, note) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [bid.id, senderRole, req.user.id, counterPrice, finalQty, note || `Counteroffer of ₹${counterPrice}/kg`]
    );

    // Notify other party
    await createNotification(
      recipientId,
      'Counteroffer Received',
      `${req.user.name || 'Participant'} proposed a counteroffer of ₹${counterPrice}/kg for ${finalQty} kg of ${bid.crop_name}.`,
      isFarmer ? 'buyer-dashboard.html' : 'farmer-dashboard.html',
      'bid'
    );

    res.json({ message: 'Counteroffer sent successfully' });
  } catch (err) {
    console.error('POST /bids/:id/counter error:', err.message);
    res.status(500).json({ error: 'Failed to send counteroffer' });
  }
});

// 6. ACCEPT OFFER (Creates real order with inventory check in database transaction)
router.post('/:id/accept', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [bids] = await connection.query(
      `SELECT crop_bids.*, crops.crop_name, crops.quantity_available 
       FROM crop_bids 
       JOIN crops ON crop_bids.crop_id = crops.id 
       WHERE crop_bids.id = ? FOR UPDATE`,
      [req.params.id]
    );

    if (bids.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Negotiation not found' });
    }

    const bid = bids[0];

    // Check if already completed or accepted
    if (['accepted', 'converted_to_order'].includes(bid.status)) {
      await connection.rollback();
      return res.status(400).json({ error: 'This offer has already been accepted and processed' });
    }

    if (['rejected', 'cancelled'].includes(bid.status)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Cannot accept a rejected or cancelled offer' });
    }

    // Role check: Only farmer or buyer involved in this bid can accept
    const isFarmer = req.user.id === bid.farmer_id;
    const isBuyer = req.user.id === bid.buyer_id;

    if (!isFarmer && !isBuyer) {
      await connection.rollback();
      return res.status(403).json({ error: 'Not authorized to accept this offer' });
    }

    // Verify stock availability
    if (bid.quantity_available < bid.quantity) {
      await connection.rollback();
      return res.status(400).json({ 
        error: `Insufficient stock remaining to accept this offer (only ${bid.quantity_available} kg left)` 
      });
    }

    // Calculate total price at negotiated rate
    const totalPrice = (bid.quantity * bid.offered_price_per_kg).toFixed(2);

    // 1. Decrement crop inventory safely
    await connection.query(
      `UPDATE crops SET quantity_available = quantity_available - ? WHERE id = ?`,
      [bid.quantity, bid.crop_id]
    );

    // 2. Create the real order in orders table
    const [orderResult] = await connection.query(
      `INSERT INTO orders (buyer_id, crop_id, quantity, total_price, status) VALUES (?, ?, ?, ?, 'accepted')`,
      [bid.buyer_id, bid.crop_id, bid.quantity, totalPrice]
    );

    const orderId = orderResult.insertId;

    // 3. Record in order_status_history
    await connection.query(
      `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note) 
       VALUES (?, 'accepted', ?, ?, 'Order created from accepted price negotiation')`,
      [orderId, req.user.id, isFarmer ? 'farmer' : 'buyer']
    );

    // 4. Update bid status to converted_to_order
    await connection.query(
      `UPDATE crop_bids SET status = 'converted_to_order', order_id = ? WHERE id = ?`,
      [orderId, bid.id]
    );

    // 5. Add acceptance record to negotiation history
    await connection.query(
      `INSERT INTO negotiation_history (bid_id, offered_by, user_id, price_per_kg, quantity, note) 
       VALUES (?, ?, ?, ?, ?, 'Offer accepted! Order created.')`,
      [bid.id, isFarmer ? 'farmer' : 'buyer', req.user.id, bid.offered_price_per_kg, bid.quantity]
    );

    await connection.commit();

    // Send notifications to both parties
    const otherUserId = isFarmer ? bid.buyer_id : bid.farmer_id;
    await createNotification(
      otherUserId,
      'Negotiation Accepted! Order Created',
      `Your negotiated offer of ₹${bid.offered_price_per_kg}/kg for ${bid.quantity} kg of ${bid.crop_name} was accepted! Order #${orderId} is confirmed.`,
      isFarmer ? 'buyer-dashboard.html' : 'farmer-dashboard.html',
      'order'
    );

    res.json({ 
      message: 'Offer accepted and order created successfully!', 
      orderId, 
      totalPrice 
    });
  } catch (err) {
    await connection.rollback();
    console.error('POST /bids/:id/accept error:', err.message);
    res.status(500).json({ error: 'Server error accepting offer: ' + err.message });
  } finally {
    connection.release();
  }
});

// 7. REJECT OFFER
router.post('/:id/reject', verifyToken, async (req, res) => {
  try {
    const [bids] = await db.query(
      `SELECT crop_bids.*, crops.crop_name FROM crop_bids JOIN crops ON crop_bids.crop_id = crops.id WHERE crop_bids.id = ?`,
      [req.params.id]
    );

    if (bids.length === 0) return res.status(404).json({ error: 'Negotiation not found' });
    const bid = bids[0];

    if (req.user.id !== bid.farmer_id && req.user.id !== bid.buyer_id) {
      return res.status(403).json({ error: 'Not authorized to reject this offer' });
    }

    await db.query(`UPDATE crop_bids SET status = 'rejected' WHERE id = ?`, [bid.id]);

    await db.query(
      `INSERT INTO negotiation_history (bid_id, offered_by, user_id, price_per_kg, quantity, note) 
       VALUES (?, ?, ?, ?, ?, 'Offer rejected')`,
      [bid.id, req.user.id === bid.farmer_id ? 'farmer' : 'buyer', req.user.id, bid.offered_price_per_kg, bid.quantity]
    );

    const otherUserId = req.user.id === bid.farmer_id ? bid.buyer_id : bid.farmer_id;
    await createNotification(
      otherUserId,
      'Offer Rejected',
      `Negotiation on ${bid.crop_name} was rejected.`,
      req.user.id === bid.farmer_id ? 'buyer-dashboard.html' : 'farmer-dashboard.html',
      'bid'
    );

    res.json({ message: 'Offer rejected' });
  } catch (err) {
    console.error('POST /bids/:id/reject error:', err.message);
    res.status(500).json({ error: 'Failed to reject offer' });
  }
});

module.exports = router;
