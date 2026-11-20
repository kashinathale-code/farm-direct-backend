const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

// Optional JWT extractor for event logging
function optionalUser(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    req.user = null;
    return next();
  }
  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
    req.user = err ? null : decoded;
    next();
  });
}

// 1. LOG MARKETPLACE INTERACTION EVENT
router.post('/event', optionalUser, async (req, res) => {
  try {
    const { event_type, crop_name, category, state, district } = req.body;
    if (!event_type) {
      return res.status(400).json({ error: 'event_type is required' });
    }

    const userId = req.user ? req.user.id : null;

    await db.query(
      `INSERT INTO marketplace_analytics_events (event_type, user_id, crop_name, category, state, district)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event_type,
        userId,
        crop_name ? crop_name.trim() : null,
        category ? category.trim() : null,
        state ? state.trim() : null,
        district ? district.trim() : null
      ]
    );

    res.json({ success: true });
  } catch (err) {
    // Analytics logging should be non-blocking
    console.warn('Analytics event log warning:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// 2. GET AGGREGATED DEMAND INSIGHTS (For farmer advisory and market intelligence)
router.get('/demand', async (req, res) => {
  try {
    // 1. Top demanded crops by search, view, wishlist, and orders
    const [topCrops] = await db.query(
      `SELECT 
         LOWER(TRIM(crop_name)) AS crop_name,
         COUNT(*) AS total_demand_signals,
         SUM(CASE WHEN event_type = 'search' THEN 1 ELSE 0 END) AS search_count,
         SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS view_count,
         SUM(CASE WHEN event_type = 'wishlist' THEN 1 ELSE 0 END) AS wishlist_count,
         SUM(CASE WHEN event_type = 'order' THEN 1 ELSE 0 END) AS order_count
       FROM marketplace_analytics_events
       WHERE crop_name IS NOT NULL AND crop_name != ''
         AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY LOWER(TRIM(crop_name))
       ORDER BY total_demand_signals DESC
       LIMIT 8`
    );

    // 2. Category demand breakdown
    const [categoryBreakdown] = await db.query(
      `SELECT 
         COALESCE(category, 'Vegetables') AS category,
         COUNT(*) AS demand_count
       FROM marketplace_analytics_events
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY category
       ORDER BY demand_count DESC`
    );

    // 3. Top active buyer districts
    const [topDistricts] = await db.query(
      `SELECT 
         district,
         COUNT(*) AS interaction_count
       FROM marketplace_analytics_events
       WHERE district IS NOT NULL AND district != ''
         AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY district
       ORDER BY interaction_count DESC
       LIMIT 6`
    );

    // 4. Current supply inventory on platform
    const [supplyData] = await db.query(
      `SELECT 
         LOWER(TRIM(crop_name)) AS crop_name,
         SUM(quantity_available) AS total_available_kg,
         COUNT(*) AS active_listings_count,
         ROUND(AVG(price_per_kg), 2) AS avg_listed_price
       FROM crops
       WHERE quantity_available > 0
       GROUP BY LOWER(TRIM(crop_name))`
    );

    const supplyMap = {};
    supplyData.forEach(s => {
      supplyMap[s.crop_name] = s;
    });

    // 5. Generate intelligent rule-based farmer recommendations
    const recommendations = [];
    const highDemandNames = ['onion', 'tomato', 'potato', 'wheat', 'rice', 'cotton', 'soybean', 'mango'];

    // Combine top crops with supply
    const demandInsights = topCrops.map(tc => {
      const sup = supplyMap[tc.crop_name] || { total_available_kg: 0, active_listings_count: 0, avg_listed_price: null };
      const demandRatio = sup.total_available_kg > 0 ? (tc.total_demand_signals / (sup.total_available_kg / 100)) : 10;
      
      let demandStatus = 'Balanced';
      if (demandRatio > 1.5 || sup.total_available_kg === 0) {
        demandStatus = 'High Demand (Undersupplied)';
      } else if (demandRatio < 0.5) {
        demandStatus = 'Oversupplied';
      }

      return {
        crop_name: tc.crop_name.charAt(0).toUpperCase() + tc.crop_name.slice(1),
        demand_signals: tc.total_demand_signals,
        search_count: tc.search_count,
        wishlist_count: tc.wishlist_count,
        order_count: tc.order_count,
        available_supply_kg: sup.total_available_kg,
        active_listings: sup.active_listings_count,
        avg_market_price: sup.avg_listed_price,
        status: demandStatus
      };
    });

    // Generate actionable advisory messages
    demandInsights.forEach(d => {
      if (d.status.includes('High Demand')) {
        recommendations.push({
          type: 'opportunity',
          crop: d.crop_name,
          title: `High Buyer Demand for ${d.crop_name}`,
          message: `Buyer searches and wishlists for ${d.crop_name} are outpacing current marketplace listings. Farmers listing fresh harvests now can expect fast sales and optimal pricing.`
        });
      }
    });

    // Fallback baseline recommendations if new DB has few events
    if (recommendations.length === 0) {
      recommendations.push(
        {
          type: 'opportunity',
          crop: 'Onion',
          title: 'Steady Seasonal Demand: Onion & Tomato',
          message: 'Wholesale APMC arrival rates indicate strong buyer demand across Western Maharashtra. Direct listings priced competitively against Lasalgaon and Pune mandis sell quickly.'
        },
        {
          type: 'tip',
          crop: 'Wheat',
          title: 'Bulk Grain Inquiries from Institutional Buyers',
          message: 'Buyers frequently search for Wheat and Pulses in 100kg+ bulk orders. Enable tiered bulk pricing on your listings to attract restaurant and retail buyers.'
        }
      );
    }

    res.json({
      summary: {
        total_tracked_events: topCrops.reduce((acc, c) => acc + c.total_demand_signals, 0),
        period: 'Last 30 Days',
        source: 'Real Farm Direct buyer search, order, and wishlist interactions'
      },
      top_crops: demandInsights,
      category_breakdown: categoryBreakdown,
      top_districts: topDistricts,
      advisory_recommendations: recommendations
    });
  } catch (err) {
    console.error('GET /api/analytics/demand error:', err.message);
    res.status(500).json({ error: 'Failed to fetch demand insights' });
  }
});

module.exports = router;
