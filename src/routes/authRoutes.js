// src/routes/authRoutes.js
import express from 'express';
import { firebaseLogin, sendOTP, verifyOTPAndLogin } from '../controllers/authController.js';

const router = express.Router();

// NEW: OTP-based authentication (no Firebase Phone Auth needed)
router.post('/send-otp', sendOTP);
router.post('/verify-otp', verifyOTPAndLogin);

// ORIGINAL: Firebase Phone Auth (requires Blaze plan)
router.post('/firebase-login', firebaseLogin);

export default router;