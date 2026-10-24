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

// Health check and root route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ 
    message: "Welcome to the Farm Direct API!",
    version: "2.0.0",
    features: ["crops", "orders", "bids", "group-buys", "traceability", "notifications", "assistant"]
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