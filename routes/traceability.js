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
  return 'https://farm-direct-frontend.netlify.app';
}

// 1. PUBLIC TRACEABILITY LOOKUP (No login required)
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
         crops.created_at,
         users.name AS farmer_name, 
         users.location AS farmer_location
       FROM crops 
       JOIN users ON crops.farmer_id = users.id 
       WHERE crops.traceability_code = ?`,
      [code.trim()]
    );

    if (crops.length === 0) {
      return res.status(404).json({ error: 'No crop listing found matching this traceability code' });
    }

    const crop = crops[0];

    // Return safe, public verification payload (No private email, phone, or password)
    res.json({
      traceability_code: crop.traceability_code,
      crop_name: crop.crop_name,
      category: crop.category || 'Other',
      harvest_date: crop.harvest_date,
      description: crop.description || '',
      image: crop.image,
      farmer_name: crop.farmer_name,
      farmer_location: crop.farmer_location || 'India',
      listed_at: crop.created_at,
      status: crop.quantity_available > 0 ? 'Available on Marketplace' : 'Sold Out / Harvest Concluded',
      is_direct_trade: true,
      disclaimer: 'Information shown is farmer-reported crop data directly recorded upon harvest and listing on Farm Direct.'
    });
  } catch (err) {
    console.error('GET /traceability/code error:', err.message);
    res.status(500).json({ error: 'Server error retrieving crop traceability' });
  }
});

// 2. GENERATE OR FETCH QR CODE FOR A CROP (Farmer utility)
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

    // Generate unique code if somehow missing
    if (!code) {
      code = 'FD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      await db.query(`UPDATE crops SET traceability_code = ? WHERE id = ?`, [code, req.params.cropId]);
    }

    const baseUrl = getFrontendBaseUrl(req);
    const traceabilityUrl = `${baseUrl}/traceability.html?code=${code}`;

    // Generate QR Code as high-res Data URL PNG
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
