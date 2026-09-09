const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Import your route files
const authRoutes = require('./routes/auth');
const cropRoutes = require('./routes/crops');
const orderRoutes = require('./routes/orders');
const messageRoutes = require('./routes/messages');

const app = express();

// Middleware to understand JSON and allow frontend requests
app.use(cors());
app.use(express.json());

// Set up your API routes
app.use('/api/auth', authRoutes);
app.use('/api/crops', cropRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/messages', messageRoutes);

// A simple test route to make sure the server is alive
app.get('/api/test', (req, res) => {
  res.json({ message: "Welcome to the Farm Direct API!" });
});

// Import DB initializer
const createTables = require('./init-db');

// Start the server
const PORT = process.env.PORT || 5000;

createTables().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
});