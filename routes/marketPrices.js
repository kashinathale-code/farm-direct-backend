const express = require('express');
const marketPriceService = require('../services/marketPriceService');

const router = express.Router();

// 1. GET ALL MARKET PRICES (Filter by commodity, state, district)
router.get('/', async (req, res) => {
  try {
    const { commodity, state, district, limit } = req.query;
    const prices = await marketPriceService.getMarketPrices({
      commodity: commodity || null,
      state: state || null,
      district: district || null,
      limit: limit ? parseInt(limit, 10) : 50
    });
    res.json(prices);
  } catch (err) {
    console.error('GET /api/market-prices error:', err.message);
    res.status(500).json({ error: 'Failed to fetch market prices' });
  }
});

// 2. GET DISTINCT COMMODITIES
router.get('/commodities', async (req, res) => {
  try {
    const commodities = await marketPriceService.getDistinctCommodities();
    res.json(commodities);
  } catch (err) {
    console.error('GET /api/market-prices/commodities error:', err.message);
    res.status(500).json({ error: 'Failed to fetch commodities list' });
  }
});

// 3. GET STATES AND DISTRICTS
router.get('/locations', async (req, res) => {
  try {
    const locations = await marketPriceService.getStatesAndDistricts();
    res.json(locations);
  } catch (err) {
    console.error('GET /api/market-prices/locations error:', err.message);
    res.status(500).json({ error: 'Failed to fetch market locations' });
  }
});

// 4. COMPARE MANDIS FOR A GIVEN COMMODITY
router.get('/compare', async (req, res) => {
  try {
    const { commodity, state } = req.query;
    if (!commodity) {
      return res.status(400).json({ error: 'Commodity name is required' });
    }
    const comparison = await marketPriceService.compareMarkets(commodity, state || null);
    res.json(comparison);
  } catch (err) {
    console.error('GET /api/market-prices/compare error:', err.message);
    res.status(500).json({ error: 'Failed to compare mandi prices' });
  }
});

// 5. GET PRICE TRENDS (Monthly / historical)
router.get('/trends', async (req, res) => {
  try {
    const { commodity, district } = req.query;
    if (!commodity) {
      return res.status(400).json({ error: 'Commodity name is required' });
    }
    const trends = await marketPriceService.getPriceTrends(commodity, district || null);
    res.json(trends);
  } catch (err) {
    console.error('GET /api/market-prices/trends error:', err.message);
    res.status(500).json({ error: 'Failed to fetch price trends' });
  }
});

// 6. GET NEARBY APMC MARKETS
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lon, district, radius } = req.query;
    const nearby = await marketPriceService.getNearbyMarkets({
      userLat: lat ? parseFloat(lat) : null,
      userLon: lon ? parseFloat(lon) : null,
      userDistrict: district || null,
      radiusKm: radius ? parseInt(radius, 10) : 100
    });
    res.json(nearby);
  } catch (err) {
    console.error('GET /api/market-prices/nearby error:', err.message);
    res.status(500).json({ error: 'Failed to find nearby markets' });
  }
});

// 7. BENCHMARK COMPARISON (Farmer price vs APMC modal price)
router.get('/benchmark', async (req, res) => {
  try {
    const { commodity, price, district } = req.query;
    if (!commodity || !price) {
      return res.status(400).json({ error: 'commodity and price (₹/kg) are required' });
    }
    const benchmark = await marketPriceService.calculateBenchmarkComparison(commodity, parseFloat(price), district || null);
    res.json(benchmark);
  } catch (err) {
    console.error('GET /api/market-prices/benchmark error:', err.message);
    res.status(500).json({ error: 'Failed to calculate price benchmark' });
  }
});

module.exports = router;
