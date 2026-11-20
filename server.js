const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Import route modules
const authRoutes = require('./routes/auth');
const cropRoutes = require('./routes/crops');
const orderRoutes = require('./routes/orders');
const messageRoutes = require('./routes/messages');
const { router: notificationRoutes } = require('./routes/notifications');
const bidRoutes = require('./routes/bids');
const groupBuyRoutes = require('./routes/groupBuys');
const traceabilityRoutes = require('./routes/traceability');
const assistantRoutes = require('./routes/assistant');

// New feature route modules
const marketPriceRoutes = require('./routes/marketPrices');
const profileRoutes = require('./routes/profile');
const wishlistRoutes = require('./routes/wishlist');
const { router: priceAlertRoutes } = require('./routes/priceAlerts');
const reviewRoutes = require('./routes/reviews');
const harvestCalendarRoutes = require('./routes/harvestCalendar');
const profitCalculatorRoutes = require('./routes/profitCalculator');
const demandAnalyticsRoutes = require('./routes/demandAnalytics');

const app = express();

// Security headers and CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parser with 2mb limit for base64 images
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Basic security middleware: prevent MIME type sniffing and clickjacking
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/crops', cropRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/bids', bidRoutes);
app.use('/api/group-buys', groupBuyRoutes);
app.use('/api/traceability', traceabilityRoutes);
app.use('/api/assistant', assistantRoutes);

// Mount new feature routes
app.use('/api/market-prices', marketPriceRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/price-alerts', priceAlertRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/harvest-calendar', harvestCalendarRoutes);
app.use('/api/profit-calculator', profitCalculatorRoutes);
app.use('/api/analytics', demandAnalyticsRoutes);

// Health check and root route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ 
    message: "Welcome to the Farm Direct API!",
    version: "3.0.0",
    features: [
      "crops", "orders", "bids", "group-buys", "traceability", "notifications",
      "assistant", "market-prices", "profile", "wishlist", "price-alerts",
      "reviews", "harvest-calendar", "profit-calculator", "demand-analytics"
    ]
  });
});

// Centralized error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Farm Direct server running on port ${PORT}`);
});

module.exports = app;
