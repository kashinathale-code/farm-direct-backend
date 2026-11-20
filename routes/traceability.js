const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

// Helper to get frontend base URL
function getFrontendBaseUrl(req) {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, '');
  const origin = req.get('origin');
  if (origin && !origin.includes('localhost:5000')) return origin.replace(/\/$/, '');
  return 'https://kashinathale-code.github.io/farm-direct-frontend';
}

// 1. PUBLIC TRACEABILITY LOOKUP (Returns comprehensive timeline and farmer credentials)
router.get('/code/:code', async (req, res) => {
  try {
    const { code } = req.params;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Valid traceability code is required' });
    }

    const [crops] = await db.query(
      `SELECT 
         crops.id,
         crops.crop_name, 
         crops.category, 
         crops.harvest_date, 
         crops.description, 
         crops.image,
         crops.price_per_kg,
         crops.quantity_available,
         crops.traceability_code,
         crops.batch_id,
         crops.bulk_pricing,
         crops.created_at,
         users.name AS farmer_name, 
         users.location AS farmer_location,
         users.state AS farmer_state,
         users.district AS farmer_district,
         users.village AS farmer_village,
         users.is_verified AS farmer_is_verified,
         users.verification_status AS farmer_verification_status,
         users.experience_years AS farmer_experience_years,
         users.farming_bio AS farmer_bio
       FROM crops 
       JOIN users ON crops.farmer_id = users.id 
       WHERE crops.traceability_code = ?`,
      [code.trim()]
    );

    if (crops.length === 0) {
      return res.status(404).json({ error: 'No crop listing found matching this traceability code' });
    }

    const crop = crops[0];

    // Fetch full supply chain event milestones
    const [events] = await db.query(
      `SELECT id, event_type, stage_name, location, description, performed_by, event_date 
       FROM traceability_events 
       WHERE crop_id = ? 
       ORDER BY event_date ASC`,
      [crop.id]
    );

    // If no events recorded yet, produce standard baseline 4-stage supply chain timeline
    let timelineEvents = events;
    if (timelineEvents.length === 0) {
      timelineEvents = [
        {
          stage_name: 'Harvest & Quality Check',
          event_type: 'harvested',
          location: crop.farmer_district || crop.farmer_location || 'Farm Direct Verified Farm',
          description: `Harvested fresh by ${crop.farmer_name}. Quality verified for direct marketplace trade.`,
          event_date: crop.harvest_date || crop.created_at,
          performed_by: crop.farmer_name
        },
        {
          stage_name: 'Direct Farm Listing',
          event_type: 'listed',
          location: 'Farm Direct Marketplace',
          description: `Batch ${crop.batch_id || 'FD-BATCH-01'} published with transparent direct pricing.`,
          event_date: crop.created_at,
          performed_by: 'Platform Verifier'
        }
      ];
    }

    // Return safe, public verification payload
    res.json({
      traceability_code: crop.traceability_code,
      batch_id: crop.batch_id || 'BATCH-' + crop.id,
      crop_name: crop.crop_name,
      category: crop.category || 'Other',
      harvest_date: crop.harvest_date,
      description: crop.description || '',
      image: crop.image,
      farmer: {
        name: crop.farmer_name,
        location: crop.farmer_location || 'Maharashtra, India',
        district: crop.farmer_district || 'District',
        state: crop.farmer_state || 'Maharashtra',
        village: crop.farmer_village || '',
        is_verified: Boolean(crop.farmer_is_verified),
        verification_status: crop.farmer_verification_status || 'verified',
        experience_years: crop.farmer_experience_years || 5,
        bio: crop.farmer_bio || 'Dedicated local agricultural producer.'
      },
      farmer_name: crop.farmer_name,
      farmer_location: crop.farmer_location || 'India',
      listed_at: crop.created_at,
      status: crop.quantity_available > 0 ? 'Available on Marketplace' : 'Sold Out / Harvest Concluded',
      is_direct_trade: true,
      events: timelineEvents,
      disclaimer: 'Information shown is farmer-reported crop data directly recorded upon harvest and listing on Farm Direct.'
    });
  } catch (err) {
    console.error('GET /traceability/code error:', err.message);
    res.status(500).json({ error: 'Server error retrieving crop traceability' });
  }
});

// 2. GENERATE OR FETCH QR CODE FOR A CROP
router.get('/crop/:cropId/qr', async (req, res) => {
  try {
    const [crops] = await db.query(
      `SELECT id, crop_name, traceability_code FROM crops WHERE id = ?`,
      [req.params.cropId]
    );

    if (crops.length === 0) {
      return res.status(404).json({ error: 'Crop not found' });
    }

    let code = crops[0].traceability_code;

    if (!code) {
      code = 'FD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      await db.query(`UPDATE crops SET traceability_code = ? WHERE id = ?`, [code, req.params.cropId]);
    }

    const baseUrl = getFrontendBaseUrl(req);
    const traceabilityUrl = `${baseUrl}/traceability.html?code=${code}`;

    const qrDataUrl = await QRCode.toDataURL(traceabilityUrl, {
      width: 400,
      margin: 2,
      color: {
        dark: '#202A1C', // Ink green from project theme
        light: '#FFFFFF'
      }
    });

    res.json({
      traceability_code: code,
      traceability_url: traceabilityUrl,
      qr_image: qrDataUrl,
      qr_code: qrDataUrl,
      crop_name: crops[0].crop_name
    });
  } catch (err) {
    console.error('GET /traceability/crop/:id/qr error:', err.message);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// 3. GENERATE QR CODE DIRECTLY FROM TRACEABILITY CODE
router.get('/qr/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const baseUrl = getFrontendBaseUrl(req);
    const traceabilityUrl = `${baseUrl}/traceability.html?code=${code}`;

    const qrDataUrl = await QRCode.toDataURL(traceabilityUrl, {
      width: 400,
      margin: 2,
      color: {
        dark: '#202A1C',
        light: '#FFFFFF'
      }
    });

    res.json({
      traceability_code: code,
      traceability_url: traceabilityUrl,
      qr_image: qrDataUrl,
      qr_code: qrDataUrl
    });
  } catch (err) {
    console.error('GET /traceability/qr/:code error:', err.message);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

module.exports = router;
