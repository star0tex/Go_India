// src/routes/authRoutes.js
import express from 'express';
import { firebaseSync  } from '../controllers/authController.js';

const router = express.Router();

// NEW: OTP-based authentication (no Firebase Phone Auth needed)
router.post('/firebase-sync', firebaseSync);


export default router;