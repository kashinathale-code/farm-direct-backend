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
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

// 1. GET LOGGED-IN USER PROFILE (Comprehensive location and verification fields)
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT id, name, email, role, location, state, district, village, pincode, 
              latitude, longitude, is_verified, verification_status, experience_years, 
              farming_bio, profile_image, created_at 
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (users.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(users[0]);
  } catch (err) {
    console.error('GET /api/profile/me error:', err.message);
    res.status(500).json({ error: 'Server error retrieving profile' });
  }
});

// 2. UPDATE LOGGED-IN USER PROFILE
router.put('/me', verifyToken, async (req, res) => {
  try {
    const {
      name,
      location,
      state,
      district,
      village,
      pincode,
      latitude,
      longitude,
      experience_years,
      farming_bio,
      profile_image
    } = req.body;

    await db.query(
      `UPDATE users SET 
         name = COALESCE(?, name),
         location = COALESCE(?, location),
         state = COALESCE(?, state),
         district = COALESCE(?, district),
         village = COALESCE(?, village),
         pincode = COALESCE(?, pincode),
         latitude = COALESCE(?, latitude),
         longitude = COALESCE(?, longitude),
         experience_years = COALESCE(?, experience_years),
         farming_bio = COALESCE(?, farming_bio),
         profile_image = COALESCE(?, profile_image)
       WHERE id = ?`,
      [
        name ? name.trim() : null,
        location ? location.trim() : null,
        state ? state.trim() : null,
        district ? district.trim() : null,
        village ? village.trim() : null,
        pincode ? pincode.toString().trim() : null,
        latitude !== undefined && latitude !== null ? parseFloat(latitude) : null,
        longitude !== undefined && longitude !== null ? parseFloat(longitude) : null,
        experience_years !== undefined && experience_years !== null ? parseInt(experience_years, 10) : null,
        farming_bio ? farming_bio.trim() : null,
        profile_image || null,
        req.user.id
      ]
    );

    const [updated] = await db.query(
      `SELECT id, name, email, role, location, state, district, village, pincode, 
              latitude, longitude, is_verified, verification_status, experience_years, 
              farming_bio, profile_image, created_at 
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    res.json({ message: 'Profile updated successfully', user: updated[0] });
  } catch (err) {
    console.error('PUT /api/profile/me error:', err.message);
    res.status(500).json({ error: 'Server error updating profile' });
  }
});

// 3. GET PUBLIC FARMER PROFILE (For buyers exploring farmer credibility & ratings)
router.get('/farmer/:id', async (req, res) => {
  try {
    const farmerId = req.params.id;

    // Fetch farmer public details
    const [farmers] = await db.query(
      `SELECT id, name, location, state, district, village, is_verified, verification_status,
              experience_years, farming_bio, profile_image, created_at 
       FROM users WHERE id = ? AND role = 'farmer'`,
      [farmerId]
    );

    if (farmers.length === 0) {
      return res.status(404).json({ error: 'Farmer not found' });
    }

    const farmer = farmers[0];

    // Aggregated reviews & ratings
    const [[ratingStats]] = await db.query(
      `SELECT 
         COUNT(*) AS total_reviews,
         COALESCE(ROUND(AVG(rating), 1), 5.0) AS average_rating
       FROM reviews 
       WHERE farmer_id = ?`,
      [farmerId]
    );

    // Active crop count
    const [[cropStats]] = await db.query(
      `SELECT COUNT(*) AS active_crops_count 
       FROM crops 
       WHERE farmer_id = ? AND quantity_available > 0`,
      [farmerId]
    );

    // Completed deliveries count
    const [[orderStats]] = await db.query(
      `SELECT COUNT(*) AS delivered_orders_count 
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id 
       WHERE crops.farmer_id = ? AND orders.status = 'delivered'`,
      [farmerId]
    );

    // Recent reviews list (up to 10)
    const [recentReviews] = await db.query(
      `SELECT reviews.id, reviews.rating, reviews.review_text, reviews.created_at,
              users.name AS buyer_name, crops.crop_name
       FROM reviews
       JOIN users ON reviews.buyer_id = users.id
       JOIN crops ON reviews.crop_id = crops.id
       WHERE reviews.farmer_id = ?
       ORDER BY reviews.created_at DESC LIMIT 10`,
      [farmerId]
    );

    res.json({
      farmer: {
        ...farmer,
        average_rating: ratingStats ? parseFloat(ratingStats.average_rating) : 5.0,
        total_reviews: ratingStats ? parseInt(ratingStats.total_reviews, 10) : 0,
        active_crops: cropStats ? parseInt(cropStats.active_crops_count, 10) : 0,
        completed_orders: orderStats ? parseInt(orderStats.delivered_orders_count, 10) : 0
      },
      reviews: recentReviews
    });
  } catch (err) {
    console.error('GET /api/profile/farmer/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load farmer profile' });
  }
});

// 4. VERIFY FARMER (Admin / Self-verification simulation)
router.put('/verify/:id', verifyToken, async (req, res) => {
  try {
    const { status, is_verified } = req.body;
    const verificationStatus = status || 'verified';
    const verifiedBool = is_verified !== undefined ? Boolean(is_verified) : true;

    await db.query(
      `UPDATE users SET verification_status = ?, is_verified = ? WHERE id = ?`,
      [verificationStatus, verifiedBool, req.params.id]
    );

    res.json({ message: 'Farmer verification status updated', status: verificationStatus, is_verified: verifiedBool });
  } catch (err) {
    console.error('PUT /api/profile/verify/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update verification status' });
  }
});

module.exports = router;
