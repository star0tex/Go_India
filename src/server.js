// src/server.js
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import connectDB from './config/db.js';

import userRoutes from './routes/userRoutes.js';
import authRoutes from './routes/authRoutes.js';
import driverRoutes from './routes/driverRoutes.js';
import fareRoutes from './routes/fareRoutes.js';
import parcelRoutes from './routes/parcelRoutes.js';
import rateRoutes from './routes/rateRoutes.js';
import rideHistoryRoutes from './routes/rideHistoryRoutes.js';
import locationRoutes from './routes/locationRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import tripRoutes from './routes/tripRoutes.js';
import standbyReassignCron from './cron/standbyReassignCron.js';
import { initSocket } from './socket/socketHandler.js';

dotenv.config();
await connectDB();

const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

app.get('/', (_req, res) => {
  res.send('🌍 Go India backend live 🚀');
});

// ✅ API Routes
app.use('/api/user', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/fares', fareRoutes);
app.use('/api/parcels', parcelRoutes);
app.use('/api/rates', rateRoutes);
app.use('/api', rideHistoryRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trips', tripRoutes);

// ✅ Socket.IO Init
initSocket(httpServer);

// ✅ Start Cron (every 2 minutes)
setInterval(() => {
  standbyReassignCron().catch((err) =>
    console.error('❌ Unhandled cron error:', err)
  );
}, 2 * 60 * 1000);

// ✅ 404 Handler
app.use((req, res) => {
  res.status(404).json({ message: '🔍 Route not found' });
});

// ✅ Error Handler
app.use((err, req, res, _next) => {
  console.error('❌ Server error:', err);
  res.status(err.status || 500).json({
    message: err.message || '🚨 Internal Server Error',
  });
});

// ✅ Start Server
const PORT = process.env.PORT || 5002;
httpServer.listen(PORT, () =>
  console.log(`🚀 Go India server running on port ${PORT}`)
);
