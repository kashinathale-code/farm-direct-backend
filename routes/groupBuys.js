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

// 1. GET ALL ACTIVE GROUP BUYING CAMPAIGNS (Marketplace browse)
router.get('/', async (req, res) => {
  try {
    const [groupBuys] = await db.query(
      `SELECT 
         group_buys.*, 
         crops.crop_name, 
         crops.price_per_kg AS original_price, 
         crops.quantity_available AS stock_left,
         crops.image,
         users.name AS farmer_name, 
         users.location AS farmer_location,
         (SELECT COUNT(*) FROM group_buy_participants WHERE group_buy_id = group_buys.id AND status != 'cancelled') AS participant_count
       FROM group_buys 
       JOIN crops ON group_buys.crop_id = crops.id 
       JOIN users ON group_buys.farmer_id = users.id 
       WHERE group_buys.status = 'active' AND group_buys.end_date > NOW() 
       ORDER BY group_buys.created_at DESC`
    );
    res.json(groupBuys);
  } catch (err) {
    console.error('GET /group-buys error:', err.message);
    res.status(500).json({ error: 'Failed to fetch group buy campaigns' });
  }
});

// 2. GET SINGLE GROUP BUY DETAILS INCLUDING PARTICIPANTS
router.get('/:id', async (req, res) => {
  try {
    const [campaigns] = await db.query(
      `SELECT 
         group_buys.*, 
         crops.crop_name, 
         crops.price_per_kg AS original_price, 
         crops.quantity_available AS stock_left,
         crops.image,
         users.name AS farmer_name, 
         users.location AS farmer_location
       FROM group_buys 
       JOIN crops ON group_buys.crop_id = crops.id 
       JOIN users ON group_buys.farmer_id = users.id 
       WHERE group_buys.id = ?`,
      [req.params.id]
    );

    if (campaigns.length === 0) {
      return res.status(404).json({ error: 'Group buy campaign not found' });
    }

    const campaign = campaigns[0];

    // Fetch participant summary (safe: no passwords/tokens)
    const [participants] = await db.query(
      `SELECT 
         group_buy_participants.id,
         group_buy_participants.quantity, 
         group_buy_participants.total_price, 
         group_buy_participants.status, 
         group_buy_participants.joined_at, 
         users.name AS buyer_name,
         group_buy_participants.buyer_id
       FROM group_buy_participants 
       JOIN users ON group_buy_participants.buyer_id = users.id 
       WHERE group_buy_participants.group_buy_id = ? AND group_buy_participants.status != 'cancelled'
       ORDER BY group_buy_participants.joined_at ASC`,
      [campaign.id]
    );

    res.json({ ...campaign, campaign, participants });
  } catch (err) {
    console.error('GET /group-buys/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch campaign details' });
  }
});

// 3. GET FARMER'S CREATED GROUP BUYS
router.get('/farmer/mine', verifyToken, async (req, res) => {
  try {
    const [campaigns] = await db.query(
      `SELECT 
         group_buys.*, 
         crops.crop_name, 
         crops.price_per_kg AS original_price, 
         crops.quantity_available AS stock_left,
         (SELECT COUNT(*) FROM group_buy_participants WHERE group_buy_id = group_buys.id AND status != 'cancelled') AS participant_count
       FROM group_buys 
       JOIN crops ON group_buys.crop_id = crops.id 
       WHERE group_buys.farmer_id = ? 
       ORDER BY group_buys.created_at DESC`,
      [req.user.id]
    );
    res.json(campaigns);
  } catch (err) {
    console.error('GET /group-buys/farmer/mine error:', err.message);
    res.status(500).json({ error: 'Failed to fetch farmer campaigns' });
  }
});

// 4. GET BUYER'S JOINED GROUP BUYS
router.get('/buyer/mine', verifyToken, async (req, res) => {
  try {
    const [joined] = await db.query(
      `SELECT 
         group_buy_participants.id AS participation_id,
         group_buy_participants.quantity AS my_quantity,
         group_buy_participants.total_price AS my_total_price,
         group_buy_participants.status AS my_status,
         group_buy_participants.joined_at,
         group_buys.*,
         crops.crop_name,
         users.name AS farmer_name
       FROM group_buy_participants 
       JOIN group_buys ON group_buy_participants.group_buy_id = group_buys.id 
       JOIN crops ON group_buys.crop_id = crops.id 
       JOIN users ON group_buys.farmer_id = users.id 
       WHERE group_buy_participants.buyer_id = ? 
       ORDER BY group_buy_participants.joined_at DESC`,
      [req.user.id]
    );
    res.json(joined);
  } catch (err) {
    console.error('GET /group-buys/buyer/mine error:', err.message);
    res.status(500).json({ error: 'Failed to fetch joined campaigns' });
  }
});

// 5. FARMER CREATES A GROUP BUYING CAMPAIGN
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'farmer') {
      return res.status(403).json({ error: 'Only farmers can create group buying campaigns' });
    }

    const { crop_id, title, target_quantity, discount_price_per_kg, min_participants, end_date } = req.body;
    const targetQty = parseInt(target_quantity, 10);
    const discountPrice = parseFloat(discount_price_per_kg);
    const minPart = min_participants ? parseInt(min_participants, 10) : 2;

    if (!crop_id || !title || isNaN(targetQty) || targetQty <= 0 || isNaN(discountPrice) || discountPrice <= 0 || !end_date) {
      return res.status(400).json({ error: 'All fields (crop, title, target quantity, discount price, end date) are required' });
    }

    // Verify crop belongs to farmer and has enough stock
    const [crops] = await db.query(
      `SELECT id, farmer_id, crop_name, quantity_available FROM crops WHERE id = ?`,
      [crop_id]
    );

    if (crops.length === 0) return res.status(404).json({ error: 'Crop listing not found' });
    if (crops[0].farmer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized: You can only create campaigns for your own crops' });
    }

    if (crops[0].quantity_available < targetQty) {
      return res.status(400).json({ 
        error: `Target quantity (${targetQty} kg) exceeds your currently available crop stock (${crops[0].quantity_available} kg)` 
      });
    }

    const [result] = await db.query(
      `INSERT INTO group_buys 
       (crop_id, farmer_id, title, target_quantity, committed_quantity, discount_price_per_kg, min_participants, end_date, status) 
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'active')`,
      [crop_id, req.user.id, title.trim(), targetQty, discountPrice, minPart, end_date]
    );

    res.status(201).json({ message: 'Group buying campaign launched!', id: result.insertId, campaignId: result.insertId });
  } catch (err) {
    console.error('POST /group-buys error:', err.message);
    res.status(500).json({ error: 'Server error creating group buy campaign' });
  }
});

// 6. BUYER JOINS A GROUP BUY (Commits quantity with transaction safety)
router.post('/:id/join', verifyToken, async (req, res) => {
  if (req.user.role !== 'buyer') {
    return res.status(403).json({ error: 'Only buyers can join group buying campaigns' });
  }

  const qty = parseInt(req.body.quantity, 10);
  if (isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Please enter a valid quantity in kg' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Lock campaign row
    const [campaigns] = await connection.query(
      `SELECT group_buys.*, crops.crop_name, crops.quantity_available 
       FROM group_buys 
       JOIN crops ON group_buys.crop_id = crops.id 
       WHERE group_buys.id = ? FOR UPDATE`,
      [req.params.id]
    );

    if (campaigns.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaigns[0];

    if (campaign.status !== 'active') {
      await connection.rollback();
      return res.status(400).json({ error: `Campaign is not active (current status: ${campaign.status})` });
    }

    if (new Date(campaign.end_date) < new Date()) {
      await connection.rollback();
      return res.status(400).json({ error: 'Campaign has passed its deadline and is closed' });
    }

    // Check if buyer already committed
    const [existing] = await connection.query(
      `SELECT id FROM group_buy_participants WHERE group_buy_id = ? AND buyer_id = ? AND status != 'cancelled'`,
      [campaign.id, req.user.id]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'You have already joined this group buy campaign' });
    }

    const remainingToTarget = campaign.target_quantity - campaign.committed_quantity;
    if (qty > remainingToTarget) {
      await connection.rollback();
      return res.status(400).json({ 
        error: `Quantity exceeds remaining capacity needed for target (${remainingToTarget} kg left)` 
      });
    }

    if (qty > campaign.quantity_available) {
      await connection.rollback();
      return res.status(400).json({ 
        error: `Quantity exceeds current crop stock (${campaign.quantity_available} kg left)` 
      });
    }

    const totalPrice = (qty * campaign.discount_price_per_kg).toFixed(2);

    // 1. Insert participant record
    await connection.query(
      `INSERT INTO group_buy_participants (group_buy_id, buyer_id, quantity, total_price, status) 
       VALUES (?, ?, ?, ?, 'committed')`,
      [campaign.id, req.user.id, qty, totalPrice]
    );

    // 2. Increment committed quantity
    const newCommitted = campaign.committed_quantity + qty;
    const isTargetReached = newCommitted >= campaign.target_quantity;

    await connection.query(
      `UPDATE group_buys SET committed_quantity = ?, status = ? WHERE id = ?`,
      [newCommitted, isTargetReached ? 'completed' : 'active', campaign.id]
    );

    // If target reached, finalize campaign automatically and create real orders for all participants!
    if (isTargetReached) {
      // Fetch all participants
      const [allParticipants] = await connection.query(
        `SELECT * FROM group_buy_participants WHERE group_buy_id = ? AND status = 'committed'`,
        [campaign.id]
      );

      // Decrement crop inventory
      await connection.query(
        `UPDATE crops SET quantity_available = quantity_available - ? WHERE id = ?`,
        [newCommitted, campaign.crop_id]
      );

      for (const p of allParticipants) {
        // Create real order
        const [orderResult] = await connection.query(
          `INSERT INTO orders (buyer_id, crop_id, quantity, total_price, status) VALUES (?, ?, ?, ?, 'accepted')`,
          [p.buyer_id, campaign.crop_id, p.quantity, p.total_price]
        );

        const orderId = orderResult.insertId;

        // Record status history
        await connection.query(
          `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note) 
           VALUES (?, 'accepted', ?, 'system', 'Order fulfilled via successfully completed Group Buy')`,
          [orderId, campaign.farmer_id]
        );

        // Update participant record with order_id
        await connection.query(
          `UPDATE group_buy_participants SET status = 'converted_to_order', order_id = ? WHERE id = ?`,
          [orderId, p.id]
        );

        // Notify buyer
        await createNotification(
          p.buyer_id,
          'Group Buy Completed! Order Created',
          `Target reached for "${campaign.title}"! Your group order for ${p.quantity} kg of ${campaign.crop_name} is confirmed (Order #${orderId}).`,
          'buyer-dashboard.html',
          'group_buy'
        );
      }

      // Notify farmer
      await createNotification(
        campaign.farmer_id,
        'Group Buy Target Reached!',
        `Your campaign "${campaign.title}" successfully reached its ${campaign.target_quantity} kg target. Orders have been created!`,
        'farmer-dashboard.html',
        'group_buy'
      );
    }

    await connection.commit();

    res.json({ 
      message: isTargetReached ? 'Target reached! Group buy completed and orders created!' : 'Successfully joined group buy!',
      isTargetReached,
      committedQuantity: newCommitted,
      targetQuantity: campaign.target_quantity
    });
  } catch (err) {
    await connection.rollback();
    console.error('POST /group-buys/:id/join error:', err.message);
    res.status(500).json({ error: 'Failed to join group buy: ' + err.message });
  } finally {
    connection.release();
  }
});

// 7. BUYER LEAVES A GROUP BUY BEFORE COMPLETION
router.post('/:id/leave', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [participants] = await connection.query(
      `SELECT group_buy_participants.*, group_buys.status AS campaign_status, group_buys.committed_quantity 
       FROM group_buy_participants 
       JOIN group_buys ON group_buy_participants.group_buy_id = group_buys.id 
       WHERE group_buy_participants.group_buy_id = ? AND group_buy_participants.buyer_id = ? AND group_buy_participants.status = 'committed'`,
      [req.params.id, req.user.id]
    );

    if (participants.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Active group buy participation not found' });
    }

    const participant = participants[0];

    if (participant.campaign_status !== 'active') {
      await connection.rollback();
      return res.status(400).json({ error: 'Cannot leave a campaign that is already finalized or completed' });
    }

    // Cancel participation
    await connection.query(
      `UPDATE group_buy_participants SET status = 'cancelled' WHERE id = ?`,
      [participant.id]
    );

    // Decrement committed quantity
    await connection.query(
      `UPDATE group_buys SET committed_quantity = GREATEST(0, committed_quantity - ?) WHERE id = ?`,
      [participant.quantity, req.params.id]
    );

    await connection.commit();
    res.json({ message: 'Successfully left group buy campaign' });
  } catch (err) {
    await connection.rollback();
    console.error('POST /group-buys/:id/leave error:', err.message);
    res.status(500).json({ error: 'Failed to leave group buy' });
  } finally {
    connection.release();
  }
});

module.exports = router;
