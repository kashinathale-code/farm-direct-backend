const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Import your route files
const authRoutes = require('./routes/auth');
const cropRoutes = require('./routes/crops');
const orderRoutes = require('./routes/orders');
const messageRoutes = require('./routes/messages');

const app = express();

// Middleware to understand JSON (2mb limit for base64 crop images) and allow frontend requests
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Set up your API routes
app.use('/api/auth', authRoutes);
app.use('/api/crops', cropRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/messages', messageRoutes);

// A simple test route to make sure the server is alive
app.get('/', (req, res) => {
  res.json({ message: "Welcome to the Farm Direct API!" });
});

// Start the server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});