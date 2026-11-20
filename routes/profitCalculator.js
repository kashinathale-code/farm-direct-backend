const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const marketPriceService = require('../services/marketPriceService');
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

// 1. CALCULATE COST & PROFIT (Interactive calculation with APMC mandi comparison)
router.post('/calculate', async (req, res) => {
  try {
    const {
      crop_name,
      acreage,
      seed_cost,
      fertilizer_cost,
      labor_cost,
      irrigation_cost,
      transport_cost,
      other_cost,
      expected_yield_kg,
      selling_price_per_kg,
      district
    } = req.body;

    const cropName = (crop_name || 'Crop').trim();
    const yieldKg = parseFloat(expected_yield_kg) || 0;
    const sellPricePerKg = parseFloat(selling_price_per_kg) || 0;

    const seed = parseFloat(seed_cost) || 0;
    const fert = parseFloat(fertilizer_cost) || 0;
    const labor = parseFloat(labor_cost) || 0;
    const irrig = parseFloat(irrigation_cost) || 0;
    const trans = parseFloat(transport_cost) || 0;
    const other = parseFloat(other_cost) || 0;

    const totalCost = Number((seed + fert + labor + irrig + trans + other).toFixed(2));
    const grossRevenue = Number((yieldKg * sellPricePerKg).toFixed(2));
    const netProfit = Number((grossRevenue - totalCost).toFixed(2));
    const profitPerKg = yieldKg > 0 ? Number((netProfit / yieldKg).toFixed(2)) : 0;
    const costPerKg = yieldKg > 0 ? Number((totalCost / yieldKg).toFixed(2)) : 0;
    const roiPercentage = totalCost > 0 ? Number(((netProfit / totalCost) * 100).toFixed(1)) : 0;
    const breakEvenPrice = yieldKg > 0 ? Number((totalCost / yieldKg).toFixed(2)) : 0;

    // Fetch official APMC mandi benchmark comparison for this crop
    let mandiBenchmark = null;
    try {
      mandiBenchmark = await marketPriceService.calculateBenchmarkComparison(cropName, sellPricePerKg, district || null);
    } catch (benchErr) {
      console.warn('Mandi benchmark lookup warning:', benchErr.message);
    }

    // Direct platform advantage vs Mandi
    let directAdvantage = null;
    if (mandiBenchmark && mandiBenchmark.status === 'success') {
      const mandiGrossRevenue = Number((yieldKg * mandiBenchmark.mandi_modal_per_kg).toFixed(2));
      // Traditional mandi middleman cuts: 8-12% commission + mandi fees ~ 10%
      const estimatedMandiCommission = Number((mandiGrossRevenue * 0.10).toFixed(2));
      const mandiNetFarmerEarning = Number((mandiGrossRevenue - estimatedMandiCommission - totalCost).toFixed(2));
      const extraProfitDirect = Number((netProfit - mandiNetFarmerEarning).toFixed(2));

      directAdvantage = {
        mandi_modal_rate_per_kg: mandiBenchmark.mandi_modal_per_kg,
        mandi_market_name: mandiBenchmark.market_name,
        mandi_estimated_gross: mandiGrossRevenue,
        estimated_middleman_cut: estimatedMandiCommission,
        mandi_net_earning: mandiNetFarmerEarning,
        direct_extra_profit: extraProfitDirect,
        direct_extra_percentage: mandiNetFarmerEarning > 0 ? Number(((extraProfitDirect / mandiNetFarmerEarning) * 100).toFixed(1)) : 0
      };
    }

    res.json({
      crop_name: cropName,
      acreage: parseFloat(acreage) || 1,
      expected_yield_kg: yieldKg,
      selling_price_per_kg: sellPricePerKg,
      costs: {
        seed,
        fertilizer: fert,
        labor,
        irrigation: irrig,
        transport: trans,
        other,
        total_cost: totalCost,
        cost_per_kg: costPerKg
      },
      financials: {
        gross_revenue: grossRevenue,
        net_profit: netProfit,
        profit_per_kg: profitPerKg,
        break_even_price: breakEvenPrice,
        roi_percentage: roiPercentage,
        is_profitable: netProfit > 0
      },
      mandi_comparison: directAdvantage,
      advisory_note: netProfit > 0 
        ? `Listing on Farm Direct at ₹${sellPricePerKg}/kg covers your cost of ₹${costPerKg}/kg with a healthy ${roiPercentage}% ROI.`
        : `Your selling price (₹${sellPricePerKg}/kg) is below your production cost (₹${costPerKg}/kg). Consider increasing price or reducing input costs to ensure profitability.`
    });
  } catch (err) {
    console.error('POST /api/profit-calculator/calculate error:', err.message);
    res.status(500).json({ error: 'Failed to calculate profit: ' + err.message });
  }
});

// 2. SAVE PROFIT CALCULATION (Farmer utility)
router.post('/save', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'farmer') {
      return res.status(403).json({ error: 'Only farmers can save calculations' });
    }

    const {
      crop_name,
      acreage,
      seed_cost,
      fertilizer_cost,
      labor_cost,
      irrigation_cost,
      transport_cost,
      other_cost,
      expected_yield_kg,
      selling_price_per_kg,
      total_cost,
      gross_revenue,
      net_profit,
      notes
    } = req.body;

    const [result] = await db.query(
      `INSERT INTO profit_calculations 
         (farmer_id, crop_name, acreage, seed_cost, fertilizer_cost, labor_cost, irrigation_cost, transport_cost, other_cost, expected_yield_kg, selling_price_per_kg, total_cost, gross_revenue, net_profit, notes) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        crop_name || 'My Crop',
        acreage || 1,
        seed_cost || 0,
        fertilizer_cost || 0,
        labor_cost || 0,
        irrigation_cost || 0,
        transport_cost || 0,
        other_cost || 0,
        expected_yield_kg || 0,
        selling_price_per_kg || 0,
        total_cost || 0,
        gross_revenue || 0,
        net_profit || 0,
        notes || null
      ]
    );

    res.status(201).json({ message: 'Profit calculation saved successfully', calculationId: result.insertId });
  } catch (err) {
    console.error('POST /api/profit-calculator/save error:', err.message);
    res.status(500).json({ error: 'Failed to save calculation' });
  }
});

// 3. GET SAVED CALCULATIONS FOR LOGGED-IN FARMER
router.get('/history', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM profit_calculations WHERE farmer_id = ? ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/profit-calculator/history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calculation history' });
  }
});

// 4. DELETE A SAVED CALCULATION
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const [result] = await db.query(
      `DELETE FROM profit_calculations WHERE id = ? AND farmer_id = ?`,
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Calculation not found' });
    }

    res.json({ message: 'Calculation deleted successfully' });
  } catch (err) {
    console.error('DELETE /api/profit-calculator/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete calculation' });
  }
});

module.exports = router;
