const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

// Whitelist of valid crop categories
const ALLOWED_CATEGORIES = ['Vegetables', 'Fruits', 'Grains', 'Pulses', 'Spices', 'Other'];

// Helper to validate and sanitize base64 crop image
// Must be JPEG format and under 400KB in size
function sanitizeCropImage(image) {
  if (!image || typeof image !== 'string') return null;
  // Check for JPEG base64 data URL header and characters
  const isJpegBase64 = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image);
  if (!isJpegBase64) return null;
  // Ensure size is under 400KB (400 * 1024 bytes)
  const byteSize = Buffer.byteLength(image, 'utf8');
  if (byteSize > 400 * 1024) return null;
  return image;
}

// Helper to validate category against allowed whitelist
function validateCategory(category) {
  if (!category) return 'Other';
  if (!ALLOWED_CATEGORIES.includes(category)) return null;
  return category;
}

// Helper to sanitize harvest date (YYYY-MM-DD or valid date string)
function sanitizeHarvestDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return dateStr;
}

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

// 1. GET ALL CROPS (Marketplace view for buyers - hides private min_bidding_price)
router.get('/', async (req, res) => {
  try {
    const [crops] = await db.query(
      `SELECT 
         crops.id, 
         crops.farmer_id, 
         crops.crop_name, 
         crops.price_per_kg, 
         crops.quantity_available, 
         crops.quantity_available AS quantity,
         crops.description,
         crops.category,
         crops.harvest_date,
         crops.image,
         crops.bidding_enabled,
         crops.traceability_code,
         users.name AS farmer_name, 
         users.location 
       FROM crops 
       JOIN users ON crops.farmer_id = users.id 
       ORDER BY crops.id DESC`
    );
    res.json(crops);
  } catch (err) {
    console.error("GET /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while fetching crops' });
  }
});

// Helper: Calculate SQL-aggregated price benchmark for a given crop
async function computePriceBenchmark({ cropName, farmerPrice = null, excludeFarmerId = null, excludeCropId = null, region = null }) {
  const normalized = (cropName || '').trim().toLowerCase();
  if (!normalized) {
    return {
      status: 'invalid_crop',
      message: 'Crop name is required for benchmark calculation',
      calculated_at: new Date().toISOString()
    };
  }

  let scope = 'platform_wide';
  let matchedRegion = null;
  let stats = null;

  // 1. If regional data is available and specified, prefer regional comparison first
  if (region && typeof region === 'string' && region.trim().length >= 2) {
    const cleanRegion = region.trim();
    const [regionalRows] = await db.query(
      `SELECT 
         COUNT(*) AS listing_count,
         ROUND(AVG(crops.price_per_kg), 2) AS avg_price,
         ROUND(MIN(crops.price_per_kg), 2) AS min_price,
         ROUND(MAX(crops.price_per_kg), 2) AS max_price
       FROM crops 
       JOIN users ON crops.farmer_id = users.id 
       WHERE LOWER(TRIM(crops.crop_name)) = ?
         AND crops.quantity_available > 0
         AND crops.price_per_kg > 0
         AND (? IS NULL OR crops.farmer_id != ?)
         AND (? IS NULL OR crops.id != ?)
         AND (users.location LIKE ? OR ? LIKE CONCAT('%', users.location, '%'))`,
      [
        normalized,
        excludeFarmerId || null, excludeFarmerId || null,
        excludeCropId || null, excludeCropId || null,
        `%${cleanRegion}%`, cleanRegion
      ]
    );

    if (regionalRows && regionalRows[0] && Number(regionalRows[0].listing_count) >= 2) {
      stats = regionalRows[0];
      scope = 'regional';
      matchedRegion = cleanRegion;
    }
  }

  // 2. If regional data is insufficient (< 2 listings) or omitted, fall back to platform-wide comparison
  if (!stats) {
    const [platformRows] = await db.query(
      `SELECT 
         COUNT(*) AS listing_count,
         ROUND(AVG(crops.price_per_kg), 2) AS avg_price,
         ROUND(MIN(crops.price_per_kg), 2) AS min_price,
         ROUND(MAX(crops.price_per_kg), 2) AS max_price
       FROM crops 
       WHERE LOWER(TRIM(crops.crop_name)) = ?
         AND crops.quantity_available > 0
         AND crops.price_per_kg > 0
         AND (? IS NULL OR crops.farmer_id != ?)
         AND (? IS NULL OR crops.id != ?)`,
      [
        normalized,
        excludeFarmerId || null, excludeFarmerId || null,
        excludeCropId || null, excludeCropId || null
      ]
    );
    stats = platformRows[0] || { listing_count: 0, avg_price: null, min_price: null, max_price: null };
    scope = 'platform_wide';
  }

  const count = Number(stats.listing_count) || 0;
  const avg = stats.avg_price != null ? Number(stats.avg_price) : null;
  const min = stats.min_price != null ? Number(stats.min_price) : null;
  const max = stats.max_price != null ? Number(stats.max_price) : null;

  // If too few comparable listings (less than 2), do not invent a benchmark
  if (count < 2 || avg === null || avg <= 0) {
    return {
      crop_name: cropName,
      normalized_name: normalized,
      listing_count: count,
      comparison_average: null,
      min_price: min,
      max_price: max,
      status: 'insufficient_data',
      message: 'Not enough comparable listings yet',
      comparison_scope: scope,
      region: matchedRegion,
      calculated_at: new Date().toISOString(),
      disclaimer: 'Benchmark based on active Farm Direct platform listings. Not an official APMC mandi price or verified national rate.'
    };
  }

  // Compute percentage and absolute differences if farmer price is provided
  let pctDiff = null;
  let diffPerKg = null;
  let benchmarkStatus = 'around';
  let isGoodDeal = false;

  if (farmerPrice != null && !isNaN(Number(farmerPrice)) && Number(farmerPrice) > 0) {
    const p = Number(farmerPrice);
    diffPerKg = Number((p - avg).toFixed(2));
    pctDiff = Number((((p - avg) / avg) * 100).toFixed(2));

    // Clear rule: price at least 5% below average is 'below' and 'is_good_deal'
    if (pctDiff <= -5.0) {
      benchmarkStatus = 'below';
      isGoodDeal = true;
    } else if (pctDiff >= 5.0) {
      benchmarkStatus = 'above';
      isGoodDeal = false;
    } else {
      benchmarkStatus = 'around';
      isGoodDeal = false;
    }
  }

  return {
    crop_name: cropName,
    normalized_name: normalized,
    farmer_price: farmerPrice != null ? Number(farmerPrice) : null,
    comparison_average: avg,
    min_price: min,
    max_price: max,
    listing_count: count,
    percentage_difference: pctDiff,
    difference_per_kg: diffPerKg,
    benchmark_status: benchmarkStatus,
    is_good_deal: isGoodDeal,
    comparison_scope: scope,
    region: matchedRegion,
    status: 'ok',
    calculated_at: new Date().toISOString(),
    disclaimer: 'Benchmark based on active Farm Direct platform listings. Not an official APMC mandi price or verified national rate.'
  };
}

// 1b. GET PRICE INSIGHTS (Single crop benchmark or all platform benchmarks)
router.get('/price-insights', async (req, res) => {
  try {
    const { crop_name, farmer_id, crop_id, farmer_price, region, all } = req.query;

    // If 'all=true' or no crop_name provided, return benchmark summary for all active crops
    if (all === 'true' || !crop_name) {
      const [rows] = await db.query(
        `SELECT 
           LOWER(TRIM(crops.crop_name)) AS normalized_name,
           MIN(crops.crop_name) AS crop_name,
           MIN(crops.category) AS category,
           COUNT(*) AS listing_count,
           ROUND(AVG(crops.price_per_kg), 2) AS avg_price,
           ROUND(MIN(crops.price_per_kg), 2) AS min_price,
           ROUND(MAX(crops.price_per_kg), 2) AS max_price
         FROM crops 
         WHERE crops.quantity_available > 0 AND crops.price_per_kg > 0
         GROUP BY LOWER(TRIM(crops.crop_name))
         ORDER BY listing_count DESC, normalized_name ASC`
      );

      const benchmarks = rows.map(r => {
        const count = Number(r.listing_count);
        const avg = r.avg_price != null ? Number(r.avg_price) : null;
        return {
          crop_name: r.crop_name,
          normalized_name: r.normalized_name,
          category: r.category || 'Other',
          listing_count: count,
          comparison_average: count >= 2 ? avg : null,
          min_price: count >= 2 ? Number(r.min_price) : null,
          max_price: count >= 2 ? Number(r.max_price) : null,
          status: count >= 2 ? 'ok' : 'insufficient_data',
          message: count >= 2 ? 'Benchmark calculated' : 'Not enough comparable listings yet'
        };
      });

      return res.json({
        total_crops: benchmarks.length,
        calculated_at: new Date().toISOString(),
        disclaimer: 'Benchmark based on active Farm Direct platform listings. Not an official APMC mandi price or verified national rate.',
        benchmarks
      });
    }

    const benchmark = await computePriceBenchmark({
      cropName: crop_name,
      farmerPrice: farmer_price ? parseFloat(farmer_price) : null,
      excludeFarmerId: farmer_id ? parseInt(farmer_id, 10) : null,
      excludeCropId: crop_id ? parseInt(crop_id, 10) : null,
      region: region || null
    });

    res.json(benchmark);
  } catch (err) {
    console.error("GET /api/crops/price-insights Error:", err);
    res.status(500).json({ error: 'Server error while calculating price insights' });
  }
});

// 1c. GET BENCHMARK FOR SPECIFIC CROP LISTING (Auto-excludes current listing & farmer)
router.get('/:id/price-benchmark', async (req, res) => {
  try {
    const cropId = parseInt(req.params.id, 10);
    if (isNaN(cropId)) return res.status(400).json({ error: 'Invalid crop ID' });

    const [crops] = await db.query(
      `SELECT crops.*, users.location 
       FROM crops 
       JOIN users ON crops.farmer_id = users.id 
       WHERE crops.id = ?`,
      [cropId]
    );

    if (crops.length === 0) {
      return res.status(404).json({ error: 'Crop listing not found' });
    }

    const crop = crops[0];
    const benchmark = await computePriceBenchmark({
      cropName: crop.crop_name,
      farmerPrice: crop.price_per_kg,
      excludeFarmerId: crop.farmer_id,
      excludeCropId: crop.id,
      region: crop.location || null
    });

    res.json(benchmark);
  } catch (err) {
    console.error("GET /api/crops/:id/price-benchmark Error:", err);
    res.status(500).json({ error: 'Server error while calculating crop price benchmark' });
  }
});

// 2. GET STATS FOR FARMER (Excludes heavy image column for performance)
router.get('/stats/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [[stats]] = await db.query(
      `SELECT 
         COUNT(*) AS totalCrops,
         COALESCE(SUM(quantity_available), 0) AS totalStock,
         COALESCE(SUM(CASE WHEN quantity_available < 5 THEN 1 ELSE 0 END), 0) AS lowStockCount
       FROM crops 
       WHERE farmer_id = ?`,
      [req.params.id]
    );
    res.json(stats || { totalCrops: 0, totalStock: 0, lowStockCount: 0 });
  } catch (err) {
    console.error("GET /api/crops/stats/farmer Error:", err);
    res.status(500).json({ error: 'Server error while fetching crop stats' });
  }
});

// 3. GET CROPS BY FARMER ID (For farmer's dashboard listing)
router.get('/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [crops] = await db.query(
      `SELECT * FROM crops WHERE farmer_id = ? ORDER BY id DESC`,
      [req.params.id]
    );
    res.json(crops);
  } catch (err) {
    console.error("GET /api/crops/farmer Error:", err);
    res.status(500).json({ error: 'Server error while fetching farmer crops' });
  }
});

// 4. POST NEW CROP (Includes photo, category, and harvest date)
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'farmer') {
      return res.status(403).json({ error: 'Only farmers can add crops' });
    }

    // Accepts either naming convention sent by frontend
    const crop_name = req.body.name || req.body.crop_name;
    const price_per_kg = req.body.price || req.body.price_per_kg;
    const quantity_available = req.body.quantity || req.body.quantity_available || 0;
    const description = req.body.description || '';
    const raw_category = req.body.category || 'Other';
    const harvest_date = sanitizeHarvestDate(req.body.harvest_date);
    const image = sanitizeCropImage(req.body.image);
    const bidding_enabled = req.body.bidding_enabled === true || req.body.bidding_enabled === 'true';
    const min_bidding_price = req.body.min_bidding_price ? parseFloat(req.body.min_bidding_price) : null;
    const traceability_code = 'FD-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    if (!crop_name || !price_per_kg) {
      return res.status(400).json({ error: 'Crop name and price are required' });
    }

    // Reject unknown categories
    const category = validateCategory(raw_category);
    if (!category) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const [result] = await db.query(
      `INSERT INTO crops 
       (farmer_id, crop_name, price_per_kg, quantity_available, description, category, harvest_date, image, bidding_enabled, min_bidding_price, traceability_code) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, crop_name, price_per_kg, quantity_available, description, category, harvest_date, image, bidding_enabled, min_bidding_price, traceability_code]
    );

    res.status(201).json({ message: 'Crop added successfully', id: result.insertId, cropId: result.insertId, traceability_code });
  } catch (err) {
    console.error("POST /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while adding crop' });
  }
});

// 5. UPDATE CROP (Keeps old image if no new one sent)
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const crop_name = req.body.name || req.body.crop_name;
    const price_per_kg = req.body.price || req.body.price_per_kg;
    const quantity_available = req.body.quantity || req.body.quantity_available || 0;
    const description = req.body.description || '';

    const [crops] = await db.query('SELECT * FROM crops WHERE id = ?', [req.params.id]);
    if (crops.length === 0) return res.status(404).json({ error: 'Crop not found' });

    if (crops[0].farmer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to edit this crop' });
    }

    // Category update: keep existing or validate new
    let category = crops[0].category || 'Other';
    if (req.body.category !== undefined) {
      category = validateCategory(req.body.category);
      if (!category) {
        return res.status(400).json({ error: 'Invalid category' });
      }
    }

    // Harvest date update: keep existing or sanitize new
    let harvest_date = crops[0].harvest_date;
    if (req.body.harvest_date !== undefined) {
      harvest_date = sanitizeHarvestDate(req.body.harvest_date);
    }

    // Image update: keep existing if image field is omitted (undefined)
    let image = crops[0].image;
    if (req.body.image !== undefined) {
      // Validate new image (or NULL if invalid / cleared)
      image = sanitizeCropImage(req.body.image);
    }

    // Bidding updates
    let bidding_enabled = crops[0].bidding_enabled;
    if (req.body.bidding_enabled !== undefined) {
      bidding_enabled = req.body.bidding_enabled === true || req.body.bidding_enabled === 'true';
    }

    let min_bidding_price = crops[0].min_bidding_price;
    if (req.body.min_bidding_price !== undefined) {
      min_bidding_price = req.body.min_bidding_price ? parseFloat(req.body.min_bidding_price) : null;
    }

    await db.query(
      `UPDATE crops 
       SET crop_name = ?, price_per_kg = ?, quantity_available = ?, description = ?, category = ?, harvest_date = ?, image = ?, bidding_enabled = ?, min_bidding_price = ? 
       WHERE id = ?`,
      [crop_name, price_per_kg, quantity_available, description, category, harvest_date, image, bidding_enabled, min_bidding_price, req.params.id]
    );

    res.json({ message: 'Crop updated successfully' });
  } catch (err) {
    console.error("PUT /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while updating crop' });
  }
});

// 6. DELETE CROP
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const [crops] = await db.query('SELECT * FROM crops WHERE id = ?', [req.params.id]);
    if (crops.length === 0) return res.status(404).json({ error: 'Crop not found' });

    if (crops[0].farmer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this crop' });
    }

    await db.query('DELETE FROM crops WHERE id = ?', [req.params.id]);
    res.json({ message: 'Crop deleted successfully' });
  } catch (err) {
    console.error("DELETE /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while deleting crop' });
  }
});

module.exports = router;